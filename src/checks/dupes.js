/* Check 5: the same or nearly the same text queued twice.
   Same channel: X refuses identical posts, and followers see a repeat. Across channels at the same time is normal
   cross-posting, so only identical text at different times on other channels is mentioned, at low severity. */
import { normalizeForCompare, similarity, words } from './text.js';
import { SERVICE_NAMES } from './length.js';
import { localParts, fmtDay, fmtTime, validTz } from './time.js';

export const NEAR = 0.8;
const SAME_TIME_MS = 15 * 60 * 1000;

function label(channel) {
  if (!channel) return 'another channel';
  return (channel.displayName || channel.name || 'channel') + ' (' + (SERVICE_NAMES[channel.service] || channel.service) + ')';
}
function when(post) { return post.dueAt ? post.dueAt : null; }
function fmtWhen(post, channels) {
  const d = post.dueAt ? new Date(post.dueAt) : null;
  if (!d || isNaN(d)) return null;
  const ch = channels.get(post.channelId);
  const tz = validTz(ch && ch.timezone);
  const p = localParts(d, tz);
  return fmtDay(p) + ', ' + fmtTime(p) + ' (' + tz + ')';
}

/* posts: [{id, channelId, text, dueAt, status}] ; channels: Map id -> channel ; returns Map postId -> flags[] */
export function checkDuplicates(posts, channels) {
  const out = new Map();
  const add = (id, f) => { if (!out.has(id)) out.set(id, []); out.get(id).push(f); };
  const items = posts.filter((p) => p && typeof p.text === 'string' && p.text.trim()).map((p) => ({ p, norm: normalizeForCompare(p.text) }))
    .filter((x) => words(x.norm).length >= 3);
  /* n is capped by the scan (at most 300 posts), so the pairwise pass stays small */
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]; const b = items[j];
      const exact = a.norm === b.norm;
      const sim = exact ? 1 : similarity(a.norm, b.norm);
      if (sim < NEAR) continue;
      const sameChannel = a.p.channelId === b.p.channelId;
      /* the later one is the one to move */
      const ta = Date.parse(when(a.p) || '') || Infinity; const tb = Date.parse(when(b.p) || '') || Infinity;
      const [first, second] = ta <= tb ? [a.p, b.p] : [b.p, a.p];
      if (sameChannel) {
        const pct = Math.round(sim * 100);
        const both = (post, other, isLater) => add(post.id, {
          check: 'dupe', id: exact ? 'dupe.same_channel' : 'dupe.near_same_channel', severity: exact ? 'high' : 'medium', where: 'text',
          title: exact ? 'Same text queued twice on this channel' : 'Nearly the same text queued twice (' + pct + '% alike)',
          detail: (exact ? 'Another queued post on this channel has the same words' : 'Another queued post on this channel reads almost the same') +
            (fmtWhen(other, channels) ? ' and goes out ' + fmtWhen(other, channels) : '') + '. ' +
            (exact && (channels.get(post.channelId) || {}).service === 'twitter' ? 'X refuses identical posts, and followers notice repeats.' : 'Followers notice repeats.') +
            (isLater ? ' This is the later one.' : ''),
          related: [other.id],
          fixes: isLater ? [{ type: 'draft' }, { type: 'move', position: 'bottom' }, { type: 'edit', label: 'Reword' }] : [{ type: 'edit', label: 'Reword' }]
        });
        both(first, second, false);
        both(second, first, true);
      } else if (exact) {
        const gap = Math.abs((Date.parse(a.p.dueAt || '') || 0) - (Date.parse(b.p.dueAt || '') || 0));
        if (a.p.dueAt && b.p.dueAt && gap <= SAME_TIME_MS) continue; /* plain cross-posting */
        add(a.p.id, crossFlag(b.p, channels));
        add(b.p.id, crossFlag(a.p, channels));
      }
    }
  }
  return out;
}
function crossFlag(other, channels) {
  return {
    check: 'dupe', id: 'dupe.cross_channel', severity: 'low', where: 'text',
    title: 'Same text also queued on ' + label(channels.get(other.channelId)),
    detail: 'Fine if you are cross-posting on purpose' + (fmtWhen(other, channels) ? '; that one goes out ' + fmtWhen(other, channels) : '') + '.',
    related: [other.id], fixes: []
  };
}
