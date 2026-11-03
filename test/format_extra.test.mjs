import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFormatting, cleanFormatting, findFormatting } from '../src/checks/format.js';
import { checkPlaceholders, checkAltText, checkTags } from '../src/checks/extra.js';
import { post, BSKY, X, ids } from './helpers.mjs';

const rulesIn = (text, ch) => { const f = checkFormatting(post(text), ch || BSKY); return f.length ? f[0].data.rules : []; };

test('formatting: each Markdown/HTML rule fires', () => {
  assert.deepEqual(rulesIn('This is **big** news'), ['format.md_bold']);
  assert.deepEqual(rulesIn('This is __big__ news'), ['format.md_bold']);
  assert.deepEqual(rulesIn('Read [the guide](https://example.org/g)'), ['format.md_link']);
  assert.deepEqual(rulesIn('## Release notes\nstuff'), ['format.md_heading']);
  assert.deepEqual(rulesIn('Old ~~price~~ new'), ['format.md_strike']);
  assert.deepEqual(rulesIn('Run `npm i`'), ['format.md_code']);
  assert.deepEqual(rulesIn('Line one<br>line two'), ['format.html_tag']);
  assert.deepEqual(rulesIn('Tom &amp; Jerry'), ['format.html_entity']);
  assert.deepEqual(rulesIn('Price \\*today\\*'), ['format.md_escape']);
});
test('formatting: no false positives on hashtags, numbers, URLs and plain text', () => {
  assert.deepEqual(rulesIn('#launch day! We are #1 at https://x.org/a__b__c#top and 5 * 3 = 15'), []);
  assert.deepEqual(rulesIn('Plain text with a [bracket] and (parens) and a * star'), []);
  assert.deepEqual(rulesIn('a_b_c snake_case and 2**8'), []);
});
test('formatting: skipped on networks with their own formatting', () => {
  assert.deepEqual(checkFormatting(post('**bold**'), { service: 'substack' }), []);
  assert.equal(checkFormatting(post('**bold**'), X).length, 1);
});
test('formatting: one grouped flag with a clean suggestion', () => {
  const f = checkFormatting(post('**Big news**: our [new guide](https://buffer.com/resources) is live.\n## Read it now &amp; share'), BSKY);
  assert.equal(f.length, 1);
  assert.equal(f[0].id, 'format.mixed');
  assert.equal(f[0].fixes[0].text, 'Big news: our new guide: https://buffer.com/resources is live.\nRead it now & share');
});
test('cleanFormatting handles HTML links and numeric entities', () => {
  assert.equal(cleanFormatting('See <a href="https://x.org">our site</a> &#39;now&#39;'), "See our site: https://x.org 'now'");
  assert.equal(cleanFormatting('nothing to do'), 'nothing to do');
  assert.equal(findFormatting('&#0; &#55296;').length, 2);
  assert.equal(cleanFormatting('&#0;'), '&#0;');
});

test('placeholders: template leftovers are flagged, normal brackets are not', () => {
  assert.deepEqual(ids(checkPlaceholders(post('Grab it here: [link] — thanks {{first_name}}!'))), ['placeholder.left']);
  assert.deepEqual(ids(checkPlaceholders(post('TODO: add pricing'))), ['placeholder.left']);
  assert.deepEqual(ids(checkPlaceholders(post('[lastlook-test] Lorem ipsum dolor'))), ['placeholder.left']);
  assert.deepEqual(checkPlaceholders(post('Our [beta] is open (finally). Todo lists are fun.')), []);
});
test('alt text: missing alt text is flagged, present alt text is not', () => {
  assert.deepEqual(ids(checkAltText(post('x', { assets: [{ type: 'image', altText: '' }] }))), ['alt.missing']);
  assert.deepEqual(checkAltText(post('x', { assets: [{ type: 'image', altText: 'A chart' }, { type: 'video', altText: null }] })), []);
  assert.equal(checkAltText(post('x', { thread: [{ text: 'a', assets: [] }, { text: 'b', assets: [{ type: 'image', altText: '' }] }] }))[0].data.count, 1);
});
test('hashtags and mentions', () => {
  const f = checkTags(post('Big day #launch-day for @team'), BSKY);
  assert.deepEqual(ids(f), ['tags.broken']);
  assert.equal(f[0].fixes[0].text, 'Big day #launchday for @team');
  assert.deepEqual(ids(checkTags(post('Thanks @ alice for the help'), BSKY)), ['tags.stray']);
  assert.deepEqual(ids(checkTags(post('Note (this is open'), BSKY)), ['tags.unbalanced']);
  assert.deepEqual(checkTags(post('Love it :) and 1) first 2) second #fine'), BSKY), []);
  const many = Array.from({ length: 31 }, (_, i) => '#t' + i).join(' ');
  assert.deepEqual(ids(checkTags(post(many), { service: 'instagram' })), ['tags.too_many']);
  assert.deepEqual(ids(checkTags(post(Array.from({ length: 8 }, (_, i) => '#t' + i).join(' ')), BSKY)), ['tags.many']);
  assert.deepEqual(checkTags(post('Rock &#39;n roll &amp; #music'), BSKY), []);
});
