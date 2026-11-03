/* Look back: the endpoint only reads (one query per organization, at most two), spends through the gate, hands out
   no post tokens; the checks judge each sent post at the time it went out, in its channel's zone, with no fixes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { _resetLimits } from '../src/index.js';
import { runLookback } from '../src/checks/lookback.js';
import { sampleSent, SAMPLE_CHANNELS } from '../public/sample.js';
import { sha256hex } from '../src/session.js';
import { makeEnv, signIn } from './fakes.mjs';

const ORIGIN = 'https://lastlook.swiftbotlab.workers.dev';
let calls = [];
const realFetch = globalThis.fetch;
function mockFetch(handler) {
  calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: init && init.body ? String(init.body) : '' }); return handler(String(url), init); };
}
const bufferCalls = () => calls.filter((c) => c.url === 'https://api.buffer.com').map((c) => JSON.parse(c.body));
test.beforeEach(() => { _resetLimits(); mockFetch(() => jsonRes({})); });
test.after(() => { globalThis.fetch = realFetch; });
const RATE = { ratelimit: '"15m"; r=100; t=600, "24h"; r=500; t=80000', 'ratelimit-policy': '"15m"; q=110; w=900, "24h"; q=525; w=86400' };
const jsonRes = (obj, status, headers) => new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}) });
const req = (path, s, body, headers) => new Request(ORIGIN + path, {
  method: 'POST',
  headers: Object.assign({ origin: ORIGIN, 'content-type': 'application/json', cookie: s ? s.cookie : '', 'x-csrf-token': s ? s.csrf : '', 'cf-connecting-ip': '203.0.113.20' }, headers || {}),
  body: JSON.stringify(body || {})
});
const CH = { id: 'chan123456', name: 'SBL', service: 'bluesky', timezone: 'Asia/Kolkata', metadata: { __typename: 'BlueskyMetadata' } };
const SENT = (over) => Object.assign({ id: 'sent' + Math.random().toString(36).slice(2, 10), channelId: 'chan123456', channelService: 'bluesky', status: 'sent', dueAt: '2026-10-26T07:42:24.214Z', sentAt: '2026-10-26T07:42:24.214Z', createdAt: '2026-10-26T07:42:24.214Z', shareMode: 'customScheduled', isCustomScheduled: true, text: 'A post that went out.', allowedActions: [], assets: [], externalLink: 'https://bsky.app/profile/x/post/1', metadata: { __typename: 'BlueskyPostMetadata', threadCount: 0, thread: [] } }, over || {});
const lbData = (nodes) => ({ data: { channels: [CH], posts: { edges: nodes.map((n) => ({ node: n })) } } });

test('look back: one read-only query per organization, sent posts only, newest first, no post tokens', async () => {
  const env = makeEnv();
  const s = await signIn(env);
  const older = SENT({ id: 'sentolder1', sentAt: '2026-10-01T10:00:00.000Z', dueAt: '2026-10-01T10:00:00.000Z' });
  const newer = SENT({ id: 'sentnewer1', sentAt: '2026-10-20T10:00:00.000Z', dueAt: '2026-10-20T10:00:00.000Z', externalLink: 'javascript:alert(1)' });
  const plain = SENT({ id: 'senthttp01', externalLink: 'http://example.com/x' });
  const odd = SENT({ id: 'queued0001', status: 'scheduled' });
  mockFetch(() => jsonRes(lbData([older, newer, plain, odd]), 200, RATE));
  const r = await worker.fetch(req('/api/lookback', s), env);
  assert.equal(r.status, 200);
  const j = await r.json();
  const q = bufferCalls();
  assert.equal(q.length, 1);
  assert.match(q[0].query, /^query LookBack/);
  assert.ok(!/\bmutation\b|editPost|createPost|deletePost|shareNow|shareNext|publish|addToQueue|movePost/i.test(q[0].query));
  assert.match(q[0].query, /filter: \{ status: \[sent\] \}/);
  assert.match(q[0].query, /sort: \[\{ field: dueAt, direction: desc \}\]/);
  assert.deepEqual(q[0].variables, { org: 'org1', first: 90 });
  assert.deepEqual(j.posts.map((p) => p.id), [plain.id, 'sentnewer1', 'sentolder1'], 'newest first; the scheduled post is dropped');
  assert.ok(j.posts.every((p) => p.ptok === undefined), 'no post tokens: nothing here can reach /api/fix');
  assert.equal(j.posts.find((p) => p.id === 'sentnewer1').externalLink, null, 'javascript: links are dropped');
  assert.equal(j.posts.find((p) => p.id === plain.id).externalLink, null, 'only https links are kept');
  assert.equal(j.posts.find((p) => p.id === 'sentolder1').externalLink, 'https://bsky.app/profile/x/post/1');
  assert.equal(j.calls, 1);
});

test('look back: at most two Buffer calls, even with five organizations', async () => {
  const env = makeEnv();
  const s = await signIn(env, 'acct-orgs', { orgs: [1, 2, 3, 4, 5].map((i) => ({ id: 'org' + i, name: 'Org ' + i })) });
  mockFetch(() => jsonRes(lbData([SENT()]), 200, RATE));
  const j = await (await worker.fetch(req('/api/lookback', s), env)).json();
  assert.equal(bufferCalls().length, 2);
  assert.equal(j.orgsSkipped, 3);
});

test('look back goes through the gate: two-minute gap, six a day, app margin; refused requests cost no Buffer call', async () => {
  const env = makeEnv();
  const s = await signIn(env);
  mockFetch(() => jsonRes(lbData([SENT()]), 200, RATE));
  assert.equal((await worker.fetch(req('/api/lookback', s), env)).status, 200);
  mockFetch(() => jsonRes(lbData([SENT()]), 200, RATE));
  let r = await worker.fetch(req('/api/lookback', s), env);
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error, 'lookback_gap');
  assert.ok(Number(r.headers.get('retry-after')) > 60);
  assert.equal(bufferCalls().length, 0);
  const core = env.GATE.obj.core; const t0 = Date.now();
  const a = await core.account(s.acct); a.lookbacks = 6; a.lastLookback = 0; await core.saveAccount(s.acct, a);
  core.now = () => t0 + 10000;
  r = await worker.fetch(req('/api/lookback', s), env);
  assert.equal((await r.json()).error, 'lookback_budget');
  /* app-wide allowance nearly gone: refused before any call */
  const b = await signIn(env, 'acct-b');
  await core.record({ '15m': { name: '15m', r: 20, t: 600, w: 900 }, '24h': { name: '24h', r: 400, t: 8000, w: 86400 } });
  r = await worker.fetch(req('/api/lookback', b), env);
  assert.equal((await r.json()).error, 'app_busy');
  assert.equal(bufferCalls().length, 0);
});

