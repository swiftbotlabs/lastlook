/* Per-channel rules, set by the user: phrases never to use on a channel (each with an optional word to say instead)
   and tags or phrases every post on it must carry (a disclosure like #ad, a brand tag). Pure.
   Rules are cleaned by cleanRules() before use. Matching ignores case and works on whole words; links are masked
   first, so a banned word inside a URL is not flagged. Phrases are matched literally (never as a pattern), so a
   rule cannot slow the checks down. */
import { maskUrls, clipForChecks, clip } from './text.js';

export const RULES_MAX = { channels: 60, banned: 20, required: 10, phrase: 60, storeBytes: 16000 };
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const BAD_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const WORD = /[\p{L}\p{N}_]/u;

/* one phrase as typed: invisible and control characters out, spaces collapsed; null if empty or too long */
function phrase(s) {
  if (typeof s !== 'string') return null;
  const t = s.normalize('NFC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return t.length >= 2 && t.length <= RULES_MAX.phrase ? t : null;
}
const key = (s) => s.toLocaleLowerCase('en');

/* the stored or typed rules, made safe: { channelId: { banned: [{phrase, instead}], required: [phrase] } }
   (a null-prototype object; unknown fields, bad ids, empty rule sets and everything over the caps are dropped) */
export function cleanRules(raw) {
  const out = Object.create(null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  let n = 0;
  for (const id of Object.keys(raw)) {
    if (n >= RULES_MAX.channels) break;
    if (!ID_RE.test(id) || BAD_IDS.has(id)) continue;
    const r = raw[id];
    if (!r || typeof r !== 'object') continue;
    const banned = []; const required = []; const seenB = new Set(); const seenR = new Set();
    for (const b of Array.isArray(r.banned) ? r.banned : []) {
      if (banned.length >= RULES_MAX.banned) break;
      const p = phrase(b && typeof b === 'object' ? b.phrase : b);
      if (!p || seenB.has(key(p))) continue;
      const insteadRaw = b && typeof b === 'object' ? b.instead : null;
      const ins = insteadRaw == null || insteadRaw === '' ? null : phrase(insteadRaw);
      if (insteadRaw != null && insteadRaw !== '' && !ins) continue;
      if (ins && key(ins) === key(p)) continue;
      seenB.add(key(p));
      banned.push({ phrase: p, instead: ins });
    }
    for (const q of Array.isArray(r.required) ? r.required : []) {
      if (required.length >= RULES_MAX.required) break;
      const p = phrase(q);
      if (!p || seenR.has(key(p)) || seenB.has(key(p))) continue;
      seenR.add(key(p));
      required.push(p);
    }
    if (!banned.length && !required.length) continue;
    out[id] = { banned, required };
    n++;
  }
  return out;
}

/* the two boxes of the rules dialog, one rule per line; "old => new" (or -> or →) suggests a replacement.
   Returns { banned, required, errors: [text] } */
export function parseRuleLines(bannedText, requiredText) {
  const errors = [];
  const lines = (s) => String(s == null ? '' : s).slice(0, 8000).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const banned = [];
  for (const l of lines(bannedText)) {
    const m = /^(.*?)\s*(?:=>|->|→)\s*(.*)$/.exec(l);
    const p = phrase(m ? m[1] : l);
    const ins = m && m[2] ? phrase(m[2]) : null;
    if (!p || (m && m[2] && !ins)) { errors.push('“' + clip(l, 40) + '”: each phrase needs 2 to ' + RULES_MAX.phrase + ' characters.'); continue; }
    if (ins && key(ins) === key(p)) { errors.push('“' + clip(l, 40) + '”: the word to say instead is the same word.'); continue; }
    banned.push({ phrase: p, instead: ins });
  }
  const required = [];
  for (const l of lines(requiredText)) {
    const p = phrase(l);
    if (!p) { errors.push('“' + clip(l, 40) + '”: each phrase needs 2 to ' + RULES_MAX.phrase + ' characters.'); continue; }
    required.push(p);
  }
  if (banned.length > RULES_MAX.banned) errors.push('Up to ' + RULES_MAX.banned + ' phrases to avoid per channel.');
  if (required.length > RULES_MAX.required) errors.push('Up to ' + RULES_MAX.required + ' must-have phrases or tags per channel.');
  return { banned, required, errors };
}

/* every place the phrase occurs as whole words, ignoring case: [[start, end]] in the (masked) text.
   Literal search on a lowercased copy (same length for the scripts this is meant for; a length change falls back
   to an exact-case search), so nothing in a rule is ever run as a pattern. */
export function findPhrase(text, p, limit) {
  const out = [];
  const lower = key(text);
  const same = lower.length === text.length;
  const hay = same ? lower : text;
  const needle = same ? key(p) : p;
  /* a phrase that starts with a letter, digit, # or @ must not continue a word before it ("ad" is not in "bad",
     "#ad" is not in "x#ad"); one that ends with a letter or digit must not run on ("#kiln" is not "#kilns") */
  const guardStart = WORD.test(needle[0]) || needle[0] === '#' || needle[0] === '@';
  const endsWord = WORD.test(needle[needle.length - 1]);
  let i = 0;
  while (out.length < (limit || 20)) {
    const at = hay.indexOf(needle, i);
    if (at < 0) break;
    const before = at > 0 ? hay[at - 1] : '';
    const after = hay[at + needle.length] || '';
    const okStart = !guardStart || !before || !WORD.test(before);
    const okEnd = !endsWord || !after || !WORD.test(after);
    if (okStart && okEnd) out.push([at, at + needle.length]);
    i = at + Math.max(1, needle.length);
  }
  return out;
}

/* "Sneak peek" with the rule "sneak peek => first look" becomes "First look" */
function caseLike(match, word) {
  if (match && match[0] !== match[0].toLocaleLowerCase('en') && word[0] === word[0].toLocaleLowerCase('en')) return word[0].toLocaleUpperCase('en') + word.slice(1);
  return word;
}
function replaceSpans(text, spans, word) {
  let out = text;
  for (let i = spans.length - 1; i >= 0; i--) {
    const [a, b] = spans[i];
    out = out.slice(0, a) + caseLike(text.slice(a, b), word) + out.slice(b);
  }
  return out;
}
const quote = (s) => '“' + s + '”';

/* post: a shaped post; channel: its channel; rules: this channel's cleaned rules (or nothing) */
export function checkRules(post, channel, rules) {
  if (!rules || (!rules.banned.length && !rules.required.length)) return [];
  const name = (channel && (channel.displayName || channel.name)) || 'this channel';
  const isThread = post.thread && post.thread.length > 1;
  const items = isThread ? post.thread.map((t, i) => ({ text: clipForChecks(t.text), where: 'thread:' + i })) : [{ text: clipForChecks(post.text), where: 'text' }];
  const flags = [];
  for (const b of rules.banned) {
    for (const it of items) {
      const spans = findPhrase(maskUrls(it.text), b.phrase);
      if (!spans.length) continue;
      const fixes = [];
      if (b.instead && it.where === 'text') fixes.push({ type: 'edit', label: 'Say ' + quote(b.instead), text: replaceSpans(it.text, spans, b.instead) });
      else if (it.where === 'text') fixes.push({ type: 'edit', label: 'Reword' });
      fixes.push({ type: 'draft' });
      flags.push({
        check: 'rules', id: 'rules.banned', severity: 'high', where: it.where, spans,
        title: quote(it.text.slice(spans[0][0], spans[0][1])) + ' is on this channel’s avoid list',
        detail: 'Your rule for ' + name + ': never ' + quote(b.phrase) + (b.instead ? ', say ' + quote(b.instead) + ' instead' : '') + '.' + (spans.length > 1 ? ' It appears ' + spans.length + ' times.' : ''),
        data: { phrase: b.phrase, instead: b.instead },
        fixes
      });
    }
  }
  if (rules.required.length) {
    const all = items.map((it) => maskUrls(it.text)).concat(post.firstComment ? [maskUrls(clipForChecks(post.firstComment))] : []);
    const missing = rules.required.filter((r) => !all.some((t) => findPhrase(t, r, 1).length));
    if (missing.length) {
      const fixes = [];
      if (!isThread) {
        const sep = /\n/.test(post.text || '') || ['instagram', 'linkedin'].includes(channel && channel.service) ? '\n\n' : ' ';
        fixes.push({ type: 'edit', label: 'Add ' + missing.map(quote).join(' '), text: String(post.text || '').replace(/\s+$/, '') + sep + missing.join(' ') });
      }
      fixes.push({ type: 'draft' });
      flags.push({
        check: 'rules', id: 'rules.required', severity: 'high', where: 'text',
        title: missing.length === 1 ? 'Missing ' + quote(missing[0]) + ', required on this channel' : 'Missing ' + missing.length + ' must-haves: ' + missing.map(quote).join(', '),
        detail: 'Your rule for ' + name + ': every post includes ' + rules.required.map(quote).join(' and ') + '.' + (post.firstComment ? ' Checked the text and the first comment.' : ''),
        data: { missing },
        fixes
      });
    }
  }
  return flags;
}

/* a one-line summary for the channel header: Never “sneak peek” (say “first look”) · Always #littlekiln */
export function rulesSummary(rules) {
  if (!rules) return '';
  const parts = [];
  if (rules.banned.length) parts.push('Never ' + rules.banned.map((b) => quote(b.phrase) + (b.instead ? ' (say ' + quote(b.instead) + ')' : '')).join(', '));
  if (rules.required.length) parts.push('Always ' + rules.required.join(' '));
  return parts.join(' · ');
}
export const rulesCount = (rules) => (rules ? rules.banned.length + rules.required.length : 0);
