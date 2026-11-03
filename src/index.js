/* Last Look: a last look at your Buffer queue before it posts.
   Cloudflare Worker. Routes:
     GET  /                  landing page, or the app shell when connected
     GET  /oauth/start       start Buffer OAuth (Authorization Code + PKCE, confidential client)
     GET  /oauth/callback    finish OAuth, create the session (replaces any older session of the same account)
     POST /api/scan          read the queue through the user's token (the checks run in the browser)
     POST /api/links         check up to 6 links found by a scan (server-signed, 10-minute expiry)
     POST /api/fix           edit text / move to drafts / move in queue, one post the scan returned, after confirm
     POST /api/disconnect    delete the session and its token
     GET  /privacy, /about, /healthz
   Every POST needs the session cookie, a same-origin Origin header and the session's CSRF token.
   Every request that spends Buffer's per-app allowance or checks links asks the gate (src/gate.js) first. */
import { gql, BufferError, Q_ACCOUNT, scanQuery, Q_POST, M_EDIT_TEXT, M_TO_DRAFT, M_MOVE, shapePost, shapeChannel } from './buffer.js';
import { postLinks } from './checks/index.js';
import { clearUrlCache } from './checks/text.js';
import { checkLink, linkFlag, siteOf } from './net.js';
import { parseIP } from './ip.js';
import { gate } from './gate.js';
import { createSession, readSession, deleteSession, deleteSessionByKey, setCookie, clearCookie, parseCookies, sealJSON, openJSON, randomToken, sha256, sha256hex, b64url, hmac, signer, safeEqual, SESSION_COOKIE, OAUTH_COOKIE } from './session.js';
import { landingPage, appPage, privacyPage, aboutPage, errorPage } from './pages.js';
export { Gate } from './gate.js';

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
const MAX_SCAN_CALLS = 3;          /* Buffer requests per scan, across organizations and pages */
const PAGE = 100;
const LINK_BATCH = 6;
const LINK_SUBREQUESTS = 40;
const LINK_TOKEN_MS = 10 * 60 * 1000;
const POST_TOKEN_MS = 60 * 60 * 1000;
const IP_LIMIT = 120;              /* pages and API calls per IP per minute, checked before any session lookup */

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
export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: https://buffer-channel-avatars-bucket.s3.amazonaws.com https://*.buffer.com https://*.bufferapp.com; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; manifest-src 'self'";
function html(body, status, extra) {
  return new Response(body, { status: status || 200, headers: Object.assign({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': CSP }, SEC, extra || {}) });
}
function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, SEC, extra || {}) });
}
const fail = (status, code, message, extra) => json({ ok: false, error: code, message }, status, extra);
const refusal = (g) => fail(g.code === 'replaced' ? 401 : 429, g.code, g.message || 'Not now.', g.code === 'replaced' ? { 'set-cookie': clearCookie(SESSION_COOKIE) } : { 'retry-after': String(g.retryAfter || 60) });
function redirect(location, cookies) {
  const h = new Headers(Object.assign({ location, 'cache-control': 'no-store' }, SEC));
  for (const c of cookies || []) h.append('set-cookie', c);
  return new Response(null, { status: 303, headers: h });
}

/* ---------- per-IP limits (Cloudflare rate-limiting binding; per-isolate fallback in dev and tests) ---------- */
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
export function _resetLimits() { memLimits.clear(); }
const clientIp = (request) => request.headers.get('cf-connecting-ip') || 'unknown';

/* run a slow store write after the response when the runtime allows it (tests have no ctx: wait for it) */
async function later(ctx, promise) {
  const p = Promise.resolve(promise).catch(() => { /* best effort; the gate already refuses the session */ });
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p); else await p;
}

/* ---------- gate helpers ---------- */
async function ask(env, msg) {
  try { return await gate(env, msg); } catch (e) { return { ok: false, code: 'gate_down', message: 'Last Look is busy. Try again in a minute.', retryAfter: 60 }; }
}
async function noteRate(env, rate) {
  if (!rate || !rate.windows || !Object.keys(rate.windows).length) return;
  await ask(env, { op: 'record', windows: rate.windows });
}

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

