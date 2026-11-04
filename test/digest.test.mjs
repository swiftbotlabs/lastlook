/* The daily digest: opt-in OAuth for a separate read-only grant with offline_access, the sealed refresh token
   (rotated and saved before use), one build per alarm with the app allowance and per-account limits, the page
   and Atom feed (storage only, never Buffer), one-click off that deletes everything and revokes the grant at
   Buffer, isolation between accounts, idle switch-off, read limits, escaping, and the /healthz watchdog.
   Buffer's token endpoint, the GraphQL API and DNS are mocked through globalThis.fetch. */
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { _resetLimits } from '../src/index.js';
import { DIGEST, DIGEST_SCOPES, nextDelivery, digestWindow } from '../src/digest.js';
import { openJSON, OAUTH_COOKIE, sha256hex } from '../src/session.js';
import { localParts } from '../src/checks/time.js';
import { makeEnv, signIn, digestNamespace } from './fakes.mjs';

const ORIGIN = 'https://lastlook.swiftbotlab.workers.dev';
const realFetch = globalThis.fetch;
const realNow = Date.now;
test.after(() => { globalThis.fetch = realFetch; Date.now = realNow; });
test.beforeEach(() => { _resetLimits(); Date.now = realNow; });

const RATE = (r15, r24) => ({ ratelimit: '"15m"; r=' + r15 + '; t=600, "24h"; r=' + r24 + '; t=80000', 'ratelimit-policy': '"15m"; q=110; w=900, "24h"; q=525; w=86400' });
const jres = (obj, status, headers) => new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}) });
const get = (path, ip, headers) => new Request(ORIGIN + path, { headers: Object.assign({ 'cf-connecting-ip': ip || '198.51.100.4' }, headers || {}) });
const form = (path, origin, extra) => new Request(ORIGIN + path, { method: 'POST', headers: Object.assign({ 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '198.51.100.4' }, origin === undefined ? { origin: ORIGIN } : origin === null ? {} : { origin }, extra || {}), body: '' });
const api = (path, s, body) => new Request(ORIGIN + path, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: s.cookie, 'x-csrf-token': s.csrf, 'cf-connecting-ip': '198.51.100.4' }, body: JSON.stringify(body) });

/* a fake Buffer: one grant per authorization code, refresh tokens rotate, an old one coming back revokes the grant */
function fakeBuffer(opts) {
  const o = Object.assign({ accountId: 'acct-A', posts: () => [], scope: DIGEST_SCOPES, refresh: true, rate: RATE(100, 500) }, opts || {});
  const b = { calls: [], grants: new Map(), tokenCalls: [], gql: [], seq: 0, o };
  b.fetch = async (url, init) => {
    const u = String(url);
    const body = init && init.body ? String(init.body) : '';
    b.calls.push(u);
    if (u === 'https://auth.buffer.com/token') {
      const p = new URLSearchParams(body);
      b.tokenCalls.push({ grant: p.get('grant_type'), rt: p.get('refresh_token') });
      if (p.get('grant_type') === 'authorization_code') {
        const g = { id: ++b.seq, current: 'rt-' + b.seq + '-1', used: new Set(), revoked: false, n: 1 };
        b.grants.set(g.id, g);
        return jres(Object.assign({ access_token: 'at-' + g.id, expires_in: 3600, scope: o.scope }, o.refresh ? { refresh_token: g.current } : {}));
      }
      if (p.get('grant_type') === 'refresh_token') {
        const rt = p.get('refresh_token');
        const g = [...b.grants.values()].find((x) => x.current === rt || x.used.has(rt));
        if (!g || g.revoked) return jres({ error: 'invalid_grant' }, 400);
        if (g.used.has(rt)) { g.revoked = true; return jres({ error: 'invalid_grant' }, 400); }
        g.used.add(rt); g.n++; g.current = 'rt-' + g.id + '-' + g.n;
        return jres({ access_token: 'at-' + g.id + '-' + g.n, refresh_token: g.current, expires_in: 3600, scope: o.scope });
      }
      return jres({ error: 'unsupported' }, 400);
    }
    if (u === 'https://api.buffer.com') {
      const q = JSON.parse(body);
      b.gql.push(q);
      if (/query Me/.test(q.query)) return jres({ data: { account: { id: o.accountId, name: 'Tester', timezone: 'UTC', organizations: [{ id: 'org-' + o.accountId, name: 'Org' }] } } }, 200, o.rate);
      if (/query Digest/.test(q.query)) {
        /* the live API (probed 2026-11-04): status [scheduled, needs_approval] without draft returns only posts awaiting
           approval, so a queue of scheduled posts comes back empty; with draft in the list every listed status is returned */
        const m = /status: \[([a-z_, ]+)\]/.exec(q.query);
        const want = new Set(m ? m[1].split(',').map((x) => x.trim()) : []);
        const keep = want.has('needs_approval') && !want.has('draft') ? new Set(['needs_approval']) : want;
        const nodes = o.posts(q.variables).filter((n) => keep.has(n.status)).slice(0, q.variables.first);
        return jres({ data: { channels: [{ id: 'ch1', name: 'studio', displayName: 'Studio', service: 'bluesky', timezone: 'Europe/London', metadata: { __typename: 'BlueskyMetadata' } }], posts: { edges: nodes.map((n) => ({ node: n })) } } }, 200, o.rate);
      }
      return jres({ errors: [{ message: 'unexpected query' }] }, 200);
    }
    if (u.startsWith('https://cloudflare-dns.com/')) return jres({ Status: 0, Answer: [{ type: 1, data: '93.184.215.14' }] });
    if (u.startsWith('https://shop.example.net/')) return new Response(null, { status: 404 });
    return new Response('unexpected ' + u, { status: 599 });
  };
  globalThis.fetch = b.fetch;
  return b;
}
const NODE = (id, dueAt, text, extra) => Object.assign({ id, channelId: 'ch1', channelService: 'bluesky', status: 'scheduled', dueAt, createdAt: new Date(Date.parse(dueAt) - 3 * 864e5).toISOString(), shareMode: 'customScheduled', isCustomScheduled: true, text, allowedActions: ['updatePost'], assets: [], metadata: { __typename: 'BlueskyPostMetadata', threadCount: 1, thread: [{ text, assets: [] }] } }, extra || {});