test('look back needs the same origin, session and CSRF token as every other POST', async () => {
  const env = makeEnv();
  const s = await signIn(env);
  mockFetch(() => jsonRes(lbData([SENT()]), 200, RATE));
  assert.equal((await worker.fetch(req('/api/lookback', s, {}, { origin: 'https://evil.example' }), env)).status, 403);
  assert.equal((await worker.fetch(req('/api/lookback', s, {}, { 'x-csrf-token': 'nope' }), env)).status, 403);
  assert.equal((await worker.fetch(req('/api/lookback', null), env)).status, 401);
  assert.equal(bufferCalls().length, 0);
});

test('a sent post from look back cannot be changed through /api/fix (no token, no Buffer call)', async () => {
  const env = makeEnv();
  const s = await signIn(env);
  const node = SENT({ id: 'sentpost77' });
  mockFetch(() => jsonRes(lbData([node]), 200, RATE));
  const j = await (await worker.fetch(req('/api/lookback', s), env)).json();
  mockFetch(() => jsonRes({ data: { post: node } }, 200, RATE));
  const r = await worker.fetch(req('/api/fix', s, { postId: 'sentpost77', action: 'edit', text: 'x', confirm: true, expectedHash: await sha256hex(node.text), ts: Date.parse(j.checkedAt), ptok: 'A'.repeat(32) }), env);
  assert.equal(r.status, 403);
  assert.equal(bufferCalls().length, 0);
});

/* ---------- the checks ---------- */
const LI = { id: 'li', service: 'linkedin', timezone: 'America/New_York', name: 'Studio' };
const BS = { id: 'bs', service: 'bluesky', timezone: 'Asia/Kolkata', name: 'SBL' };
const P = (id, channelId, sentAt, text, extra) => Object.assign({ id, channelId, channelService: channelId === 'li' ? 'linkedin' : 'bluesky', status: 'sent', dueAt: sentAt, sentAt, createdAt: sentAt, text, assets: [], thread: [] }, extra || {});

test('look back checks: judged at the real send time in the channel zone, past tense, no fixes', () => {
  /* scheduled for a Friday, actually sent on Monday 2026-11-02 at 08:30 New York (13:30 UTC) */
  const late = P('late', 'li', '2026-11-02T13:30:00.000Z', 'Happy Friday! Good evening, everyone.', { dueAt: '2026-10-30T13:30:00.000Z' });
  /* 23:30 UTC on a Thursday is already Friday 05:00 in Kolkata: "Happy Friday" is right there */
  const tz = P('tz', 'bs', '2026-10-29T23:30:00.000Z', 'Happy Friday from the studio, a sunny morning here.');
  const res = runLookback([LI, BS], [late, tz], new Date('2026-11-03T00:00:00Z'));
  const f = res.posts.find((p) => p.id === 'late').flags;
  assert.ok(f.some((x) => x.id === 'time.wrong_day' && /went out on a Monday/.test(x.title)), 'judged at sentAt, not dueAt');
  assert.ok(f.some((x) => x.id === 'time.greeting' && /went out at 08:30/.test(x.detail)));
  assert.deepEqual(res.posts.find((p) => p.id === 'tz').flags, []);
  assert.ok(res.posts.every((p) => p.flags.every((x) => Array.isArray(x.fixes) && x.fixes.length === 0)));
});

