/* Runs every check over a scanned queue. Pure: input is the shaped channels and posts, output is per-post flags
   plus the list of links the browser should ask /api/links to check. */
import { checkTime, checkNight, checkSlotShift, checkShareNext } from './time.js';
import { checkFormatting } from './format.js';
import { checkLength } from './length.js';
import { checkDuplicates } from './dupes.js';
import { checkPlaceholders, checkAltText, checkTags } from './extra.js';
import { findUrls, clipForChecks } from './text.js';

export const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };
const LIVE = new Set(['scheduled', 'needs_approval']);

/* which fixes the post allows right now */
export function allowedFixes(post) {
  const acts = new Set(post.allowedActions || []);
  const live = LIVE.has(post.status);
  const isThread = post.thread && post.thread.length > 1;
  return {
    edit: !isThread && (acts.size === 0 || acts.has('updatePost')) && (live || post.status === 'draft'),
    draft: live && (acts.size === 0 || acts.has('movePostToDraft')),
    move: post.status === 'scheduled' && !post.isCustomScheduled && post.shareMode !== 'customScheduled'
  };
}

/* links in one post with where they sit */
export function postLinks(post) {
  const out = [];
  const add = (url, where, start, end) => {
    if (!url) return;
    const u = String(url).slice(0, 2048);
    let e = out.find((x) => x.url === u);
    if (!e) { e = { url: u, places: [] }; out.push(e); }
    e.places.push({ where, start, end });
  };
  const items = post.thread && post.thread.length > 1 ? post.thread.map((t, i) => ({ text: t.text, where: 'thread:' + i })) : [{ text: post.text, where: 'text' }];
  for (const it of items) for (const u of findUrls(clipForChecks(it.text))) add(u.url, it.where, u.start, u.end);
  if (post.linkAttachment) add(post.linkAttachment, 'linkAttachment');
  if (post.firstComment) for (const u of findUrls(clipForChecks(post.firstComment))) add(u.url, 'firstComment', u.start, u.end);
  if (post.pinUrl) add(post.pinUrl, 'pinUrl');
  return out.slice(0, 25);
}

export function runChecks(channels, posts, now, opts) { return runAll(channels, posts, now, opts).posts; }

/* returns {posts, meta}; meta.repeatsPartial is true when the duplicate check hit its work cap.
   opts.shifts: Map post id -> the send time (ISO) the post had before a queue reorder moved it; those posts get
   their day words re-judged at the new slot (time.slot_shift), which replaces the general queue-slot note. */
export function runAll(channels, posts, now, opts) {
  const shifts = (opts && opts.shifts) || null;
  const chMap = new Map(channels.map((c) => [c.id, c]));
  const live = posts.filter((p) => LIVE.has(p.status));
  const dupes = checkDuplicates(live, chMap);
  const out = [];
  for (const p of posts) {
    const ch = chMap.get(p.channelId) || { service: p.channelService, timezone: 'Europe/London' };
    let flags = [];
    const run = (fn) => { try { flags = flags.concat(fn() || []); } catch (e) { flags.push({ check: 'internal', id: 'internal.error', severity: 'low', where: 'text', title: 'One check could not run on this post', detail: 'The other checks still ran.', fixes: [] }); } };
    run(() => checkTime(p, ch, now));
    const from = shifts && shifts.get(p.id);
    if (from) {
      const moved = [];
      run(() => { const f = checkSlotShift(p, ch, from); moved.push(...f); return f; });
      /* the re-judged word replaces the general "day word in a queue slot" note for the same words */
      const spans = moved.flatMap((f) => f.spans || []);
      if (spans.length) flags = flags.filter((f) => !(f.id === 'time.relative_queue' && (f.spans || []).some(([a, b]) => spans.some(([c, d]) => a < d && c < b))));
    }
    run(() => checkNight(p, ch));
    run(() => checkShareNext(p));
    run(() => checkFormatting(p, ch));
    run(() => checkLength(p, ch));
    run(() => checkPlaceholders(p));
    run(() => checkAltText(p));
    run(() => checkTags(p, ch));
    if (dupes.has(p.id)) flags = flags.concat(dupes.get(p.id));
    if (p.publishError) flags.push({ check: 'buffer', id: 'buffer.error', severity: 'high', where: 'text', title: 'Buffer reported a problem with this post', detail: p.publishError, fixes: [] });
    if (ch.isDisconnected) flags.push({ check: 'buffer', id: 'buffer.disconnected', severity: 'high', where: 'text', title: 'Channel is disconnected', detail: 'Buffer cannot post to this channel until you reconnect it in Buffer.', fixes: [] });
    if (ch.isQueuePaused && p.status === 'scheduled') flags.push({ check: 'buffer', id: 'buffer.paused', severity: 'low', where: 'text', title: 'Queue is paused', detail: 'Nothing on this channel goes out until you resume the queue in Buffer.', fixes: [] });
    const allowed = allowedFixes(p);
    for (const f of flags) f.fixes = (f.fixes || []).filter((x) => allowed[x.type]);
    flags.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    out.push(Object.assign({}, p, { flags, links: postLinks(p), allowed }));
  }
  return { posts: out, meta: { repeatsPartial: !!(dupes.meta && dupes.meta.partial) } };
}