async function digestEnv() {
  const env = makeEnv();
  env.DIGEST = await digestNamespace(env);
  return env;
}
/* the whole opt-in: /digest/start -> consent (skipped) -> /oauth/callback -> the private page address */
async function subscribe(env, b, hour, tz) {
  const r = await worker.fetch(get('/digest/start?hour=' + (hour == null ? '17' : hour) + '&tz=' + encodeURIComponent(tz || 'Europe/London')), env);
  assert.equal(r.status, 303);
  const loc = new URL(r.headers.get('location'));
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const cb = await worker.fetch(new Request(ORIGIN + '/oauth/callback?code=CODE12345678&state=' + encodeURIComponent(loc.searchParams.get('state')), { headers: { cookie, 'cf-connecting-ip': '198.51.100.4' } }), env);
  return { start: loc, cb };
}
const ftOf = (cb) => { const m = /^\/digest\/([A-Za-z0-9_-]{43})\?new=1$/.exec(cb.headers.get('location') || ''); return m && m[1]; };
const storeText = (env) => JSON.stringify([...env.DIGEST.storage._m.entries()]);
async function runAlarms(env, n) { for (let i = 0; i < (n || 1); i++) await env.DIGEST.obj.alarm(); }

test('digest start asks Buffer for read-only scopes plus offline_access, never posts:write; hour and zone are validated', async () => {
  const env = await digestEnv();
  for (const [h, tz, wantH, wantTz] of [['17', 'Asia/Kolkata', 17, 'Asia/Kolkata'], ['3', 'Mars/Olympus', 17, 'Europe/London'], ['7', 'America/New_York', 7, 'America/New_York']]) {
    const r = await worker.fetch(get('/digest/start?hour=' + h + '&tz=' + encodeURIComponent(tz)), env);
    assert.equal(r.status, 303);
    const loc = new URL(r.headers.get('location'));
    assert.equal(loc.searchParams.get('scope'), 'account:read posts:read offline_access');
    assert.ok(!/posts:write/.test(loc.searchParams.get('scope')));
    assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
    const sealed = r.headers.get('set-cookie').split(';')[0].split('=').slice(1).join('=');
    const flow = await openJSON(env, 'oauth', 'lastlook-oauth-v1', sealed);
    assert.deepEqual([flow.kind, flow.hour, flow.tz], ['digest', wantH, wantTz]);
  }
  /* positive control: the normal sign-in keeps its write scope and no offline access */
  const r = await worker.fetch(get('/oauth/start'), env);
  assert.equal(new URL(r.headers.get('location')).searchParams.get('scope'), 'account:read posts:read posts:write');
});

