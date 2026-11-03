/* Review 2 fixes on the server: forged OAuth callbacks cost the app allowance nothing, each sign-in attempt is
   single-use, per-IP limits key on the /64 for IPv6, held calls lapse, and one per-account budget of real Buffer calls.
   Buffer and its token endpoint are mocked through globalThis.fetch; the gate is the real Gate class in memory. */
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { _resetLimits, ipBucket } from '../src/index.js';
import { GateCore, LIMITS } from '../src/gate.js';
import { SESSION_COOKIE } from '../src/session.js';
import { makeEnv, signIn, memStorage } from './fakes.mjs';

const ORIGIN = 'https://lastlook.swiftbotlab.workers.dev';
const realFetch = globalThis.fetch;
const realLog = console.log;
let n = { token: 0, api: 0 };
const jsonRes = (obj, status, headers) => new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}) });
const RATE = (r15, r24) => ({ ratelimit: '"15m"; r=' + r15 + '; t=600, "24h"; r=' + r24 + '; t=80000', 'ratelimit-policy': '"15m"; q=110; w=900, "24h"; q=525; w=86400' });
/* the token endpoint refuses every code (forged); api.buffer.com answers an empty queue */
function mock(token, api) {
  n = { token: 0, api: 0 };
  globalThis.fetch = async (u, init) => {
    if (String(u) === 'https://auth.buffer.com/token') { n.token++; return token ? token(init) : jsonRes({ error: 'invalid_grant' }, 400); }
    if (String(u) === 'https://api.buffer.com') { n.api++; return api ? api(init) : jsonRes({ data: { channels: [], posts: { pageInfo: { hasNextPage: false }, edges: [] } } }, 200, RATE(99, 499)); }
    return jsonRes({}, 404);
  };
}
test.beforeEach(() => { _resetLimits(); mock(); console.log = () => {}; });
test.after(() => { globalThis.fetch = realFetch; console.log = realLog; });

const get = (path, ip, cookie) => new Request(ORIGIN + path, { headers: { 'cf-connecting-ip': ip || '203.0.113.9', cookie: cookie || '' } });
async function start(env, ip) {
  const r = await worker.fetch(get('/oauth/start', ip), env);
  assert.equal(r.status, 303);
  return { state: new URL(r.headers.get('location')).searchParams.get('state'), cookie: r.headers.get('set-cookie').split(';')[0] };
}
const callback = (f, ip, code) => new Request(ORIGIN + '/oauth/callback?code=' + (code || 'AAAAAAAA') + '&state=' + encodeURIComponent(f.state), { headers: { cookie: f.cookie, 'cf-connecting-ip': ip || '203.0.113.9' } });
const scanReq = (s) => new Request(ORIGIN + '/api/scan', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: s.cookie, 'x-csrf-token': s.csrf, 'cf-connecting-ip': '198.51.100.7' }, body: '{}' });
const fresh64 = (i) => '2001:db8:' + (i + 1).toString(16) + '::1';
const left = (env) => [env.GATE.obj.core.remaining(900), env.GATE.obj.core.remaining(86400)];
const allowance = (env, r15, r24) => env.GATE.obj.core.record({ '15m': { name: '15m', r: r15, t: 600, w: 900 }, '24h': { name: '24h', r: r24, t: 80000, w: 86400 } });

test('forged callbacks (fake codes, each from a fresh /64) leave the app allowance unchanged; a signed-in scan still works', async () => {
  const env = makeEnv();
  await allowance(env, 100, 500);
  const N = 200;
  for (let i = 0; i < N; i++) {
    const r = await worker.fetch(callback(await start(env, fresh64(i)), fresh64(i)), env);
    assert.equal(r.status, 400);
  }
  assert.equal(n.token, N, 'each forged attempt reached the token endpoint once');
  assert.equal(n.api, 0);
  assert.deepEqual(left(env), [100, 500], 'nothing reserved, nothing held');
  /* the same with token replies that are not a usable token */
  for (const bad of [() => jsonRes({ token_type: 'Bearer' }), () => new Response('not json', { status: 200 }), () => jsonRes({ access_token: '' }), () => jsonRes({ access_token: 42 })]) {
    mock(bad);
    await worker.fetch(callback(await start(env, fresh64(900)), fresh64(900)), env);
    _resetLimits();
  }
  assert.deepEqual(left(env), [100, 500]);
  mock();
  const s = await signIn(env, 'victim');
  assert.equal((await worker.fetch(scanReq(s), env)).status, 200);
  assert.equal((await worker.fetch(get('/oauth/start', '198.51.100.8'), env)).status, 303);
});

