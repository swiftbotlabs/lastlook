/* Last Look: a last look at your Buffer queue before it posts.
   Cloudflare Worker. Routes:
     GET  /                  landing page, or the app shell when connected
     GET  /oauth/start       start Buffer OAuth (Authorization Code + PKCE, confidential client)
     GET  /oauth/callback    finish OAuth, create the session
     POST /api/scan          read the queue through the user's token and run the checks
     POST /api/links         check up to 6 links found by a scan (signed by the server, so only those links)
     POST /api/fix           edit text / move to drafts / move in queue, one post, after the user confirmed
     POST /api/disconnect    delete the session and its token
     GET  /privacy, /about, /healthz
   Every POST needs the session cookie, a same-origin Origin header and the session's CSRF token. */
import { gql, BufferError, Q_ACCOUNT, scanQuery, Q_POST, M_EDIT_TEXT, M_TO_DRAFT, M_MOVE, shapePost, shapeChannel } from './buffer.js';
import { runChecks } from './checks/index.js';
import { checkLink, linkFlag } from './net.js';
import { createSession, readSession, deleteSession, setCookie, clearCookie, parseCookies, sealJSON, openJSON, randomToken, sha256, sha256hex, b64url, hmac, safeEqual, SESSION_COOKIE, OAUTH_COOKIE } from './session.js';
import { landingPage, appPage, privacyPage, aboutPage, errorPage } from './pages.js';

export const ORIGIN = 'https://lastlook.swiftbotlab.workers.dev';
const SELF_HOST = 'lastlook.swiftbotlab.workers.dev';
const REDIRECT_URI = ORIGIN + '/oauth/callback';
const AUTHORIZE = 'https://auth.buffer.com/auth';
const TOKEN = 'https://auth.buffer.com/token';
const SCOPES = 'account:read posts:read posts:write';
const MAX_BODY = 64 * 1024;
const MAX_TEXT = 30000;
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const MAX_ORGS = 5;
const MAX_PAGES = 3;
const PAGE = 100;
const LINK_BATCH = 6;
const LINK_SUBREQUESTS = 40;

/* ---------- responses ---------- */
const SEC = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'x-frame-options': 'DENY'
};
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; manifest-src 'self'";
function html(body, status, extra) {
  return new Response(body, { status: status || 200, headers: Object.assign({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': CSP }, SEC, extra || {}) });
}
function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, SEC, extra || {}) });
}
const fail = (status, code, message, extra) => json({ ok: false, error: code, message }, status, extra);
function redirect(location, cookies) {
  const h = new Headers(Object.assign({ location, 'cache-control': 'no-store' }, SEC));
  for (const c of cookies || []) h.append('set-cookie', c);
  return new Response(null, { status: 303, headers: h });
}

/* ---------- rate limits ---------- */
/* Cloudflare's rate-limiting binding when present, else a per-isolate fallback (dev and tests) */
const memLimits = new Map();
async function limited(env, binding, key, limit) {
  const rl = env[binding];
  if (rl && typeof rl.limit === 'function') {
    try { const { success } = await rl.limit({ key }); return !success; } catch (e) { /* fall through */ }
  }
  const now = Date.now();
  const k = binding + ':' + key;
  const e = memLimits.get(k);
  if (!e || e.reset < now) { memLimits.set(k, { n: 1, reset: now + 60000 }); if (memLimits.size > 5000) memLimits.clear(); return false; }
  e.n++;
  return e.n > limit;
}
const clientIp = (request) => request.headers.get('cf-connecting-ip') || 'unknown';

/* ---------- request body ---------- */
async function readJson(request) {
  const len = Number(request.headers.get('content-length'));
  if (Number.isFinite(len) && len > MAX_BODY) throw new Error('too_large');
  if (!/^application\/json\b/i.test(request.headers.get('content-type') || '')) throw new Error('content_type');
  const reader = request.body && request.body.getReader();
  if (!reader) return {};
  const chunks = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MAX_BODY) { try { await reader.cancel(); } catch (e) { /* ignore */ } throw new Error('too_large'); }
    chunks.push(value);
  }
  const buf = new Uint8Array(n); let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
  const v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buf) || '{}');
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('shape');
  return v;
}