test('digest callback stores only a sealed refresh token: no session, no access token, no plain token anywhere', async () => {
  const env = await digestEnv();
  const b = fakeBuffer();
  const { cb } = await subscribe(env, b);
  assert.equal(cb.status, 303);
  const ft = ftOf(cb);
  assert.ok(ft, 'redirects to the private page');
  assert.equal(env.SESSIONS._m.size, 0, 'no browser session was created');
  assert.match(cb.headers.get('set-cookie') || '', /__Host-lastlook-oauth=; /, 'the sign-in cookie is cleared');
  const all = storeText(env);
  assert.ok(!all.includes('rt-1-1'), 'refresh token not in clear');
  assert.ok(!all.includes('at-1'), 'access token not stored');
  assert.ok(!all.includes(ft), 'the private address is stored only hashed and sealed');
  const sub = [...env.DIGEST.storage._m.entries()].find(([k]) => k.startsWith('u:'))[1];
  assert.ok(sub.rt && sub.rt.length > 40, 'a sealed token is stored');
  assert.equal(sub.hour, 17);
  assert.equal(sub.acct, await sha256hex('lastlook-account:acct-A'));
});

test('digest callback refuses a grant without a refresh token, or one that could write; nothing is stored', async () => {
  for (const o of [{ refresh: false }, { scope: 'account:read posts:read posts:write offline_access' }]) {
    const env = await digestEnv();
    const b = fakeBuffer(o);
    const { cb } = await subscribe(env, b);
    assert.equal(cb.status, 400);
    assert.match(await cb.text(), /Digest not turned on/);
    assert.equal([...env.DIGEST.storage._m.keys()].filter((k) => k.startsWith('u:')).length, 0);
    assert.equal(b.gql.length, 0, 'no account read for a refused grant');
  }
});

