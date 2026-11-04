/* /try "Your own post": one typed post runs through the real checks in the tab. The text is rendered as text nodes
   (never handed to an HTML parser), flagged words are marked, suggestion buttons open the same edit dialog and
   diff, input is capped at 3,000 characters, links are listed but never opened, and the tab makes no network call. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { browser, FakeEl } from './dom.mjs';
import { checkOwn, clipOwn, defaultWhen, parseWhen, localZone, OWN_EXAMPLES, OWN_MAX } from '../public/own.js';
import { localParts } from '../public/checks/time.js';
import worker, { CSP } from '../src/index.js';
import { makeEnv } from './fakes.mjs';

const ORIGIN = 'https://lastlook.swiftbotlab.workers.dev';
const NOW = new Date('2026-11-03T12:00:00Z'); /* a Tuesday; the fake browser's clock starts here too */
const ids = (r) => r.post.flags.map((f) => f.id);

/* fake DOM tree helpers */
function nodes(root) { const out = []; const go = (n) => { out.push(n); for (const k of n.kids || []) if (k instanceof FakeEl) go(k); }; go(root); return out; }
const byClass = (root, c) => nodes(root).filter((n) => String(n.className || '').split(' ').includes(c));
const byTag = (root, t) => nodes(root).filter((n) => n.tag === t);
const buttons = (root, label) => byTag(root, 'button').filter((n) => n.text() === label);

async function tryPage(opts) {
  const b = browser(Object.assign({ meta: { mode: 'try' }, path: '/try' }, opts || {}));
  b.respond = async () => { throw new Error('the try page must not fetch'); };
  await b.load();
  return b;
}
async function type(b, text) {
  const box = b.$('own-text');
  box.value = text;
  box.fire('input');
  await b.advance(150);
}
function pick(b, id) { b.$(id).checked = true; b.$(id).fire('change'); }

/* the five-plus texts through the render path: what is shown, what is marked, which flags */
const CASES = [
  { name: 'an HTML image tag with an onerror handler', text: '<img src=x onerror=alert(1)>', ch: 'twitter', flags: [], marks: [] },
  { name: 'Markdown bold on X', text: '**bold**', ch: 'twitter', flags: ['format.md_bold'], marks: ['**bold**'], fix: ['Clean up formatting', 'bold'] },
  { name: 'a pasted link', text: 'Book a class here: https://example.com/classes?utm_source=x&a=1', ch: 'twitter', flags: [], marks: [], links: 1 },
  { name: '"Happy Friday" going out on a Monday', text: 'Happy Friday, team!', ch: 'linkedin', flags: ['time.wrong_day'], marks: ['Happy Friday'], fix: ['Say Monday', 'Happy Monday, team!'] },
  { name: 'HTML tags, an entity and a script tag on Bluesky', text: '<b>Sale</b> &amp; more <script>alert(1)</script>', ch: 'bluesky', flags: ['format.mixed'], marks: ['<b>', '</b>', '&amp;'], fix: ['Clean up formatting', 'Sale & more <script>alert(1)</script>'] },
  { name: 'a morning greeting and a past "today at 7pm" at 21:30, fixed time', text: 'Good morning! Doors open today at 7pm', ch: 'threads', when: '2026-11-09T21:30', fixed: true, flags: ['time.event_passed', 'time.greeting', 'time.relative_shift'], marks: ['Good morning', 'today at 7pm'], fix: ['Say "evening"', 'Good evening! Doors open today at 7pm'] },
  { name: 'an SVG onload payload after a javascript: string on Mastodon', text: 'javascript:alert(1) "><svg onload=alert(1)>', ch: 'mastodon', flags: [], marks: [] },
  { name: 'too long for X', text: 'a'.repeat(300), ch: 'twitter', flags: ['length.over'], marks: [] }
];

