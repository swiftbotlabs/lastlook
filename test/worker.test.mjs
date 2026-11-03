/* Worker routes and security: OAuth state, sessions, CSRF, origin, input caps, and the guards on every fix.
   Buffer and the token endpoint are mocked through globalThis.fetch. */
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { sha256hex, createSession, SESSION_COOKIE, OAUTH_COOKIE } from '../src/session.js';

const ORIGIN = 'https://lastlook.swiftbotlab.workers.dev';
function kv() { const m = new Map(); return { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); }, _m: m }; }
function makeEnv() { return { SESSIONS: kv(), SESSION_SECRET: 's'.repeat(32) + 'secret-for-tests', BUFFER_CLIENT_ID: 'client-id-test', BUFFER_CLIENT_SECRET: 'client-secret-test' }; }

let calls = [];
let bufferHandler = null;
const realFetch = globalThis.fetch;
function mockFetch(handler) {
  calls = [];
  bufferHandler = handler;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const body = init && init.body ? String(init.body) : '';
    calls.push({ url: u, body, headers: init && init.headers });
    return handler(u, body, init);
  };
}
test.after(() => { globalThis.fetch = realFetch; });
const jsonRes = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });

async function session(env, extra) {
  const { sid, record } = await createSession(env, Object.assign({ at: 'access-token-test', orgs: [{ id: 'org1', name: 'Org' }], name: 'Tester', canWrite: true }, extra || {}), 3600);
  return { sid, csrf: record.csrf, cookie: SESSION_COOKIE + '=' + sid };
}
function post(path, s, body, headers) {
  return new Request(ORIGIN + path, {
    method: 'POST',
    headers: Object.assign({ origin: ORIGIN, 'content-type': 'application/json', cookie: s ? s.cookie : '', 'x-csrf-token': s ? s.csrf : '' }, headers || {}),
    body: typeof body === 'string' ? body : JSON.stringify(body || {})
  });
}
const POST_NODE = (over) => Object.assign({ id: 'post123456', channelId: 'chan123456', channelService: 'bluesky', status: 'scheduled', dueAt: new Date(Date.now() + 20 * 864e5).toISOString(), createdAt: new Date().toISOString(), shareMode: 'customScheduled', isCustomScheduled: true, text: 'Hello **world**', allowedActions: ['updatePost', 'movePostToDraft'], assets: [], metadata: { __typename: 'BlueskyPostMetadata', threadCount: 1, thread: [{ text: 'Hello **world**', assets: [] }] } }, over || {});

test('pages: landing for visitors, app shell only with a session, security headers everywhere', async () => {
  const env = makeEnv();
  let r = await worker.fetch(new Request(ORIGIN + '/'), env);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Connect Buffer/);
  for (const h of ['content-security-policy', 'x-content-type-options', 'referrer-policy', 'strict-transport-security', 'x-frame-options']) assert.ok(r.headers.get(h), h);
  const s = await session(env);
  r = await worker.fetch(new Request(ORIGIN + '/', { headers: { cookie: s.cookie } }), env);
  const html = await r.text();
  assert.match(html, /<meta name="csrf" content="/);
  assert.match(html, /Connected as Tester/);
  for (const p of ['/privacy', '/about']) assert.equal((await worker.fetch(new Request(ORIGIN + p), env)).status, 200);
  assert.equal((await worker.fetch(new Request(ORIGIN + '/nope'), env)).status, 404);
  assert.equal((await worker.fetch(new Request('https://evil.example/'), env)).status, 404);
});

test('session store holds only ciphertext', async () => {
  const env = makeEnv();
  await session(env);
  const [[key, val]] = Array.from(env.SESSIONS._m.entries());
  assert.match(key, /^s:[0-9a-f]{64}$/);
  assert.ok(!val.includes('access-token-test'));
  assert.ok(!Buffer.from(val, 'base64url').toString('latin1').includes('access-token-test'));
});

test('account name is escaped in the app shell', async () => {
  const env = makeEnv();
  const s = await session(env, { name: '<img src=x onerror=alert(1)>' });
  const html = await (await worker.fetch(new Request(ORIGIN + '/', { headers: { cookie: s.cookie } }), env)).text();
  assert.ok(!html.includes('<img src=x'));
  assert.match(html, /&lt;img src=x/);
});