test('a sign-in attempt is single-use: a second callback with the same state is refused before any token request', async () => {
  const env = makeEnv();
  const f = await start(env);
  assert.equal((await worker.fetch(callback(f, fresh64(1)), env)).status, 400);
  assert.equal(n.token, 1);
  for (let i = 0; i < 5; i++) {
    const r = await worker.fetch(callback(f, fresh64(10 + i)), env);
    assert.equal(r.status, 400);
    assert.match(await r.text(), /already used/);
  }
  assert.equal(n.token, 1, 'replays never reach the token endpoint');
  /* a successful sign-in cannot be replayed either */
  mock(() => jsonRes({ access_token: 'tok-real', token_type: 'Bearer', expires_in: 3600, scope: 'account:read posts:read posts:write' }),
    () => jsonRes({ data: { account: { id: 'acc-1', name: 'Swift', organizations: [{ id: 'org1', name: 'Org' }] } } }, 200, RATE(100, 500)));
  const g = await start(env);
  assert.equal((await worker.fetch(callback(g, fresh64(20), 'abcdefgh123'), env)).status, 303);
  assert.equal(env.SESSIONS._m.size, 1);
  const again = await worker.fetch(callback(g, fresh64(21), 'abcdefgh123'), env);
  assert.equal(again.status, 400);
  assert.equal(n.token, 1, 'the replayed success made no second token request');
  assert.equal(env.SESSIONS._m.size, 1);
  /* the record lasts the cookie's 10 minutes, across the gate's 10-minute slots */
  const core = env.GATE.obj.core;
  const h = 'ab'.repeat(16);
  const t0 = Math.ceil(Date.now() / LIMITS.nonceMs) * LIMITS.nonceMs - 1000;   /* one second before a slot boundary */
  core.now = () => t0;
  assert.equal((await core.useNonce(h)).ok, true);
  core.now = () => t0 + 9 * 60000;
  assert.equal((await core.useNonce(h)).code, 'replayed');
  assert.equal((await core.useNonce('nope')).ok, false);
});

test('sign-in order: nonce, peek, token exchange, then reserve, account query, record, bind', async () => {
  const env = makeEnv();
  const f = await start(env);
  env.GATE.ops.length = 0;
  await worker.fetch(callback(f, fresh64(1)), env);
  assert.deepEqual(env.GATE.ops, ['nonce', 'peek'], 'a forged code reserves nothing');
  mock(() => jsonRes({ access_token: 'tok-real', expires_in: 3600, scope: 'account:read posts:read posts:write' }),
    () => jsonRes({ data: { account: { id: 'acc-1', name: 'Swift', organizations: [{ id: 'org1', name: 'Org' }] } } }, 200, RATE(97, 480)));
  const g = await start(env);
  env.GATE.ops.length = 0;
  assert.equal((await worker.fetch(callback(g, fresh64(2), 'abcdefgh123'), env)).status, 303);
  assert.deepEqual(env.GATE.ops, ['nonce', 'peek', 'admit:signin', 'record', 'bind']);
  assert.deepEqual(left(env), [97, 480], 'the reservation is settled by the account query reply');
});

test('when the allowance runs out during the token exchange, the sign-in is refused before the account query', async () => {
  const env = makeEnv();
  await allowance(env, 100, 500);
  const f = await start(env);
  mock(async () => { await allowance(env, 4, 500); return jsonRes({ access_token: 'tok-real', expires_in: 3600 }); });
  const r = await worker.fetch(callback(f, fresh64(3), 'abcdefgh123'), env);
  assert.equal(r.status, 429);
  assert.match(await r.text(), /A short pause/);
  assert.equal(n.api, 0, 'no account query');
  assert.equal(env.SESSIONS._m.size, 0);
});

