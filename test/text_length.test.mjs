import test from 'node:test';
import assert from 'node:assert/strict';
import { findUrls, maskUrls, similarity, normalizeForCompare, graphemeCount } from '../src/checks/text.js';
import { twitterLength, blueskyLength, blueskyShortUrl, lengthFor, limitFor, checkLength } from '../src/checks/length.js';
import { post, BSKY, X, ids } from './helpers.mjs';

test('findUrls trims trailing punctuation and keeps balanced parentheses', () => {
  const u = findUrls('See https://a.example.org/x. and (https://en.wikipedia.org/wiki/Foo_(bar)) or www.b.org/y!');
  assert.deepEqual(u.map((x) => x.url), ['https://a.example.org/x', 'https://en.wikipedia.org/wiki/Foo_(bar)', 'https://www.b.org/y']);
  assert.equal(findUrls('[t](https://c.org/p)')[0].url, 'https://c.org/p');
});
test('findUrls: no false links in plain text', () => {
  assert.equal(findUrls('version 1.2.3 is out, e.g. today. node.js rocks').length, 0);
});
test('maskUrls keeps length and blanks the link', () => {
  const s = 'a https://x.org/__b__/c d';
  const m = maskUrls(s);
  assert.equal(m.length, s.length);
  assert.ok(!m.includes('__'));
});
test('similarity: one inserted word is near, different text is far', () => {
  const a = normalizeForCompare('We just shipped dark mode. Try it and tell us what you think!');
  const b = normalizeForCompare('We just shipped dark mode! Try it today and tell us what you think.');
  const c = normalizeForCompare('Our hiring page is live; we are looking for two designers in Lisbon.');
  assert.ok(similarity(a, b) >= 0.8, 'near duplicate');
  assert.ok(similarity(a, c) < 0.5, 'different');
  assert.equal(normalizeForCompare('Hi https://x.org/a?utm_source=y'), normalizeForCompare('hi https://www.x.org/a/'));
});

test('X weighted length: links 23, emoji 2, CJK 2', () => {
  assert.equal(twitterLength('hello'), 5);
  assert.equal(twitterLength('https://example.org/a/very/long/path/that/is/long'), 23);
  assert.equal(twitterLength('🚀'), 2);
  assert.equal(twitterLength('👨‍👩‍👧'), 2);
  assert.equal(twitterLength('日本'), 4);
  assert.equal(twitterLength('café'), 4);
});
test('Bluesky length: graphemes, links shortened like the app', () => {
  assert.equal(blueskyLength('👨‍👩‍👧'), 1);
  assert.equal(blueskyShortUrl('https://example.org/'), 'example.org');
  assert.equal(blueskyShortUrl('https://example.org/abcdefghijklmnopqrstuvwxyz'), 'example.org/abcdefghijkl...');
  assert.equal(blueskyLength('x https://example.org/abcdefghijklmnopqrstuvwxyz'), 2 + 'example.org'.length + 16);
});
test('LinkedIn counts links as 24, Instagram newlines as 2, Mastodon drops the mention server', () => {
  assert.equal(lengthFor('linkedin', 'a https://example.org/very/long/link/here'), 2 + 24);
  assert.equal(lengthFor('instagram', 'a\nb'), 4);
  assert.equal(lengthFor('mastodon', '@alice@mastodon.social hi'), '@alice hi'.length);
  assert.equal(lengthFor('threads', '🚀'), 2);
});
test('limits per channel: X premium, Mastodon server, TikTok video', () => {
  assert.equal(limitFor('twitter', { metadata: {} }), 280);
  assert.equal(limitFor('twitter', { metadata: { subscriptionType: 'premium' } }), 25000);
  assert.equal(limitFor('mastodon', { metadata: { maxCharacters: 1000 } }), 1000);
  assert.equal(limitFor('mastodon', { metadata: {} }), 500);
  assert.equal(limitFor('tiktok', {}, { assets: [{ type: 'video' }] }), 2200);
  assert.equal(limitFor('bluesky', {}), 300);
  assert.equal(limitFor('startPage', {}), null);
});
test('checkLength flags over-length posts and not posts at the limit', () => {
  const over = checkLength(post('a'.repeat(301)), BSKY);
  assert.deepEqual(ids(over), ['length.over']);
  assert.equal(over[0].data.count, 301);
  assert.deepEqual(checkLength(post('a'.repeat(300)), BSKY), []);
  assert.deepEqual(ids(checkLength(post('🚀'.repeat(141), { channelService: 'twitter', channelId: 'c2' }), X)), ['length.over']);
  assert.deepEqual(checkLength(post('🚀'.repeat(140), { channelService: 'twitter', channelId: 'c2' }), X), []);
});
test('checkLength checks each thread part and first comments', () => {
  const th = post('a', { thread: [{ text: 'ok' }, { text: 'b'.repeat(400) }] });
  const f = checkLength(th, BSKY);
  assert.equal(f.length, 1);
  assert.equal(f[0].where, 'thread:1');
  const li = checkLength(post('hi', { firstComment: 'c'.repeat(1300) }), { service: 'linkedin' });
  assert.deepEqual(ids(li), ['length.first_comment']);
  assert.equal(graphemeCount('é'), 1);
});
