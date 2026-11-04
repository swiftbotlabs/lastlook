/* After a queue reorder (movePostInQueue) Buffer keeps the channel's slots and changes the order, so every post
   between the two positions gets a new send time. checkSlotShift re-judges each day word at the new slot against
   the day it meant at the old one, and suggests the word that keeps that day. Also: the Worker re-reads the
   channel's queue after a move (one request, the session's own organization only), and the page shows the
   result on the sample queue with no network call. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSlotShift, shiftPhrase, localParts } from '../src/checks/time.js';
import { runAll } from '../src/checks/index.js';
import worker, { _resetLimits } from '../src/index.js';
import { sha256hex } from '../src/session.js';
import { makeEnv, signIn } from './fakes.mjs';
import { browser, FakeEl } from './dom.mjs';
import { sampleQueue } from '../public/sample.js';

const NY = { id: 'c', service: 'bluesky', timezone: 'America/New_York', name: 'Studio' };
const qpost = (text, dueAt, extra) => Object.assign({ id: 'a', channelId: 'c', channelService: 'bluesky', status: 'scheduled', isCustomScheduled: false, shareMode: 'addToQueue', dueAt, createdAt: '2026-11-04T10:00:00Z', text, allowedActions: ['updatePost', 'movePostToDraft'], thread: [], assets: [] }, extra || {});
const MON = '2026-11-09T14:30:00.000Z';   /* Mon 9 Nov 09:30 New York */
const TUE = '2026-11-10T14:30:00.000Z';
const WED = '2026-11-11T14:30:00.000Z';
const THU = '2026-11-12T14:30:00.000Z';
const one = (text, to, from) => checkSlotShift(qpost(text, to), NY, from);

test('reorder: "tomorrow" pushed one slot later keeps its day as "today"', () => {
  const f = one('Our sale ends tomorrow! Last pieces online.', TUE, MON);
  assert.equal(f.length, 1);
  assert.equal(f[0].id, 'time.slot_shift');
  assert.equal(f[0].severity, 'high');
  assert.equal(f[0].title, '“tomorrow” now means Wed 11 Nov, not Tue 10 Nov');
  assert.match(f[0].detail, /from Mon 9 Nov 09:30 to Tue 10 Nov 09:30 \(America\/New_York\)/);
  assert.equal(f[0].fixes[0].label, 'Say “today”');
  assert.equal(f[0].fixes[0].text, 'Our sale ends today! Last pieces online.');
  assert.deepEqual(f[0].spans, [[14, 22]]);
});

test('reorder: moved to the front, "tomorrow" becomes the weekday it meant; capitals kept', () => {
  const f = one('Tomorrow we open the doors at 6pm.', MON, THU);
  assert.equal(f.length, 1);
  assert.equal(f[0].fixes[0].text, 'Friday we open the doors at 6pm.');
  assert.equal(shiftPhrase('tomorrow', localParts(new Date(THU), NY.timezone).day + 1, localParts(new Date(MON), NY.timezone)), 'Friday');
  assert.equal(shiftPhrase('tonight', localParts(new Date(MON), NY.timezone).day + 1, localParts(new Date(MON), NY.timezone)), 'tomorrow night');
  assert.equal(shiftPhrase('today', localParts(new Date(MON), NY.timezone).day + 9, localParts(new Date(MON), NY.timezone)), 'Wed 18 Nov');
});

test('reorder: a day that has passed at the new slot offers the front of the queue or drafts, never a made-up word', () => {
  const f = one('Doors open today at 6pm, see you there', WED, MON);
  assert.equal(f.length, 1);
  assert.match(f[0].detail, /has passed/);
  assert.deepEqual(f[0].fixes.map((x) => x.type + (x.position ? ':' + x.position : '') + (x.text ? ':text' : '')), ['edit', 'move:top', 'draft']);
});

