/* The gate's rules on their own, and the CPU bounds of the checks on crafted input. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GateCore, LIMITS } from '../src/gate.js';
import { memStorage } from './fakes.mjs';
import { checkDuplicates, WORK_CAP } from '../src/checks/dupes.js';
import { runAll } from '../src/checks/index.js';
import { findFormatting, cleanFormatting } from '../src/checks/format.js';
import { findUrls } from '../src/checks/text.js';

function core(t0) { let t = t0 || Date.parse('2026-11-03T10:00:00Z'); const c = new GateCore(memStorage(), () => t); c.tick = (ms) => { t += ms; }; return c; }
const win = (r15, r24, t15, t24) => ({ a: { name: '15m', r: r15, t: t15 || 600, w: 900 }, b: { name: '24h', r: r24, t: t24 || 80000, w: 86400 } });

test('gate: unknown allowance admits; low 15-minute or 24-hour windows refuse scans but keep a reserve for sign-ins', async () => {
  const c = core();
  await c.bind('A', 'sk1');
  assert.equal((await c.admit('scan', 'A', 'sk1', 3)).ok, true);
  await c.record(win(22, 500));
  c.tick(61000);
  assert.equal((await c.admit('scan', 'A', 'sk1', 3)).code, 'app_busy');
  assert.equal((await c.admit('signin', null, null, 1)).ok, true, 'sign-ins keep working down to their own margin');
  await c.record(win(100, 140));
  assert.equal((await c.admit('fix', 'A', 'sk1', 2)).code, 'app_busy_day');
  /* after the 15-minute window resets, the estimate is unknown again and requests flow */
  await c.record(win(10, 500, 5));
  c.tick(6000);
  assert.equal((await c.admit('fix', 'A', 'sk1', 2)).ok, true);
});

test('gate: reservations stop parallel requests from overshooting the margin', async () => {
  const c = core();
  for (const acct of ['A', 'B', 'C', 'D']) await c.bind(acct, 'sk-' + acct);
  await c.record(win(28, 500));
  const r = [];
  for (const acct of ['A', 'B', 'C', 'D']) r.push((await c.admit('scan', acct, 'sk-' + acct, 3)).ok);
  assert.deepEqual(r, [true, true, false, false], '28 left, margin 20, 3 calls per scan: two scans fit');
});

test('gate: one live session per account; replaced and unbound sessions are refused', async () => {
  const c = core();
  assert.equal((await c.bind('A', 'sk1')).old, null);
  assert.equal((await c.bind('A', 'sk2')).old, 'sk1');
  assert.equal((await c.current('A', 'sk1')).ok, false);
  assert.equal((await c.admit('scan', 'A', 'sk1', 1)).code, 'replaced');
  assert.equal((await c.admitLinks('A', 'sk1', [{ h: 'x', site: 's' }])).code, 'replaced');
  await c.unbind('A', 'sk2');
  assert.equal((await c.current('A', 'sk2')).ok, false);
  for (let i = 0; i < LIMITS.signinsPerDay - 2; i++) await c.bind('A', 'sk' + (i + 3));
  assert.equal((await c.bind('A', 'skX')).code, 'signin_budget');
  c.tick(24 * 3600e3);
  assert.equal((await c.bind('A', 'skY')).ok, true, 'budgets reset with the UTC day');
});

test('gate: daily link budget per account', async () => {
  const c = core();
  await c.bind('A', 'sk1');
  const a = await c.account('A'); a.links = LIMITS.linksPerDay - 1; await c.saveAccount('A', a);
  const r = await c.admitLinks('A', 'sk1', [{ h: '1', site: 'a.org' }, { h: '2', site: 'b.org' }]);
  assert.deepEqual(r.results, ['ok', 'budget']);
});

const vocab = Array.from({ length: 400 }, (_, i) => 'w' + i);
const crafted = (n) => Array.from({ length: n }, (_, i) => { const w = vocab.slice(); w[i % 400] = 'z' + i; w.reverse(); return { id: 'p' + i, channelId: 'c' + (i % 3), channelService: 'twitter', status: 'scheduled', dueAt: new Date(Date.now() + i * 3600e3).toISOString(), createdAt: new Date().toISOString(), shareMode: 'customScheduled', isCustomScheduled: true, text: w.join(' '), allowedActions: [], assets: [], thread: [] }; });
const CH = [0, 1, 2].map((i) => ({ id: 'c' + i, service: 'twitter', timezone: 'UTC', name: 'X' + i, metadata: {} }));

test('repeats: bounded work on 300 crafted posts, and the result says it was partial', () => {
  const m = checkDuplicates(crafted(300), new Map(CH.map((c) => [c.id, c])));
  assert.ok(m.meta.steps <= WORK_CAP);
  assert.equal(m.meta.partial, true);
  const t0 = performance.now();
  const r = runAll(CH, crafted(300), new Date());
  assert.ok(performance.now() - t0 < 3000, 'all checks on 300 crafted posts in well under a few seconds');
  assert.equal(r.meta.repeatsPartial, true);
  const small = runAll(CH, crafted(20), new Date());
  assert.equal(small.meta.repeatsPartial, false);
});

test('repeats: identical texts are grouped in one pass, even many of them', () => {
  const same = Array.from({ length: 200 }, (_, i) => ({ id: 's' + i, channelId: 'c0', text: 'Exactly the same words every single time here', dueAt: new Date(Date.now() + i * 6e4).toISOString() }));
  const m = checkDuplicates(same, new Map(CH.map((c) => [c.id, c])));
  assert.equal(m.get('s0')[0].title, 'Same text queued 200 times on this channel');
  assert.equal(m.get('s5')[0].related.length, 10);
  assert.equal(m.meta.steps, 0, 'identical texts need no word-by-word comparison');
});

test('crafted 30,000-character drafts finish fast in every check', () => {
  const unit2 = '<a ' + 'href=href='.repeat(50) + 'y'.repeat(2000);
  for (const text of [unit2.repeat(12), 'https://x.org/' + ')'.repeat(30000), '['.repeat(15000) + ']'.repeat(15000), '#a-'.repeat(10000), 'Mon, Nov 3 - '.repeat(2300), '**'.repeat(15000), 'word '.repeat(40000)]) {
    const p = Object.assign({}, crafted(1)[0], { id: 'evil', status: 'draft', text });
    const t0 = performance.now();
    runAll(CH, [p], new Date());
    const ms = performance.now() - t0;
    assert.ok(ms < 400, text.slice(0, 12) + ' took ' + ms.toFixed(0) + ' ms');
  }
});

test('the linear <a> pattern finds the same links as before on normal input', () => {
  const good = 'Read <a href="https://ex.com/x" target="_blank">our post</a> and <b>bold</b> <a class=x href=https://e.org>e</a> <a name="top">top</a>';
  assert.equal(cleanFormatting(good), 'Read our post: https://ex.com/x and bold e: https://e.org top');
  assert.equal(findFormatting(good).length, 5);
  assert.equal(findUrls('x ' + ')'.repeat(5)).length, 0);
  assert.equal(findUrls('https://en.wikipedia.org/wiki/A_(b))).')[0].url, 'https://en.wikipedia.org/wiki/A_(b)');
});