test('build: refresh rotates the token and the new one is saved before the read; the next build uses the new one', async () => {
  const env = await digestEnv();
  const now = Date.now();
  const due = new Date(now + 20 * 3600e3).toISOString();
  const b = fakeBuffer({ posts: () => [NODE('p1', due, 'Happy Friday! Our sale ends **today** <script>alert(1)</script> [link]')] });
  const { cb } = await subscribe(env, b);
  const ft = ftOf(cb);
  await runAlarms(env);
  const refreshes = b.tokenCalls.filter((t) => t.grant === 'refresh_token');
  assert.deepEqual(refreshes.map((t) => t.rt), ['rt-1-1']);
  const dq = b.gql.filter((q) => /query Digest/.test(q.query));
  assert.equal(dq.length, 1);
  assert.match(dq[0].query, /status: \[scheduled, needs_approval, draft\]/, 'draft must be in the list, or Buffer returns no scheduled posts');
  assert.ok(!/dueAt: \{/.test(dq[0].query), 'no dueAt filter: share-next posts have no time and must not be left out');
  assert.match(dq[0].query, /sort: \[\{ field: dueAt, direction: asc \}\]/);
  assert.ok(!/mutation/.test(dq[0].query));
  assert.equal(dq[0].variables.first, DIGEST.readPosts);
  const all = storeText(env);
  assert.ok(!all.includes('rt-1-2') && !all.includes('rt-1-1'), 'rotated token stored sealed only');
  /* second build (next day): Buffer sees the rotated token, not the used one */
  const sub = [...env.DIGEST.storage._m.entries()].find(([k]) => k.startsWith('u:'))[1];
  sub.nextAt = 0; await env.DIGEST.storage.put('u:' + sub.id, sub);
  await runAlarms(env);
  assert.deepEqual(b.tokenCalls.filter((t) => t.grant === 'refresh_token').map((t) => t.rt), ['rt-1-1', 'rt-1-2']);
  assert.equal(b.grants.get(1).revoked, false, 'the grant is still alive: no used token was sent twice');
  /* the page: flags, escaped post text, no script; the feed: Atom with the same, escaped twice */
  const page = await (await worker.fetch(get('/digest/' + ft), env)).text();
  assert.match(page, /to fix before it goes out/);
  assert.ok(!page.includes('<script>alert(1)</script>'));
  assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.ok(!/<script\b/.test(page), 'the digest page has no script at all');
  const fr = await worker.fetch(get('/digest/' + ft + '/feed.xml'), env);
  assert.equal(fr.headers.get('content-type'), 'application/atom+xml; charset=utf-8');
  assert.equal(fr.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  const feed = await fr.text();
  assert.match(feed, /^<\?xml version="1.0" encoding="utf-8"\?>\n<feed xmlns="http:\/\/www.w3.org\/2005\/Atom">/);
  assert.equal((feed.match(/<entry>/g) || []).length, 1, 'one digest a day: the rebuild replaced it');
  assert.ok(!feed.includes('<script>') && !feed.includes('&lt;script&gt;'), 'escaped twice inside the html content');
  assert.match(feed, /&amp;lt;script&amp;gt;/);
  assert.ok(!feed.includes(ft + '"') || feed.includes('/digest/' + ft), 'the address appears only in its own links');
});

test('reading the page or the feed never calls Buffer or opens a link; 120 reads an hour per digest', async () => {
  const env = await digestEnv();
  const b = fakeBuffer({ posts: () => [NODE('p1', new Date(Date.now() + 5 * 3600e3).toISOString(), 'Read https://shop.example.net/x now')] });
  const ft = ftOf((await subscribe(env, b)).cb);
  await runAlarms(env);
  const before = b.calls.length;
  for (let i = 0; i < 10; i++) {
    assert.equal((await worker.fetch(get('/digest/' + ft, '198.51.100.' + (10 + i)), env)).status, 200);
    assert.equal((await worker.fetch(get('/digest/' + ft + '/feed.xml', '198.51.100.' + (10 + i)), env)).status, 200);
  }
  assert.equal(b.calls.length, before, 'no network at all while reading');
  const codes = [];
  for (let i = 0; i < 105; i++) codes.push((await worker.fetch(get('/digest/' + ft + '/feed.xml', '203.0.113.' + (i % 200)), env)).status);
  assert.equal(codes.filter((c) => c === 429).length, 5, 'reads over 120 an hour are refused');
  /* an unknown or malformed address is just "no digest here" */
  for (const bad of ['A'.repeat(43), 'short', ft.slice(0, 42) + '!']) assert.equal((await worker.fetch(get('/digest/' + bad), env)).status, 404);
});

test('off from the page: one POST deletes the token and every digest at once, then the grant is revoked at Buffer', async () => {
  const env = await digestEnv();
  const b = fakeBuffer({ posts: () => [NODE('p1', new Date(Date.now() + 5 * 3600e3).toISOString(), 'ends today [link]')] });
  const ft = ftOf((await subscribe(env, b)).cb);
  await runAlarms(env);
  /* a GET (link prefetch, chat unfurl) only asks */
  const ask = await worker.fetch(get('/digest/' + ft + '/off'), env);
  assert.equal(ask.status, 200);
  assert.match(await ask.text(), /<form method="post" action="\/digest\/[A-Za-z0-9_-]{43}\/off"/);
  assert.equal((await worker.fetch(get('/digest/' + ft), env)).status, 200, 'still on after a GET');
  /* a cross-site form cannot turn it off */
  assert.equal((await worker.fetch(form('/digest/' + ft + '/off', 'https://evil.example'), env)).status, 403);
  assert.equal((await worker.fetch(form('/digest/' + ft + '/off', null), env)).status, 403);
  /* the page sends Referrer-Policy: no-referrer, so Chrome's form POST carries the literal Origin "null": only a
     same-origin fetch site may pass with it; an opaque origin from another site (sandboxed frame, data: page) may not */
  assert.equal((await worker.fetch(form('/digest/' + ft + '/off', 'null'), env)).status, 403);
  assert.equal((await worker.fetch(form('/digest/' + ft + '/off', 'null', { 'sec-fetch-site': 'cross-site' }), env)).status, 403);
  assert.equal((await worker.fetch(form('/digest/' + ft + '/off', 'https://evil.example', { 'sec-fetch-site': 'same-origin' }), env)).status, 403);
  assert.equal((await worker.fetch(get('/digest/' + ft), env)).status, 200, 'still on after refused POSTs');
  /* what Chrome really sends when the button on the page is pressed (seen live 2026-11-04: it was refused before) */
  const r = await worker.fetch(form('/digest/' + ft + '/off', 'null', { 'sec-fetch-site': 'same-origin' }), env);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /The daily digest is off/);
  const keys = [...env.DIGEST.storage._m.keys()];
  assert.deepEqual(keys.filter((k) => /^(u|e|f|a):/.test(k)), [], 'subscription, digests, address and account index gone');
  assert.equal((await worker.fetch(get('/digest/' + ft), env)).status, 404);
  assert.equal((await worker.fetch(get('/digest/' + ft + '/feed.xml'), env)).status, 404);
  /* the alarm then revokes: one refresh, then the used token once more, which revokes the grant */
  await runAlarms(env);
  assert.equal(b.grants.get(1).revoked, true, 'grant revoked at Buffer');
  assert.deepEqual(env.DIGEST.storage._m.get('rv'), [], 'revocation queue empty');
});

test('the app: status shows only this account\'s digest; off works with the session; accounts never see each other', async () => {
  const env = await digestEnv();
  const bA = fakeBuffer({ accountId: 'acct-A', posts: () => [NODE('pa', new Date(Date.now() + 4 * 3600e3).toISOString(), 'A secret launch tomorrow [link]')] });
  const ftA = ftOf((await subscribe(env, bA)).cb);
  await runAlarms(env);
  bA.o.accountId = 'acct-B';
  bA.o.posts = () => [NODE('pb', new Date(Date.now() + 4 * 3600e3).toISOString(), 'B private note {{first_name}}')];
  _resetLimits();
  const ftB = ftOf((await subscribe(env, bA)).cb);
  await runAlarms(env);
  assert.notEqual(ftA, ftB);
  const pageA = await (await worker.fetch(get('/digest/' + ftA), env)).text();
  const pageB = await (await worker.fetch(get('/digest/' + ftB), env)).text();
  assert.match(pageA, /A secret launch/); assert.ok(!pageA.includes('B private note'));
  assert.match(pageB, /B private note/); assert.ok(!pageB.includes('A secret launch'));
  /* signed-in account A sees A's address, and its off touches only A */
  const sA = await signIn(env, await sha256hex('lastlook-account:acct-A'));
  const st = await (await worker.fetch(api('/api/digest', sA, { op: 'status' }), env)).json();
  assert.equal(st.on, true);
  assert.equal(st.page, ORIGIN + '/digest/' + ftA);
  assert.equal(st.feed, ORIGIN + '/digest/' + ftA + '/feed.xml');
  assert.equal(st.hour, 17);
  const off = await (await worker.fetch(api('/api/digest', sA, { op: 'off' }), env)).json();
  assert.deepEqual(off, { ok: true, was: true });
  assert.equal((await worker.fetch(get('/digest/' + ftA), env)).status, 404);
  assert.equal((await worker.fetch(get('/digest/' + ftB), env)).status, 200, 'B untouched');
  assert.equal((await (await worker.fetch(api('/api/digest', sA, { op: 'status' }), env)).json()).on, false);
  /* the API needs the session and its CSRF token */
  const bad = new Request(ORIGIN + '/api/digest', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: sA.cookie, 'cf-connecting-ip': '198.51.100.4' }, body: '{"op":"status"}' });
  assert.equal((await worker.fetch(bad, env)).status, 403);
});

