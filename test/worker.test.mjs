/* Worker routes and security: OAuth state, one session per account, the gate (app allowance, budgets, link limits),
   CSRF, origin, per-IP limits, input caps, and the guards on every fix.
   Buffer and the token endpoint are mocked through globalThis.fetch; the gate is the real Gate class in memory. */
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { _resetLimits } from '../src/index.js';
import { sha256hex, SESSION_COOKIE, OAUTH_COOKIE, b64url, sha256 } from '../src/session.js';
import { makeEnv, signIn } from './fakes.mjs';

const ORIGIN = 'https://lastlook.swiftbotlab.workers.dev';
let calls = [];
const realFetch = globalThis.fetch;
function mockFetch(handler) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const body = init && init.body ? String(init.body) : '';
    calls.push({ url: u, body, headers: init && init.headers, method: init && init.method });
    return handler(u, body, init);
  };
}
const bufferCalls = () => calls.filter((c) => c.url === 'https://api.buffer.com');
test.beforeEach(() => { _resetLimits(); mockFetch(() => jsonRes({})); });
test.after(() => { globalThis.fetch = realFetch; });
const RATE = (r15, r24) => ({ ratelimit: '"15m"; r=' + r15 + '; t=600, "24h"; r=' + r24 + '; t=80000', 'ratelimit-policy': '"15m"; q=110; w=900, "24h"; q=525; w=86400' });
const jsonRes = (obj, status, headers) => new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}) });

function post(path, s, body, headers) {
  return new Request(ORIGIN + path, {
    method: 'POST',
    headers: Object.assign({ origin: ORIGIN, 'content-type': 'application/json', cookie: s ? s.cookie : '', 'x-csrf-token': s ? s.csrf : '', 'cf-connecting-ip': '203.0.113.9' }, headers || {}),
    body: typeof body === 'string' ? body : JSON.stringify(body || {})
  });
}
const get = (path, s, ip) => new Request(ORIGIN + path, { headers: { cookie: s ? s.cookie : '', 'cf-connecting-ip': ip || '203.0.113.9' } });
const POST_NODE = (over) => Object.assign({ id: 'post123456', channelId: 'chan123456', channelService: 'bluesky', status: 'scheduled', dueAt: new Date(Date.now() + 20 * 864e5).toISOString(), createdAt: new Date().toISOString(), shareMode: 'customScheduled', isCustomScheduled: true, text: 'Hello **world** https://example.net/a', allowedActions: ['updatePost', 'movePostToDraft'], assets: [], metadata: { __typename: 'BlueskyPostMetadata', threadCount: 1, thread: [{ text: 'Hello **world**', assets: [] }] } }, over || {});
const scanData = (nodes, more) => ({ data: { channels: [{ id: 'chan123456', name: 'SBL', service: 'bluesky', timezone: 'UTC', avatar: 'https://buffer-channel-avatars-bucket.s3.amazonaws.com/a', metadata: { __typename: 'BlueskyMetadata' } }], posts: { pageInfo: { hasNextPage: !!more, endCursor: more ? 'c' : null }, edges: nodes.map((n) => ({ node: n })) } } });

/* a scan that returns `node`, so the test holds real post and link tokens */
async function scanned(env, s, node) {
  mockFetch(() => jsonRes(scanData([node]), 200, RATE(100, 500)));
  const r = await worker.fetch(post('/api/scan', s, {}), env);
  assert.equal(r.status, 200);
  return r.json();
}

test('pages: landing for visitors, app shell only for the live session, security headers everywhere', async () => {
  const env = makeEnv();
  let r = await worker.fetch(get('/'), env);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Connect Buffer/);
  for (const h of ['content-security-policy', 'x-content-type-options', 'referrer-policy', 'strict-transport-security', 'x-frame-options']) assert.ok(r.headers.get(h), h);
  assert.ok(!/img-src[^;]*https:(\s|;)/.test(r.headers.get('content-security-policy')), 'images only from listed hosts');
  const s = await signIn(env);
  r = await worker.fetch(get('/', s), env);
  const html = await r.text();
  assert.match(html, /<meta name="csrf" content="/);
  assert.match(html, /Connected as Tester/);
  for (const p of ['/privacy', '/about']) assert.equal((await worker.fetch(get(p), env)).status, 200);
  assert.equal((await worker.fetch(get('/nope'), env)).status, 404);
  assert.equal((await worker.fetch(new Request('https://evil.example/'), env)).status, 404);
});