/* POST guard: session + same origin + CSRF */
async function guard(request, env) {
  const origin = request.headers.get('origin');
  if (origin !== ORIGIN) return { error: fail(403, 'bad_origin', 'This request did not come from Last Look.') };
  const s = await readSession(env, request);
  if (!s) return { error: fail(401, 'not_connected', 'Your session ended. Connect Buffer again.') };
  const token = request.headers.get('x-csrf-token') || '';
  if (!safeEqual(token, s.record.csrf)) return { error: fail(403, 'bad_csrf', 'This page is out of date. Reload it and try again.') };
  return { session: s };
}

function bufferFailure(e, sid, env) {
  if (e instanceof BufferError) {
    if (e.kind === 'auth') {
      return deleteSession(env, sid).then(() => fail(401, 'not_connected', 'Buffer says this connection is no longer valid. Connect again.', { 'set-cookie': clearCookie(SESSION_COOKIE) }));
    }
    if (e.kind === 'rate') return Promise.resolve(fail(429, 'buffer_rate', 'Buffer asked Last Look to slow down. Try again in ' + Math.ceil((e.retryAfter || 60) / 60) + ' min.', { 'retry-after': String(e.retryAfter || 60) }));
    return Promise.resolve(fail(502, 'buffer_' + e.kind, e.message + '. Try again in a moment.'));
  }
  return Promise.resolve(fail(500, 'internal', 'Something went wrong on our side. Try again.'));
}

/* ---------- OAuth ---------- */
async function pkcePair() {
  const verifier = randomToken(48);
  const challenge = b64url(await sha256(verifier));
  return { verifier, challenge };
}
async function oauthStart(request, env) {
  if (await limited(env, 'RL_AUTH', clientIp(request), 10)) return html(errorPage('Slow down', 'Too many sign-in attempts from your network. Wait a minute and try again.'), 429);
  if (!env.BUFFER_CLIENT_ID || !env.BUFFER_CLIENT_SECRET) return html(errorPage('Not configured', 'Last Look is not configured yet.'), 503);
  const { verifier, challenge } = await pkcePair();
  const nonce = randomToken(24);
  const state = nonce + '.' + (await hmac(env, 'oauth-state', nonce)).slice(0, 22);
  const sealed = await sealJSON(env, 'oauth', 'lastlook-oauth-v1', { state, verifier, exp: Date.now() + 600000 });
  const u = new URL(AUTHORIZE);
  u.searchParams.set('client_id', env.BUFFER_CLIENT_ID);
  u.searchParams.set('redirect_uri', REDIRECT_URI);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPES);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('prompt', 'consent');
  return redirect(u.toString(), [setCookie(OAUTH_COOKIE, sealed, 600)]);
}
async function oauthCallback(request, env, url) {
  if (await limited(env, 'RL_AUTH', clientIp(request), 10)) return html(errorPage('Slow down', 'Too many sign-in attempts from your network. Wait a minute and try again.'), 429);
  const clear = [clearCookie(OAUTH_COOKIE)];
  const sealed = parseCookies(request)[OAUTH_COOKIE];
  const flow = sealed ? await openJSON(env, 'oauth', 'lastlook-oauth-v1', sealed) : null;
  const state = String(url.searchParams.get('state') || '').slice(0, 200);
  const errorParam = url.searchParams.get('error');
  const code = String(url.searchParams.get('code') || '');
  const page = (title, msg, status) => { const r = html(errorPage(title, msg, true), status); for (const c of clear) r.headers.append('set-cookie', c); return r; };
  if (!flow || !(flow.exp > Date.now())) return page('Sign-in expired', 'The sign-in took too long or started in another browser. Start again.', 400);
  const [nonce, sig] = state.split('.');
  const expectSig = nonce ? (await hmac(env, 'oauth-state', nonce)).slice(0, 22) : '';
  if (!state || !safeEqual(state, flow.state) || !safeEqual(sig || '', expectSig)) return page('Sign-in refused', 'The sign-in response did not match this browser. Start again.', 403);
  if (errorParam) return page(errorParam === 'access_denied' ? 'No problem' : 'Buffer said no', errorParam === 'access_denied' ? 'You cancelled the connection, so nothing was read.' : 'Buffer could not complete the connection. Start again.', 400);
  if (!/^[A-Za-z0-9._~-]{8,2048}$/.test(code)) return page('Sign-in failed', 'Buffer returned an unexpected code. Start again.', 400);
  let tok;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    const r = await fetch(TOKEN, {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ client_id: env.BUFFER_CLIENT_ID, client_secret: env.BUFFER_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: flow.verifier })
    });
    clearTimeout(t);
    const text = await r.text();
    if (text.length > 65536) throw new Error('large');
    tok = JSON.parse(text);
    if (r.status !== 200 || !tok || typeof tok.access_token !== 'string') {
      console.log(JSON.stringify({ ev: 'token_exchange_failed', status: r.status, error: tok && typeof tok.error === 'string' ? tok.error.slice(0, 40) : null }));
      return page('Sign-in failed', 'Buffer did not accept the sign-in. Start again.', 400);
    }
  } catch (e) {
    return page('Sign-in failed', 'Could not reach Buffer to finish signing in. Try again.', 502);
  }
  if (tok.access_token.length > 8192) return page('Sign-in failed', 'Buffer returned an unexpected token.', 400);
  const scopes = String(tok.scope || '');
  let acct;
  try {
    const r = await gql(tok.access_token, Q_ACCOUNT);
    acct = r.data && r.data.account;
    if (!acct || !Array.isArray(acct.organizations)) throw new Error('no account');
  } catch (e) {
    return page('Sign-in failed', 'Connected, but Buffer would not show the account. Try again.', 502);
  }
  const ttl = Math.min(Number(tok.expires_in) || 3600, 3600) - 60;
  const { sid, life } = await createSession(env, {
    at: tok.access_token,
    orgs: acct.organizations.slice(0, MAX_ORGS).map((o) => ({ id: String(o.id), name: String(o.name || '').slice(0, 80) })),
    name: acct.name ? String(acct.name).slice(0, 80) : null,
    canWrite: !scopes || /posts:write/.test(scopes)
  }, ttl);
  console.log(JSON.stringify({ ev: 'connected', orgs: acct.organizations.length }));
  return redirect('/', [...clear, setCookie(SESSION_COOKIE, sid, life)]);
}