test('per-IP limits key on the address for IPv4 and on the /64 for IPv6', async () => {
  assert.equal(ipBucket('2001:db8:1:2:3:4:5:6'), '2001:0db8:0001:0002::/64');
  assert.equal(ipBucket('2001:DB8:1:2::ffff'), '2001:0db8:0001:0002::/64');
  assert.equal(ipBucket('::ffff:192.0.2.1'), '192.0.2.1');
  assert.equal(ipBucket('203.0.113.9'), '203.0.113.9');
  for (const bad of ['', null, 'junk', '1.2.3.4.5', 'x'.repeat(500)]) assert.equal(ipBucket(bad), 'unknown');
  const env = makeEnv();
  for (let i = 0; i < 10; i++) assert.equal((await worker.fetch(get('/oauth/start', '2001:db8:1:2::' + (i + 1).toString(16)), env)).status, 303);
  assert.equal((await worker.fetch(get('/oauth/start', '2001:db8:1:2:ffff:ffff:ffff:fffe'), env)).status, 429, 'another address in the same /64 shares the limit');
  const f = await start(env, '2001:db8:1:3::1');
  assert.equal((await worker.fetch(callback(f, '2001:db8:1:2::77'), env)).status, 429, 'the callback shares it too');
  assert.equal(n.token, 0);
  assert.equal((await worker.fetch(get('/oauth/start', '2001:db8:1:3::2'), env)).status, 303, 'the next /64 has its own');
  assert.equal((await worker.fetch(get('/oauth/start', '198.51.100.1'), env)).status, 303);
  /* pages and API calls: 120 a minute per /64 */
  for (let i = 0; i < 120; i++) await worker.fetch(get('/', '2001:db8:9:9::' + (i + 1).toString(16)), env);
  assert.equal((await worker.fetch(get('/', '2001:db8:9:9::abcd'), env)).status, 429);
  assert.equal((await worker.fetch(get('/', '2001:db8:9:a::1'), env)).status, 200);
});

function core(t0) { let t = t0 || Date.parse('2026-11-03T10:00:00Z'); const c = new GateCore(memStorage(), () => t); c.tick = (ms) => { t += ms; }; return c; }
const win = (r15, r24) => ({ a: { name: '15m', r: r15, t: 600, w: 900 }, b: { name: '24h', r: r24, t: 80000, w: 86400 } });

test('held calls: settled by the operation\'s own reply, and lapse after 30 s when no reply comes', async () => {
  const c = core();
  await c.bind('A', 'sk1');
  await c.record(win(100, 500));
  const a1 = await c.admit('scan', 'A', 'sk1', 3);
  assert.equal(c.remaining(900), 97);
  c.tick(29000);
  assert.equal(c.remaining(900), 97);
  c.tick(2000);
  assert.deepEqual([c.remaining(900), c.remaining(86400)], [100, 500], 'an unrecorded hold lapses after 30 s');
  await c.record(win(100, 500), a1.hold, 1);   /* a late reply for a lapsed hold changes nothing */
  assert.equal(c.remaining(900), 100);
  c.tick(61000);
  const a2 = await c.admit('scan', 'A', 'sk1', 3);
  await c.record(win(99, 499), a2.hold, 1);
  assert.equal(c.remaining(900), 99, 'a reply with headers settles the hold');
  c.tick(61000);
  const a3 = await c.admit('scan', 'A', 'sk1', 3);
  await c.record({}, a3.hold, 1);
  assert.equal(c.remaining(900), 98, 'without headers only the call made stays held');
  await c.record({}, a3.hold, 0);
  assert.equal(c.remaining(900), 98, 'a hold is settled once');
  c.tick(31000);
  assert.equal(c.remaining(900), 99);
});

