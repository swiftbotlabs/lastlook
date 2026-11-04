/* Per-channel rules: an avoid list (with a word to say instead) and must-haves, per channel. The rules are cleaned
   and capped, matched literally on whole words outside links, checked on every post of their channel with a fix,
   kept in the browser only (never sent to the server or Buffer), and the /try sample carries its own. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { browser, FakeEl } from './dom.mjs';
import { cleanRules, parseRuleLines, findPhrase, checkRules, rulesSummary, RULES_MAX } from '../src/checks/rules.js';
import { runAll } from '../src/checks/index.js';
import { SampleBackend, SAMPLE_RULES } from '../public/sample.js';

const CH = { id: 'ch1', displayName: 'Kiln (X)', name: 'kiln', service: 'twitter', timezone: 'America/New_York' };
const post = (text, extra) => Object.assign({ id: 'p1', channelId: 'ch1', channelService: 'twitter', status: 'scheduled', text, dueAt: '2026-11-20T15:00:00Z', shareMode: 'addToQueue', isCustomScheduled: false, allowedActions: ['updatePost', 'movePostToDraft'], assets: [], thread: [] }, extra || {});
const R = (banned, required) => cleanRules({ ch1: { banned, required: required || [] } }).ch1;

test('cleanRules: shapes, caps, bad ids, duplicates and prototype keys are dropped', () => {
  const r = cleanRules({ ch1: { banned: [{ phrase: '  sneak   peek ', instead: 'first look' }, 'Sneak Peek', 'x', 'cheap', { phrase: 'same', instead: 'SAME' }, { phrase: 'ok phrase', instead: 'y'.repeat(61) }, 42, null], required: ['#ad', '#AD', 'cheap', ''], extra: 1 } });
  assert.deepEqual(JSON.parse(JSON.stringify(r)), { ch1: { banned: [{ phrase: 'sneak peek', instead: 'first look' }, { phrase: 'cheap', instead: null }], required: ['#ad'] } });
  assert.equal(Object.getPrototypeOf(r), null);
  const p = cleanRules(JSON.parse('{"__proto__": {"banned": ["evil"]}, "constructor": {"banned": ["evil"]}, "bad id!": {"banned": ["evil"]}, "ok": {"banned": ["fine"]}}'));
  assert.deepEqual(Object.keys(p), ['ok']);
  assert.equal({}.banned, undefined, 'nothing reached Object.prototype');
  /* invisible and control characters never reach a rule */
  assert.deepEqual(cleanRules({ c: { banned: ['ne​ver\u0007 say'] } }).c.banned, [{ phrase: 'ne ver say', instead: null }]);
  /* caps: phrases per channel, channels, phrase length */
  const many = cleanRules({ c: { banned: Array.from({ length: 50 }, (_, i) => 'phrase ' + i), required: Array.from({ length: 50 }, (_, i) => '#tag' + i) } });
  assert.equal(many.c.banned.length, RULES_MAX.banned);
  assert.equal(many.c.required.length, RULES_MAX.required);
  const chans = {}; for (let i = 0; i < 100; i++) chans['c' + i] = { banned: ['word'] };
  assert.equal(Object.keys(cleanRules(chans)).length, RULES_MAX.channels);
  assert.deepEqual(Object.keys(cleanRules({ c: { banned: ['a'.repeat(61)] } })), [], 'too long: dropped, and an empty rule set is no rule set');
  for (const bad of [null, 'x', 7, [], [{ banned: ['x'] }]]) assert.deepEqual(Object.keys(cleanRules(bad)), []);
});

test('parseRuleLines: one rule per line, "old => new" (or -> or →) suggests a word, errors name the line', () => {
  const p = parseRuleLines('sneak peek => first look\n  cheap  \nbuy now -> shop now\nsale → offer\n\n', '#ad\nLittle Kiln');
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.banned, [{ phrase: 'sneak peek', instead: 'first look' }, { phrase: 'cheap', instead: null }, { phrase: 'buy now', instead: 'shop now' }, { phrase: 'sale', instead: 'offer' }]);
  assert.deepEqual(p.required, ['#ad', 'Little Kiln']);
  const e = parseRuleLines('a\nfine => \nsame => same\n' + 'z'.repeat(70), 'b');
  assert.equal(e.errors.length, 4, e.errors.join(' | '));
  assert.match(e.errors[0], /“a”: each phrase needs 2 to 60 characters/);
  assert.match(e.errors[1], /same word/);
  assert.match(e.errors[3], /“b”/, 'the must-have box is checked too');
  assert.deepEqual(e.banned, [{ phrase: 'fine', instead: null }], 'a trailing => with nothing after it is just the phrase');
  const over = parseRuleLines(Array.from({ length: 25 }, (_, i) => 'word' + i).join('\n'), '');
  assert.match(over.errors.join(' '), /Up to 20 phrases/);
});