test('reorder: words that still mean the same day are left alone (positive control: the same words do flag across a day)', () => {
  /* 09:30 -> 18:00 the same day: "tonight" and "today" still point to Monday */
  assert.deepEqual(one('Join us tonight! Doors open today.', '2026-11-09T23:00:00.000Z', MON), []);
  /* a weekday ahead in the same week resolves to the same date from both slots */
  assert.deepEqual(one('Webinar on Thursday', TUE, MON), []);
  /* positive control: across a day both flag */
  assert.equal(one('Join us tonight! Doors open today.', TUE, MON).length, 2);
  /* no move, no flag; a date written next to the word is the regular checks' job */
  assert.deepEqual(one('Sale ends tomorrow', MON, MON), []);
  assert.deepEqual(one('Sale ends tomorrow (Nov 10)', TUE, MON), []);
  /* threads are edited in Buffer */
  assert.deepEqual(checkSlotShift(qpost('ends tomorrow', TUE, { thread: [{ text: 'a' }, { text: 'b' }] }), NY, MON), []);
});

test('reorder: week words that change week are flagged without a suggested text', () => {
  const f = one('Big news coming this week', '2026-11-16T14:30:00.000Z', THU);
  assert.equal(f.length, 1);
  assert.equal(f[0].fixes[0].label, 'Reword');
  assert.equal(f[0].fixes[0].text, undefined);
});

test('reorder: runAll swaps the general queue-slot note for the re-judged word (positive control without the shift)', () => {
  const p = qpost('Our sale ends tomorrow!', TUE);
  const now = new Date('2026-11-05T00:00:00Z');
  const plain = runAll([NY], [p], now).posts[0].flags.map((f) => f.id);
  assert.ok(plain.includes('time.relative_queue'));
  assert.ok(!plain.includes('time.slot_shift'));
  const moved = runAll([NY], [p], now, { shifts: new Map([['a', MON]]) }).posts[0];
  assert.deepEqual(moved.flags.map((f) => f.id), ['time.slot_shift']);
  assert.deepEqual(moved.flags[0].fixes.map((x) => x.type), ['edit', 'draft'], 'fixes filtered by what the post allows');
});

/* ---------- Worker: the re-read after a move ---------- */
const ORIGIN = 'https://lastlook.swiftbotlab.workers.dev';
let calls = [];
const realFetch = globalThis.fetch;
function mockFetch(handler) {
  calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: init && init.body ? String(init.body) : '' }); return handler(String(url), init && init.body ? String(init.body) : ''); };
}
test.beforeEach(() => _resetLimits());
test.after(() => { globalThis.fetch = realFetch; });
const RATE = { ratelimit: '"15m"; r=100; t=600, "24h"; r=500; t=80000', 'ratelimit-policy': '"15m"; q=110; w=900, "24h"; q=525; w=86400' };
const jres = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'content-type': 'application/json' }, RATE) });
const req = (path, s, body) => new Request(ORIGIN + path, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: s.cookie, 'x-csrf-token': s.csrf, 'cf-connecting-ip': '203.0.113.7' }, body: JSON.stringify(body) });
const NODE = (id, dueAt, text) => ({ id, channelId: 'chan123456', channelService: 'bluesky', status: 'scheduled', dueAt, createdAt: '2026-11-04T10:00:00Z', shareMode: 'addToQueue', isCustomScheduled: false, text, allowedActions: ['updatePost', 'movePostToDraft'], assets: [], metadata: { __typename: 'BlueskyPostMetadata', threadCount: 1, thread: [{ text, assets: [] }] } });
const CH = [{ id: 'chan123456', name: 'SBL', service: 'bluesky', timezone: 'UTC', avatar: null, metadata: { __typename: 'BlueskyMetadata' } }];