test('a second sign-up for the same account replaces the first and revokes its grant; 5 sign-ups a day; 300 in all', async () => {
  const env = await digestEnv();
  const b = fakeBuffer();
  const ft1 = ftOf((await subscribe(env, b)).cb);
  const ft2 = ftOf((await subscribe(env, b)).cb);
  assert.equal((await worker.fetch(get('/digest/' + ft1), env)).status, 404);
  assert.equal((await worker.fetch(get('/digest/' + ft2), env)).status, 200);
  await runAlarms(env, 2);
  assert.equal(b.grants.get(1).revoked, true, 'the replaced grant is revoked');
  assert.equal(b.grants.get(2).revoked, false);
  for (let i = 0; i < 3; i++) { _resetLimits(); assert.ok(ftOf((await subscribe(env, b)).cb)); }
  _resetLimits();
  const sixth = (await subscribe(env, b)).cb;
  assert.equal(sixth.status, 429);
  assert.match(await sixth.text(), /Too many digest sign-ups/);
  /* the cap: a store already holding 300 subscriptions refuses a new account */
  const ids = []; for (let i = 0; i < 300; i++) ids.push('x' + i);
  await env.DIGEST.storage.put('ids', ids);
  b.o.accountId = 'acct-new';
  _resetLimits();
  const full = (await subscribe(env, b)).cb;
  assert.equal(full.status, 503);
  assert.match(await full.text(), /full/);
});

test('Buffer refusing the token turns the digest off; nobody reading for 14 days turns it off and revokes', async () => {
  let env = await digestEnv();
  let b = fakeBuffer();
  let ft = ftOf((await subscribe(env, b)).cb);
  b.grants.get(1).revoked = true;                    /* the user removed Last Look in Buffer */
  await runAlarms(env);
  assert.equal((await worker.fetch(get('/digest/' + ft), env)).status, 404);
  assert.equal(b.gql.filter((q) => /query Digest/.test(q.query)).length, 0, 'nothing read without a valid grant');

  env = await digestEnv();
  b = fakeBuffer();
  ft = ftOf((await subscribe(env, b)).cb);
  const sub = [...env.DIGEST.storage._m.entries()].find(([k]) => k.startsWith('u:'))[1];
  sub.lastRead = Date.now() - 15 * 864e5; sub.created = sub.lastRead; await env.DIGEST.storage.put('u:' + sub.id, sub);
  await runAlarms(env, 2);
  assert.equal((await worker.fetch(get('/digest/' + ft), env)).status, 404);
  assert.equal(b.grants.get(1).revoked, true, 'the idle grant was revoked');
  /* positive control: a digest read 13 days ago keeps going */
  env = await digestEnv();
  b = fakeBuffer();
  ft = ftOf((await subscribe(env, b)).cb);
  const s2 = [...env.DIGEST.storage._m.entries()].find(([k]) => k.startsWith('u:'))[1];
  s2.lastRead = Date.now() - 13 * 864e5; s2.created = s2.lastRead; await env.DIGEST.storage.put('u:' + s2.id, s2);
  await runAlarms(env);
  assert.equal((await worker.fetch(get('/digest/' + ft), env)).status, 200);
  assert.equal(b.grants.get(1).revoked, false);
});

