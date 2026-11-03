import test from 'node:test';
import assert from 'node:assert/strict';
import { checkTime, checkNight, findDates, localParts } from '../src/checks/time.js';
import { checkDuplicates } from '../src/checks/dupes.js';
import { runChecks } from '../src/checks/index.js';
import { post, BSKY, X, ids } from './helpers.mjs';

const NOW = new Date('2026-11-03T03:00:00Z');
/* 2026-11-30T15:42Z = Mon 30 Nov 21:12 in Asia/Kolkata */
const t = (text, extra, ch) => checkTime(post(text, extra), ch || BSKY, NOW);

test('local time is judged in the channel time zone', () => {
  const p = localParts(new Date('2026-11-30T20:00:00Z'), 'Asia/Kolkata');
  assert.deepEqual([p.d, p.hour, p.min], [1, 1, 30]);
  assert.equal(localParts(new Date('2026-11-30T20:00:00Z'), 'Not/AZone').tz, 'Europe/London');
});
test('past dates: flagged when past at send time, not when still ahead', () => {
  const f = t('Sale ends Nov 20!');
  assert.deepEqual(ids(f), ['time.past_date']);
  assert.equal(f[0].severity, 'high');
  assert.deepEqual(t('Sale ends December 4th!'), []);
  assert.deepEqual(t('Join us on 2026-12-01'), []);
  assert.deepEqual(ids(t('Join us on 2026-11-29')), ['time.past_date']);
  assert.deepEqual(ids(t('Webinar Nov 28-29, register now')), ['time.past_date']);
  assert.deepEqual(t('Webinar Nov 28 - Dec 2, register now'), []);
});
test('past dates: a retrospective mention far back is only a note', () => {
  const f = t('We started this on March 3, 2019 and never looked back.');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'low');
});
test('year inference across the new year', () => {
  const send = localParts(new Date('2026-12-30T10:00:00Z'), 'UTC');
  assert.equal(findDates('see you Jan 3', send)[0].y, 2027);
  const f = checkTime(post('Doors open Jan 3!', { dueAt: '2026-12-30T10:00:00Z' }), { service: 'bluesky', timezone: 'UTC' }, NOW);
  assert.deepEqual(f, []);
});
test('weekday that does not match its date', () => {
  assert.deepEqual(ids(t('Live on Thursday, December 3!')), []);
  assert.ok(ids(t('Live on Friday, December 3!')).includes('time.weekday_mismatch'));
});
test('lower-case "may" is not a month', () => {
  assert.deepEqual(t('you may 2 times a day see this'), []);
});
test('relative words in a queue slot are flagged; with a fixed time only when the meaning moved', () => {
  const q = t('Launching tomorrow!', { isCustomScheduled: false, shareMode: 'addToQueue' });
  assert.deepEqual(ids(q), ['time.relative_queue']);
  assert.equal(q[0].severity, 'medium');
  const c = t('Launching tomorrow!');
  assert.deepEqual(ids(c), ['time.relative_shift']);
  assert.equal(c[0].severity, 'low');
  assert.deepEqual(t('Launching tomorrow!', { createdAt: '2026-11-30T02:00:00Z' }), []);
});
test('relative word next to a date that disagrees', () => {
  const f = t('Doors open tomorrow (Dec 5)');
  assert.deepEqual(ids(f), ['time.relative_conflict']);
  assert.deepEqual(t('Doors open tomorrow (Dec 1)'), []);
});
test('event time that will have passed', () => {
  assert.deepEqual(ids(t('Join us tonight at 7pm', { createdAt: '2026-11-30T02:00:00Z' })), ['time.event_passed']);
  assert.deepEqual(t('Join us tonight at 10pm', { createdAt: '2026-11-30T02:00:00Z' }), []);
  assert.deepEqual(t('today, 3 new features', { createdAt: '2026-11-30T02:00:00Z' }), []);
});
test('greetings and day names on the wrong day or hour', () => {
  const g = t('Good morning, friends', { createdAt: '2026-11-30T02:00:00Z' });
  assert.deepEqual(ids(g), ['time.greeting']);
  assert.equal(g[0].fixes[0].text, 'Good evening, friends');
  const d = t('Happy Friday everyone #FridayFeeling');
  assert.deepEqual(ids(d), ['time.wrong_day', 'time.wrong_day']);
  assert.equal(d[0].fixes[0].text, 'Happy Monday everyone #FridayFeeling');
  assert.deepEqual(t('Happy Monday #MondayMotivation'), []);
  assert.deepEqual(ids(t('TGIF!')), ['time.wrong_day']);
});
test('holiday greetings out of season', () => {
  assert.deepEqual(ids(t('Merry Christmas to all')), ['time.holiday']);
  assert.deepEqual(checkTime(post('Merry Christmas to all', { dueAt: '2026-12-24T10:00:00Z', createdAt: '2026-12-24T09:00:00Z' }), BSKY, NOW), []);
  assert.deepEqual(checkTime(post('Happy Thanksgiving', { dueAt: '2026-11-26T15:00:00Z', createdAt: '2026-11-26T09:00:00Z' }), X, NOW), []);
});
test('no due time, no time checks', () => {
  assert.deepEqual(checkTime(post('tomorrow Nov 2', { dueAt: null }), BSKY, NOW), []);
});
test('night-time send', () => {
  assert.deepEqual(ids(checkNight(post('x', { dueAt: '2026-11-30T21:00:00Z' }), BSKY)), ['night.small_hours']);
  assert.deepEqual(checkNight(post('x'), BSKY), []);
});