test('session store holds only ciphertext; account name is escaped', async () => {
  const env = makeEnv();
  const s = await signIn(env, 'acct-x', { name: '<img src=x onerror=alert(1)>' });
  const [[key, val]] = Array.from(env.SESSIONS._m.entries());
  assert.match(key, /^s:[0-9a-f]{64}$/);
  assert.ok(!val.includes('access-token-test'));
  const html = await (await worker.fetch(get('/', s), env)).text();
  assert.ok(!html.includes('<img src=x'));
  assert.match(html, /&lt;img src=x/);
});

test('OAuth start: PKCE S256, exact redirect URI, narrow scopes, sealed state cookie', async () => {
  const env = makeEnv();
  const r = await worker.fetch(get('/oauth/start'), env);
  assert.equal(r.status, 303);
  const loc = new URL(r.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, 'https://auth.buffer.com/auth');
  assert.equal(loc.searchParams.get('redirect_uri'), ORIGIN + '/oauth/callback');
  assert.equal(loc.searchParams.get('scope'), 'account:read posts:read posts:write');
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  const ck = r.headers.get('set-cookie');
  assert.match(ck, new RegExp('^' + OAUTH_COOKIE + '=[A-Za-z0-9_-]+; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$'));
  assert.ok(!ck.includes(loc.searchParams.get('state')));
});

async function startFlow(env) {
  const r = await worker.fetch(get('/oauth/start'), env);
  const loc = new URL(r.headers.get('location'));
  return { state: loc.searchParams.get('state'), challenge: loc.searchParams.get('code_challenge'), cookie: r.headers.get('set-cookie').split(';')[0] };
}
const callback = (f, extra) => new Request(ORIGIN + '/oauth/callback?code=abcdefgh123&state=' + f.state + (extra || ''), { headers: { cookie: f.cookie, 'cf-connecting-ip': '203.0.113.9' } });
const tokenAndAccount = (id) => (u) => {
  if (u === 'https://auth.buffer.com/token') return jsonRes({ access_token: 'tok-' + Math.random(), token_type: 'Bearer', expires_in: 3600, scope: 'account:read posts:read posts:write' });
  if (u === 'https://api.buffer.com') return jsonRes({ data: { account: { id: id || 'acc-1', name: 'Swift', timezone: 'UTC', organizations: [{ id: 'org1', name: 'Org' }] } } }, 200, RATE(100, 500));
  return jsonRes({}, 404);
};

test('OAuth callback: refuses missing cookie, wrong state, forged state; no token request', async () => {
  const env = makeEnv();
  const f = await startFlow(env);
  mockFetch(() => jsonRes({}));
  let r = await worker.fetch(new Request(ORIGIN + '/oauth/callback?code=abcdefgh123&state=' + f.state), env);
  assert.equal(r.status, 400);
  r = await worker.fetch(new Request(ORIGIN + '/oauth/callback?code=abcdefgh123&state=' + f.state + 'x', { headers: { cookie: f.cookie } }), env);
  assert.equal(r.status, 403);
  const other = await startFlow(env);
  r = await worker.fetch(new Request(ORIGIN + '/oauth/callback?code=abcdefgh123&state=' + other.state, { headers: { cookie: f.cookie } }), env);
  assert.equal(r.status, 403);
  assert.equal(calls.length, 0);
});

