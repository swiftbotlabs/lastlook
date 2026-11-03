/* Check 5: the same or nearly the same text queued twice.
   Same channel: X refuses identical posts, and followers see a repeat. Across channels at the same time is normal
   cross-posting, so only identical text at different times on other channels is mentioned, at low severity.

   Cost is bounded: identical texts are grouped with a hash map (one pass); "nearly the same" is compared only
   within a channel, only between texts of similar length (within 20%), on at most 120 words per post, and the
   whole comparison stops after WORK_CAP table steps. When the cap stops it, the result says so (meta.partial). */
import { normalizeForCompare, similarityWords, words, clipForChecks } from './text.js';
import { SERVICE_NAMES } from './length.js';
import { localParts, fmtDay, fmtTime, validTz } from './time.js';

export const NEAR = 0.8;
export const WORD_CAP = 120;
export const WORK_CAP = 4e6;
const SAME_TIME_MS = 15 * 60 * 1000;
const MAX_RELATED = 10;

function label(channel) {
  if (!channel) return 'another channel';
  return (channel.displayName || channel.name || 'channel') + ' (' + (SERVICE_NAMES[channel.service] || channel.service) + ')';
}
function fmtWhen(post, channels) {
  const d = post.dueAt ? new Date(post.dueAt) : null;
  if (!d || isNaN(d)) return null;
  const ch = channels.get(post.channelId);
  const tz = validTz(ch && ch.timezone);
  const p = localParts(d, tz);
  return fmtDay(p) + ', ' + fmtTime(p) + ' (' + tz + ')';
}
const dueMs = (p) => { const t = Date.parse(p.dueAt || ''); return Number.isFinite(t) ? t : Infinity; };

/* posts: [{id, channelId, text, dueAt}] ; channels: Map id -> channel
   returns Map postId -> flags[], with .meta = {partial, steps, pairs} */
export function checkDuplicates(posts, channels) {
  const out = new Map();
  const meta = { partial: false, steps: 0, pairs: 0 };
  out.meta = meta;
  const add = (id, f) => { if (!out.has(id)) out.set(id, []); out.get(id).push(f); };
  const items = [];
  for (const p of posts) {
    if (!p || typeof p.text !== 'string' || !p.text.trim()) continue;
    const norm = normalizeForCompare(clipForChecks(p.text));
    const w = words(norm);
    if (w.length < 3) continue;
    items.push({ p, norm, w: w.slice(0, WORD_CAP) });
  }

  /* 1. identical text: one hash-map pass */
  const groups = new Map();
  for (const it of items) { if (!groups.has(it.norm)) groups.set(it.norm, []); groups.get(it.norm).push(it); }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const byChannel = new Map();
    for (const it of group) { if (!byChannel.has(it.p.channelId)) byChannel.set(it.p.channelId, []); byChannel.get(it.p.channelId).push(it.p); }
    for (const list of byChannel.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => dueMs(a) - dueMs(b));
      const svc = (channels.get(list[0].channelId) || {}).service;
      list.forEach((post, i) => {
        const others = list.filter((x) => x !== post);
        const later = i > 0;
        const next = others[0];
        add(post.id, {
          check: 'dupe', id: 'dupe.same_channel', severity: 'high', where: 'text',
          title: list.length === 2 ? 'Same text queued twice on this channel' : 'Same text queued ' + list.length + ' times on this channel',
          detail: 'Another queued post on this channel has the same words' + (fmtWhen(next, channels) ? ' and goes out ' + fmtWhen(next, channels) : '') + '. ' +
            (svc === 'twitter' ? 'X refuses identical posts, and followers notice repeats.' : 'Followers notice repeats.') + (later ? ' This is a later one.' : ''),
          related: others.slice(0, MAX_RELATED).map((x) => x.id),
          fixes: later ? [{ type: 'draft' }, { type: 'move', position: 'bottom' }, { type: 'edit', label: 'Reword' }] : [{ type: 'edit', label: 'Reword' }]
        });
      });
    }
    /* the same words on other channels at a different time */
    if (byChannel.size > 1) {
      for (const it of group) {
        const elsewhere = group.filter((o) => o.p.channelId !== it.p.channelId && !(it.p.dueAt && o.p.dueAt && Math.abs(dueMs(it.p) - dueMs(o.p)) <= SAME_TIME_MS));
        if (!elsewhere.length) continue;
        const first = elsewhere[0].p;
        add(it.p.id, {
          check: 'dupe', id: 'dupe.cross_channel', severity: 'low', where: 'text',
          title: 'Same text also queued on ' + label(channels.get(first.channelId)) + (elsewhere.length > 1 ? ' and ' + (elsewhere.length - 1) + ' more' : ''),
          detail: 'Fine if you are cross-posting on purpose' + (fmtWhen(first, channels) ? '; that one goes out ' + fmtWhen(first, channels) : '') + '.',
          related: elsewhere.slice(0, MAX_RELATED).map((o) => o.p.id), fixes: []
        });
      }
    }
  }

  /* 2. nearly the same text: within a channel, similar lengths only, bounded work */
  const byChannel = new Map();
  for (const it of items) { if (!byChannel.has(it.p.channelId)) byChannel.set(it.p.channelId, []); byChannel.get(it.p.channelId).push(it); }
  outer:
  for (const list of byChannel.values()) {
    list.sort((a, b) => a.w.length - b.w.length);
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (a.w.length < NEAR * b.w.length) break;      /* sorted by length: the rest are longer still */
        if (a.norm === b.norm) continue;                  /* already reported as identical */
        const cost = a.w.length * b.w.length;
        if (meta.steps + cost > WORK_CAP) { meta.partial = true; break outer; }
        meta.steps += cost;
        meta.pairs++;
        const sim = similarityWords(a.w, b.w);
        if (sim < NEAR) continue;
        const [first, second] = dueMs(a.p) <= dueMs(b.p) ? [a.p, b.p] : [b.p, a.p];
        const pct = Math.round(sim * 100);
        const flag = (post, other, isLater) => {
          const existing = (out.get(post.id) || []).filter((f) => f.id === 'dupe.near_same_channel').length;
          if (existing >= 3) return;
          add(post.id, {
            check: 'dupe', id: 'dupe.near_same_channel', severity: 'medium', where: 'text',
            title: 'Nearly the same text queued twice (' + pct + '% alike)',
            detail: 'Another queued post on this channel reads almost the same' + (fmtWhen(other, channels) ? ' and goes out ' + fmtWhen(other, channels) : '') + '. Followers notice repeats.' + (isLater ? ' This is the later one.' : ''),
            related: [other.id],
            fixes: isLater ? [{ type: 'draft' }, { type: 'move', position: 'bottom' }, { type: 'edit', label: 'Reword' }] : [{ type: 'edit', label: 'Reword' }]
          });
        };
        flag(first, second, false);
        flag(second, first, true);
      }
    }
  }
  return out;
}
