/* /try: the sample queue runs through the real checks, its link results match the real checker's flags, the local
   backend keeps the server's guards, and nothing on the sample page reaches the network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sampleQueue, SAMPLE_CHANNELS, SAMPLE_LINKS, SampleBackend, zoned } from '../public/sample.js';
import { runAll, postLinks } from '../public/checks/index.js';
import { localParts } from '../public/checks/time.js';
import { linkFlag, checkShape, Refused } from '../src/net.js';
import worker from '../src/index.js';
import { makeEnv, signIn } from './fakes.mjs';

const ORIGIN = 'https://lastlook.swiftbotlab.workers.dev';
const sha = async (s) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))), (x) => x.toString(16).padStart(2, '0')).join('');
/* dates across the year, both DST changes in New York, and a year end */
const DATES = ['2026-11-03T05:00:00Z', '2026-12-24T12:00:00Z', '2027-02-27T23:30:00Z', '2027-03-13T05:00:00Z', '2027-06-30T16:00:00Z', '2027-10-31T03:00:00Z'].map((d) => new Date(d));
const WANT = ['time.wrong_day', 'time.relative_queue', 'time.greeting', 'time.event_passed', 'time.past_date', 'time.weekday_mismatch',
  'format.mixed', 'length.over', 'dupe.same_channel', 'dupe.cross_channel', 'placeholder.left', 'alt.missing', 'tags.too_many', 'tags.broken', 'night.small_hours'];

test('sample: 8-12 posts on X, LinkedIn, Bluesky and Instagram; every check type fires on any date', () => {
  for (const now of DATES) {
    const posts = sampleQueue(now);
    assert.ok(posts.length >= 8 && posts.length <= 12);
    assert.deepEqual([...new Set(SAMPLE_CHANNELS.map((c) => c.service))].sort(), ['bluesky', 'instagram', 'linkedin', 'twitter']);
    const res = runAll(SAMPLE_CHANNELS, posts, now);
    const ids = new Set(res.posts.flatMap((p) => p.flags.map((f) => f.id)));
    for (const w of WANT) assert.ok(ids.has(w), w + ' on ' + now.toISOString());
    /* one post stays clean, so "All posts" shows what a good post looks like */
    assert.ok(res.posts.some((p) => !p.flags.length));
    /* every post goes out after now */
    for (const p of posts) assert.ok(Date.parse(p.dueAt) > now.getTime(), p.id);
  }
});

test('sample: local times land on the intended wall clock, also across DST', () => {
  for (const [n, hh, mm] of [[20520, 9, 30], [20526, 2, 30], [20526, 3, 10], [20765, 20, 15]]) {
    const p = localParts(new Date(zoned(n, hh, mm)), 'America/New_York');
    if (!(n === 20526 && hh === 2)) assert.deepEqual([p.day, p.hour, p.min], [n, hh, mm]);
  }
});

test('sample links: every link in the posts has a result, and each flag is what the real checker says', () => {
  const urls = new Set(sampleQueue(new Date()).flatMap((p) => postLinks(p).map((l) => l.url)));
  assert.deepEqual([...urls].sort(), Object.keys(SAMPLE_LINKS).sort());
  for (const [url, s] of Object.entries(SAMPLE_LINKS)) {
    const real = linkFlag(Object.assign({ url }, s.result));
    assert.deepEqual(s.flag, real, url);
  }
  /* the localhost link is refused by the real shape check with the same reason */
  assert.throws(() => checkShape('http://localhost:8080/winter-classes'), (e) => e instanceof Refused && e.kind === 'private' && e.message === SAMPLE_LINKS['http://localhost:8080/winter-classes'].result.reason);
  /* the brand domains are reserved names: the real checker would never fetch them */
  assert.throws(() => checkShape('https://shop.littlekiln.example/autumn-sale'), Refused);
});

test('sample backend: scan shape, link results, and the fix guards of /api/fix', async () => {
  const be = new SampleBackend(() => new Date('2026-11-03T05:00:00Z'));
  const d = await be.scan();
  assert.equal(d.posts.length, 12);
  assert.ok(d.posts.every((p) => p.ptok === 'sample'));
  const lr = await be.checkLinks({ ts: d.ts, items: d.links });
  assert.equal(lr.results.filter((r) => r.flag && r.flag.severity === 'high').length, 3);
  const sale = d.posts.find((p) => p.id === 's-sale');
  const base = { postId: sale.id, confirm: true, expectedHash: await sha(sale.text) };
  await assert.rejects(be.fix(Object.assign({}, base, { action: 'edit', text: 'x', confirm: false })), (e) => e.status === 400);
  await assert.rejects(be.fix(Object.assign({}, base, { action: 'edit', text: 'x', expectedHash: 'f'.repeat(64) })), (e) => e.status === 409);
  await assert.rejects(be.fix(Object.assign({}, base, { action: 'delete' })), (e) => e.status === 400);
  await assert.rejects(be.fix(Object.assign({}, base, { action: 'edit', text: '   ' })), (e) => e.status === 400);
  const r = await be.fix(Object.assign({}, base, { action: 'edit', text: sale.text.replace('Friday', 'Monday') }));
  assert.match(r.post.text, /^Happy Monday/);
  assert.equal(r.links[0].url, 'https://shop.littlekiln.example/autumn-sale');
  /* the old version is gone: a second edit from the stale scan is refused like the server does */
  await assert.rejects(be.fix(Object.assign({}, base, { action: 'edit', text: 'again' })), (e) => e.code === 'changed');
  /* move to drafts keeps the time */
  const bowls2 = d.posts.find((p) => p.id === 's-bowls-2');
  const dr = await be.fix({ postId: bowls2.id, action: 'draft', confirm: true, expectedHash: await sha(bowls2.text) });
  assert.equal(dr.post.status, 'draft');
  assert.equal(dr.post.dueAt, bowls2.dueAt);
  /* custom-time posts cannot be moved in the queue */
  const hiring = d.posts.find((p) => p.id === 's-hiring');
  await assert.rejects(be.fix({ postId: hiring.id, action: 'move', position: 'top', confirm: true, expectedHash: await sha(hiring.text) }), (e) => e.code === 'not_queue');
});