test('OAuth start: PKCE S256, exact redirect URI, narrow scopes, sealed state cookie', async () => {
  const env = makeEnv();
  const r = await worker.fetch(new Request(ORIGIN + '/oauth/start'), env);
  assert.equal(r.status, 303);
  const loc = new URL(r.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, 'https://auth.buffer.com/auth');
  assert.equal(loc.searchParams.get('redirect_uri'), ORIGIN + '/oauth/callback');
  assert.equal(loc.searchParams.get('scope'), 'account:read posts:read posts:write');
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  assert.match(loc.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  const ck = r.headers.get('set-cookie');
  assert.match(ck, new RegExp('^' + OAUTH_COOKIE + '=[A-Za-z0-9_-]+; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$'));
  assert.ok(!ck.includes(loc.searchParams.get('state')), 'state is sealed, not stored in clear');
});

async function startFlow(env) {
  const r = await worker.fetch(new Request(ORIGIN + '/oauth/start'), env);
  const loc = new URL(r.headers.get('location'));
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return { state: loc.searchParams.get('state'), challenge: loc.searchParams.get('code_challenge'), cookie };
}

test('OAuth callback: refuses a missing cookie, a wrong state and a forged state', async () => {
  const env = makeEnv();
  mockFetch(() => jsonRes({}));
  const f = await startFlow(env);
  let r = await worker.fetch(new Request(ORIGIN + '/oauth/callback?code=abcdefgh123&state=' + f.state), env);
  assert.equal(r.status, 400);
  r = await worker.fetch(new Request(ORIGIN + '/oauth/callback?code=abcdefgh123&state=' + f.state + 'x', { headers: { cookie: f.cookie } }), env);
  assert.equal(r.status, 403);
  const other = await startFlow(env);
  r = await worker.fetch(new Request(ORIGIN + '/oauth/callback?code=abcdefgh123&state=' + other.state, { headers: { cookie: f.cookie } }), env);
  assert.equal(r.status, 403);
  r = await worker.fetch(new Request(ORIGIN + '/oauth/callback?error=access_denied&state=' + f.state, { headers: { cookie: f.cookie } }), env);
  assert.equal(r.status, 400);
  assert.match(await r.text(), /cancelled/);
  assert.equal(calls.length, 0, 'no token request on any refused callback');
});

test('OAuth callback: exchanges the code with the verifier and secret, then opens a session', async () => {
  const env = makeEnv();
  const f = await startFlow(env);
  mockFetch((u, body) => {
    if (u === 'https://auth.buffer.com/token') return jsonRes({ access_token: 'tok-abc', token_type: 'Bearer', expires_in: 3600, scope: 'account:read posts:read posts:write' });
    if (u === 'https://api.buffer.com') return jsonRes({ data: { account: { id: 'acc', name: 'Swift', timezone: 'UTC', organizations: [{ id: 'org1', name: 'Org' }] } } });
    return jsonRes({}, 404);
  });
  const r = await worker.fetch(new Request(ORIGIN + '/oauth/callback?code=abcdefgh123&state=' + f.state, { headers: { cookie: f.cookie } }), env);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/');
  const tokenCall = new URLSearchParams(calls[0].body);
  assert.equal(tokenCall.get('grant_type'), 'authorization_code');
  assert.equal(tokenCall.get('client_secret'), 'client-secret-test');
  assert.equal(tokenCall.get('redirect_uri'), ORIGIN + '/oauth/callback');
  const verifier = tokenCall.get('code_verifier');
  const { b64url, sha256 } = await import('../src/session.js');
  assert.equal(b64url(await sha256(verifier)), f.challenge, 'verifier matches the challenge sent to Buffer');
  assert.match(calls[1].headers.authorization, /^Bearer tok-abc$/);
  const cookies = r.headers.getSetCookie();
  assert.ok(cookies.some((c) => c.startsWith(SESSION_COOKIE + '=') && /HttpOnly/.test(c) && /Secure/.test(c)));
  assert.ok(cookies.some((c) => c.startsWith(OAUTH_COOKIE + '=;')));
  assert.equal(env.SESSIONS._m.size, 1);
  assert.ok(!Array.from(env.SESSIONS._m.values())[0].includes('tok-abc'));
});

test('POST guards: origin, session and CSRF are all required', async () => {
  const env = makeEnv();
  const s = await session(env);
  mockFetch(() => jsonRes({ data: {} }));
  assert.equal((await worker.fetch(post('/api/scan', s, {}, { origin: 'https://evil.example' }), env)).status, 403);
  assert.equal((await worker.fetch(post('/api/scan', s, {}, { origin: '' }), env)).status, 403);
  assert.equal((await worker.fetch(post('/api/scan', null, {}), env)).status, 401);
  assert.equal((await worker.fetch(post('/api/scan', s, {}, { 'x-csrf-token': 'wrong' }), env)).status, 403);
  assert.equal((await worker.fetch(post('/api/scan', s, 'x'.repeat(70000)), env)).status, 400);
  assert.equal((await worker.fetch(post('/api/scan', s, '{bad json'), env)).status, 400);
  assert.equal((await worker.fetch(post('/api/scan', s, {}, { 'content-type': 'text/plain' }), env)).status, 400);
  assert.equal((await worker.fetch(new Request(ORIGIN + '/api/scan', { method: 'PUT' }), env)).status, 405);
  assert.equal(calls.length, 0, 'Buffer was never called');
});

test('scan: reads through the user token, runs checks, signs links', async () => {
  const env = makeEnv();
  const s = await session(env);
  mockFetch((u, body) => {
    const q = JSON.parse(body);
    assert.match(q.query, /posts\(first: \$first/);
    return jsonRes({ data: {
      channels: [{ id: 'chan123456', name: 'SBL', service: 'bluesky', timezone: 'UTC', avatar: 'https://cdn.example/a.png', metadata: { __typename: 'BlueskyMetadata' } }],
      posts: { pageInfo: { hasNextPage: false }, edges: [{ node: POST_NODE({ text: 'See https://example.net/x **now**' }) }] }
    } });
  });
  const r = await worker.fetch(post('/api/scan', s, {}), env);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.posts.length, 1);
  assert.ok(j.posts[0].flags.some((f) => f.check === 'format'));
  assert.equal(j.links[0].url, 'https://example.net/x');
  assert.match(j.links[0].sig, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(calls[0].headers.authorization, 'Bearer access-token-test');
});

test('links: only server-signed links are checked', async () => {
  const env = makeEnv();
  const s = await session(env);
  mockFetch(() => jsonRes({}));
  const r = await worker.fetch(post('/api/links', s, { items: [{ url: 'http://169.254.169.254/latest/meta-data/', sig: 'A'.repeat(32) }] }), env);
  const j = await r.json();
  assert.equal(j.results[0].error, 'unsigned');
  assert.equal(calls.length, 0);
});

test('Buffer 401 ends the session; 429 is passed on with Retry-After', async () => {
  const env = makeEnv();
  let s = await session(env);
  mockFetch(() => new Response('{}', { status: 401 }));
  let r = await worker.fetch(post('/api/scan', s, {}), env);
  assert.equal(r.status, 401);
  assert.equal(env.SESSIONS._m.size, 0);
  s = await session(env);
  mockFetch(() => new Response('{}', { status: 429, headers: { 'retry-after': '120' } }));
  r = await worker.fetch(post('/api/scan', s, {}), env);
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '120');
});

async function fixEnv(node, mutationResult) {
  const env = makeEnv();
  const s = await session(env);
  mockFetch((u, body) => {
    const q = JSON.parse(body);
    if (/query One/.test(q.query)) return jsonRes({ data: { post: node } });
    return jsonRes({ data: mutationResult || { editPost: { __typename: 'PostActionSuccess', post: { id: node.id, status: 'scheduled', dueAt: node.dueAt, shareMode: node.shareMode } } } });
  });
  return { env, s };
}
const mutations = () => calls.map((c) => JSON.parse(c.body)).filter((q) => /^mutation/.test(q.query));

test('fix edit: needs confirm and the scanned version; sends only id and text', async () => {
  const node = POST_NODE();
  const { env, s } = await fixEnv(node);
  const hash = await sha256hex(node.text);
  let r = await worker.fetch(post('/api/fix', s, { postId: node.id, action: 'edit', text: 'Hello world', expectedHash: hash }), env);
  assert.equal(r.status, 400, 'no confirm');
  r = await worker.fetch(post('/api/fix', s, { postId: node.id, action: 'edit', text: 'Hello world', expectedHash: 'f'.repeat(64), confirm: true }), env);
  assert.equal(r.status, 409, 'changed since scan');
  r = await worker.fetch(post('/api/fix', s, { postId: '../x', action: 'edit', text: 'a', expectedHash: hash, confirm: true }), env);
  assert.equal(r.status, 400, 'bad id');
  r = await worker.fetch(post('/api/fix', s, { postId: node.id, action: 'delete', expectedHash: hash, confirm: true }), env);
  assert.equal(r.status, 400, 'no delete action exists');
  r = await worker.fetch(post('/api/fix', s, { postId: node.id, action: 'edit', text: 'bad\u0000text', expectedHash: hash, confirm: true }), env);
  assert.equal(r.status, 400, 'control chars');
  r = await worker.fetch(post('/api/fix', s, { postId: node.id, action: 'edit', text: '   ', expectedHash: hash, confirm: true }), env);
  assert.equal(r.status, 400, 'empty');
  assert.equal(mutations().length, 0, 'nothing written by refused requests');
  r = await worker.fetch(post('/api/fix', s, { postId: node.id, action: 'edit', text: 'Hello world\r\n', expectedHash: hash, confirm: true }), env);
  assert.equal(r.status, 200);
  const m = mutations();
  assert.equal(m.length, 1);
  assert.match(m[0].query, /editPost\(input: \{ id: \$id, text: \$text \}\)/);
  assert.deepEqual(m[0].variables, { id: node.id, text: 'Hello world\n' });
  assert.ok(!/shareNow|shareNext|addToQueue|deletePost|publish/.test(m[0].query));
});

test('fix guards: threads, posts about to go out, sent posts', async () => {
  let node = POST_NODE({ metadata: { __typename: 'BlueskyPostMetadata', threadCount: 2, thread: [{ text: 'Hello **world**', assets: [] }, { text: 'two', assets: [] }] } });
  let { env, s } = await fixEnv(node);
  const hash = await sha256hex(node.text);
  assert.equal((await worker.fetch(post('/api/fix', s, { postId: node.id, action: 'edit', text: 'x', expectedHash: hash, confirm: true }), env)).status, 409);
  node = POST_NODE({ dueAt: new Date(Date.now() + 60000).toISOString() });
  ({ env, s } = await fixEnv(node));
  assert.equal((await worker.fetch(post('/api/fix', s, { postId: node.id, action: 'draft', expectedHash: hash, confirm: true }), env)).status, 409);
  node = POST_NODE({ status: 'sent' });
  ({ env, s } = await fixEnv(node));
  assert.equal((await worker.fetch(post('/api/fix', s, { postId: node.id, action: 'edit', text: 'x', expectedHash: hash, confirm: true }), env)).status, 409);
  assert.equal((await worker.fetch(post('/api/fix', s, { postId: node.id, action: 'draft', expectedHash: hash, confirm: true }), env)).status, 409);
  node = POST_NODE({ allowedActions: ['viewPost'] });
  ({ env, s } = await fixEnv(node));
  assert.equal((await worker.fetch(post('/api/fix', s, { postId: node.id, action: 'edit', text: 'x', expectedHash: hash, confirm: true }), env)).status, 403);
  assert.equal(mutations().length, 0);
});

test('fix draft sends the checked text with saveToDraft; move only for queue-slot posts', async () => {
  let node = POST_NODE();
  let { env, s } = await fixEnv(node);
  const hash = await sha256hex(node.text);
  let r = await worker.fetch(post('/api/fix', s, { postId: node.id, action: 'draft', expectedHash: hash, confirm: true }), env);
  assert.equal(r.status, 200);
  assert.deepEqual(mutations()[0].variables, { id: node.id, text: node.text });
  assert.match(mutations()[0].query, /saveToDraft: true/);
  r = await worker.fetch(post('/api/fix', s, { postId: node.id, action: 'move', position: 'bottom', expectedHash: hash, confirm: true }), env);
  assert.equal(r.status, 409, 'custom-time post is not moved');
  node = POST_NODE({ isCustomScheduled: false, shareMode: 'addToQueue' });
  ({ env, s } = await fixEnv(node, { movePostInQueue: { __typename: 'PostActionSuccess', post: { id: 'post123456', status: 'scheduled', dueAt: node.dueAt } } }));
  r = await worker.fetch(post('/api/fix', s, { postId: node.id, action: 'move', position: 'sideways', expectedHash: hash, confirm: true }), env);
  assert.equal(r.status, 400);
  r = await worker.fetch(post('/api/fix', s, { postId: node.id, action: 'move', position: 'bottom', expectedHash: hash, confirm: true }), env);
  assert.equal(r.status, 200);
  assert.deepEqual(mutations()[0].variables, { id: node.id, position: 'bottom' });
});

test('fix: a Buffer refusal is reported, not hidden', async () => {
  const node = POST_NODE();
  const { env, s } = await fixEnv(node, { editPost: { __typename: 'InvalidInputError', message: 'Bluesky posts cannot exceed 300 characters.' } });
  const r = await worker.fetch(post('/api/fix', s, { postId: node.id, action: 'edit', text: 'x', expectedHash: await sha256hex(node.text), confirm: true }), env);
  assert.equal(r.status, 422);
  assert.match((await r.json()).message, /cannot exceed 300/);
});

test('disconnect deletes the session and clears the cookie', async () => {
  const env = makeEnv();
  const s = await session(env);
  const r = await worker.fetch(post('/api/disconnect', s, {}), env);
  assert.equal(r.status, 200);
  assert.equal(env.SESSIONS._m.size, 0);
  assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await worker.fetch(post('/api/scan', s, {}), env)).status, 401);
});

test('per-session rate limit on scans', async () => {
  const env = makeEnv();
  const s = await session(env);
  mockFetch(() => jsonRes({ data: { channels: [], posts: { pageInfo: { hasNextPage: false }, edges: [] } } }));
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await worker.fetch(post('/api/scan', s, {}), env)).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 429, 429]);
});