test('builds yield to people: a low app allowance defers the build before any token request', async () => {
  const env = await digestEnv();
  const b = fakeBuffer();
  ftOf((await subscribe(env, b)).cb);
  const core = env.GATE.obj.core;
  await core.loadRate();
  core.rate = { 900: { r: 25, resetAt: Date.now() + 600000 }, 86400: { r: 400, resetAt: Date.now() + 8e7 } };
  const n = b.tokenCalls.length;
  await runAlarms(env);
  assert.equal(b.tokenCalls.length, n, 'no refresh while the allowance is low (margin 30 for digests)');
  const sub = [...env.DIGEST.storage._m.entries()].find(([k]) => k.startsWith('u:'))[1];
  assert.ok(sub.nextAt > Date.now() + 15 * 60000, 'tried again in about 20 minutes');
  /* positive control: an interactive scan would still be admitted at 25 left (its margin is 20) */
  const s = await signIn(env, 'acct-scan');
  assert.equal((await core.admit('scan', s.acct, s.sk, 3)).ok, true);
});

test('only the posts inside the window, with at most 4 links opened, private links judged without the network', async () => {
  const env = await digestEnv();
  const now = Date.now();
  const inside = new Date(now + 6 * 3600e3).toISOString();
  const outside = new Date(now + 4 * 864e5).toISOString();
  const b = fakeBuffer({ posts: () => [
    NODE('in1', inside, 'Admin page http://localhost:8080/admin and https://shop.example.net/gone'),
    NODE('in2', inside, 'More: https://shop.example.net/a https://shop.example.net/b https://shop.example.net/c https://shop.example.net/d'),
    NODE('out', outside, 'OUTSIDE the window **bold**'),
    NODE('next', '1970-01-01T00:00:00.000Z', 'SHARE NEXT post: doors open tomorrow', { shareMode: 'addToQueue' })
  ] });
  const ft = ftOf((await subscribe(env, b)).cb);
  await runAlarms(env);
  const dq = b.gql.find((q) => /query Digest/.test(q.query));
  assert.deepEqual(Object.keys(dq.variables).sort(), ['first', 'org']);
  assert.ok(!b.calls.some((u) => /localhost/.test(u)), 'a private link is never fetched');
  const heads = b.calls.filter((u) => u.startsWith('https://shop.example.net/'));
  assert.ok(heads.length <= DIGEST.maxLinks, 'at most 4 links opened, got ' + heads.length);
  const page = await (await worker.fetch(get('/digest/' + ft), env)).text();
  assert.match(page, /Link points to a private address/);
  assert.match(page, /Broken link \(404 Not Found\)/);
  assert.ok(!page.includes('OUTSIDE the window'), 'posts outside the window are left out even if returned');
  assert.match(page, /SHARE NEXT post/, 'a post set to share next (no time) is in the digest');
  assert.match(page, /Shares next/);
  assert.match(page, /in a post set to share next/);
  assert.match(page, /of 6 links opened/);
});

test('a queue of plain scheduled posts reaches the digest (Buffer returns none for [scheduled, needs_approval] alone); drafts are left out', async () => {
  const env = await digestEnv();
  const now = Date.now();
  const soon = new Date(now + 5 * 3600e3).toISOString();
  const b = fakeBuffer({ posts: () => [
    NODE('q1', soon, 'QUEUED studio night is **tomorrow** at 7pm', { shareMode: 'addToQueue', isCustomScheduled: false }),
    NODE('q2', soon, 'QUEUED two: new mugs [link]', { shareMode: 'addToQueue', isCustomScheduled: false }),
    NODE('d1', soon, 'DRAFT ONLY **never shown**', { status: 'draft' })
  ] });
  const ft = ftOf((await subscribe(env, b)).cb);
  await runAlarms(env);
  const page = await (await worker.fetch(get('/digest/' + ft), env)).text();
  assert.ok(!/nothing queued to check/.test(page), 'the digest must see the queued posts');
  assert.match(page, /Checked 2 posts going out/);
  assert.match(page, /QUEUED studio night/);
  assert.match(page, /QUEUED two/);
  assert.ok(!page.includes('DRAFT ONLY'), 'a draft is not going out, so it is not in the digest');
});

