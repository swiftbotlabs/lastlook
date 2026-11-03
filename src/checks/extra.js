/* Extra checks: leftover placeholders, images without alt text, hashtag and mention problems. */
import { maskUrls, clip } from './text.js';
import { SERVICE_NAMES } from './length.js';

/* leftovers from templates and drafts */
const PLACEHOLDERS = [
  /\[(?:insert[^\]\n]{0,40}|link|url|link here|add link|name|first ?name|company|date|time|price|cta|tbd|todo|xx+|placeholder|image|photo|handle|@handle|hashtag)\]/gi,
  /\{\{\s*[\w.]{1,40}\s*\}\}|\{\s*(?:first_?name|name|link|url|date|company)\s*\}/gi,
  /<(?:insert[^>\n]{0,40}|link|url|name|date)>/gi,
  /\b(?:TODO|TBD|FIXME|TKTK|XXX+)\b/g,
  /\blorem ipsum\b/gi,
  /\b(?:insert|add|paste) (?:link|url|image|name|date) here\b/gi
];
export function checkPlaceholders(post) {
  const flags = [];
  const items = post.thread && post.thread.length > 1 ? post.thread.map((t, i) => ({ text: t.text, where: 'thread:' + i })) : [{ text: post.text, where: 'text' }];
  for (const it of items) {
    const masked = maskUrls(it.text);
    const spans = [];
    const found = [];
    for (const re of PLACEHOLDERS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(masked)) && spans.length < 20) {
        if (spans.some(([a, b]) => m.index < b && a < m.index + m[0].length)) continue;
        spans.push([m.index, m.index + m[0].length]);
        found.push(m[0]);
      }
    }
    if (spans.length) flags.push({
      check: 'placeholder', id: 'placeholder.left', severity: 'high', where: it.where, spans,
      title: 'Leftover placeholder' + (spans.length > 1 ? 's' : ''),
      detail: 'Looks like template text that was never filled in: ' + found.slice(0, 4).map((x) => '"' + clip(x, 30) + '"').join(', ') + '.',
      fixes: it.where === 'text' ? [{ type: 'edit', label: 'Fill it in' }, { type: 'draft' }] : [{ type: 'draft' }]
    });
  }
  return flags;
}

/* images without a description */
export function checkAltText(post) {
  const imgs = [];
  (post.assets || []).forEach((a, i) => { if (a && a.type === 'image') imgs.push({ a, where: 'asset:' + i }); });
  if (post.thread && post.thread.length > 1) post.thread.forEach((t, ti) => (t.assets || []).forEach((a, i) => { if (a && a.type === 'image') imgs.push({ a, where: 'thread:' + ti + ':asset:' + i }); }));
  const missing = imgs.filter((x) => !(x.a.altText && String(x.a.altText).trim()));
  if (!missing.length) return [];
  return [{
    check: 'alt', id: 'alt.missing', severity: 'medium', where: 'assets',
    title: missing.length === 1 ? 'Image has no alt text' : missing.length + ' images have no alt text',
    detail: 'People using screen readers hear nothing for ' + (missing.length === 1 ? 'this image' : 'these images') + '. Add a short description in Buffer before it goes out.',
    data: { count: missing.length },
    fixes: []
  }];
}