test('per-account budget of real Buffer calls: 15 per 15 minutes, 60 a day, sign-ins included; unused reservations come back', async () => {
  const c = core();
  await c.bind('A', 'sk1');                                                  /* 1 call */
  for (let i = 0; i < 7; i++) assert.equal((await c.admit('fix', 'A', 'sk1', 2)).ok, true);   /* 15 */
  const no = await c.admit('fix', 'A', 'sk1', 2);
  assert.equal(no.code, 'call_rate');
  assert.ok(no.retryAfter > 800 && no.retryAfter <= 900, String(no.retryAfter));
  assert.equal((await c.account('A')).fixes, 7, 'a refused request counts nothing');
  assert.equal((await c.admit('scan', 'A', 'sk1', 3)).code, 'call_rate');
  c.tick(15 * 60000);
  assert.equal((await c.admit('fix', 'A', 'sk1', 2)).ok, true, 'a new 15-minute window');
  /* reserved but not made: a one-page scan gives two calls back */
  c.tick(15 * 60000);
  const s = await c.admit('scan', 'A', 'sk1', 3);
  assert.equal((await c.account('A')).calls, 20);
  await c.record({}, s.hold, 1);
  const a = await c.account('A');
  assert.equal(a.calls, 18);
  assert.equal(a.q15.n, 1);
  /* the daily budget */
  a.calls = LIMITS.callsPerDay - 1; await c.saveAccount('A', a);
  c.tick(61000);
  const day = await c.admit('scan', 'A', 'sk1', 3);
  assert.equal(day.code, 'call_budget');
  assert.ok(day.retryAfter > 0 && day.retryAfter <= 86400);
  assert.equal((await c.admit('lookback', 'A', 'sk1', 1)).ok, true, 'one call still fits');
  /* per-kind limits keep their own answers */
  assert.equal((await c.admit('lookback', 'A', 'sk1', 1)).code, 'lookback_gap');
  c.tick(24 * 3600e3);
  assert.equal((await c.admit('scan', 'A', 'sk1', 3)).ok, true, 'budgets reset with the UTC day');
});

test('the call budget counts what the Worker really spent: sign-in 1, a one-page scan 1', async () => {
  const env = makeEnv();
  mock(() => jsonRes({ access_token: 'tok-real', expires_in: 3600, scope: 'account:read posts:read posts:write' }),
    () => jsonRes({ data: { account: { id: 'acc-9', name: 'Swift', organizations: [{ id: 'org1', name: 'Org' }] }, channels: [], posts: { pageInfo: { hasNextPage: false }, edges: [] } } }, 200, RATE(100, 500)));
  const f = await start(env);
  const r = await worker.fetch(callback(f, fresh64(5), 'abcdefgh123'), env);
  assert.equal(r.status, 303);
  const sid = r.headers.getSetCookie().find((x) => x.startsWith(SESSION_COOKIE + '=')).split(';')[0];
  const page = await (await worker.fetch(get('/', '198.51.100.3', sid), env)).text();
  const csrf = page.match(/<meta name="csrf" content="([^"]+)"/)[1];
  assert.equal((await worker.fetch(scanReq({ cookie: sid, csrf }), env)).status, 200);
  const core = env.GATE.obj.core;
  const [[key, a]] = Array.from(core.storage._m.entries()).filter(([k]) => k.startsWith('a:'));
  assert.ok(key);
  assert.equal(a.calls, 2);
  assert.equal(a.q15.n, 2);
  assert.equal(n.api, 2);
});

test('sign-in records are cleared within 30 minutes, by the next sign-in or by the gate\'s alarm', async () => {
  const st = memStorage();
  let alarmAt = null;
  st.setAlarm = async (t) => { alarmAt = t; };
  st.delete = async (k) => { st._m.delete(k); };
  const t0 = Math.floor(Date.parse('2026-11-03T10:00:00Z') / LIMITS.nonceMs) * LIMITS.nonceMs + 5000;
  let t = t0;
  const c = new GateCore(st, () => t);
  assert.equal((await c.useNonce('a'.repeat(32))).ok, true);
  assert.equal(alarmAt, t0 - 5000 + 2 * LIMITS.nonceMs + 1000, 'alarm when the slot is no longer needed');
  const keys = () => Array.from(st._m.keys()).filter((k) => k.startsWith('n:'));
  assert.equal(keys().length, 1);
  /* no further sign-ins: the alarm clears it */
  t = alarmAt;
  await c.sweepNonces();
  assert.deepEqual(keys(), []);
  assert.equal((await c.useNonce('a'.repeat(32))).ok, true, 'a cleared value no longer blocks anything (its cookie is long expired)');
  /* with sign-ins in each slot, the oldest key is cleared on write */
  t += LIMITS.nonceMs; await c.useNonce('b'.repeat(32));
  t += LIMITS.nonceMs; await c.useNonce('c'.repeat(32));
  assert.equal(keys().length, 2, 'only this slot and the one before are kept');
  for (const k of keys()) assert.ok(!st._m.get(k).list.includes('a'.repeat(32)));
});
