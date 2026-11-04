/* /try, first paint without JavaScript: the sample's flagged posts are in the HTML the server sends, checked by the
   same code the page runs, escaped, with nothing that reads as a placeholder; the interactive app hides that copy
   and shows the same numbers. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { browser } from './dom.mjs';
import worker from '../src/index.js';
import { trySample, markText } from '../src/trystatic.js';
import { makeEnv } from './fakes.mjs';

const ORIGIN = 'https://lastlook.swiftbotlab.workers.dev';

/* what a reader that does not run scripts gets: the text of the page without script, style and svg (the same rule
   as the release gate's no-JS check) */
function visibleText(html) {
  const body = html.replace(/<(script|style|template|svg)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  return body.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}
/* the plain-HTML block alone */
const block = (html) => { const m = /<section class="try-static" id="try-static"[\s\S]*?<p class="muted ts-foot">[\s\S]*?<\/p><\/section>/.exec(html); return m ? m[0] : ''; };

test('/try without JavaScript: the first paint shows the sample\'s real flagged posts, not a placeholder', async () => {
  const env = makeEnv();
  const r = await worker.fetch(new Request(ORIGIN + '/try', { headers: { 'cf-connecting-ip': '203.0.113.21' } }), env);
  assert.equal(r.status, 200);
  const html = await r.text();
  const text = visibleText(html);
  assert.ok(!/\bloading\b/i.test(text), 'no "Loading" anywhere in the page text: ' + (text.match(/.{0,40}\bloading\b.{0,40}/i) || [''])[0]);
  assert.ok(!/one moment/i.test(text));
  const plain = block(html);
  assert.ok(plain, 'the plain-HTML sample block is in the page');
  const pt = visibleText(plain);
  assert.ok(pt.length > 2000, 'a full page of results, got ' + pt.length + ' chars');
  /* the headline and the flags a judge should see */
  assert.match(pt, /\b\d+ posts need a look\b/);
  for (const t of ['"Happy Friday" goes out on a Monday', 'Broken link (404 Not Found)', 'Too long for X by', 'Link points to a private address', 'Same text queued twice on this channel', 'Link goes nowhere: tickets.littlekiln.example does not exist', 'Link lands on a sign-in page'])
    assert.ok(pt.includes(t), 'flag shown: ' + t);
  assert.match(pt, /Fixes offered Say “?Monday”? · Edit text · Move to drafts/);
  assert.match(pt, /Look back: Last Look would have caught 8 issues in the studio’s last 14 sent posts/);
  assert.match(pt, /Sample queue, made up for this demo\. These are the queued posts of Little Kiln Studio, a fictional pottery studio/);
  /* flagged words are marked, as in the app */
  assert.match(plain, /<mark class="hl hl-high">Happy Friday<\/mark>/);
  /* still no session, no gate call, no Buffer call to make this page */
  assert.equal(env.SESSIONS._m.size, 0);
  assert.equal(env.GATE.calls, 0);
  /* only the /try page carries it */
  const landing = await (await worker.fetch(new Request(ORIGIN + '/'), env)).text();
  assert.ok(!/try-static/.test(landing));
});

test('/try plain copy: hidden once scripts run (boot.js before first paint, app.js again), and removed by the app', async () => {
  const css = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');
  assert.match(css, /html\.js \.try-static\{display:none\}/);
  const html = await (await worker.fetch(new Request(ORIGIN + '/try'), makeEnv())).text();
  /* boot.js is a classic script in <head>, before the body is parsed */
  assert.ok(html.indexOf('<script src="/boot.js') < html.indexOf('<body'), 'boot.js runs before the body');
  assert.ok(!/<script src="\/boot\.js[^>]*\s(async|defer|type=)/.test(html), 'boot.js blocks (no async/defer/module)');
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /document\.documentElement\.classList\.add\('js'\)/);
  assert.match(app, /getElementById\('try-static'\)/);
});

test('/try plain copy and the interactive sample agree on the numbers', async () => {
  const s = trySample(new Date());
  const b = browser({ meta: { mode: 'try' }, path: '/try', hash: '#sample' });
  b.respond = async () => { throw new Error('the try page must not fetch'); };
  await b.load();
  await b.advance(3000);
  assert.equal(b.$('headline').textContent, s.headline);
  assert.equal(b.$('subline').textContent, s.subline);
  assert.ok(s.flagged >= 8 && s.posts === 12, JSON.stringify({ flagged: s.flagged, posts: s.posts }));
  assert.deepEqual(s.back, { checked: 14, issues: 8, notes: 0, postsWithIssues: 8, links: 1 });
});

test('/try plain copy: works on any date (every week day for a fortnight), and text is escaped', () => {
  for (let i = 0; i < 14; i++) {
    const at = new Date(Date.parse('2026-11-04T18:00:00Z') + i * 864e5 + i * 3600e3);
    const s = trySample(at);
    assert.ok(s.flagged >= 8, at.toISOString() + ' flagged ' + s.flagged);
    assert.equal(s.back.issues, 8, at.toISOString());
    assert.ok(s.html.includes('goes out on a Monday'), at.toISOString());
    assert.ok(!/\bloading\b/i.test(visibleText(s.html)));
  }
  /* markText escapes every character it is given, marked or not */
  const evil = '<img src=x onerror=alert(1)> & "q" \'s\'';
  const out = markText(evil, [{ where: 'text', severity: 'high', spans: [[0, 4]] }], 'text');
  assert.equal(out, '<mark class="hl hl-high">&lt;img</mark> src=x onerror=alert(1)&gt; &amp; &quot;q&quot; &#39;s&#39;');
  assert.ok(!/<img/.test(out));
  /* spans outside the text are clipped */
  assert.equal(markText('abc', [{ where: 'text', severity: 'medium', spans: [[-4, 99]] }], 'text'), '<mark class="hl hl-med">abc</mark>');
  assert.equal(markText('abc', [{ where: 'thread:0', severity: 'medium', spans: [[0, 3]] }], 'text'), 'abc');
});