test('right after turning it on, the page says Buffer ends the earlier sign-in and offers to connect again; later visits do not', async () => {
  const env = await digestEnv();
  const b = fakeBuffer({ posts: () => [] });
  const ft = ftOf((await subscribe(env, b)).cb);
  await runAlarms(env);
  const first = await (await worker.fetch(get('/digest/' + ft + '?new=1'), env)).text();
  assert.match(first, /To keep fixing posts, connect again\./);
  assert.match(first, /<a class="btn btn-small" href="\/oauth\/start">Connect again<\/a>/);
  const later = await (await worker.fetch(get('/digest/' + ft), env)).text();
  assert.ok(!/To keep fixing posts/.test(later), 'only on the welcome visit');
});

test('/healthz: the digest watchdog fails after 6 builds in a row fail on our side, and when builds are overdue', async () => {
  const env = await digestEnv();
  let r = await worker.fetch(get('/healthz'), env);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).digest.ok, true);
  await env.DIGEST.storage.put('health', { ourFails: 6, lastResult: 'error' });
  r = await worker.fetch(get('/healthz'), env);
  assert.equal(r.status, 503);
  assert.equal((await r.json()).digest.consecutiveFailures, 6);
  await env.DIGEST.storage.put('health', { ourFails: 0 });
  assert.equal((await worker.fetch(get('/healthz'), env)).status, 200);
  /* a subscription due 3 hours ago with no alarm run */
  const b = fakeBuffer();
  ftOf((await subscribe(env, b)).cb);
  const sub = [...env.DIGEST.storage._m.entries()].find(([k]) => k.startsWith('u:'))[1];
  sub.nextAt = Date.now() - 3 * 3600e3; await env.DIGEST.storage.put('u:' + sub.id, sub);
  r = await worker.fetch(get('/healthz'), env);
  assert.equal(r.status, 503);
  assert.equal((await r.json()).digest.overdue, 1);
  await runAlarms(env);
  assert.equal((await worker.fetch(get('/healthz'), env)).status, 200, 'healthy again after the build');
});

test('delivery time and window: today at the hour if still ahead, else tomorrow; the window ends with the next local day', () => {
  const tz = 'Asia/Kolkata';
  const t0 = Date.parse('2026-11-04T09:00:00Z');          /* 14:30 in Kolkata */
  assert.equal(new Date(nextDelivery(t0, tz, 17)).toISOString(), '2026-11-04T11:30:00.000Z');
  assert.equal(new Date(nextDelivery(t0, tz, 7)).toISOString(), '2026-11-05T01:30:00.000Z');
  const w = digestWindow(t0, tz);
  assert.equal(new Date(w.to + 1000).toISOString(), '2026-11-05T18:30:00.000Z', 'midnight after tomorrow, Kolkata');
  const lp = localParts(new Date(w.to), tz);
  assert.deepEqual([lp.hour, lp.min], [23, 59]);
});

test('old digests: at most 7 kept, excerpts cut to 140 characters', async () => {
  const env = await digestEnv();
  const long = 'Doors open today at 6pm [link] ' + 'x'.repeat(400);
  const b = fakeBuffer({ posts: () => [NODE('p', new Date(Date.now() + 5 * 3600e3).toISOString(), long)] });
  const ft = ftOf((await subscribe(env, b)).cb);
  let clock = Date.now();
  Date.now = () => clock;
  for (let d = 0; d < 9; d++) {
    const sub = [...env.DIGEST.storage._m.entries()].find(([k]) => k.startsWith('u:'))[1];
    sub.nextAt = 0; sub.lastRead = clock; await env.DIGEST.storage.put('u:' + sub.id, sub);
    env.GATE.obj.core.rate = null; await env.GATE.obj.core.storage.put('rate', {});
    const a = await env.GATE.obj.core.account(sub.acct); a.digests = 0; a.calls = 0; a.q15 = null; await env.GATE.obj.core.saveAccount(sub.acct, a);
    await runAlarms(env);
    clock += 864e5;
  }
  Date.now = realNow;
  const feed = await (await worker.fetch(get('/digest/' + ft + '/feed.xml'), env)).text();
  assert.equal((feed.match(/<entry>/g) || []).length, DIGEST.keep);
  const page = await (await worker.fetch(get('/digest/' + ft), env)).text();
  const ex = /<p class="post-text">([^<]*)<\/p>/.exec(page)[1];
  assert.ok(ex.length <= 140 + 10, 'excerpt length ' + ex.length);
  assert.ok(!page.includes('x'.repeat(200)));
});