test('sample backend: moves behave like Buffer: the end takes the slot after the last post, the front shares next with no time', async () => {
  const be = new SampleBackend(() => new Date('2026-11-03T05:00:00Z'));
  const d = await be.scan();
  const xSlots = d.posts.filter((p) => p.channelId === 'kiln-x' && !p.isCustomScheduled).sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  assert.deepEqual(xSlots.map((p) => p.id), ['s-sale', 's-bowls-1', 's-bowls-2']);
  const sale = xSlots[0];
  const r = await be.fix({ postId: sale.id, action: 'move', position: 'bottom', confirm: true, expectedHash: await sha(sale.text) });
  assert.equal(r.post.dueAt, new Date(Date.parse(xSlots[2].dueAt) + 864e5).toISOString(), 'the slot after the last queued post');
  assert.deepEqual(r.shifted, [], 'the other posts keep their times');
  /* after the move the checks see the new send day: "Happy Friday" now goes out on Friday... of the next week */
  const after = (await be.scan()).posts;
  const res = runAll(SAMPLE_CHANNELS, after, new Date('2026-11-03T05:00:00Z'));
  const moved = res.posts.find((p) => p.id === 's-sale');
  assert.equal(moved.dueAt, r.post.dueAt);
  /* to the front: share next, no time */
  const bowls = xSlots[2];
  const r2 = await be.fix({ postId: bowls.id, action: 'move', position: 'top', confirm: true, expectedHash: await sha(bowls.text) });
  assert.equal(r2.post.dueAt, null);
  assert.equal(r2.post.shareNext, true);
  assert.equal(r2.post.shareMode, 'shareNext');
});

test('sample page never touches the network: no fetch from the sample backend, and api() refuses in try mode', async () => {
  const real = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => { n++; throw new Error('network'); };
  try {
    const be = new SampleBackend();
    const d = await be.scan();
    await be.checkLinks({ ts: d.ts, items: d.links });
    const p = d.posts[0];
    await be.fix({ postId: p.id, action: 'draft', confirm: true, expectedHash: await sha(p.text) });
  } finally { globalThis.fetch = real; }
  assert.equal(n, 0);
  const sampleSrc = readFileSync(new URL('../public/sample.js', import.meta.url), 'utf8');
  assert.ok(!/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|import\(['"]https?:/.test(sampleSrc));
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /async function api\(path, body\) \{\n {2}if \(MODE === 'try'\) throw/);
  /* in try mode the backend is replaced before the first scan */
  assert.match(app, /if \(MODE === 'try'\) \{\n\s+const \{ SampleBackend, SAMPLE_RULES \} = await import\('\.\/sample\.js'\);/);
});

test('/try page: served without a session, no CSRF token, clear banner, same CSP; landing and empty state link to it', async () => {
  const env = makeEnv();
  const r = await worker.fetch(new Request(ORIGIN + '/try', { headers: { 'cf-connecting-ip': '203.0.113.7' } }), env);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /<meta name="mode" content="try">/);
  assert.ok(!/name="csrf"/.test(html));
  assert.match(html, /Nothing here is sent to Buffer/);
  assert.match(html, /Save to sample/);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self';/);
  assert.equal(env.SESSIONS._m.size, 0);
  assert.equal(env.GATE.calls, 0, 'the gate is not asked');
  /* a signed-in visitor gets the same sample page, still without the session's CSRF token */
  const s = await signIn(env);
  const html2 = await (await worker.fetch(new Request(ORIGIN + '/try', { headers: { cookie: s.cookie } }), env)).text();
  assert.ok(!html2.includes(s.csrf));
  const landing = await (await worker.fetch(new Request(ORIGIN + '/'), env)).text();
  assert.match(landing, /href="\/try">Try it on your own post/);
  assert.match(landing, /href="\/try#sample">browse a sample queue/);
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /href: '\/try#sample' \}, 'See a sample queue'/);
});

test('sample backend: Undo restores the previous text once, only with its own token, within two minutes', async () => {
  let t = new Date('2026-11-03T05:00:00Z').getTime();
  const be = new SampleBackend(() => new Date(t));
  const d = await be.scan();
  const p = d.posts.find((x) => x.id === 's-sale');
  const r = await be.fix({ postId: p.id, action: 'edit', confirm: true, expectedHash: await sha(p.text), text: 'Happy Monday!' });
  assert.equal(r.undo.until - r.undo.uts, 120000);
  const u = { postId: p.id, action: 'undo', confirm: true, expectedHash: await sha('Happy Monday!'), text: p.text, uts: r.undo.uts, undo: r.undo.token };
  await assert.rejects(be.fix(Object.assign({}, u, { text: 'something else' })), (e) => e.code === 'bad_undo');
  await assert.rejects(be.fix(Object.assign({}, u, { undo: 'forged' })), (e) => e.code === 'bad_undo');
  t += 3 * 60000;
  await assert.rejects(be.fix(u), (e) => e.code === 'undo_expired');
  t -= 2 * 60000;
  const back = await be.fix(u);
  assert.equal(back.post.text, p.text);
  await assert.rejects(be.fix(u), (e) => e.status === 409 || e.code === 'bad_undo');
});