test('OAuth callback: code + verifier + secret exchanged; a second sign-in of the same account replaces the first', async () => {
  const env = makeEnv();
  const f1 = await startFlow(env);
  mockFetch(tokenAndAccount('acc-1'));
  const r1 = await worker.fetch(callback(f1), env);
  assert.equal(r1.status, 303);
  const tokenCall = new URLSearchParams(calls[0].body);
  assert.equal(tokenCall.get('client_secret'), 'client-secret-test');
  assert.equal(b64url(await sha256(tokenCall.get('code_verifier'))), f1.challenge);
  const sid1 = r1.headers.getSetCookie().find((c) => c.startsWith(SESSION_COOKIE + '=')).split(';')[0];
  assert.equal(env.SESSIONS._m.size, 1);
  assert.equal((await (await worker.fetch(new Request(ORIGIN + '/', { headers: { cookie: sid1 } }), env)).text()).includes('id="queue"'), true);

  const f2 = await startFlow(env);
  mockFetch(tokenAndAccount('acc-1'));
  const r2 = await worker.fetch(callback(f2), env);
  assert.equal(r2.status, 303);
  assert.equal(env.SESSIONS._m.size, 1, 'the old session record was deleted');
  const page = await (await worker.fetch(new Request(ORIGIN + '/', { headers: { cookie: sid1 } }), env)).text();
  assert.ok(!page.includes('id="queue"'), 'the replaced session no longer opens the app');
  const sid2 = r2.headers.getSetCookie().find((c) => c.startsWith(SESSION_COOKIE + '=')).split(';')[0];
  assert.ok((await (await worker.fetch(new Request(ORIGIN + '/', { headers: { cookie: sid2 } }), env)).text()).includes('id="queue"'));

  /* a different account keeps its own session */
  const f3 = await startFlow(env);
  mockFetch(tokenAndAccount('acc-2'));
  await worker.fetch(callback(f3), env);
  assert.equal(env.SESSIONS._m.size, 2);
});

test('OAuth callback is refused when the app allowance is nearly gone (before spending a Buffer call)', async () => {
  const env = makeEnv();
  await env.GATE.obj.core.record({ '15m': { name: '15m', r: 4, t: 600, w: 900 } });
  const f = await startFlow(env);
  mockFetch(tokenAndAccount('acc-1'));
  const r = await worker.fetch(callback(f), env);
  assert.equal(r.status, 429);
  assert.equal(calls.length, 0);
});

test('POST guards: per-IP limit runs before the session lookup; origin, session and CSRF required', async () => {
  const env = makeEnv();
  const s = await signIn(env);
  let gets = 0;
  const realGet = env.SESSIONS.get;
  env.SESSIONS.get = async (k) => { gets++; return realGet(k); };
  for (let i = 0; i < 120; i++) await worker.fetch(post('/api/nothing', null, {}, { 'cf-connecting-ip': '192.0.2.50' }), env);
  const before = gets;
  const r = await worker.fetch(post('/api/scan', s, {}, { 'cf-connecting-ip': '192.0.2.50' }), env);
  assert.equal(r.status, 429);
  assert.equal(gets, before, 'no session lookup once the IP is over its limit');
  assert.equal((await worker.fetch(get('/', s, '192.0.2.50'), env)).status, 429);
  assert.equal((await worker.fetch(post('/api/scan', s, {}, { origin: 'https://evil.example' }), env)).status, 403);
  assert.equal((await worker.fetch(post('/api/scan', null, {}), env)).status, 401);
  assert.equal((await worker.fetch(post('/api/scan', s, {}, { 'x-csrf-token': 'wrong' }), env)).status, 403);
  assert.equal((await worker.fetch(post('/api/scan', s, 'x'.repeat(70000)), env)).status, 400);
  assert.equal((await worker.fetch(post('/api/scan', s, '{bad json'), env)).status, 400);
  assert.equal(bufferCalls().length, 0);
});

test('scan: one Buffer call, raw posts with post tokens, signed links; checks are left to the browser', async () => {
  const env = makeEnv();
  const s = await signIn(env);
  const j = await scanned(env, s, POST_NODE());
  assert.equal(bufferCalls().length, 1);
  assert.equal(bufferCalls()[0].headers.authorization, 'Bearer access-token-test');
  assert.equal(j.posts.length, 1);
  assert.equal(j.posts[0].flags, undefined);
  assert.match(j.posts[0].ptok, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(j.links[0].url, 'https://example.net/a');
  assert.ok(Number.isFinite(j.ts));
});

test('scan budget: one per minute per account, Buffer is not called for a refused scan; at most 3 calls per scan', async () => {
  const env = makeEnv();
  const s = await signIn(env);
  await scanned(env, s, POST_NODE());
  mockFetch(() => jsonRes(scanData([POST_NODE()], true), 200, RATE(100, 500)));
  let r = await worker.fetch(post('/api/scan', s, {}), env);
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error, 'scan_gap');
  assert.equal(bufferCalls().length, 0);
  /* a minute later a long queue costs at most 3 Buffer calls */
  const core = env.GATE.obj.core; const t = Date.now(); core.now = () => t + 61000;
  r = await worker.fetch(post('/api/scan', s, {}), env);
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(bufferCalls().length, 3);
  assert.equal(j.truncated, true);
  /* daily budget */
  const a = await core.account(s.acct); a.scans = 20; a.lastScan = 0; await core.saveAccount(s.acct, a);
  core.now = () => t + 200000;
  r = await worker.fetch(post('/api/scan', s, {}), env);
  assert.equal((await r.json()).error, 'scan_budget');
});