/* ---------- the app's Daily digest tab (real public/app.js, fake DOM) ---------- */
import { browser, FakeEl } from './dom.mjs';
function nodes(root) { const out = []; const go = (n) => { out.push(n); for (const k of n.kids || []) if (k instanceof FakeEl) go(k); }; go(root); return out; }
const byTag = (root, t) => nodes(root).filter((n) => n.tag === t);
test('app tab: off by default with a turn-on link carrying the hour and zone; on shows the page and feed; off takes two clicks', async () => {
  const b = browser({ meta: { csrf: 'c'.repeat(32) } });
  let on = false;
  const reqs = [];
  b.respond = async (path, init) => {
    if (path === '/api/scan') return jres({ ok: true, channels: [], posts: [], links: [], ts: Date.now(), truncated: false, rateLow: false });
    if (path === '/api/digest') {
      const body = JSON.parse(init.body); reqs.push(body.op);
      if (body.op === 'status') return jres(on ? { ok: true, on: true, page: ORIGIN + '/digest/' + 'F'.repeat(43), feed: ORIGIN + '/digest/' + 'F'.repeat(43) + '/feed.xml', tz: 'Asia/Kolkata', hour: 17, nextAt: Date.now() + 3600e3, last: { tomorrow: 'Thu 5 Nov', flagged: 2, scanned: 5, high: 2 } } : { ok: true, on: false });
      if (body.op === 'off') { on = false; return jres({ ok: true, was: true }); }
    }
    return jres({}, 404);
  };
  await b.load();
  b.$('v-digest').click();
  await b.flush();
  assert.equal(b.$('v-digest').getAttribute('aria-pressed'), 'true');
  assert.equal(b.$('headline').textContent, 'Daily digest');
  const go = b.$('queue').find('digest-on');
  assert.ok(go, 'a turn-on button');
  assert.match(go.getAttribute('href'), /^\/digest\/start\?hour=17&tz=/);
  const sel = b.$('queue').find('digest-hour');
  sel.value = '7'; sel.fire('change');
  assert.match(go.getAttribute('href'), /^\/digest\/start\?hour=7&tz=/);
  assert.equal(b.$('toolbar').hidden, true, 'no queue filters on this tab');
  /* turned on (back from Buffer): the tab reads the status again */
  on = true;
  b.$('v-digest').click();
  await b.flush();
  assert.equal(b.$('headline').textContent, 'Daily digest is on');
  assert.match(b.$('queue').text(), /tomorrow \(Thu 5 Nov\), 2 posts to fix in 5 posts checked/);
  assert.ok(byTag(b.$('queue'), 'a').some((a) => a.getAttribute('href') === ORIGIN + '/digest/' + 'F'.repeat(43) && a.getAttribute('rel') === 'noopener noreferrer'));
  assert.match(b.$('queue').text(), /feed\.xml/);
  const off = b.$('queue').find('digest-off');
  off.click(); await b.flush();
  assert.equal(reqs.filter((x) => x === 'off').length, 0, 'the first click only asks');
  b.$('queue').find('digest-off').click(); await b.flush();
  assert.equal(reqs.filter((x) => x === 'off').length, 1);
  assert.equal(b.$('headline').textContent, 'Daily digest');
});

test('gate: a digest build is not held back by the user\'s own link check a minute ago; per-site limits still apply', async () => {
  const env = makeEnv();
  const core = env.GATE.obj.core;
  const s = await signIn(env, 'acct-links');
  const item = { h: 'a'.repeat(32), site: 'example.net' };
  assert.deepEqual((await core.admitLinks(s.acct, s.sk, [item])).results, ['ok']);
  assert.deepEqual((await core.admitLinks(s.acct, s.sk, [item])).results, ['recent'], 'positive control: the interactive path dedupes');
  assert.deepEqual((await core.admitLinks(s.acct, null, [item], true)).results, ['ok'], 'the digest path does not');
  const many = Array.from({ length: 10 }, (_, i) => ({ h: String(i).padStart(32, 'b'), site: 'busy.example' }));
  await core.admitLinks(s.acct, null, many, true);
  await core.admitLinks(s.acct, null, many, true);
  const r = await core.admitLinks(s.acct, null, many, true);
  assert.equal(r.results.filter((x) => x === 'site').length, 10, 'per-site cap of 20 a minute holds for digests');
  assert.equal((await core.admitLinks(s.acct, null, [item], false)).ok, false, 'no session and not a digest: refused');
});
