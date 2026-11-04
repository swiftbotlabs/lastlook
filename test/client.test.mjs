import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { diffTokens } from '../public/app.js';

test('browser copies of the check modules match the server ones', () => {
  for (const f of ['index.js', 'text.js', 'length.js', 'time.js', 'format.js', 'dupes.js', 'extra.js', 'lookback.js']) assert.equal(readFileSync(new URL('../public/checks/' + f, import.meta.url), 'utf8'), readFileSync(new URL('../src/checks/' + f, import.meta.url), 'utf8'), f);
});
test('word diff marks only what changed', () => {
  const d = diffTokens('Edit me: **this** now', 'Edit me: this now');
  assert.deepEqual(d.filter((x) => x.t !== 'eq').map((x) => x.t + ':' + x.s), ['del:**', 'del:**']);
  assert.equal(d.filter((x) => x.t !== 'del').map((x) => x.s).join(''), 'Edit me: this now');
  assert.equal(d.filter((x) => x.t !== 'ins').map((x) => x.s).join(''), 'Edit me: **this** now');
});
test('client renders post text with textContent only', () => {
  const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(src));
});
test('calm states: limits and 429 read as a short pause with a time to come back', async () => {
  const { retryText, isCalm, calmText } = await import('../public/app.js');
  const t0 = new Date(2026, 10, 3, 14, 0, 0).getTime();
  assert.equal(retryText(30, t0), 'Try again in about a minute');
  assert.equal(retryText(420, t0), 'Try again at 14:07, in about 7 minutes');
  assert.equal(retryText(3600, t0), 'Try again after 15:00');
  assert.ok(isCalm({ status: 429, code: 'scan_gap' }) && isCalm({ status: 429, code: 'buffer_rate' }) && isCalm({ status: 503 }));
  assert.ok(!isCalm({ status: 502, code: 'buffer_upstream', message: 'x' }));
  const m = calmText({ status: 429, code: 'app_busy', retryAfter: 300 });
  assert.match(m, /shared allowance/);
  assert.match(m, /Nothing was changed\.$/);
});
test('empty queue points to Look back and the sample; error copy never blames the user', () => {
  const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(src, /'Look back at sent posts'/);
  assert.match(src, /href: '\/try#sample' \}, 'See a sample queue'/);
});