test('app-wide allowance: Buffer headers feed the gate; scans and fixes stop below the margin', async () => {
  const env = makeEnv();
  const a = await signIn(env, 'acct-a');
  mockFetch(() => jsonRes(scanData([POST_NODE()]), 200, RATE(22, 400)));
  assert.equal((await worker.fetch(post('/api/scan', a, {}), env)).status, 200);
  const b = await signIn(env, 'acct-b');
  mockFetch(() => jsonRes(scanData([POST_NODE()]), 200, RATE(100, 500)));
  const r = await worker.fetch(post('/api/scan', b, {}), env);
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error, 'app_busy');
  assert.equal(bufferCalls().length, 0);
  await env.GATE.obj.core.record({ '15m': { name: '15m', r: 100, t: 600, w: 900 }, '24h': { name: '24h', r: 140, t: 8000, w: 86400 } });
  assert.equal((await (await worker.fetch(post('/api/scan', b, {}), env)).json()).error, 'app_busy_day');
});

test('links: signed, deduplicated, expiring, one check per URL per minute, bare IPs flagged without a request', async () => {
  const env = makeEnv();
  const s = await signIn(env);
  const j = await scanned(env, s, POST_NODE({ text: 'a https://example.net/a b http://8.8.8.8/x c http://127.0.0.1/admin' }));
  const byUrl = Object.fromEntries(j.links.map((l) => [l.url, l]));
  let fetched = [];
  mockFetch((u, body, init) => {
    if (u.startsWith('https://cloudflare-dns.com/')) return jsonRes({ Status: 0, Answer: u.endsWith('type=A') ? [{ type: 1, data: '93.184.215.14' }] : [] });
    fetched.push(init.method + ' ' + u);
    return new Response(null, { status: 404 });
  });
  const one = byUrl['https://example.net/a'];
  let r = await worker.fetch(post('/api/links', s, { ts: j.ts, items: [one, one, one, one, one, one] }), env);
  let res = (await r.json()).results;
  assert.equal(res.length, 1, 'duplicates in a batch are checked once');
  assert.equal(res[0].flag.id, 'links.not_found');
  assert.deepEqual(fetched, ['HEAD https://example.net/a']);
  r = await worker.fetch(post('/api/links', s, { ts: j.ts, items: [one] }), env);
  assert.equal((await r.json()).results[0].skipped, 'recent');
  assert.equal(fetched.length, 1, 'no second request within a minute');
  r = await worker.fetch(post('/api/links', s, { ts: j.ts, items: [byUrl['http://8.8.8.8/x'], byUrl['http://127.0.0.1/admin']] }), env);
  res = (await r.json()).results;
  assert.deepEqual(res.map((x) => x.flag.id).sort(), ['links.ip', 'links.private']);
  assert.equal(fetched.length, 1, 'IP links are never fetched');
  assert.equal((await worker.fetch(post('/api/links', s, { ts: j.ts - 11 * 60000, items: [one] }), env)).status, 410);
  r = await worker.fetch(post('/api/links', s, { ts: j.ts, items: [{ url: 'http://169.254.169.254/latest/meta-data/', sig: one.sig }] }), env);
  assert.equal((await r.json()).results[0].error, 'unsigned');
});

test('links: per-site limit across all users', async () => {
  const env = makeEnv();
  const core = env.GATE.obj.core;
  const items = Array.from({ length: 25 }, (_, i) => ({ h: 'h' + i, site: 'victim.example' }));
  const acctA = await signIn(env, 'acct-a'); const acctB = await signIn(env, 'acct-b');
  const r1 = await core.admitLinks(acctA.acct, acctA.sk, items.slice(0, 10));
  const r2 = await core.admitLinks(acctB.acct, acctB.sk, items.slice(10, 20));
  const r3 = await core.admitLinks(acctB.acct, acctB.sk, items.slice(20, 25));
  assert.equal([...r1.results, ...r2.results].filter((x) => x === 'ok').length, 20);
  assert.deepEqual(r3.results, ['site', 'site', 'site', 'site', 'site']);
});