/* POST guard: same origin + session + CSRF (the per-IP limit already ran) */
async function guard(request, env) {
  const origin = request.headers.get('origin');
  if (origin !== ORIGIN) return { error: fail(403, 'bad_origin', 'This request did not come from Last Look.') };
  const s = await readSession(env, request);
  if (!s || !s.record.acct) return { error: fail(401, 'not_connected', 'Your session ended. Connect Buffer again.') };
  const token = request.headers.get('x-csrf-token') || '';
  if (!safeEqual(token, s.record.csrf)) return { error: fail(403, 'bad_csrf', 'This page is out of date. Reload it and try again.') };
  return { session: s };
}

async function bufferFailure(e, s, env, ctx) {
  if (e instanceof BufferError) {
    if (e.rate) await noteRate(env, e.rate);
    if (e.kind === 'auth') {
      await ask(env, { op: 'unbind', acct: s.record.acct, sk: s.sk });
      await later(ctx, deleteSession(env, s.sid));
      return fail(401, 'not_connected', 'Buffer says this connection is no longer valid. Connect again.', { 'set-cookie': clearCookie(SESSION_COOKIE) });
    }
    if (e.kind === 'rate') return fail(429, 'buffer_rate', 'Buffer asked Last Look to slow down. Try again in ' + Math.ceil((e.retryAfter || 60) / 60) + ' min.', { 'retry-after': String(e.retryAfter || 60) });
    return fail(502, 'buffer_' + e.kind, e.message + '. Try again in a moment.');
  }
  return fail(500, 'internal', 'Something went wrong on our side. Try again.');
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
async function oauthCallback(request, env, url, ctx) {
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
  /* a sign-in spends one Buffer request: refuse early when the app allowance is nearly gone */
  const adm = await ask(env, { op: 'admit', kind: 'signin', calls: 1 });
  if (!adm.ok) return page('Last Look is busy', adm.message || 'Try again in a few minutes.', 429);
  let tok;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    const r = await fetch(TOKEN, {
      method: 'POST', signal: ctl.signal, redirect: 'manual',
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
    await noteRate(env, r.rate);
    acct = r.data && r.data.account;
    if (!acct || !acct.id || !Array.isArray(acct.organizations)) throw new Error('no account');
  } catch (e) {
    if (e instanceof BufferError && e.rate) await noteRate(env, e.rate);
    return page('Sign-in failed', 'Connected, but Buffer would not show the account. Try again.', 502);
  }
  const acctHash = await sha256hex('lastlook-account:' + String(acct.id));
  const ttl = Math.min(Number(tok.expires_in) || 3600, 3600) - 60;
  const { sid, sk, life } = await createSession(env, {
    at: tok.access_token,
    acct: acctHash,
    orgs: acct.organizations.slice(0, MAX_ORGS).map((o) => ({ id: String(o.id), name: String(o.name || '').slice(0, 80) })),
    name: acct.name ? String(acct.name).slice(0, 80) : null,
    canWrite: !scopes || /posts:write/.test(scopes)
  }, ttl);
  /* one live session per account: this one replaces any older one */
  const bound = await ask(env, { op: 'bind', acct: acctHash, sk });
  if (!bound.ok) {
    await deleteSessionByKey(env, sk);
    return page('Not now', bound.message || 'Too many sign-ins. Try again later.', 429);
  }
  if (bound.old) await later(ctx, deleteSessionByKey(env, bound.old));
  console.log(JSON.stringify({ ev: 'connected', replaced: !!bound.old }));
  return redirect('/', [...clear, setCookie(SESSION_COOKIE, sid, life)]);
}

/* ---------- tokens the scan hands out ---------- */
/* post token: lets /api/fix spend Buffer calls only on posts this session's scan returned */
async function postToken(env, sid, ts, id, sign) { return (sign || await signer(env, 'post:' + sid))(ts + '\n' + id); }
/* link token: lets /api/links check only links from this session's scan, for 10 minutes */
async function linkToken(env, sid, ts, url, sign) { return (sign || await signer(env, 'link:' + sid))(ts + '\n' + url); }

async function tokensFor(env, sid, ts, posts) {
  const signPost = await signer(env, 'post:' + sid);
  const signLink = await signer(env, 'link:' + sid);
  const seen = new Set(); const links = [];
  for (const p of posts) {
    p.ptok = await signPost(ts + '\n' + p.id);
    for (const l of postLinks(p)) {
      if (seen.has(l.url) || links.length >= 150) continue;
      seen.add(l.url);
      links.push({ url: l.url, sig: await signLink(ts + '\n' + l.url) });
    }
  }
  return links;
}

/* ---------- scan ---------- */
async function scan(env, s) {
  const adm = await ask(env, { op: 'admit', kind: 'scan', acct: s.record.acct, sk: s.sk, calls: MAX_SCAN_CALLS });
  if (!adm.ok) return refusal(adm);
  const token = s.record.at;
  const channels = []; const posts = [];
  let truncated = false; let rate = null; let calls = 0;
  try {
    outer:
    for (const org of s.record.orgs) {
      let after = null;
      for (let page = 0; ; page++) {
        if (calls >= MAX_SCAN_CALLS) { truncated = true; break outer; }
        calls++;
        const r = await gql(token, scanQuery(page === 0), { org: org.id, first: PAGE, after });
        rate = r.rate;
        if (page === 0) for (const c of (r.data.channels || []).slice(0, 100)) channels.push(Object.assign(shapeChannel(c), { org: org.name }));
        const conn = r.data.posts || {};
        for (const e of (conn.edges || [])) if (e && e.node) posts.push(shapePost(e.node));
        if (!conn.pageInfo || !conn.pageInfo.hasNextPage) break;
        after = conn.pageInfo.endCursor;
        if (r.rate && r.rate.low) { truncated = true; break outer; }
      }
    }
  } finally {
    await noteRate(env, rate);
  }
  const ts = Date.now();
  const links = await tokensFor(env, s.sid, ts, posts);
  return json({ ok: true, channels, posts, links, ts, truncated, rateLow: !!(rate && rate.low), scannedAt: new Date(ts).toISOString() });
}

/* ---------- links ---------- */
async function links(env, s, body) {
  const ts = Number(body.ts);
  const now = Date.now();
  if (!Number.isFinite(ts) || ts > now + 60000 || now - ts > LINK_TOKEN_MS) return fail(410, 'links_expired', 'These link checks expired. Scan again to check links.');
  const raw = Array.isArray(body.items) ? body.items.slice(0, LINK_BATCH) : null;
  if (!raw || !raw.length) return fail(400, 'bad_input', 'No links to check.');
  const sign = await signer(env, 'link:' + s.sid);
  const out = []; const valid = []; const seen = new Set();
  for (const it of raw) {
    const url = it && typeof it.url === 'string' ? it.url.slice(0, 2048) : '';
    if (!url || seen.has(url)) continue;                      /* one check per URL per batch */
    seen.add(url);
    const sig = it && typeof it.sig === 'string' ? it.sig : '';
    if (!safeEqual(sig, await linkToken(env, s.sid, ts, url, sign))) { out.push({ url, error: 'unsigned' }); continue; }
    let host = '';
    try { host = new URL(url).hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase(); } catch (e) { host = ''; }
    valid.push({ url, host });
  }
  const toFetch = [];
  const items = [];
  for (const v of valid) {
    /* bare IP links and unparsable links are judged without the network and without spending the budget */
    if (!v.host || parseIP(v.host)) { toFetch.push({ url: v.url, local: true }); continue; }
    items.push({ h: (await sha256hex(v.url)).slice(0, 32), site: siteOf(v.host) });
    toFetch.push({ url: v.url, local: false, idx: items.length - 1 });
  }
  let verdicts = [];
  if (items.length) {
    const g = await ask(env, { op: 'links', acct: s.record.acct, sk: s.sk, items });
    if (!g.ok) return refusal(g);
    verdicts = g.results || [];
  }
  let budget = LINK_SUBREQUESTS;
  const deps = { selfHost: SELF_HOST, timeoutMs: 8000, spend: (n) => { budget -= n; if (budget < 0) throw new Error('budget'); } };
  const jobs = toFetch.map(async (t) => {
    if (!t.local && verdicts[t.idx] !== 'ok') return { url: t.url, skipped: verdicts[t.idx] || 'not_admitted' };
    const r = await checkLink(t.url, deps);
    return { url: r.url, kind: r.kind, status: r.status, finalUrl: r.finalUrl, hops: r.hops.length, ms: r.ms, flag: linkFlag(r) };
  });
  for (const r of await Promise.all(jobs)) out.push(r);
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
  /* the post must come from this session's own scan: no Buffer request is spent on any other id */
  const ts = Number(body.ts);
  const now = Date.now();
  const ptok = typeof body.ptok === 'string' ? body.ptok : '';
  if (!Number.isFinite(ts) || ts > now + 60000 || now - ts > POST_TOKEN_MS || !safeEqual(ptok, await postToken(env, s.sid, ts, postId))) {
    return fail(403, 'unknown_post', 'Scan again before changing this post.');
  }
  if (action === 'edit') {
    if (typeof body.text !== 'string') return fail(400, 'bad_input', 'Missing new text.');
    const t = body.text.replace(/\r\n?/g, '\n');
    if (!t.trim()) return fail(400, 'bad_input', 'The new text is empty. To pull the post, move it to drafts instead.');
    if (t.length > MAX_TEXT) return fail(400, 'bad_input', 'The new text is too long.');
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(t)) return fail(400, 'bad_input', 'The new text contains control characters.');
  }
  let position = null;
  if (action === 'move') {
    position = body.position === 'top' ? 'top' : body.position === 'bottom' ? 'bottom' : null;
    if (!position) return fail(400, 'bad_input', 'Pick top or bottom.');
  }
  const adm = await ask(env, { op: 'admit', kind: 'fix', acct: s.record.acct, sk: s.sk, calls: 2 });
  if (!adm.ok) return refusal(adm);
  let rate = null;
  try {
    /* re-read the post: it must still be what the user looked at, and still be safe to change */
    const cur = await gql(s.record.at, Q_POST, { id: postId });
    rate = cur.rate;
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
      const text = body.text.replace(/\r\n?/g, '\n');
      if (text === post.text) return fail(400, 'no_change', 'The text is unchanged.');
      m = M_EDIT_TEXT; vars = { id: postId, text };
    } else if (action === 'draft') {
      if (!LIVE.has(post.status)) return fail(409, 'not_queued', 'Only queued posts can be moved to drafts.');
      if (acts.size && !acts.has('movePostToDraft')) return fail(403, 'not_allowed', 'Buffer does not let this account move that post to drafts.');
      m = M_TO_DRAFT; vars = { id: postId, text: post.text };
    } else {
      if (post.status !== 'scheduled' || post.isCustomScheduled || post.shareMode === 'customScheduled') return fail(409, 'not_queue', 'Only posts in queue slots can be moved in the queue. This one has its own time.');
      m = M_MOVE; vars = { id: postId, position };
    }
    const r = await gql(s.record.at, m, vars);
    rate = r.rate;
    const payload = r.data && (r.data.editPost || r.data.movePostInQueue);
    if (!payload) return fail(502, 'buffer_graphql', 'Buffer did not confirm the change. Scan again to see the current state.');
    if (payload.__typename !== 'PostActionSuccess') return fail(422, 'buffer_refused', 'Buffer refused the change: ' + String(payload.message || payload.__typename).slice(0, 200));
    /* hand back the whole updated post (with fresh tokens) so the page updates it without a new scan */
    const updated = payload.post && payload.post.id ? shapePost(payload.post) : null;
    let newLinks = [];
    let nts = null;
    if (updated) { nts = Date.now(); newLinks = await tokensFor(env, s.sid, nts, [updated]); }
    console.log(JSON.stringify({ ev: 'fix', action, ok: true }));
    return json({ ok: true, action, post: updated, ts: nts, links: newLinks });
  } finally {
    await noteRate(env, rate);
  }
}