async function moveSetup(orgs, queueAnswer) {
  const env = makeEnv();
  const s = await signIn(env, 'acct-move', { orgs });
  const a = NODE('posta11111', '2026-12-01T09:00:00.000Z', 'Sale ends tomorrow');
  const b = NODE('postb22222', '2026-12-02T09:00:00.000Z', 'Doors open tonight');
  mockFetch(() => jres({ data: { channels: CH, posts: { pageInfo: { hasNextPage: false }, edges: [{ node: a }, { node: b }] } } }));
  const scan = await (await worker.fetch(req('/api/scan', s, {}), env)).json();
  assert.equal(scan.channels[0].orgId, orgs[0].id, 'the scan tells the page which organization a channel is in');
  const pb = scan.posts.find((p) => p.id === b.id);
  mockFetch((u, body) => {
    const q = JSON.parse(body);
    if (/query One/.test(q.query)) return jres({ data: { post: b } });
    if (/^mutation/.test(q.query)) return jres({ data: { movePostInQueue: { __typename: 'PostActionSuccess', post: Object.assign({}, b, { dueAt: a.dueAt }) } } });
    if (/query Queue/.test(q.query)) return queueAnswer(q, a, b);
    return jres({}, 500);
  });
  return { env, s, base: { postId: b.id, ts: scan.ts, ptok: pb.ptok, expectedHash: await sha256hex(b.text), confirm: true, action: 'move', position: 'top' }, a, b };
}

test('worker: a move re-reads that channel\'s queue once and hands back every post with its new time and fresh tokens', async () => {
  const { env, s, base, a, b } = await moveSetup([{ id: 'org1', name: 'Org' }], (q, a) => jres({ data: { posts: { edges: [{ node: Object.assign({}, b, { dueAt: a.dueAt }) }, { node: Object.assign({}, a, { dueAt: b.dueAt }) }] } } }));
  const r = await worker.fetch(req('/api/fix', s, Object.assign({}, base, { orgId: 'org1' })), env);
  assert.equal(r.status, 200);
  const j = await r.json();
  const qs = calls.map((c) => JSON.parse(c.body));
  assert.equal(qs.length, 3, 're-read, move, queue read');
  assert.match(qs[2].query, /channelIds: \[\$channel\]/);
  assert.match(qs[2].query, /status: \[scheduled\]/);
  assert.ok(!/^mutation/.test(qs[2].query));
  assert.deepEqual(qs[2].variables, { org: 'org1', channel: 'chan123456' });
  assert.equal(j.shiftedError, false);
  assert.equal(j.shifted.length, 1, 'the moved post itself is not repeated');
  assert.equal(j.shifted[0].id, a.id);
  assert.equal(j.shifted[0].dueAt, b.dueAt);
  assert.match(j.shifted[0].ptok, /^[A-Za-z0-9_-]{32}$/);
});

test('worker: the queue read uses only the session\'s own organization; a foreign one means no read, and the move still succeeds', async () => {
  const { env, s, base } = await moveSetup([{ id: 'org1', name: 'A' }, { id: 'org2', name: 'B' }], () => jres({ data: { posts: { edges: [] } } }));
  const r = await worker.fetch(req('/api/fix', s, Object.assign({}, base, { orgId: 'org-not-mine' })), env);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.shiftedError, true);
  assert.equal(calls.length, 2, 'no queue read for an organization outside the session');
  /* a single-organization session needs no orgId */
  const m2 = await moveSetup([{ id: 'org1', name: 'A' }], () => jres({ data: { posts: { edges: [] } } }));
  const r2 = await worker.fetch(req('/api/fix', m2.s, m2.base), m2.env);
  assert.equal((await r2.json()).shiftedError, false);
  assert.equal(calls.length, 3);
});

test('worker: a failed queue read after a successful move is reported as "not re-checked", not as a failed fix', async () => {
  const { env, s, base } = await moveSetup([{ id: 'org1', name: 'A' }], () => jres({}, 502));
  const r = await worker.fetch(req('/api/fix', s, base), env);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.action, 'move');
  assert.equal(j.shiftedError, true);
  assert.deepEqual(j.shifted, []);
});