test('Buffer 401 ends the session; 429 is passed on with Retry-After', async () => {
  const env = makeEnv();
  let s = await signIn(env, 'acct-a');
  mockFetch(() => new Response('{}', { status: 401 }));
  let r = await worker.fetch(post('/api/scan', s, {}), env);
  assert.equal(r.status, 401);
  assert.equal(env.SESSIONS._m.size, 0);
  s = await signIn(env, 'acct-b');
  mockFetch(() => new Response('{}', { status: 429, headers: { 'retry-after': '120' } }));
  r = await worker.fetch(post('/api/scan', s, {}), env);
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '120');
});

/* ---------- fixes ---------- */
async function fixSetup(node, mutationResult) {
  const env = makeEnv();
  const s = await signIn(env);
  const j = await scanned(env, s, node);
  const p = j.posts[0];
  mockFetch((u, body) => {
    const q = JSON.parse(body);
    if (/query One/.test(q.query)) return jsonRes({ data: { post: node } }, 200, RATE(90, 450));
    return jsonRes({ data: mutationResult || { editPost: { __typename: 'PostActionSuccess', post: Object.assign({}, node, { text: q.variables.text || node.text, status: /saveToDraft/.test(q.query) ? 'draft' : node.status }) } } }, 200, RATE(89, 449));
  });
  const base = { postId: p.id, ts: j.ts, ptok: p.ptok, expectedHash: await sha256hex(node.text), confirm: true };
  return { env, s, base };
}
const mutations = () => calls.map((c) => (c.body ? JSON.parse(c.body) : {})).filter((q) => /^mutation/.test(q.query || ''));

test('fix: an id this session never scanned costs no Buffer call', async () => {
  const { env, s, base } = await fixSetup(POST_NODE());
  for (const b of [Object.assign({}, base, { postId: 'otherpost99' }), Object.assign({}, base, { ptok: 'A'.repeat(32) }), Object.assign({}, base, { ts: base.ts - 2 * 3600e3 }), Object.assign({}, base, { ptok: undefined })]) {
    const r = await worker.fetch(post('/api/fix', s, Object.assign(b, { action: 'draft' })), env);
    assert.equal(r.status, 403);
  }
  assert.equal(bufferCalls().length, 0);
});