/* ---------- scan ---------- */
async function scan(env, s) {
  const token = s.record.at;
  const channels = []; const posts = [];
  let truncated = false; let rate = null;
  for (const org of s.record.orgs) {
    let after = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await gql(token, scanQuery(page === 0), { org: org.id, first: PAGE, after });
      rate = r.rate;
      if (page === 0) for (const c of (r.data.channels || []).slice(0, 100)) channels.push(Object.assign(shapeChannel(c), { org: org.name }));
      const conn = r.data.posts || {};
      for (const e of (conn.edges || [])) if (e && e.node) posts.push(shapePost(e.node));
      if (!conn.pageInfo || !conn.pageInfo.hasNextPage) { after = null; break; }
      after = conn.pageInfo.endCursor;
      if (r.rate && r.rate.low) { truncated = true; break; }
      if (page === MAX_PAGES - 1) truncated = true;
    }
  }
  const checked = runChecks(channels, posts, new Date());
  /* links the browser may ask us to check: signed, so /api/links only fetches links from this user's queue */
  const linkSet = new Map();
  for (const p of checked) for (const l of p.links) if (!linkSet.has(l.url)) linkSet.set(l.url, null);
  const links = [];
  for (const u of Array.from(linkSet.keys()).slice(0, 150)) links.push({ url: u, sig: await linkSig(env, s.sid, u) });
  return { channels, posts: checked, links, truncated, rateLow: !!(rate && rate.low), scannedAt: new Date().toISOString() };
}
const linkSig = async (env, sid, url) => (await hmac(env, 'link:' + sid, url)).slice(0, 32);