test('own post (pure): each case gets exactly the expected flags in any time zone; only text fixes are offered', () => {
  for (const tz of ['America/New_York', 'Asia/Kolkata', 'Pacific/Auckland', 'Europe/London']) {
    for (const c of CASES) {
      const r = checkOwn({ text: c.text, service: c.ch, when: c.when, queue: !c.fixed, now: NOW, tz });
      assert.deepEqual(ids(r), c.flags, c.name + ' in ' + tz);
      assert.equal(r.post.links.length, c.links || 0, c.name);
      for (const f of r.post.flags) assert.ok(f.fixes.every((x) => x.type === 'edit'), 'no drafts or queue moves for a single post');
      if (c.fix) assert.ok(r.post.flags.some((f) => f.fixes.some((x) => x.label === c.fix[0] && x.text === c.fix[1])), c.name + ': ' + c.fix[0]);
    }
  }
});

test('own post (pure): "goes out" defaults to the next Monday 09:30 local, and picker values are read strictly', () => {
  for (const tz of ['America/New_York', 'Asia/Kolkata', 'Pacific/Auckland']) {
    const v = defaultWhen(NOW, tz);
    const p = localParts(new Date(parseWhen(v, tz)), tz);
    assert.deepEqual([p.dow, p.hour, p.min], [1, 9, 30], tz);
    assert.ok(p.day > localParts(NOW, tz).day, 'never today');
    /* on a Monday the default is the Monday after */
    const mon = new Date(parseWhen(v, tz));
    assert.equal(localParts(new Date(parseWhen(defaultWhen(mon, tz), tz)), tz).day, p.day + 7);
  }
  for (const bad of ['', 'garbage', '2026-02-30T09:30', '2026-11-09T24:00', '2026-11-09T09:60', '1999-01-01T09:30', '2026-11-09 09:30', null, '2026-11-09T09:30' + 'x'.repeat(40)]) {
    assert.equal(parseWhen(bad, 'Asia/Kolkata'), null, String(bad));
  }
  assert.equal(parseWhen('2026-11-09T09:30:00', 'UTC'), '2026-11-09T09:30:00.000Z');
  /* an unreadable picker value falls back to the default instead of failing */
  const r = checkOwn({ text: 'Happy Friday!', service: 'twitter', when: 'garbage', now: NOW, tz: 'UTC' });
  assert.equal(r.usedDefault, true);
  assert.deepEqual(ids(r), ['time.wrong_day']);
  assert.ok(['string', 'undefined'].includes(typeof localZone()));
});

test('own post (pure): input is capped at 3,000 characters, never splitting an emoji; unknown channels fall back to X', () => {
  assert.equal(clipOwn('x'.repeat(5000)).length, OWN_MAX);
  const s = 'x'.repeat(OWN_MAX - 1) + '😀';
  assert.equal(clipOwn(s).length, OWN_MAX - 1, 'half an emoji is dropped, not kept');
  assert.equal(clipOwn('a\r\nb\rc'), 'a\nb\nc');
  const r = checkOwn({ text: 'x'.repeat(9000), service: '<script>', now: NOW, tz: 'UTC' });
  assert.equal(r.text.length, OWN_MAX);
  assert.equal(r.full, true);
  assert.equal(r.channel.service, 'twitter');
  assert.ok(ids(r).includes('length.over'));
});

test('own post (pure): the three one-tap examples catch what their labels promise', () => {
  const tz = 'Europe/London';
  const slip = checkOwn({ text: OWN_EXAMPLES.slip.text, service: OWN_EXAMPLES.slip.service, queue: OWN_EXAMPLES.slip.queue, now: NOW, tz });
  assert.deepEqual(ids(slip), ['time.wrong_day']);
  assert.match(slip.post.flags[0].title, /"Happy Friday" goes out on a Monday/);
  assert.equal(slip.post.flags[0].fixes[0].label, 'Say Monday');
  const tom = checkOwn({ text: OWN_EXAMPLES.tomorrow.text, service: OWN_EXAMPLES.tomorrow.service, queue: true, now: NOW, tz });
  assert.deepEqual(ids(tom), ['time.relative_queue']);
  /* the same words at a fixed time: only a note that "tomorrow" will mean the day after the send day */
  const fixed = checkOwn({ text: OWN_EXAMPLES.tomorrow.text, service: OWN_EXAMPLES.tomorrow.service, queue: false, now: NOW, tz });
  assert.deepEqual(ids(fixed), ['time.relative_shift']);
  assert.equal(fixed.post.flags[0].severity, 'low');
  const raw = checkOwn({ text: OWN_EXAMPLES.raw.text, service: OWN_EXAMPLES.raw.service, queue: true, now: NOW, tz });
  assert.equal(OWN_EXAMPLES.raw.service, 'twitter');
  assert.deepEqual(ids(raw), ['format.md_bold']);
  assert.ok(!raw.post.flags[0].fixes[0].text.includes('**'));
  assert.deepEqual(raw.post.links.map((l) => l.url), ['https://example.com/book']);
});