test('fix edit: confirm and the scanned version are required; only id and text are sent; the full post comes back', async () => {
  const node = POST_NODE();
  const { env, s, base } = await fixSetup(node);
  let r = await worker.fetch(post('/api/fix', s, Object.assign({}, base, { action: 'edit', text: 'Hello world', confirm: false })), env);
  assert.equal(r.status, 400);
  r = await worker.fetch(post('/api/fix', s, Object.assign({}, base, { action: 'edit', text: 'Hello world', expectedHash: 'f'.repeat(64) })), env);
  assert.equal(r.status, 409);
  r = await worker.fetch(post('/api/fix', s, Object.assign({}, base, { action: 'delete' })), env);
  assert.equal(r.status, 400);
  r = await worker.fetch(post('/api/fix', s, Object.assign({}, base, { action: 'edit', text: 'bad\u0000text' })), env);
  assert.equal(r.status, 400);
  assert.equal(mutations().length, 0);
  calls = [];
  r = await worker.fetch(post('/api/fix', s, Object.assign({}, base, { action: 'edit', text: 'Hello world https://example.net/new\r\n' })), env);
  assert.equal(r.status, 200);
  const m = mutations();
  assert.equal(m.length, 1);
  assert.match(m[0].query, /editPost\(input: \{ id: \$id, text: \$text \}\)/);
  assert.deepEqual(m[0].variables, { id: node.id, text: 'Hello world https://example.net/new\n' });
  assert.ok(!/shareNow|shareNext|addToQueue|deletePost|publish/.test(m[0].query));
  const j = await r.json();
  assert.equal(j.post.text, 'Hello world https://example.net/new\n');
  assert.match(j.post.ptok, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(j.links[0].url, 'https://example.net/new');
});

test('fix guards: threads, posts about to go out, sent posts, actions Buffer does not allow', async () => {
  for (const [node, action, code] of [
    [POST_NODE({ metadata: { __typename: 'BlueskyPostMetadata', threadCount: 2, thread: [{ text: 'a', assets: [] }, { text: 'b', assets: [] }] } }), 'edit', 409],
    [POST_NODE({ dueAt: new Date(Date.now() + 60000).toISOString() }), 'draft', 409],
    [POST_NODE({ status: 'sent' }), 'draft', 409],
    [POST_NODE({ allowedActions: ['viewPost'] }), 'edit', 403],
    [POST_NODE(), 'move', 409]
  ]) {
    const { env, s, base } = await fixSetup(node);
    const r = await worker.fetch(post('/api/fix', s, Object.assign({}, base, { action, text: 'x', position: 'bottom' })), env);
    assert.equal(r.status, code, action + ' ' + node.status);
    assert.equal(mutations().length, 0);
  }
});

test('fix draft sends the checked text with saveToDraft; move works for queue-slot posts', async () => {
  let { env, s, base } = await fixSetup(POST_NODE());
  let r = await worker.fetch(post('/api/fix', s, Object.assign({}, base, { action: 'draft' })), env);
  assert.equal(r.status, 200);
  assert.match(mutations()[0].query, /saveToDraft: true/);
  assert.equal((await r.json()).post.status, 'draft');
  const qnode = POST_NODE({ isCustomScheduled: false, shareMode: 'addToQueue' });
  ({ env, s, base } = await fixSetup(qnode, { movePostInQueue: { __typename: 'PostActionSuccess', post: qnode } }));
  r = await worker.fetch(post('/api/fix', s, Object.assign({}, base, { action: 'move', position: 'sideways' })), env);
  assert.equal(r.status, 400);
  r = await worker.fetch(post('/api/fix', s, Object.assign({}, base, { action: 'move', position: 'bottom' })), env);
  assert.equal(r.status, 200);
  assert.deepEqual(mutations()[0].variables, { id: qnode.id, position: 'bottom' });
});

test('fix budgets: 10 a minute and 40 a day per account', async () => {
  const { env, s, base } = await fixSetup(POST_NODE());
  const codes = [];
  for (let i = 0; i < 12; i++) codes.push((await worker.fetch(post('/api/fix', s, Object.assign({}, base, { action: 'draft' })), env)).status);
  assert.deepEqual(codes.slice(10), [429, 429]);
  const core = env.GATE.obj.core;
  const a = await core.account(s.acct); a.fixes = 40; await core.saveAccount(s.acct, a);
  core.minute.clear();
  const r = await worker.fetch(post('/api/fix', s, Object.assign({}, base, { action: 'draft' })), env);
  assert.equal((await r.json()).error, 'fix_budget');
});

test('fix: a Buffer refusal is reported, not hidden', async () => {
  const node = POST_NODE();
  const { env, s, base } = await fixSetup(node, { editPost: { __typename: 'InvalidInputError', message: 'Bluesky posts cannot exceed 300 characters.' } });
  const r = await worker.fetch(post('/api/fix', s, Object.assign({}, base, { action: 'edit', text: 'x' })), env);
  assert.equal(r.status, 422);
  assert.match((await r.json()).message, /cannot exceed 300/);
});

test('disconnect deletes the session, unregisters it and clears the cookie', async () => {
  const env = makeEnv();
  const s = await signIn(env);
  const r = await worker.fetch(post('/api/disconnect', s, {}), env);
  assert.equal(r.status, 200);
  assert.equal(env.SESSIONS._m.size, 0);
  assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await env.GATE.obj.core.current(s.acct, s.sk)).ok, false);
  assert.equal((await worker.fetch(post('/api/scan', s, {}), env)).status, 401);
});

test('disconnect answers at once even when the store delete is slow; the session is refused immediately', async () => {
  const env = makeEnv();
  const s = await signIn(env);
  let release;
  const realDelete = env.SESSIONS.delete;
  env.SESSIONS.delete = (k) => new Promise((res) => { release = () => res(realDelete(k)); });
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const r = await worker.fetch(post('/api/disconnect', s, {}), env, ctx);
  assert.equal(r.status, 200);
  assert.equal(pending.length, 1, 'the delete runs after the reply');
  assert.equal(env.SESSIONS._m.size, 1, 'not deleted yet');
  assert.equal((await worker.fetch(post('/api/scan', s, {}), env, ctx)).status, 401, 'but already refused');
  release();
  await Promise.all(pending);
  assert.equal(env.SESSIONS._m.size, 0);
});