test('look back checks: groups, counts, repeats on one channel only, links listed not judged', () => {
  const posts = [
    P('a', 'bs', '2026-10-20T10:00:00.000Z', 'Studio hours this week: Tue to Sat, 10am to 6pm. Walk-ins welcome.'),
    P('b', 'bs', '2026-10-27T10:00:00.000Z', 'Studio hours this week: Tue to Sat, 10am to 6pm. Walk-ins welcome.'),
    P('c', 'li', '2026-10-27T10:00:00.000Z', 'Studio hours this week: Tue to Sat, 10am to 6pm. Walk-ins welcome.'),
    P('d', 'li', '2026-10-21T15:00:00.000Z', '**Big news**: we are open. Details: [link] https://example.com/a'),
    P('e', 'bs', '2026-10-22T15:00:00.000Z', 'Glaze day.', { assets: [{ type: 'image', altText: '' }] })
  ];
  const res = runLookback([LI, BS], posts, new Date('2026-11-03T00:00:00Z'));
  const by = Object.fromEntries(res.groups.map((g) => [g.check, g.items.map((i) => i.postId + ':' + i.flag.id)]));
  assert.deepEqual(by.dupe.sort(), ['a:dupe.same_channel', 'b:dupe.same_channel']);
  assert.ok(!res.posts.find((p) => p.id === 'c').flags.length, 'the same text on another channel is cross-posting, not reported');
  assert.match(res.posts.find((p) => p.id === 'b').flags[0].detail, /Also sent Tue 20 Oct, 15:30/);
  assert.deepEqual(by.format, ['d:format.md_bold']);
  assert.equal(res.posts.find((p) => p.id === 'd').flags.find((f) => f.check === 'format').title, 'Markdown bold showed as asterisks');
  assert.deepEqual(by.placeholder, ['d:placeholder.left']);
  assert.deepEqual(by.alt, ['e:alt.missing']);
  assert.equal(res.totals.checked, 5);
  assert.equal(res.totals.issues, 5);
  assert.equal(res.totals.postsWithIssues, 4);
  assert.equal(res.totals.links, 1);
  assert.ok(!res.posts.some((p) => p.flags.some((f) => f.check === 'links')), 'links are never judged in look back');
});

test('look back checks: an over-long post that went out is medium, past dates without a cue are notes, at most 90 posts', () => {
  const long = P('long', 'bs', '2026-10-20T10:00:00.000Z', 'x '.repeat(200).trim());
  const old = P('old', 'bs', '2026-10-20T10:00:00.000Z', 'Looking back at our pottery fair on Oct 3: what a crowd.');
  const res = runLookback([BS], [long, old], new Date('2026-11-03T00:00:00Z'));
  const lf = res.posts[0].flags.find((f) => f.id === 'length.over');
  assert.equal(lf.severity, 'medium');
  assert.match(lf.detail, /may have cut it short/);
  assert.ok(!/refuse/.test(lf.detail));
  assert.ok(res.posts[1].flags.every((f) => f.severity === 'low'));
  const many = Array.from({ length: 120 }, (_, i) => P('m' + i, 'bs', new Date(Date.UTC(2026, 9, 1) + i * 3600e3).toISOString(), 'Post number ' + i + ' about clay.'));
  assert.equal(runLookback([BS], many, new Date()).totals.checked, 90);
});

test('look back sample on /try: 14 sent posts, 8 issues, on any date', () => {
  for (const now of ['2026-11-03T05:00:00Z', '2027-01-02T03:00:00Z', '2027-03-16T12:00:00Z', '2027-07-04T22:00:00Z'].map((d) => new Date(d))) {
    const res = runLookback(SAMPLE_CHANNELS, sampleSent(now), now);
    assert.equal(res.totals.checked, 14);
    assert.equal(res.totals.issues, 8, now.toISOString());
    for (const g of ['time', 'format', 'placeholder', 'dupe', 'alt']) assert.ok(res.groups.find((x) => x.check === g).items.length, g);
    assert.ok(sampleSent(now).every((p) => Date.parse(p.sentAt) < now.getTime()));
  }
});
