import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { diffTokens } from '../public/app.js';

test('browser copies of the check modules match the server ones', () => {
  for (const f of ['index.js', 'text.js', 'length.js', 'time.js', 'format.js', 'dupes.js', 'extra.js']) assert.equal(readFileSync(new URL('../public/checks/' + f, import.meta.url), 'utf8'), readFileSync(new URL('../src/checks/' + f, import.meta.url), 'utf8'), f);
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