test('findPhrase: literal, case-insensitive, whole words; hashtags end where the tag ends', () => {
  assert.deepEqual(findPhrase('Sneak peek! sneakpeek. SNEAK PEEK', 'sneak peek'), [[0, 10], [23, 33]]);
  assert.deepEqual(findPhrase('cheap cheaper #cheap ohcheap cheap.', 'cheap'), [[0, 5], [15, 20], [29, 34]]);
  assert.deepEqual(findPhrase('#ad #AD #ads x#ad (#ad)', '#ad'), [[0, 3], [4, 7], [19, 22]]);
  assert.deepEqual(findPhrase('#LittleKiln #littlekilns #littlekiln_shop', '#littlekiln'), [[0, 11]]);
  /* regex characters are just characters */
  assert.deepEqual(findPhrase('C++ and c+++ and a.b and axb', 'c++'), [[0, 3], [8, 11]]);
  assert.deepEqual(findPhrase('a.b and axb', 'a.b'), [[0, 3]]);
  assert.deepEqual(findPhrase('(.*)+ text', '(.*)+'), [[0, 5]]);
  /* non-Latin text */
  assert.deepEqual(findPhrase('Oferta: ¡Rebajas! rebajasx', 'rebajas'), [[9, 16]]);
});

test('checkRules: an avoid-list phrase gets "Say …" with the word swapped in, keeping a capital, never inside a link', () => {
  const f = checkRules(post('Winter sneak peek! Sneak peek at https://shop.example/sneak-peek'), CH, R([{ phrase: 'sneak peek', instead: 'first look' }]));
  assert.equal(f.length, 1);
  assert.equal(f[0].id, 'rules.banned');
  assert.equal(f[0].severity, 'high');
  assert.deepEqual(f[0].spans, [[7, 17], [19, 29]], 'the link is left alone');
  assert.equal(f[0].title, '“sneak peek” is on this channel’s avoid list');
  assert.equal(f[0].detail, 'Your rule for Kiln (X): never “sneak peek”, say “first look” instead. It appears 2 times.');
  assert.deepEqual(f[0].fixes[0], { type: 'edit', label: 'Say “first look”', text: 'Winter first look! First look at https://shop.example/sneak-peek' });
  /* without a word to say instead: Reword (no made-up text) and drafts */
  const g = checkRules(post('So cheap!'), CH, R(['cheap']));
  assert.deepEqual(g[0].fixes, [{ type: 'edit', label: 'Reword' }, { type: 'draft' }]);
  /* a thread: flagged on the part, no one-click text (threads are edited in Buffer) */
  const t = checkRules(post('', { thread: [{ text: 'First part' }, { text: 'so cheap' }] }), CH, R(['cheap']));
  assert.equal(t[0].where, 'thread:1');
  assert.deepEqual(t[0].fixes, [{ type: 'draft' }]);
  assert.deepEqual(checkRules(post('Cheaper by the dozen'), CH, R(['cheap'])), []);
});

test('checkRules: a missing must-have is flagged with the tag added; the first comment counts', () => {
  const rules = R([], ['#littlekiln', '#ad']);
  const f = checkRules(post('New mugs.\n\n#pottery #LittleKiln'), CH, rules);
  assert.equal(f.length, 1);
  assert.equal(f[0].id, 'rules.required');
  assert.equal(f[0].title, 'Missing “#ad”, required on this channel');
  assert.equal(f[0].fixes[0].text, 'New mugs.\n\n#pottery #LittleKiln\n\n#ad');
  const both = checkRules(post('New mugs'), CH, rules);
  assert.equal(both[0].title, 'Missing 2 must-haves: “#littlekiln”, “#ad”');
  assert.equal(both[0].fixes[0].text, 'New mugs #littlekiln #ad');
  assert.deepEqual(checkRules(post('New mugs', { firstComment: '#littlekiln #ad #pottery' }), CH, rules), []);
  assert.deepEqual(checkRules(post('#littlekilns #adverts'), CH, rules)[0].data.missing, ['#littlekiln', '#ad'], 'longer tags do not count');
  /* a must-have that only appears inside a link does not count */
  assert.equal(checkRules(post('See https://x.example/#ad #littlekiln'), CH, rules)[0].data.missing[0], '#ad');
});