const chMap = new Map([['c1', BSKY], ['c2', X], ['c3', { id: 'c3', service: 'bluesky', timezone: 'UTC', name: 'Other' }]]);
test('duplicates: same text on one channel is high, the later one gets the draft fix', () => {
  const a = post('We just shipped dark mode. Try it and tell us!', { id: 'a', dueAt: '2026-12-01T10:00:00Z' });
  const b = post('We just shipped dark mode. Try it and tell us!', { id: 'b', dueAt: '2026-12-03T10:00:00Z' });
  const m = checkDuplicates([a, b], chMap);
  assert.equal(m.get('a')[0].id, 'dupe.same_channel');
  assert.equal(m.get('a')[0].severity, 'high');
  assert.ok(m.get('b')[0].fixes.some((x) => x.type === 'draft'));
  assert.ok(!m.get('a')[0].fixes.some((x) => x.type === 'draft'));
});
test('duplicates: near duplicates are medium, different texts are left alone', () => {
  const a = post('We just shipped dark mode. Try it and tell us what you think!', { id: 'a' });
  const b = post('We just shipped dark mode! Try it today and tell us what you think.', { id: 'b' });
  const c = post('Hiring two designers in Lisbon, remote friendly, apply by Friday.', { id: 'c' });
  const m = checkDuplicates([a, b, c], chMap);
  assert.equal(m.get('a')[0].id, 'dupe.near_same_channel');
  assert.equal(m.has('c'), false);
});
test('duplicates across channels: same time is cross-posting, different time is a note', () => {
  const a = post('Same words on two networks today', { id: 'a', channelId: 'c1', dueAt: '2026-12-01T10:00:00Z' });
  const b = post('Same words on two networks today', { id: 'b', channelId: 'c3', dueAt: '2026-12-01T10:05:00Z' });
  assert.equal(checkDuplicates([a, b], chMap).size, 0);
  const c = post('Same words on two networks today', { id: 'c', channelId: 'c3', dueAt: '2026-12-04T10:00:00Z' });
  const m = checkDuplicates([a, c], chMap);
  assert.equal(m.get('a')[0].id, 'dupe.cross_channel');
  assert.equal(m.get('a')[0].severity, 'low');
});
test('runChecks: drafts are not compared as duplicates, fixes follow what the post allows', () => {
  const a = post('Exactly the same words in both of these posts', { id: 'a' });
  const d = post('Exactly the same words in both of these posts', { id: 'd', status: 'draft' });
  const out = runChecks([BSKY], [a, d], NOW);
  assert.ok(!out.find((p) => p.id === 'a').flags.some((f) => f.check === 'dupe'));
  const th = runChecks([BSKY], [post('**x** y', { thread: [{ text: '**x** y' }, { text: 'z' }] })], NOW)[0];
  assert.equal(th.allowed.edit, false);
  const q = runChecks([BSKY], [post('hi', { isCustomScheduled: false, shareMode: 'addToQueue' })], NOW)[0];
  assert.equal(q.allowed.move, true);
  const ro = runChecks([BSKY], [post('**x**', { allowedActions: ['viewPost'] })], NOW)[0];
  assert.deepEqual([ro.allowed.edit, ro.allowed.draft], [false, false]);
  assert.deepEqual(ro.flags[0].fixes, []);
});
test('runChecks lists links with their places', () => {
  const out = runChecks([BSKY], [post('a https://x.org/1 b https://x.org/1', { linkAttachment: 'https://y.org/' })], NOW)[0];
  assert.deepEqual(out.links.map((l) => [l.url, l.places.length]), [['https://x.org/1', 2], ['https://y.org/', 1]]);
});