for (const c of CASES) {
  test('own post (render): ' + c.name + ' is shown as plain text, with the expected marks and flag cards', async () => {
    const b = await tryPage();
    pick(b, 'own-ch-' + c.ch);
    if (c.fixed) pick(b, 'own-mode-fixed');
    if (c.when) { b.$('own-when').value = c.when; b.$('own-when').fire('change'); }
    await type(b, c.text);
    const res = b.$('own-result');
    const pt = byClass(res, 'post-text');
    assert.equal(pt.length, 1);
    /* the text comes back exactly as typed, built only from text nodes and <mark> wrappers */
    assert.equal(pt[0].text(), c.text);
    for (const n of nodes(pt[0]).slice(1)) assert.ok(['#text', '#frag', 'mark'].includes(n.tag), 'unexpected <' + n.tag + '> inside the post text');
    assert.deepEqual(byTag(pt[0], 'mark').map((m) => m.text()), c.marks);
    /* nothing in the result is an element the text asked for */
    for (const t of ['img', 'script', 'svg', 'a', 'iframe', 'b']) assert.equal(byTag(res, t).length, 0, '<' + t + '> in the result');
    /* one flag card per flag, with the same titles the checks give */
    const expect = checkOwn({ text: c.text, service: c.ch, when: c.when || b.$('own-when').value, queue: !c.fixed, now: new Date(Date.now()), tz: localZone() });
    assert.deepEqual(ids(expect), c.flags);
    const cards = byClass(res, 'flag').filter((n) => !String(n.className).includes('sev-info'));
    assert.deepEqual(cards.map((n) => byTag(n, 'strong')[0].text()), expect.post.flags.map((f) => f.title));
    const info = byClass(res, 'sev-info');
    assert.equal(info.length, c.links ? 1 : 0);
    if (c.links) assert.match(info[0].text(), /will be opened on a real queue/);
    if (c.fix) assert.equal(buttons(res, c.fix[0]).length, 1, 'the "' + c.fix[0] + '" button');
    if (!c.flags.length) assert.equal(byClass(res, 'clear-line').length, 1);
    assert.equal(b.requests.length, 0, 'no network call');
  });
}

test('own post (render): checks run 150 ms after typing stops; the count updates at once', async () => {
  const b = await tryPage();
  const box = b.$('own-text');
  box.value = 'Happy Friday!';
  box.fire('input');
  assert.match(b.$('own-count').textContent, /^13 \/ 280 for X$/, 'the count is immediate');
  await b.advance(100);
  assert.equal(byClass(b.$('own-result'), 'post-text').length, 0, 'not yet checked');
  /* more typing inside the window restarts it */
  box.value = 'Happy Friday, all!';
  box.fire('input');
  await b.advance(100);
  assert.equal(byClass(b.$('own-result'), 'post-text').length, 0);
  await b.advance(50);
  assert.equal(byClass(b.$('own-result'), 'post-text')[0].text(), 'Happy Friday, all!');
  assert.match(b.$('own-status').textContent, /1 to fix before it posts/);
  /* a pasted 5,000 characters: 3,000 are checked and the box says so */
  box.value = 'x'.repeat(5000);
  box.fire('input');
  await b.advance(150);
  assert.equal(byClass(b.$('own-result'), 'post-text')[0].text().length, 3000);
  assert.match(b.$('own-count').textContent, /this box takes up to 3,000/);
  assert.equal(b.$('own-count').classList.contains('over'), true);
});

