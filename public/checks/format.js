/* Check 3: formatting the network will not render.
   None of these networks render Markdown or HTML in a post body; the characters show up literally:
   X, Bluesky, LinkedIn, Threads, Mastodon (stock servers post plain text), Facebook, Instagram, TikTok,
   Pinterest, YouTube descriptions and Google Business Profile posts. Substack and WhatsApp have their own
   formatting, so they are skipped. */
import { maskUrls, findUrls, clip, clipForChecks } from './text.js';
import { SERVICE_NAMES } from './length.js';

export const RAW_SERVICES = new Set(['twitter', 'bluesky', 'linkedin', 'threads', 'mastodon', 'facebook', 'instagram', 'tiktok', 'pinterest', 'youtube', 'googlebusiness']);

const HREF_RE = /\bhref=["']?([^"'\s>]{1,2000})/i;
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™' };

/* each rule: find(masked, original) -> [{start, end}] ; fix(text) -> text */
const RULES = [
  {
    id: 'format.md_link', title: 'Markdown link will show as raw text',
    explain: (svc) => '[text](link) is Markdown. ' + svc + ' shows the brackets and the link exactly as typed.',
    re: /!?\[([^\]\n]{1,300})\]\((https?:\/\/[^\s)]{1,2000})\)/g, useOriginal: true,
    replace: (m, label, url) => (m.startsWith('!') ? url : label.trim() + ': ' + url)
  },
  {
    id: 'format.md_bold', title: 'Markdown bold will show as asterisks',
    explain: (svc) => svc + ' does not render **bold** or __bold__; readers see the symbols.',
    re: /(\*\*|__)(?=\S)([^\n]{0,500}?\S)\1/g,
    replace: (m, mark, inner) => inner
  },
  {
    id: 'format.md_strike', title: 'Markdown strikethrough will show as tildes',
    explain: (svc) => svc + ' does not render ~~strikethrough~~.',
    re: /~~(?=\S)([^\n]{0,500}?\S)~~/g,
    replace: (m, inner) => inner
  },
  {
    id: 'format.md_heading', title: 'Markdown heading will show a #',
    explain: (svc) => 'A line starting with "# " is a Markdown heading. ' + svc + ' shows the # and it can read as a broken hashtag.',
    re: /^[ \t]{0,3}(#{1,6})[ \t]+(?=\S)/gm,
    replace: () => ''
  },
  {
    id: 'format.md_code', title: 'Markdown code marks will show as backticks', severity: 'low',
    explain: (svc) => svc + ' shows `backticks` literally.',
    re: /```[^\n]*\n?|`([^`\n]{1,200})`/g,
    replace: (m, inner) => (m.startsWith('```') ? '' : inner)
  },
  {
    id: 'format.html_tag', title: 'HTML tags will show as raw text',
    explain: (svc) => svc + ' shows HTML tags such as <b> or <br> exactly as typed. They often come from pasting out of a blog or CMS.',
    /* the <a> branch matches the whole tag in one linear step and reads href afterwards: the earlier pattern
       with an optional quote around a greedy href backtracked badly on crafted input */
    re: /<\/?(?:b|i|u|em|strong|br|p|span|div|ul|ol|li|h[1-6]|small|mark|sup|sub)\b[^<>\n]{0,200}\/?>|<a\s([^<>\n]{0,700})>([^<\n]{0,300})<\/a>/gi, useOriginal: true,
    replace: (m, attrs, label) => {
      const href = attrs != null ? (attrs.match(HREF_RE) || [])[1] : null;
      if (attrs != null && !href) return (label || '').trim();
      if (href) return (label || '').trim() ? label.trim() + ': ' + href : href;
      if (/^<br/i.test(m)) return '\n';
      if (/^<\/(p|div|li|h[1-6])/i.test(m)) return '\n';
      return '';
    }
  },
  {
    id: 'format.html_entity', title: 'HTML entity will show as code',
    explain: (svc) => 'Codes like &amp; or &#39; come from copying text out of a web page or feed. ' + svc + ' shows them as typed instead of the character.',
    re: /&(?:(amp|lt|gt|quot|apos|nbsp|hellip|mdash|ndash|rsquo|lsquo|rdquo|ldquo|copy|reg|trade)|#(\d{1,7})|#x([0-9a-f]{1,6}));/gi,
    replace: (m, name, dec, hex) => {
      if (name) return NAMED_ENTITIES[name.toLowerCase()] || m;
      const cp = dec ? parseInt(dec, 10) : parseInt(hex, 16);
      if (!Number.isFinite(cp) || cp < 32 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return m;
      return String.fromCodePoint(cp);
    }
  },
  {
    id: 'format.md_escape', title: 'Markdown escape backslashes will show', severity: 'low',
    explain: (svc) => 'A backslash before * _ # or [ is a Markdown escape. ' + svc + ' shows the backslash.',
    re: /\\([*_#\[\]()`~>])/g,
    replace: (m, ch) => ch
  }
];

/* run every rule once; spans index the (capped) text */
export function findFormatting(text) {
  const original = clipForChecks(text);
  const masked = maskUrls(original);
  const urls = findUrls(original);
  const hits = [];
  for (const rule of RULES) {
    const source = rule.useOriginal ? original : masked;
    rule.re.lastIndex = 0;
    let m;
    let count = 0;
    while ((m = rule.re.exec(source)) && count < 50) {
      if (m[0].length === 0) { rule.re.lastIndex++; continue; }
      /* for rules that run on the original text, skip matches that start inside a plain URL
         (Markdown links are the exception: they contain a URL on purpose) */
      if (rule.useOriginal && rule.id !== 'format.md_link' && rule.id !== 'format.html_tag') {
        const inside = urls.some((u) => m.index >= u.start && m.index < u.end);
        if (inside) continue;
      }
      hits.push({ rule, start: m.index, end: m.index + m[0].length, match: m });
      count++;
    }
  }
  /* drop overlaps: keep the earliest, longest */
  hits.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const kept = [];
  let lastEnd = -1;
  for (const h of hits) { if (h.start >= lastEnd) { kept.push(h); lastEnd = h.end; } }
  return kept;
}

/* the cleaned text, applying every replacement right to left (hits from findFormatting, so the patterns run once) */
export function cleanFormatting(text, knownHits) {
  const original = String(text || '');
  const hits = knownHits || findFormatting(original);
  let out = original;
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    const rep = h.rule.replace(...h.match);
    out = out.slice(0, h.start) + rep + out.slice(h.end);
  }
  /* tidy: no triple blank lines or trailing spaces created by removed tags */
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
}

export function checkFormatting(post, channel) {
  const service = (channel && channel.service) || post.channelService;
  if (!RAW_SERVICES.has(service)) return [];
  const svc = SERVICE_NAMES[service] || service;
  const flags = [];
  const items = post.thread && post.thread.length > 1 ? post.thread.map((t, i) => ({ text: t.text, where: 'thread:' + i })) : [{ text: post.text, where: 'text' }];
  for (const it of items) {
    const hits = findFormatting(it.text);
    if (!hits.length) continue;
    const byRule = new Map();
    for (const h of hits) {
      if (!byRule.has(h.rule.id)) byRule.set(h.rule.id, []);
      byRule.get(h.rule.id).push(h);
    }
    const rules = Array.from(byRule.values()).map((list) => list[0].rule);
    const severity = rules.some((r) => (r.severity || 'medium') === 'medium') ? 'medium' : 'low';
    const fixed = cleanFormatting(it.text, hits);
    const examples = hits.slice(0, 4).map((h) => '"' + clip(String(it.text).slice(h.start, h.end).trim() || String(it.text).slice(h.start, h.end), 32) + '"').join(', ');
    const single = rules.length === 1;
    flags.push({
      check: 'format', id: single ? rules[0].id : 'format.mixed', severity, where: it.where,
      title: single ? rules[0].title + (hits.length > 1 ? ' (' + hits.length + ')' : '') : svc + ' will show this formatting as raw text (' + hits.length + ')',
      detail: (single ? rules[0].explain(svc) : svc + ' does not render Markdown or HTML, so these show up exactly as typed.') + ' Found: ' + examples + (hits.length > 4 ? ' and more' : '') + '.',
      spans: hits.map((h) => [h.start, h.end]),
      data: { rules: rules.map((r) => r.id), count: hits.length },
      fixes: it.where === 'text' && fixed !== it.text ? [{ type: 'edit', label: 'Clean up formatting', text: fixed }] : []
    });
  }
  return flags;
}