/* ---------- links ---------- */
async function links(env, s, body) {
  const items = Array.isArray(body.items) ? body.items.slice(0, LINK_BATCH) : null;
  if (!items || !items.length) return fail(400, 'bad_input', 'No links to check.');
  let budget = LINK_SUBREQUESTS;
  const deps = { selfHost: SELF_HOST, timeoutMs: 8000, spend: (n) => { budget -= n; if (budget < 0) throw new Error('budget'); } };
  const out = [];
  const valid = [];
  for (const it of items) {
    const url = it && typeof it.url === 'string' ? it.url.slice(0, 2048) : '';
    const sig = it && typeof it.sig === 'string' ? it.sig : '';
    if (!url || !safeEqual(sig, await linkSig(env, s.sid, url))) { out.push({ url, error: 'unsigned' }); continue; }
    valid.push(url);
  }
  const results = await Promise.all(valid.map((u) => checkLink(u, deps)));
  for (const r of results) out.push({ url: r.url, kind: r.kind, status: r.status, finalUrl: r.finalUrl, hops: r.hops.length, ms: r.ms, flag: linkFlag(r) });
  return json({ ok: true, results: out });
}

/* ---------- fixes ---------- */
const LIVE = new Set(['scheduled', 'needs_approval']);
async function fix(env, s, body) {
  const postId = typeof body.postId === 'string' ? body.postId : '';
  const action = body.action;
  if (!ID_RE.test(postId)) return fail(400, 'bad_input', 'Unknown post.');
  if (!['edit', 'draft', 'move'].includes(action)) return fail(400, 'bad_input', 'Unknown fix.');
  if (body.confirm !== true) return fail(400, 'not_confirmed', 'Confirm the change first.');
  if (s.record.canWrite === false) return fail(403, 'no_write', 'This connection can only read. Reconnect and allow editing posts.');
  const expected = typeof body.expectedHash === 'string' ? body.expectedHash : '';
  if (!/^[0-9a-f]{64}$/.test(expected)) return fail(400, 'bad_input', 'Missing post version.');
  /* re-read the post: it must still be what the user looked at, and still be safe to change */
  const cur = await gql(s.record.at, Q_POST, { id: postId });
  const node = cur.data && cur.data.post;
  if (!node) return fail(404, 'not_found', 'That post is gone. Scan again.');
  const post = shapePost(node);
  if (await sha256hex(post.text) !== expected) return fail(409, 'changed', 'This post changed in Buffer after your scan. Scan again before fixing it.');
  const acts = new Set(post.allowedActions);
  const due = post.dueAt ? Date.parse(post.dueAt) : null;
  if (due && LIVE.has(post.status) && due - Date.now() < 3 * 60 * 1000) return fail(409, 'too_close', 'This post goes out in under 3 minutes. Change it in Buffer directly.');
  let m; let vars;
  if (action === 'edit') {
    if (!(LIVE.has(post.status) || post.status === 'draft')) return fail(409, 'not_editable', 'Only queued posts and drafts can be edited here.');
    if (acts.size && !acts.has('updatePost')) return fail(403, 'not_allowed', 'Buffer does not let this account edit that post.');
    if (post.thread.length > 1) return fail(409, 'thread', 'Threads are edited in Buffer, so every part stays in step.');
    if (typeof body.text !== 'string') return fail(400, 'bad_input', 'Missing new text.');
    const text = body.text.replace(/\r\n?/g, '\n');
    if (!text.trim()) return fail(400, 'bad_input', 'The new text is empty. To pull the post, move it to drafts instead.');
    if (text.length > MAX_TEXT) return fail(400, 'bad_input', 'The new text is too long.');
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return fail(400, 'bad_input', 'The new text contains control characters.');
    if (text === post.text) return fail(400, 'no_change', 'The text is unchanged.');
    m = M_EDIT_TEXT; vars = { id: postId, text };
  } else if (action === 'draft') {
    if (!LIVE.has(post.status)) return fail(409, 'not_queued', 'Only queued posts can be moved to drafts.');
    if (acts.size && !acts.has('movePostToDraft')) return fail(403, 'not_allowed', 'Buffer does not let this account move that post to drafts.');
    m = M_TO_DRAFT; vars = { id: postId };
  } else {
    const position = body.position === 'top' ? 'top' : body.position === 'bottom' ? 'bottom' : null;
    if (!position) return fail(400, 'bad_input', 'Pick top or bottom.');
    if (post.status !== 'scheduled' || post.isCustomScheduled || post.shareMode === 'customScheduled') return fail(409, 'not_queue', 'Only posts in queue slots can be moved in the queue. This one has its own time.');
    m = M_MOVE; vars = { id: postId, position };
  }
  const r = await gql(s.record.at, m, vars);
  const payload = r.data && (r.data.editPost || r.data.movePostInQueue);
  if (!payload) return fail(502, 'buffer_graphql', 'Buffer did not confirm the change. Scan again to see the current state.');
  if (payload.__typename !== 'PostActionSuccess') return fail(422, 'buffer_refused', 'Buffer refused the change: ' + String(payload.message || payload.__typename).slice(0, 200));
  const p = payload.post || {};
  console.log(JSON.stringify({ ev: 'fix', action, ok: true }));
  return json({ ok: true, action, post: { id: p.id, status: p.status, dueAt: p.dueAt, shareMode: p.shareMode } });
}

