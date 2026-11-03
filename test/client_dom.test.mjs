/* The page's own request pacing, run on the real public/app.js with a fake DOM and clock (test/dom.mjs):
   the first-scan auto-retry happens once, a link to #lookback waits for a click, tab clicks wait out a countdown,
   and a refused link check is retried once. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { browser } from './dom.mjs';

const html = (status, ra) => new Response('<html>error</html>', { status, headers: Object.assign({ 'content-type': 'text/html' }, ra === undefined ? {} : { 'retry-after': ra }) });
const json = (obj, status, ra) => new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'content-type': 'application/json' }, ra === undefined ? {} : { 'retry-after': ra }) });
const emptyScan = (links) => json({ ok: true, channels: [], posts: [], links: links || [], ts: Date.now(), truncated: false, rateLow: false });

for (const [status, ra, expected] of [[503, undefined, 2], [429, undefined, 2], [429, '60', 2], [429, 'Wed, 21 Oct 2026 07:28:00 GMT', 2], [503, '0', 2], [429, '121', 1], [500, undefined, 1]]) {
  test('first scan refused (' + status + ', Retry-After ' + (ra || 'none') + '): ' + expected + ' scan request(s) in 10 minutes, never a loop', async () => {
    const b = browser();
    b.respond = (path) => (path === '/api/scan' ? html(status, ra) : json({}, 404));
    await b.load();
    assert.equal(b.count('/api/scan'), 1);
    await b.advance(600000);
    assert.equal(b.count('/api/scan'), expected);
    if (status !== 500) {
      /* the next scan waits (the button counts down) and the user can still scan by hand afterwards */
      assert.equal(b.$('rescan').disabled, false);
      b.$('rescan').click();
      await b.flush();
      assert.equal(b.count('/api/scan'), expected + 1);
      assert.equal(b.$('rescan').disabled, true, 'the button counts down after a pause');
      assert.match(b.$('rescan').textContent, /^Scan again in \d+ s$/);
      b.$('rescan').click();
      await b.flush();
      assert.equal(b.count('/api/scan'), expected + 1, 'no request during the countdown');
    }
  });
}

test('a link to /#lookback opens the tab but reads nothing until a click; tab clicks wait out the countdown', async () => {
  const b = browser();
  globalThis.location.hash = '#lookback';
  b.respond = (path) => (path === '/api/scan' ? emptyScan() : path === '/api/lookback' ? json({ ok: false, error: 'lookback_gap', message: 'You looked back less than two minutes ago.' }, 429, '120') : json({}, 404));
  await b.load();
  assert.equal(b.$('v-back').getAttribute('aria-pressed'), 'true', 'the Look back tab is open');
  assert.equal(b.count('/api/lookback'), 0, 'no Look back on load');
  const go = b.$('queue').find('back-go');
  assert.ok(go, 'a button to start it');
  go.click();
  await b.flush();
  assert.equal(b.count('/api/lookback'), 1);
  assert.match(b.$('queue').text(), /A short pause/);
  /* tab clicks and the retry button during the 120 s countdown: no request */
  for (let i = 0; i < 3; i++) {
    b.$('v-queue').click(); await b.flush();
    b.$('v-back').click(); await b.flush();
    const retry = b.$('queue').find('back-retry');
    assert.ok(retry && retry.disabled);
    retry.click(); await b.flush();
    await b.advance(30000);
  }
  assert.equal(b.count('/api/lookback'), 1);
  await b.advance(31000);
  b.$('v-back').click(); await b.flush();
  assert.equal(b.count('/api/lookback'), 2, 'after the countdown a click reads again');
});

test('a tab click without a pending countdown reads at once', async () => {
  const b = browser();
  b.respond = (path) => (path === '/api/scan' ? emptyScan() : path === '/api/lookback' ? json({ ok: true, channels: [], posts: [], calls: 0, orgsSkipped: 0, checkedAt: new Date().toISOString() }) : json({}, 404));
  await b.load();
  assert.equal(b.count('/api/lookback'), 0);
  b.$('v-back').click(); await b.flush();
  assert.equal(b.count('/api/lookback'), 1);
});

test('a refused link check (429) is retried once, then the links are marked not checked', async () => {
  const b = browser();
  const links = [{ url: 'https://a.example/x', sig: 's1' }, { url: 'https://b.example/y', sig: 's2' }];
  b.respond = (path) => (path === '/api/scan' ? emptyScan(links) : path === '/api/links' ? json({ ok: false, error: 'link_rate', message: 'Too many link checks at once.' }, 429, '10') : json({}, 404));
  await b.load();
  await b.advance(600000);
  assert.equal(b.count('/api/links'), 2, 'one batch, one retry, then it stops');
  assert.equal(b.count('/api/scan'), 1);
});