/* ---------- the page, on the /try sample (no network) ---------- */
const realSetTimeout = setTimeout;
/* Web Crypto hashing finishes on a worker thread: wait in real time until the dialog has closed */
async function settle(b) { for (let i = 0; i < 100 && b.$('dlg').open; i++) { await new Promise((r) => realSetTimeout(r, 10)); await b.flush(); } await b.flush(); }
function nodes(root) { const out = []; const go = (n) => { out.push(n); for (const k of n.kids || []) if (k instanceof FakeEl) go(k); }; go(root); return out; }
const byTag = (root, t) => nodes(root).filter((n) => n.tag === t);
const buttons = (root, label) => byTag(root, 'button').filter((n) => n.text() === label);

test('page: on the sample, moving the sale post to the end re-checks its "tomorrow" at the new slot and says how it moved', async () => {
  const b = browser({ meta: { mode: 'try' }, path: '/try', hash: '#sample' });
  await b.load();
  b.$('f-all').click(); await b.flush();
  const sale0 = sampleQueue(new Date(b.clock)).find((p) => p.id === 's-sale');
  assert.match(sale0.text, /ends tomorrow/);
  const saleCard = () => byTag(b.$('queue'), 'article').find((n) => /autumn glaze sale/.test(n.text()));
  assert.ok(!/now means/.test(saleCard().text()), 'no reorder flag before a move');
  buttons(saleCard(), 'Move to end of queue')[0].click();
  assert.equal(b.$('dlg').open, true);
  assert.match(b.$('dlg-desc').textContent, /takes the last slot/);
  b.$('dlg-ok').click();
  await settle(b);
  assert.equal(b.$('dlg').open, false, document.getElementById('dlg-error').textContent);
  const banner = b.$('queue').find('shift-banner');
  assert.ok(banner, 'a banner after the reorder');
  assert.match(banner.text(), /^Moved to the end of the queue on Little Kiln \(X\)\. Buffer moved it from Mon 9 Nov 09:30 to Fri 13 Nov 09:30\. No other post changed time\./);
  assert.match(banner.text(), /1 post now says the wrong day/);
  const card = saleCard();
  assert.match(card.text(), /“tomorrow” now means Sat 14 Nov, not Tue 10 Nov/);
  assert.match(card.text(), /has passed/, 'Tuesday is already past at the new slot: no made-up word');
  assert.equal(buttons(card, 'Move to front of queue').length, 1, 'offers the front of the queue');
  /* to the front: Buffer shares it next with no time; its day words are flagged as unknown, never judged at a fake time */
  buttons(card, 'Move to front of queue')[0].click();
  assert.match(b.$('dlg-title').textContent, /Share it next/);
  b.$('dlg-ok').click();
  await settle(b);
  const next = saleCard();
  assert.match(next.text(), /Shares next · no time yet/);
  assert.match(next.text(), /in a post set to share next/);
  assert.ok(!/1970/.test(next.text()));
  assert.match(b.$('queue').find('shift-banner').text(), /Buffer set it to share next, with no time until it goes out/);
  assert.equal(b.requests.length, 0, 'the sample never calls the network');
});

test('worker: a post Buffer reports with dueAt 1970 or shareNext is shaped as "share next" with no time', async () => {
  const { shapePost } = await import('../src/buffer.js');
  for (const n of [{ shareMode: 'shareNext', dueAt: '1970-01-01T00:00:00.000Z' }, { shareMode: 'addToQueue', dueAt: '1970-01-01T00:00:00.000Z' }, { shareMode: 'shareNext', dueAt: null }]) {
    const p = shapePost(Object.assign({ id: 'x', channelId: 'c', status: 'scheduled', text: 'see you tomorrow' }, n));
    assert.equal(p.dueAt, null);
    assert.equal(p.shareNext, true);
  }
  const normal = shapePost({ id: 'x', channelId: 'c', status: 'scheduled', text: 't', shareMode: 'addToQueue', dueAt: '2026-11-05T15:39:00.000Z' });
  assert.equal(normal.shareNext, false);
  assert.equal(normal.dueAt, '2026-11-05T15:39:00.000Z');
});
