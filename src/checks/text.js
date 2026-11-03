/* Shared text helpers for the checks. Pure functions, no network, run in the Worker and in Node tests. */

const SEG = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;

/* user-perceived characters */
export function graphemes(s) {
  const str = String(s || '');
  if (!SEG) return Array.from(str);
  const out = [];
  for (const g of SEG.segment(str)) out.push(g.segment);
  return out;
}
export const graphemeCount = (s) => graphemes(s).length;

/* URLs in post text: explicit http(s):// links and bare www. links.
   Returns [{url, start, end, raw}] where url is the absolute URL to check and start/end index the raw text. */
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`  -​　]+/gi;
const TRAIL_CHARS = '.,;:!?\'"’”]}>*_~';
/* trim trailing punctuation, but keep a ')' that closes a '(' inside the URL (wikipedia style) */
function trimUrl(raw) {
  for (;;) {
    const last = raw[raw.length - 1];
    if (!last) return raw;
    if (last === ')') {
      const opens = (raw.match(/\(/g) || []).length;
      const closes = (raw.match(/\)/g) || []).length;
      if (closes <= opens) return raw;
      raw = raw.slice(0, -1);
      continue;
    }
    if (TRAIL_CHARS.includes(last)) { raw = raw.slice(0, -1); continue; }
    return raw;
  }
}
export function findUrls(text) {
  const s = String(text || '');
  const out = [];
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(s)) && out.length < 200) {
    const raw = trimUrl(m[0]);
    if (raw.length < 5) continue;
    const url = /^www\./i.test(raw) ? 'https://' + raw : raw;
    out.push({ url, raw, start: m.index, end: m.index + raw.length });
  }
  return out;
}

/* replace URL ranges with spaces so other checks do not read inside links */
export function maskUrls(text) {
  const s = String(text || '');
  let out = '';
  let pos = 0;
  for (const u of findUrls(s)) {
    out += s.slice(pos, u.start) + ' '.repeat(u.end - u.start);
    pos = u.end;
  }
  return out + s.slice(pos);
}

/* code points of a string (for weighting) */
export function codePoints(s) { return Array.from(String(s || ''), (c) => c.codePointAt(0)); }

/* an emoji grapheme: contains an Extended_Pictographic code point or a regional indicator pair or a keycap */
const PICTO = /\p{Extended_Pictographic}/u;
const REGIONAL = /[\u{1F1E6}-\u{1F1FF}]/u;
export function isEmojiGrapheme(g) {
  return PICTO.test(g) || REGIONAL.test(g) || /⃣/.test(g);
}

/* normalise text for duplicate detection: NFKC, lower case, URLs reduced to host+path without tracking params,
   punctuation and repeated whitespace removed */
export function normalizeForCompare(text) {
  let s = String(text || '').normalize('NFKC');
  const urls = findUrls(s);
  let out = '';
  let pos = 0;
  for (const u of urls) {
    out += s.slice(pos, u.start) + ' ' + canonicalUrl(u.url) + ' ';
    pos = u.end;
  }
  out += s.slice(pos);
  return out.toLowerCase().replace(/[^\p{L}\p{N}\s./#@]+/gu, ' ').replace(/\s+/g, ' ').trim();
}
export function canonicalUrl(u) {
  try {
    const x = new URL(u);
    const keep = [];
    for (const [k, v] of x.searchParams) if (!/^(utm_|fbclid$|gclid$|mc_|ref$|ref_src$|igshid$|si$)/i.test(k)) keep.push(k + '=' + v);
    return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/$/, '') + (keep.length ? '?' + keep.join('&') : '')).toLowerCase();
  } catch (e) { return String(u).toLowerCase(); }
}

/* word tokens for similarity */
export function words(norm) { return norm.split(' ').filter(Boolean); }

/* How alike two normalised texts are, 0..1: one minus the word-level edit distance over the longer length
   (one extra word in a 14-word post = 0.93). A cheap word-set overlap filters out clearly different pairs first. */
export function similarity(a, b) {
  const wa = words(a); const wb = words(b);
  if (!wa.length || !wb.length) return 0;
  const A = new Set(wa); const B = new Set(wb);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const jac = inter / (A.size + B.size - inter);
  if (jac < 0.5) return jac;
  const x = wa.slice(0, 400); const y = wb.slice(0, 400);
  let prev = new Array(y.length + 1);
  let cur = new Array(y.length + 1);
  for (let j = 0; j <= y.length; j++) prev[j] = j;
  for (let i = 1; i <= x.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    [prev, cur] = [cur, prev];
  }
  return 1 - prev[y.length] / Math.max(x.length, y.length);
}

/* clip for display in flag details (never more than n characters, on a grapheme boundary) */
export function clip(s, n) {
  const g = graphemes(String(s || ''));
  return g.length <= n ? g.join('') : g.slice(0, n - 1).join('') + '…';
}
