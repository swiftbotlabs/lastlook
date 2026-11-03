/* Look back: the text checks run on posts that already went out. Pure, read-only, no fixes.
   Each sent post is judged at the moment it was actually sent (sentAt, else dueAt) in its channel's time zone.
   Checks: day and time words, formatting the network showed raw, length counted the network's way, placeholders,
   the same post sent twice on one channel, images without alt text. Links are listed, never opened: a sent post
   cannot be edited, and opening every old link would spend the link-check budget the live queue needs. */
import { checkTime, localParts, fmtDay, fmtTime, validTz } from './time.js';
import { checkFormatting } from './format.js';
import { checkLength } from './length.js';
import { checkDuplicates } from './dupes.js';
import { checkPlaceholders, checkAltText } from './extra.js';
import { postLinks } from './index.js';

export const LOOKBACK_MAX = 90;
export const ISSUE = new Set(['high', 'medium']);
const ORDER = { high: 0, medium: 1, low: 2 };

/* the groups shown at the top, in this order; only flags of these checks are reported */
export const LOOKBACK_GROUPS = [
  { check: 'time', title: 'Day and time words that were wrong when the post went out', explain: '"Happy Friday" on a Monday, "good morning" in the evening, "today at 6pm" sent after six, dates already past.' },
  { check: 'format', title: 'Formatting that showed as raw text', explain: 'Markdown and HTML that the network printed as typed: asterisks, # headings, [text](link), &amp; codes.' },
  { check: 'length', title: 'Longer than the network allows', explain: 'Counted the way the network counts, so the end may have been cut off.' },
  { check: 'placeholder', title: 'Placeholders that went out unfilled', explain: 'Template text such as [link], {{first_name}} or TODO.' },
  { check: 'dupe', title: 'The same post sent twice', explain: 'Identical text sent more than once on one channel.' },
  { check: 'alt', title: 'Images sent without alt text', explain: 'Screen reader users heard nothing for these images.' }
];
const KNOWN = new Set(LOOKBACK_GROUPS.map((g) => g.check));

const sentTime = (p) => p.sentAt || p.dueAt || null;
function whenSent(post, channels) {
  const iso = sentTime(post);
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d)) return null;
  const ch = channels.get(post.channelId);
  const p = localParts(d, validTz(ch && ch.timezone));
  return fmtDay(p) + ', ' + fmtTime(p);
}

/* posts: shaped sent posts (with sentAt). Returns {posts: [post + flags + linkCount], groups, totals} */
export function runLookback(channels, posts, now) {
  const chMap = new Map((channels || []).map((c) => [c.id, c]));
  const list = (posts || []).slice(0, LOOKBACK_MAX);
  /* judged at the real send time; treated as fixed-time posts (a queue slot no longer moves once sent) */
  const virt = list.map((p) => Object.assign({}, p, { dueAt: sentTime(p), isCustomScheduled: true, shareMode: 'customScheduled', status: 'sent' }));
  const byId = new Map(virt.map((p) => [p.id, p]));
  const dupes = checkDuplicates(virt, chMap);
  const out = [];
  for (const v of virt) {
    const ch = chMap.get(v.channelId) || { service: v.channelService, timezone: 'Europe/London' };
    let flags = [];
    const run = (fn) => { try { flags = flags.concat(fn() || []); } catch (e) { /* one check failing never hides the others */ } };
    if (v.dueAt) run(() => checkTime(v, ch, now, { sent: true }));
    run(() => checkFormatting(v, ch));
    run(() => checkLength(v, ch, { sent: true }));
    run(() => checkPlaceholders(v));
    run(() => checkAltText(v, { sent: true }));
    for (const f of dupes.get(v.id) || []) {
      const others = (f.related || []).map((id) => byId.get(id)).filter(Boolean);
      const at = others.map((o) => whenSent(o, chMap)).filter(Boolean).slice(0, 2);
      if (f.id === 'dupe.same_channel') {
        const n = others.length + 1;
        flags.push(Object.assign({}, f, { severity: 'medium', title: 'Same text sent ' + (n === 2 ? 'twice' : n + ' times') + ' on this channel', detail: (at.length ? 'Also sent ' + at.join(' and ') + '. ' : '') + 'Followers saw it more than once.' }));
      } else if (f.id === 'dupe.near_same_channel') {
        flags.push(Object.assign({}, f, { severity: 'low', title: f.title.replace('queued twice', 'sent twice'), detail: 'Reads almost the same as the post sent ' + (at[0] || 'earlier') + '. Fine for a series; a repeat if not.' }));
      }
      /* the same text on another channel is ordinary cross-posting: not reported for sent posts */
    }
    for (const f of flags) {
      f.fixes = [];
      if (f.id === 'time.past_date' && f.severity === 'medium') f.severity = 'low';   /* a past date without a cue is often a look back */
      if (f.id === 'length.over') f.severity = 'medium';                               /* it went out anyway */
      if (f.check === 'format') f.title = f.title.replace(/\bwill show\b/, 'showed');    /* past tense: it already went out */
    }
    flags = flags.filter((f) => KNOWN.has(f.check)).sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
    const src = list.find((p) => p.id === v.id);
    out.push(Object.assign({}, src, { flags, linkCount: postLinks(v).length }));
  }
  const groups = LOOKBACK_GROUPS.map((g) => Object.assign({}, g, { items: [], notes: [] }));
  const gMap = new Map(groups.map((g) => [g.check, g]));
  let issues = 0; let notes = 0; let postsWithIssues = 0; let links = 0;
  for (const p of out) {
    links += p.linkCount;
    let any = false;
    for (const f of p.flags) {
      const g = gMap.get(f.check);
      if (ISSUE.has(f.severity)) { issues++; any = true; g.items.push({ postId: p.id, flag: f }); } else { notes++; g.notes.push({ postId: p.id, flag: f }); }
    }
    if (any) postsWithIssues++;
  }
  return { posts: out, groups, totals: { checked: out.length, issues, notes, postsWithIssues, links }, meta: { repeatsPartial: !!(dupes.meta && dupes.meta.partial) } };
}
