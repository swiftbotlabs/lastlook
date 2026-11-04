/* "Your own post" on /try: one post the visitor types, checked in this tab by the same code that checks a real
   Buffer queue (./checks/index.js runAll). Pure helpers: no DOM, no storage and no network code, so nothing typed
   here leaves the page. Links in the text are listed, never opened. app.js renders the result with DOM text
   nodes only (the text is the visitor's own, and is never parsed as HTML). */
import { runAll } from './checks/index.js';
import { localParts, fromDayNum, validTz } from './checks/time.js';
import { lengthFor, limitFor } from './checks/length.js';

export const OWN_MAX = 3000;
export const OWN_DEBOUNCE_MS = 150;
/* the channel pills, in the order shown */
export const OWN_SERVICES = ['twitter', 'linkedin', 'bluesky', 'threads', 'instagram', 'mastodon'];
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n) => String(n).padStart(2, '0');
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/* one-tap examples; each goes out at the default time (next Monday 09:30) */
export const OWN_EXAMPLES = {
  slip: { label: 'Weekday slip', service: 'linkedin', queue: true,
    text: 'Happy Friday, everyone! Our spring workshop dates are up, and the first sessions always fill fast. Grab a seat while you can.' },
  tomorrow: { label: '“tomorrow” that moves', service: 'bluesky', queue: true,
    text: 'Last call: early-bird tickets for our design meetup end tomorrow at midnight. Grab yours before the price goes up.' },
  raw: { label: 'Raw ** on X', service: 'twitter', queue: true,
    text: '**Big news:** our new booking page is live. Pick a class and book in two taps: https://example.com/book' }
};

/* the visitor's time zone (the channel's zone for this one post); London when the browser does not say */
export function localZone() {
  try { return validTz(Intl.DateTimeFormat().resolvedOptions().timeZone); } catch (e) { return validTz(null); }
}

/* the instant at wall-clock y-m-d hh:mm in a zone */
export function wallToIso(y, m, d, hh, mm, tz) {
  const zone = validTz(tz);
  const n = Math.floor(Date.UTC(y, m - 1, d) / 864e5);
  let guess = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 4; i++) {
    const p = localParts(new Date(guess), zone);
    const diff = (p.day - n) * 1440 + (p.hour * 60 + p.min) - (hh * 60 + mm);
    if (!diff) break;
    guess -= diff * 60000;
  }
  return new Date(guess).toISOString();
}

/* the picker's default: the next Monday (never today) at 09:30, as a datetime-local value */
export function defaultWhen(now, tz) {
  const t = localParts(now, validTz(tz));
  let n = t.day + 1;
  while (fromDayNum(n).dow !== 1) n++;
  const p = fromDayNum(n);
  return p.y + '-' + pad(p.m) + '-' + pad(p.d) + 'T09:30';
}

/* a datetime-local value ("2026-11-09T09:30", seconds optional) to an ISO instant in the zone; null if not a real time */
export function parseWhen(value, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d{1,3})?)?$/.exec(String(value == null ? '' : value).slice(0, 32));
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3], hh = +m[4], mi = +m[5];
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo) || hh > 23 || mi > 59) return null;
  return wallToIso(y, mo, d, hh, mi, tz);
}

/* "Monday 9 November" for an instant, in the zone */
export function dayWords(iso, tz) {
  const p = localParts(new Date(iso), validTz(tz));
  return DOW[p.dow] + ' ' + p.d + ' ' + MONTHS[p.m - 1];
}

/* at most OWN_MAX characters, never ending in half an emoji; line breaks as the textarea gives them (\n) */
export function clipOwn(text) {
  let s = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  if (s.length > OWN_MAX) {
    s = s.slice(0, OWN_MAX);
    const last = s.charCodeAt(s.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1);
  }
  return s;
}

export function ownChannel(service, tz) {
  const svc = OWN_SERVICES.includes(service) ? service : OWN_SERVICES[0];
  return { id: 'own', name: 'Your post', displayName: 'Your post', service: svc, type: 'profile', timezone: validTz(tz), avatar: null,
    isQueuePaused: false, isDisconnected: false, isLocked: false, metadata: { maxCharacters: null, subscriptionType: null } };
}

/* the one synthetic post, shaped like a post from a real scan: written now, going out at dueAt,
   in a queue slot (Buffer's "Add to queue") or at a fixed time; only text edits make sense for it */
export function ownPost(text, service, dueAt, queue, now) {
  const written = new Date(now.getTime()).toISOString();
  return {
    id: 'own-post', channelId: 'own', channelService: service, status: 'scheduled', dueAt, createdAt: written, updatedAt: written,
    shareMode: queue ? 'addToQueue' : 'customScheduled', isCustomScheduled: !queue, schedulingType: null,
    allowedActions: ['updatePost'], publishError: null, assets: [], thread: [], linkAttachment: null, firstComment: null, pinUrl: null,
    text
  };
}

/* run the checks on what the visitor typed. in: {text, service, when (datetime-local value), queue, now, tz} */
export function checkOwn(input) {
  const o = input || {};
  const now = o.now instanceof Date && !isNaN(o.now) ? o.now : new Date();
  const tz = validTz(o.tz);
  const text = clipOwn(o.text);
  const ch = ownChannel(o.service, tz);
  const picked = parseWhen(o.when, tz);
  const dueAt = picked || parseWhen(defaultWhen(now, tz), tz);
  const queue = o.queue !== false;
  const post = ownPost(text, ch.service, dueAt, queue, now);
  const checked = text.trim() ? runAll([ch], [post], now).posts[0] : Object.assign({}, post, { flags: [], links: [], allowed: { edit: true, draft: false, move: false } });
  /* a single post has no queue to move it in, and no drafts to move it to */
  for (const f of checked.flags) f.fixes = (f.fixes || []).filter((x) => x.type === 'edit');
  const n = { high: 0, medium: 0, low: 0 };
  for (const f of checked.flags) n[f.severity] = (n[f.severity] || 0) + 1;
  return {
    text, channel: ch, post: checked, tz, dueAt, usedDefault: !picked, queue,
    past: Date.parse(dueAt) <= now.getTime(),
    count: lengthFor(ch.service, text), limit: limitFor(ch.service, ch, post), full: text.length >= OWN_MAX,
    counts: n
  };
}