test('own post (render): a suggestion opens the same edit dialog with a diff; accepting it updates the box, Undo restores it', async () => {
  const b = await tryPage();
  b.$('own-ex-slip').click();
  await b.flush();
  assert.equal(b.$('own-text').value, OWN_EXAMPLES.slip.text);
  const say = buttons(b.$('own-result'), 'Say Monday');
  assert.equal(say.length, 1);
  say[0].click();
  assert.equal(b.$('dlg').open, true);
  assert.equal(b.$('dlg-title').textContent, 'Say Monday');
  assert.equal(b.$('dlg-ok').textContent, 'Use this text');
  assert.match(b.$('dlg-text').value, /^Happy Monday, everyone!/);
  const diff = b.$('dlg-diff');
  assert.deepEqual(byTag(diff, 'del').map((n) => n.text()), ['Friday']);
  assert.deepEqual(byTag(diff, 'ins').map((n) => n.text()), ['Monday']);
  b.$('dlg-ok').click();
  await b.flush();
  assert.equal(b.$('dlg').open, false);
  assert.match(b.$('own-text').value, /^Happy Monday, everyone!/);
  assert.equal(byClass(b.$('own-result'), 'clear-line').length, 1, 'nothing left to catch');
  assert.equal(b.$('undo-bar').hidden, false);
  b.$('undo-btn').click();
  await b.flush();
  assert.equal(b.$('own-text').value, OWN_EXAMPLES.slip.text);
  assert.equal(buttons(b.$('own-result'), 'Say Monday').length, 1);
  assert.equal(b.$('undo-bar').hidden, true);
  /* the other examples: the raw-formatting one is on X and lists its link */
  b.$('own-ex-raw').click();
  await b.flush();
  assert.equal(b.$('own-ch-twitter').checked, true);
  assert.equal(buttons(b.$('own-result'), 'Clean up formatting').length, 1);
  assert.equal(byClass(b.$('own-result'), 'sev-info').length, 1);
  b.$('own-ex-tomorrow').click();
  await b.flush();
  assert.equal(buttons(b.$('own-result'), 'Show in the text').length, 1, 'a flag without a suggested text points at the words');
  pick(b, 'own-mode-fixed');
  assert.match(b.$('own-status').textContent, /^1 note$/);
  assert.equal(b.requests.length, 0);
});