/* ---------- router ---------- */
async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if (url.hostname !== SELF_HOST && !/^(localhost|127\.0\.0\.1)$/.test(url.hostname)) return new Response('Not found', { status: 404 });

  if (method === 'GET' || method === 'HEAD') {
    if (path === '/') {
      const s = await readSession(env, request);
      if (s) return html(appPage({ csrf: s.record.csrf, name: s.record.name, expires: s.record.exp }));
      return html(landingPage());
    }
    if (path === '/oauth/start') return oauthStart(request, env);
    if (path === '/oauth/callback') return oauthCallback(request, env, url);
    if (path === '/privacy') return html(privacyPage());
    if (path === '/about') return html(aboutPage());
    if (path === '/healthz') return json({ ok: true });
    return html(errorPage('Not found', 'There is nothing at this address.'), 404);
  }
  if (method !== 'POST') return fail(405, 'method', 'Method not allowed.');
  if (!path.startsWith('/api/')) return fail(404, 'not_found', 'Not found.');
  const g = await guard(request, env);
  if (g.error) return g.error;
  const s = g.session;
  let body;
  try { body = await readJson(request); } catch (e) { return fail(400, 'bad_input', e.message === 'too_large' ? 'Request too large.' : 'Bad request.'); }
  try {
    if (path === '/api/scan') {
      if (await limited(env, 'RL_SCAN', s.sid, 4)) return fail(429, 'slow_down', 'You scanned a moment ago. Wait a few seconds and try again.', { 'retry-after': '20' });
      return json(Object.assign({ ok: true }, await scan(env, s)));
    }
    if (path === '/api/links') {
      if (await limited(env, 'RL_LINKS', s.sid, 30)) return fail(429, 'slow_down', 'Too many link checks at once. Wait a moment.', { 'retry-after': '20' });
      return await links(env, s, body);
    }
    if (path === '/api/fix') {
      if (await limited(env, 'RL_WRITE', s.sid, 10)) return fail(429, 'slow_down', 'Too many changes in a minute. Wait a moment.', { 'retry-after': '30' });
      return await fix(env, s, body);
    }
    if (path === '/api/disconnect') {
      await deleteSession(env, s.sid);
      console.log(JSON.stringify({ ev: 'disconnected' }));
      return json({ ok: true }, 200, { 'set-cookie': clearCookie(SESSION_COOKIE) });
    }
  } catch (e) {
    return bufferFailure(e, s.sid, env);
  }
  return fail(404, 'not_found', 'Not found.');
}

export default {
  async fetch(request, env, ctx) {
    try { return await handle(request, env, ctx); } catch (e) {
      console.log(JSON.stringify({ ev: 'error', where: 'top', name: String(e && e.name || 'Error').slice(0, 40) }));
      return fail(500, 'internal', 'Something went wrong on our side.');
    }
  }
};
export { handle as _handle, scan as _scan, fix as _fix, links as _links };