test('runAll: rules apply only to their own channel; with no rules nothing changes (positive control)', () => {
  const posts = [post('Our sneak peek is here #ad'), post('Our sneak peek is here', { id: 'p2', channelId: 'ch2' })];
  const chans = [CH, Object.assign({}, CH, { id: 'ch2', displayName: 'Other' })];
  const rules = cleanRules({ ch1: { banned: [{ phrase: 'sneak peek', instead: 'first look' }], required: ['#ad'] } });
  const on = runAll(chans, posts, new Date('2026-11-10T12:00:00Z'), { rules }).posts;
  const off = runAll(chans, posts, new Date('2026-11-10T12:00:00Z')).posts;
  assert.deepEqual(on[0].flags.filter((f) => f.check === 'rules').map((f) => f.id), ['rules.banned']);
  assert.deepEqual(on[1].flags.filter((f) => f.check === 'rules'), [], 'the other channel has no rules');
  assert.deepEqual(off.flatMap((p) => p.flags.filter((f) => f.check === 'rules')), []);
  assert.equal(on[0].flags[0].severity, 'high', 'sorted with the other high flags');
  /* a draft gets the check too; its fixes follow what the post allows */
  const d = runAll(chans, [post('sneak peek', { status: 'draft', allowedActions: ['updatePost'] })], new Date('2026-11-10T12:00:00Z'), { rules }).posts[0];
  assert.deepEqual(d.flags.find((f) => f.id === 'rules.banned').fixes.map((x) => x.type), ['edit']);
});

test('rules never slow the checks: 20 phrases and 10 must-haves on a 30,000-character post', () => {
  const rules = R(Array.from({ length: 20 }, (_, i) => ({ phrase: 'aa aa aa ' + i, instead: 'b' })), Array.from({ length: 10 }, (_, i) => '#t' + i));
  const text = 'aa '.repeat(10000);
  const t0 = performance.now();
  const f = checkRules(post(text), CH, rules);
  assert.ok(performance.now() - t0 < 500, 'took ' + Math.round(performance.now() - t0) + ' ms');
  assert.equal(f.length, 1, 'only the missing tags: no phrase matched');
});

test('the summary line reads the rules back', () => {
  assert.equal(rulesSummary(cleanRules(SAMPLE_RULES)['kiln-x']), 'Never “sneak peek” (say “first look”)');
  assert.equal(rulesSummary(R([{ phrase: 'cheap' }], ['#ad', '#kiln'])), 'Never “cheap” · Always #ad #kiln');
});

/* ---------- the page ---------- */
function nodes(root) { const out = []; const go = (n) => { out.push(n); for (const k of n.kids || []) if (k instanceof FakeEl) go(k); }; go(root); return out; }
const byTag = (root, t) => nodes(root).filter((n) => n.tag === t);
const buttons = (root, label) => byTag(root, 'button').filter((n) => n.text() === label);
const card = (b, re) => byTag(b.$('queue'), 'article').find((n) => re.test(n.text()));
function fakeStorage(init, opts) {
  const m = new Map(Object.entries(init || {}));
  return { m, getItem: (k) => { if (opts && opts.broken) throw new Error('denied'); return m.has(k) ? m.get(k) : null; }, setItem: (k, v) => { if (opts && opts.broken) throw new Error('denied'); m.set(k, String(v)); }, removeItem: (k) => m.delete(k) };
}