/* hashtags and mentions */
const MAX_TAGS = { instagram: 30 };       /* Instagram's long-standing cap of 30 hashtags per post (Instagram Help Center, "How do I use hashtags on Instagram?") */
const MANY_TAGS = { twitter: 3, bluesky: 3, threads: 1, linkedin: 5, mastodon: 6, facebook: 5 };
export function checkTags(post, channel) {
  const service = (channel && channel.service) || post.channelService;
  const flags = [];
  const text = String(post.text || '');
  const masked = maskUrls(text);
  const tags = masked.match(/(^|[^\w&#])#[\p{L}\p{N}_]+/gu) || [];
  const n = tags.length;
  const name = SERVICE_NAMES[service] || service;
  if (MAX_TAGS[service] && n > MAX_TAGS[service]) {
    flags.push({
      check: 'tags', id: 'tags.too_many', severity: 'medium', where: 'text',
      title: n + ' hashtags; ' + name + ' caps a post at ' + MAX_TAGS[service],
      detail: 'Over the cap, ' + name + ' can refuse the post or drop the extra tags.',
      fixes: [{ type: 'edit', label: 'Remove some' }]
    });
  } else if (MANY_TAGS[service] && n > MANY_TAGS[service] * 2) {
    flags.push({
      check: 'tags', id: 'tags.many', severity: 'low', where: 'text',
      title: n + ' hashtags',
      detail: 'Posts on ' + name + ' with this many hashtags read as spam to many people.',
      fixes: [{ type: 'edit', label: 'Trim hashtags' }]
    });
  }
  /* "#launch-day" stops at the hyphen: the tag becomes #launch */
  const broken = [];
  const reBroken = /(^|[^\w&#])(#[\p{L}\p{N}_]+)([-'’.][\p{L}\p{N}]+)/gu;
  let m;
  while ((m = reBroken.exec(masked)) && broken.length < 10) {
    const start = m.index + m[1].length;
    broken.push({ start, end: start + m[2].length + m[3].length, raw: m[2] + m[3], tag: m[2] });
  }
  if (broken.length) flags.push({
    check: 'tags', id: 'tags.broken', severity: 'low', where: 'text', spans: broken.map((b) => [b.start, b.end]),
    title: 'Hashtag cut short',
    detail: broken.slice(0, 3).map((b) => '"' + b.raw + '" links only ' + b.tag).join('; ') + '. Hashtags stop at a hyphen, apostrophe or dot.',
    fixes: [{ type: 'edit', label: 'Fix hashtag', text: fixBroken(text, broken) }]
  });
  /* "@ name" and "# tag" with a space: a mention or tag that will not link */
  const stray = [];
  const reStray = /(^|\s)([@#])\s+(?=[\p{L}_])/gu;
  while ((m = reStray.exec(masked)) && stray.length < 10) stray.push([m.index + m[1].length, m.index + m[0].length]);
  if (stray.length) {
    /* a lone "# " at the start of a line is a Markdown heading, reported by the formatting check */
    const real = stray.filter(([a]) => !(text[a] === '#' && (a === 0 || text[a - 1] === '\n')));
    if (real.length) flags.push({
      check: 'tags', id: 'tags.stray', severity: 'low', where: 'text', spans: real,
      title: 'Space after @ or #',
      detail: 'A space after @ or # means the mention or hashtag will not link.',
      fixes: [{ type: 'edit', label: 'Remove the space', text: fixStray(text, real) }]
    });
  }
  /* unbalanced brackets and quotes */
  const pairs = [['(', ')'], ['[', ']'], ['“', '”']];
  /* smileys and list markers are not brackets: ":)", ";-(", "(:", "1)", "a)" */
  const plain = masked.replace(/[:;=8xX][-^'o]?[()\[\]]+|[()\[\]]+[-^']?[:;=8]/g, ' ').replace(/(^|\s)[0-9a-zA-Z]{1,2}\)/g, ' ');
  for (const [o, c] of pairs) {
    const no = plain.split(o).length - 1; const nc = plain.split(c).length - 1;
    if (no !== nc && no + nc > 0) {
      flags.push({
        check: 'tags', id: 'tags.unbalanced', severity: 'low', where: 'text',
        title: 'Unmatched ' + o + ' ' + c,
        detail: 'The text opens ' + no + ' and closes ' + nc + '. Often a sign of a cut-off sentence or link.',
        fixes: [{ type: 'edit', label: 'Fix' }]
      });
      break;
    }
  }
  return flags;
}
function fixBroken(text, broken) {
  let out = text;
  for (let i = broken.length - 1; i >= 0; i--) {
    const b = broken[i];
    const joined = b.raw.replace(/[-'’.]/g, '');
    out = out.slice(0, b.start) + joined + out.slice(b.end);
  }
  return out;
}
function fixStray(text, spans) {
  let out = text;
  for (let i = spans.length - 1; i >= 0; i--) {
    const [a, b] = spans[i];
    out = out.slice(0, a + 1) + out.slice(b);
  }
  return out;
}