/* ---------- router ---------- */
async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if (url.hostname !== SELF_HOST && !/^(localhost|127\.0\.0\.1)$/.test(url.hostname)) return new Response('Not found', { status: 404 });

  if (method === 'GET' || method === 'HEAD') {
    if (path === '/') {
      if (await limited(env, 'RL_IP', clientIp(request), IP_LIMIT)) return html(errorPage('Slow down', 'Too many requests from your network. Wait a minute.'), 429);
      const s = await readSession(env, request);
      if (s && s.record.acct) {
        const cur = await ask(env, { op: 'current', acct: s.record.acct, sk: s.sk });
        if (cur.ok) return html(appPage({ csrf: s.record.csrf, name: s.record.name, expires: s.record.exp }));
        if (cur.code === 'gate_down') return html(errorPage('Busy', 'Last Look is busy. Try again in a minute.'), 503);
        return html(landingPage(), 200, { 'set-cookie': clearCookie(SESSION_COOKIE) });
      }
      return html(landingPage());
    }
    if (path === '/oauth/start') return oauthStart(request, env);
    if (path === '/oauth/callback') return oauthCallback(request, env, url, ctx);
    if (path === '/privacy') return html(privacyPage());
    if (path === '/about') return html(aboutPage());
    if (path === '/healthz') return json({ ok: true });
    return html(errorPage('Not found', 'There is nothing at this address.'), 404);
  }
  if (method !== 'POST') return fail(405, 'method', 'Method not allowed.');
  if (!path.startsWith('/api/')) return fail(404, 'not_found', 'Not found.');
  /* per-IP limit first, before any session lookup */
  if (await limited(env, 'RL_IP', clientIp(request), IP_LIMIT)) return fail(429, 'slow_down', 'Too many requests from your network. Wait a minute.', { 'retry-after': '60' });
  const g = await guard(request, env);
  if (g.error) return g.error;
  const s = g.session;
  let body;
  try { body = await readJson(request); } catch (e) { return fail(400, 'bad_input', e.message === 'too_large' ? 'Request too large.' : 'Bad request.'); }
  try {
    if (path === '/api/scan') return await scan(env, s);
    if (path === '/api/links') return await links(env, s, body);
    if (path === '/api/fix') return await fix(env, s, body);
    if (path === '/api/disconnect') {
      /* the gate refuses the session from this moment; the KV delete (a write that can take seconds) runs after the reply */
      await ask(env, { op: 'unbind', acct: s.record.acct, sk: s.sk });
      await later(ctx, deleteSession(env, s.sid));
      console.log(JSON.stringify({ ev: 'disconnected' }));
      return json({ ok: true }, 200, { 'set-cookie': clearCookie(SESSION_COOKIE) });
    }
  } catch (e) {
    return bufferFailure(e, s, env, ctx);
  }
  return fail(404, 'not_found', 'Not found.');
}

export default {
  async fetch(request, env, ctx) {
    try { return await handle(request, env, ctx); } catch (e) {
      console.log(JSON.stringify({ ev: 'error', where: 'top', name: String(e && e.name || 'Error').slice(0, 40) }));
      return fail(500, 'internal', 'Something went wrong on our side.');
    } finally {
      clearUrlCache();   /* no post text stays in memory after the request */
    }
  }
};
export { handle as _handle };