test('page, /try sample: the studio\'s rules flag their posts, a new rule is saved in the tab, Reset brings the sample\'s back', async () => {
  const b = browser({ meta: { mode: 'try' }, path: '/try', hash: '#sample' });
  b.respond = async () => { throw new Error('the try page must not fetch'); };
  globalThis.localStorage = fakeStorage();
  await b.load();
  const classes = card(b, /Winter class schedule/);
  assert.match(classes.text(), /“sneak peek” is on this channel’s avoid list/);
  assert.equal(buttons(classes, 'Say “first look”').length, 1);
  assert.match(card(b, /Fresh out of the kiln/).text(), /Missing “#littlekiln”, required on this channel/);
  assert.match(b.$('queue').text(), /Channel rules Never “sneak peek” \(say “first look”\)/);
  /* add a rule on Bluesky from the channel header */
  const btn = byTag(b.$('queue'), 'button').find((n) => n.attrs['data-channel'] === 'kiln-bsky');
  assert.equal(btn.text(), 'Add rules');
  btn.click();
  assert.equal(b.$('rules-dlg').open, true);
  assert.equal(b.$('rules-title').textContent, 'Rules for Little Kiln (Bluesky)');
  assert.match(b.$('rules-where').textContent, /Sample only/);
  b.$('rules-banned').value = 'x';
  b.$('rules-save').click();
  assert.equal(b.$('rules-error').hidden, false, 'a bad line is refused with a reason');
  assert.equal(b.$('rules-dlg').open, true);
  b.$('rules-banned').value = 'tickets here => book here';
  b.$('rules-save').click();
  await b.flush();
  assert.equal(b.$('rules-dlg').open, false);
  assert.match(b.$('toast').textContent, /^Rules saved for Little Kiln \(Bluesky\)\. 1 post on it breaks them\./);
  const taster = card(b, /Wheel-throwing taster night/);
  assert.match(taster.text(), /“tickets here” is on this channel’s avoid list/);
  assert.equal(buttons(taster, 'Say “book here”').length, 1);
  assert.equal(byTag(b.$('queue'), 'button').find((n) => n.attrs['data-channel'] === 'kiln-bsky').text(), 'Rules · 1');
  assert.equal(globalThis.localStorage.m.size, 0, 'the sample keeps its rules in the tab, not in storage');
  /* the suggested fix opens the edit dialog with the word swapped */
  buttons(taster, 'Say “book here”')[0].click();
  assert.match(b.$('dlg-text').value, /Doors open today at 6pm, book here: https:\/\/tickets\.littlekiln\.example\/taster-night/);
  b.$('dlg-cancel').click();
  /* Reset sample: back to the studio's own rules */
  b.$('rescan').click(); await b.flush(); await b.advance(2000);
  assert.ok(!/“tickets here” is on/.test(b.$('queue').text()));
  assert.match(card(b, /Winter class schedule/).text(), /avoid list/);
  assert.equal(b.requests.length, 0);
  delete globalThis.localStorage;
});

test('page, real queue: rules are kept in this browser, read back on the next visit, and never sent to the server', async () => {
  const sample = new SampleBackend();
  const bodies = [];
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  const respond = async (path, init) => {
    bodies.push(path + ' ' + String((init && init.body) || ''));
    if (path === '/api/scan') return json(Object.assign(await sample.scan(), { sample: undefined }));
    if (path === '/api/links') return json(await sample.checkLinks(JSON.parse(init.body)));
    return new Response('{}', { status: 404 });
  };
  const store = fakeStorage();
  globalThis.localStorage = store;
  const b = browser();
  b.respond = respond;
  await b.load();
  await b.advance(2000);
  assert.ok(!/avoid list|required on this channel/.test(b.$('queue').text()), 'a real account starts with no rules (the sample\'s are not used)');
  byTag(b.$('queue'), 'button').find((n) => n.attrs['data-channel'] === 'kiln-li').click();
  assert.match(b.$('rules-where').textContent, /Kept in this browser only: never sent to Last Look’s server or to Buffer\. The daily digest does not use them yet\./);
  b.$('rules-banned').value = 'Good morning, everyone => Hello';
  b.$('rules-required').value = '#littlekiln';
  b.$('rules-save').click();
  await b.flush();
  assert.match(card(b, /We're hiring/).text(), /“Good morning, everyone” is on this channel’s avoid list/);
  assert.match(card(b, /We're hiring/).text(), /Missing “#littlekiln”/);
  assert.deepEqual(JSON.parse(store.m.get('lastlook.rules.v1')), { 'kiln-li': { banned: [{ phrase: 'Good morning, everyone', instead: 'Hello' }], required: ['#littlekiln'] } });
  /* the next visit reads them back */
  const b2 = browser();
  b2.respond = respond;
  await b2.load();
  await b2.advance(2000);
  assert.match(card(b2, /We're hiring/).text(), /avoid list/);
  /* clearing a channel's rules removes the stored copy */
  byTag(b2.$('queue'), 'button').find((n) => n.attrs['data-channel'] === 'kiln-li').click();
  assert.equal(b2.$('rules-banned').value, 'Good morning, everyone => Hello');
  b2.$('rules-banned').value = ''; b2.$('rules-required').value = '';
  b2.$('rules-save').click(); await b2.flush();
  assert.match(b2.$('toast').textContent, /^Rules cleared for Little Kiln Studio \(LinkedIn\)\./);
  assert.equal(store.m.has('lastlook.rules.v1'), false);
  /* nothing about the rules ever left the page */
  assert.ok(bodies.length >= 2);
  assert.ok(!bodies.some((x) => /Good morning, everyone|#littlekiln|rules/i.test(x.replace(/"text":"[^"]*"/g, ''))), 'no rule in any request');
  assert.ok(!bodies.some((x) => /\/api\/rules/.test(x)));
  delete globalThis.localStorage;
});

test('page, real queue: broken or oversized storage is ignored, and a browser that keeps nothing still applies the rules for the visit', async () => {
  const sample = new SampleBackend();
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  const respond = async (path, init) => (path === '/api/scan' ? json(await sample.scan()) : path === '/api/links' ? json(await sample.checkLinks(JSON.parse(init.body))) : new Response('{}', { status: 404 }));
  for (const bad of ['{not json', JSON.stringify({ 'kiln-li': { banned: ['x'.repeat(20000)] } }), JSON.stringify({ 'kiln-li': { banned: 'hiring' } }), 'x'.repeat(RULES_MAX.storeBytes + 1)]) {
    globalThis.localStorage = fakeStorage({ 'lastlook.rules.v1': bad });
    const b = browser(); b.respond = respond;
    await b.load(); await b.advance(2000);
    assert.match(b.$('headline').textContent, /need/, 'the page still works');
    assert.ok(!/avoid list/.test(b.$('queue').text()));
  }
  globalThis.localStorage = fakeStorage({}, { broken: true });
  const b = browser(); b.respond = respond;
  await b.load(); await b.advance(2000);
  byTag(b.$('queue'), 'button').find((n) => n.attrs['data-channel'] === 'kiln-li').click();
  b.$('rules-banned').value = 'hiring';
  b.$('rules-save').click(); await b.flush();
  assert.match(card(b, /We're hiring/).text(), /“hiring” is on this channel’s avoid list/);
  assert.match(b.$('toast').textContent, /This browser does not keep site data, so they last until you leave the page\./);
  delete globalThis.localStorage;
});

test('the rules dialog is static markup on both pages, under the same CSP; the sample\'s rules sit in sample.js', async () => {
  const { default: worker } = await import('../src/index.js');
  const { makeEnv, signIn } = await import('./fakes.mjs');
  const env = makeEnv();
  const t = await (await worker.fetch(new Request('https://lastlook.swiftbotlab.workers.dev/try'), env)).text();
  for (const id of ['rules-dlg', 'rules-form', 'rules-banned', 'rules-required', 'rules-save', 'rules-cancel', 'rules-error', 'rules-where']) assert.match(t, new RegExp('id="' + id + '"'), id);
  assert.match(t, /sneak peek =&gt; first look/);
  /* the plain-HTML copy of /try shows the rules and their flags too */
  assert.match(t, /<p class="channel-rules"><span class="lbl">Channel rules<\/span> Never “sneak peek” \(say “first look”\)<\/p>/);
  assert.match(t, /“sneak peek” is on this channel’s avoid list/);
  const s = await signIn(env);
  const app = await (await worker.fetch(new Request('https://lastlook.swiftbotlab.workers.dev/', { headers: { cookie: s.cookie } }), env)).text();
  assert.match(app, /<meta name="csrf"/, 'the signed-in app page');
  assert.match(app, /id="rules-dlg"/);
  const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const part = src.slice(src.indexOf('/* ---------- per-channel rules'), src.indexOf('/* ---------- dialogs ---------- */'));
  assert.ok(part.length > 500);
  assert.ok(!/\bapi\(|fetch\(|backend\./.test(part), 'the rules code has no network path');
  assert.deepEqual(JSON.parse(JSON.stringify(cleanRules(SAMPLE_RULES))), SAMPLE_RULES);
});