test('own post: the try page makes zero network calls, whatever is typed, picked or fixed', async () => {
  const b = await tryPage();
  await b.advance(2000);
  for (const t of ['https://example.com/a', 'www.example.org', 'http://localhost:8080/admin', 'http://169.254.169.254/latest', '<img src="https://tracker.example/p.gif">', '![x](https://example.com/i.png)']) {
    for (const ch of ['twitter', 'linkedin', 'bluesky', 'threads', 'instagram', 'mastodon']) { pick(b, 'own-ch-' + ch); await type(b, t); }
  }
  for (const k of Object.keys(OWN_EXAMPLES)) { b.$('own-ex-' + k).click(); await b.flush(); }
  for (const x of nodes(b.$('own-result')).filter((n) => n.tag === 'button')) { x.click(); await b.flush(); }
  b.$('dlg-ok').click();
  await b.advance(60000);
  /* switching tabs and back: the sample queue and Look back use the local sample, never the server */
  b.$('v-queue').click(); await b.flush();
  b.$('v-back').click(); await b.flush();
  b.$('v-own').click(); await b.flush();
  assert.equal(b.requests.length, 0, 'fetch was called: ' + b.requests.join(', '));
  /* and the code has no way to: no network API in the own-post module or in its part of app.js */
  const NET = /\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|new Image\b|\bimport\(|localStorage|sessionStorage|indexedDB|\.src\s*=|innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/;
  const ownSrc = readFileSync(new URL('../public/own.js', import.meta.url), 'utf8');
  assert.ok(!NET.test(ownSrc), String(ownSrc.match(NET)));
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const part = app.slice(app.indexOf('/* ---------- Your own post'), app.indexOf('/* ---------- scanning and link checks'));
  assert.ok(part.length > 2000, 'found the own-post part of app.js');
  assert.ok(!NET.test(part) && !/\bapi\(|backend\./.test(part), String(part.match(NET)));
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/.test(app), 'app.js never parses strings as HTML or code');
});

test('own post: /try opens on "Your own post"; /try#sample opens the sample queue; the tabs switch views', async () => {
  const b = await tryPage();
  assert.equal(b.$('v-own').getAttribute('aria-pressed'), 'true');
  assert.equal(b.$('own').hidden, false);
  for (const id of ['try-banner', 'summary', 'toolbar', 'queue']) assert.equal(b.$(id).hidden, true, id);
  b.$('v-queue').click(); await b.flush();
  assert.equal(b.$('own').hidden, true);
  assert.equal(b.$('queue').hidden, false);
  assert.equal(globalThis.location.hash, '#sample');
  assert.match(b.$('headline').textContent, /posts? need/);
  b.$('v-own').click(); await b.flush();
  assert.equal(b.$('own').hidden, false);
  assert.equal(globalThis.location.hash, '');
  const s = await tryPage({ hash: '#sample' });
  assert.equal(s.$('v-queue').getAttribute('aria-pressed'), 'true');
  assert.equal(s.$('own').hidden, true);
  assert.equal(s.requests.length + b.requests.length, 0);
});

test('own post: /try serves the composer as static markup under the unchanged CSP (no inline script, style or handler)', async () => {
  const env = makeEnv();
  const r = await worker.fetch(new Request(ORIGIN + '/try', { headers: { 'cf-connecting-ip': '203.0.113.9' } }), env);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-security-policy'), CSP);
  assert.match(CSP, /script-src 'self';/);
  assert.ok(!/unsafe-inline|unsafe-eval/.test(CSP));
  const html = await r.text();
  assert.match(html, /id="v-own" aria-pressed="true">Your own post</);
  assert.match(html, /<textarea id="own-text"[^>]* maxlength="3000"/);
  for (const svc of ['twitter', 'linkedin', 'bluesky', 'threads', 'instagram', 'mastodon']) assert.match(html, new RegExp('id="own-ch-' + svc + '"'));
  for (const [k, ex] of Object.entries(OWN_EXAMPLES)) assert.ok(html.includes('id="own-ex-' + k + '">' + ex.label + '<'), 'example ' + k + ' label in step with own.js');
  assert.match(html, /<a href="\/oauth\/start">Run this on your real Buffer queue<\/a>/);
  assert.match(html, /<input type="datetime-local" id="own-when"/);
  /* every script is an external same-origin module; no inline styles or event handler attributes */
  const scripts = html.match(/<script\b[^>]*>/g) || [];
  assert.deepEqual(scripts, ['<script type="module" src="/app.js?v=20261104a">']);
  assert.ok(!/\sstyle=/i.test(html), 'inline style attribute');
  assert.ok(!/\son[a-z]+=/i.test(html), 'inline event handler');
  assert.equal(env.SESSIONS._m.size, 0);
  assert.equal(env.GATE.calls, 0);
  const landing = await (await worker.fetch(new Request(ORIGIN + '/'), env)).text();
  assert.match(landing, /<a class="btn btn-lg" href="\/try">Try it on your own post<\/a>/);
});

test('own post (render): a cleared or unreadable picker says it uses next Monday 09:30; a past time says so too', async () => {
  const b = await tryPage();
  await type(b, 'Happy Friday!');
  assert.match(b.$('own-zone').textContent, /^Monday \d+ November, in your time zone/);
  b.$('own-when').value = ''; b.$('own-when').fire('change');
  assert.match(b.$('own-zone').textContent, /^No time picked, so this uses next Monday at 09:30: Monday/);
  b.$('own-when').value = '2026-02-30T09:30'; b.$('own-when').fire('change');
  assert.match(b.$('own-zone').textContent, /^That date could not be read/);
  b.$('own-when').value = '2026-11-01T09:30'; b.$('own-when').fire('change');
  assert.match(b.$('own-zone').textContent, /^That time has already passed/);
  assert.equal(b.$('own-zone').classList.contains('is-past'), true);
  assert.equal(b.requests.length, 0);
});
