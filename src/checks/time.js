/* Check 2: time words that will be wrong when the post goes out.
   Everything is judged at the post's send time (dueAt) in the channel's time zone (Buffer's channel.timezone,
   "Default if not set is Europe/London"). */
import { maskUrls, clipForChecks } from './text.js';

export const DEFAULT_TZ = 'Europe/London';
const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_LONG = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MON_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const dayNum = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 864e5);
export function fromDayNum(n) {
  const dt = new Date(n * 864e5);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), dow: dt.getUTCDay(), day: n };
}
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

const FMT = new Map();
export function validTz(tz) {
  if (!tz || typeof tz !== 'string' || tz.length > 64) return DEFAULT_TZ;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch (e) { return DEFAULT_TZ; }
}
/* local wall-clock parts of an instant in a zone */
export function localParts(date, tz) {
  const zone = validTz(tz);
  let f = FMT.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
    FMT.set(zone, f);
  }
  const o = {};
  for (const p of f.formatToParts(date)) o[p.type] = p.value;
  const y = Number(o.year), m = Number(o.month), d = Number(o.day);
  return { y, m, d, hour: Number(o.hour) % 24, min: Number(o.minute), dow: DOW_SHORT.indexOf(o.weekday), day: dayNum(y, m, d), tz: zone };
}
export function fmtDay(p, withYearOf) {
  const s = DOW_SHORT[p.dow] + ' ' + p.d + ' ' + MON_SHORT[p.m - 1];
  return withYearOf != null && p.y !== withYearOf ? s + ' ' + p.y : s;
}
/* the instant of wall-clock time hh:mm on local day number n in zone tz (DST-safe to the minute) */
export function zonedTime(n, hh, mm, tz) {
  const zone = validTz(tz);
  const { y, m, d } = fromDayNum(n);
  let guess = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 4; i++) {
    const p = localParts(new Date(guess), zone);
    const diff = (p.day - n) * 1440 + (p.hour * 60 + p.min) - (hh * 60 + mm);
    if (!diff) break;
    guess -= diff * 60000;
  }
  return guess;
}
export const fmtTime = (p) => String(p.hour).padStart(2, '0') + ':' + String(p.min).padStart(2, '0');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/* ---------- explicit dates ---------- */
const MONTH_ALT = 'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec';
const WD_ALT = 'Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tues|Tue|Wed|Thurs|Thur|Thu|Fri|Sat|Sun';
const ORD = '(?:st|nd|rd|th)?';
const RE_MONTH_FIRST = new RegExp('\\b(?:(' + WD_ALT + ')\\.?,?\\s+)?(' + MONTH_ALT + ')\\.?\\s+(\\d{1,2})' + ORD + '\\b(?:\\s*(?:-|–|—|to|through|thru|until)\\s*(?:(' + MONTH_ALT + ')\\.?\\s+)?(\\d{1,2})' + ORD + '\\b)?(?:,?\\s+(\\d{4})\\b)?', 'gi');
const RE_DAY_FIRST = new RegExp('\\b(?:(' + WD_ALT + ')\\.?,?\\s+)?(?:the\\s+)?(\\d{1,2})' + ORD + '(?:\\s*(?:-|–|—|to)\\s*(\\d{1,2})' + ORD + ')?(?:\\s+of)?\\s+(' + MONTH_ALT + ')\\b\\.?(?:,?\\s+(\\d{4})\\b)?', 'gi');
const RE_ISO = /\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g;

function monthIndex(tok) {
  const t = tok.toLowerCase();
  if (t === 'sept') return 9;
  const i = MONTHS.findIndex((m) => m.startsWith(t.slice(0, 3)));
  return i >= 0 ? i + 1 : 0;
}
function weekdayIndex(tok) {
  if (!tok) return -1;
  return DOW_LONG.findIndex((d) => d.startsWith(tok.toLowerCase().slice(0, 3)));
}
/* "may 5" and "mar 3" in lower case are usually not dates: require a capital first letter on the month */
const titleCase = (tok) => /^[A-Z]/.test(tok);

/* pick the year for a date written without one: the year that puts it closest to the send day */
function inferYear(m, d, send) {
  let best = null;
  for (const y of [send.y - 1, send.y, send.y + 1]) {
    if (d > daysInMonth(y, m)) continue;
    const n = dayNum(y, m, d);
    if (!best || Math.abs(n - send.day) < Math.abs(best.n - send.day)) best = { y, n };
  }
  return best;
}

export function findDates(text, send) {
  const s = maskUrls(text);
  const out = [];
  const push = (o) => { if (!out.some((x) => x.start < o.end && o.start < x.end)) out.push(o); };
  let m;
  RE_MONTH_FIRST.lastIndex = 0;
  while ((m = RE_MONTH_FIRST.exec(s))) {
    if (!titleCase(m[2])) continue;
    const mon = monthIndex(m[2]); const d = Number(m[3]);
    const endMon = m[4] ? monthIndex(m[4]) : mon; const endD = m[5] ? Number(m[5]) : d;
    if (!mon || d < 1 || d > 31 || endD < 1 || endD > 31) continue;
    push(build(m, mon, d, endMon, endD, m[6] ? Number(m[6]) : null, weekdayIndex(m[1]), send));
  }
  RE_DAY_FIRST.lastIndex = 0;
  while ((m = RE_DAY_FIRST.exec(s))) {
    if (!titleCase(m[4])) continue;
    const mon = monthIndex(m[4]); const d = Number(m[2]); const endD = m[3] ? Number(m[3]) : d;
    if (!mon || d < 1 || d > 31 || endD < 1 || endD > 31) continue;
    push(build(m, mon, d, mon, endD, m[5] ? Number(m[5]) : null, weekdayIndex(m[1]), send));
  }
  RE_ISO.lastIndex = 0;
  while ((m = RE_ISO.exec(s))) {
    const y = Number(m[1]), mon = Number(m[2]), d = Number(m[3]);
    if (d > daysInMonth(y, mon)) continue;
    push({ start: m.index, end: m.index + m[0].length, raw: m[0], y, m: mon, d, day: dayNum(y, mon, d), endDay: dayNum(y, mon, d), weekday: -1, explicitYear: true });
  }
  return out.filter(Boolean).sort((a, b) => a.start - b.start);
}
function build(m, mon, d, endMon, endD, year, wd, send) {
  let y = year; let day;
  if (y) {
    if (d > daysInMonth(y, mon)) return null;
    day = dayNum(y, mon, d);
  } else {
    const best = inferYear(mon, d, send);
    if (!best) return null;
    y = best.y; day = best.n;
  }
  let endY = y;
  if (endMon < mon) endY = y + 1;
  if (endD > daysInMonth(endY, endMon)) return null;
  const endDay = dayNum(endY, endMon, endD);
  return { start: m.index, end: m.index + m[0].length, raw: m[0], y, m: mon, d, day, endDay: endDay >= day ? endDay : day, weekday: wd, explicitYear: !!year };
}

/* ---------- relative words ---------- */
/* each: regex, what it means relative to a base local time */
const REL = [
  { key: 'today', re: /\b(today|later today)\b/gi, offset: 0 },
  { key: 'tonight', re: /\b(tonight|this evening)\b/gi, offset: 0, part: 'evening' },
  { key: 'this morning', re: /\bthis morning\b/gi, offset: 0, part: 'morning' },
  { key: 'this afternoon', re: /\bthis afternoon\b/gi, offset: 0, part: 'afternoon' },
  { key: 'tomorrow', re: /\b(tomorrow|tmrw|tmr)\b/gi, offset: 1 },
  { key: 'yesterday', re: /\b(yesterday|last night)\b/gi, offset: -1 },
  { key: 'this weekend', re: /\b(this weekend|this coming weekend)\b/gi, weekend: true },
  { key: 'next week', re: /\bnext week\b/gi, week: 1 },
  { key: 'this week', re: /\bthis week\b/gi, week: 0 }
];
const RE_WEEKDAY = /\b(?:(this|next|on|coming|this coming|last)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/gi;

/* the day (or first day) a relative phrase points to, seen from base */
function resolveRel(rel, base) {
  if (rel.offset != null) return base.day + rel.offset;
  if (rel.weekend) {
    if (base.dow === 6 || base.dow === 0) return base.day; /* already the weekend */
    return base.day + (6 - base.dow);
  }
  if (rel.week != null) {
    const monday = base.day - ((base.dow + 6) % 7);
    return monday + 7 * rel.week;
  }
  return null;
}
function resolveWeekday(mod, wd, base) {
  const m = (mod || '').toLowerCase();
  if (m === 'last') { let k = (base.dow - wd + 7) % 7; if (k === 0) k = 7; return base.day - k; }
  let k = (wd - base.dow + 7) % 7;
  if (m === 'next' && k === 0) k = 7;
  return base.day + k;
}

export function findRelative(text) {
  const s = maskUrls(text);
  const out = [];
  for (const rel of REL) {
    rel.re.lastIndex = 0;
    let m;
    while ((m = rel.re.exec(s))) out.push({ rel, start: m.index, end: m.index + m[0].length, raw: m[0] });
  }
  RE_WEEKDAY.lastIndex = 0;
  let m;
  while ((m = RE_WEEKDAY.exec(s))) {
    /* "Happy Friday" and "#FridayFeeling" are handled as greetings */
    const before = s.slice(Math.max(0, m.index - 12), m.index).toLowerCase();
    if (/(happy|good|great|lovely|nice)\s+$/.test(before) || /#\w*$/.test(before)) continue;
    /* a weekday that is part of a written date ("Friday, Nov 20") is checked with the date */
    out.push({ rel: { key: 'weekday', wd: DOW_LONG.indexOf(m[2].toLowerCase()), mod: m[1] || '' }, start: m.index, end: m.index + m[0].length, raw: m[0] });
  }
  return out.sort((a, b) => a.start - b.start);
}

/* ---------- greetings tied to a day or a time ---------- */
const DAY_TAGS = [
  [/#(motivation|music|meme|marketing|manic)monday\b|#monday\w*/gi, 1],
  [/#(tuesdaytip|tiptuesday|transformationtuesday|techtuesday|tastytuesday)s?\b|#tuesday\w*/gi, 2],
  [/#(wednesdaywisdom|wisdomwednesday|wellnesswednesday|womancrushwednesday|wcw|humpday)\b|#wednesday\w*/gi, 3],
  [/#(throwbackthursday|tbt|thursdaythoughts|thankfulthursday)\b|#thursday\w*/gi, 4],
  [/#(fridayfeeling|followfriday|ff|tgif|fridayvibes|flashbackfriday|fbf|feelgoodfriday)\b|#friday\w*/gi, 5],
  [/#(saturdayvibes|caturday|saturdaymorning)\b|#saturday\w*/gi, 6],
  [/#(sundayfunday|selfcaresunday|sundayvibes|sundayreads)\b|#sunday\w*/gi, 0]
];
const RE_HAPPY_DAY = /\b(happy|good|great|lovely|have a (?:great|good|nice|lovely)) (monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\bTGIF\b/gi;
const GREETINGS = [
  { re: /\bgood morning\b|\bmorning,? (?:all|everyone|folks|friends|team)\b|\bthis morning\b/gi, ok: (h) => h >= 4 && h < 12, word: 'morning' },
  { re: /\bgood afternoon\b|\bthis afternoon\b/gi, ok: (h) => h >= 11 && h < 18, word: 'afternoon' },
  { re: /\bgood evening\b/gi, ok: (h) => h >= 16 || h < 1, word: 'evening' },
  { re: /\bgood night\b|\bgoodnight\b/gi, ok: (h) => h >= 19 || h < 4, word: 'night' }
];
const HOLIDAYS = [
  { re: /\b(happy new year|new year'?s eve|nye)\b/gi, name: 'New Year', ok: (p) => (p.m === 12 && p.d >= 26) || (p.m === 1 && p.d <= 10) },
  { re: /\b(merry christmas|happy christmas|christmas eve|xmas)\b/gi, name: 'Christmas', ok: (p) => p.m === 12 && p.d >= 1 && p.d <= 27 },
  { re: /\bhappy halloween\b/gi, name: 'Halloween', ok: (p) => (p.m === 10 && p.d >= 20) || (p.m === 11 && p.d === 1) },
  { re: /\bhappy valentine'?s\b/gi, name: "Valentine's Day", ok: (p) => p.m === 2 && p.d >= 10 && p.d <= 15 },
  { re: /\bhappy thanksgiving\b/gi, name: 'Thanksgiving', ok: (p) => { const t = thanksgiving(p.y); return p.day >= t - 6 && p.day <= t + 3; } },
  { re: /\b(black friday)\b/gi, name: 'Black Friday', ok: (p) => { const t = thanksgiving(p.y) + 1; return p.day >= t - 14 && p.day <= t + 4; } },
  { re: /\b(cyber monday)\b/gi, name: 'Cyber Monday', ok: (p) => { const t = thanksgiving(p.y) + 4; return p.day >= t - 14 && p.day <= t + 1; } }
];
function thanksgiving(y) {
  const first = new Date(Date.UTC(y, 10, 1)).getUTCDay();
  const firstThu = 1 + ((4 - first + 7) % 7);
  return dayNum(y, 11, firstThu + 21);
}
function partOfDayWord(h) { return h >= 4 && h < 12 ? 'morning' : h >= 12 && h < 17 ? 'afternoon' : 'evening'; }

/* "today at 7pm", "tonight at 8", "at 6:30pm today" */
const RE_TIME_TODAY = /\b(today|tonight|this evening|this afternoon|this morning)\s*(?:,|at|@|from)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?|\b(?:at|@)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\s+(today|tonight)\b/gi;
function eventMinutes(word, hh, mm, ap) {
  let h = Number(hh); const mi = mm ? Number(mm) : 0;
  if (h > 23 || mi > 59) return null;
  const apl = (ap || '').toLowerCase().replace(/\./g, '');
  if (apl === 'pm' && h < 12) h += 12;
  else if (apl === 'am' && h === 12) h = 0;
  else if (!apl) {
    const w = word.toLowerCase();
    if (h >= 13) { /* 24-hour clock */ } else if (w === 'tonight' || w === 'this evening') { if (h < 12) h += 12; } else if (w === 'this afternoon') { if (h < 12) h += 12; } else return null; /* "today at 7" is ambiguous */
  }
  return h * 60 + mi;
}

const FUTURE_CUE = /\b(join|register|sign[ -]?up|rsvp|tickets?|ends?|ending|until|till|deadline|due|starts?|starting|opens?|launch(?:es|ing)?|live|don'?t miss|see you|coming|upcoming|save the date|last (?:chance|day)|book|apply|sale|offer|webinar|event|happening|tune in|kicks? off|countdown|early bird|doors|reminder|only \d+ days?)\b/i;

/* main entry: flags for one post. opts.sent: the post already went out (Look back); dueAt is then the time it
   was sent, and the wording is past tense. */
export function checkTime(post, channel, now, opts) {
  const S = !!(opts && opts.sent);
  const went = S ? 'went' : 'goes';
  if (!post.dueAt) return [];
  const due = new Date(post.dueAt);
  if (isNaN(due)) return [];
  const tz = validTz((channel && channel.timezone) || DEFAULT_TZ);
  const send = localParts(due, tz);
  const created = post.createdAt && !isNaN(new Date(post.createdAt)) ? localParts(new Date(post.createdAt), tz) : null;
  const queueSlot = !post.isCustomScheduled && post.shareMode !== 'customScheduled';
  const when = fmtDay(send, (now ? localParts(now, tz).y : send.y)) + ', ' + fmtTime(send) + ' (' + tz + ')';
  const flags = [];
  const items = post.thread && post.thread.length > 1 ? post.thread.map((t, i) => ({ text: t.text, where: 'thread:' + i })) : [{ text: post.text, where: 'text' }];
  for (const it of items) {
    const text = clipForChecks(it.text);
    const masked = maskUrls(text);
    const dates = findDates(text, send);
    const rels = findRelative(text);

    /* explicit dates */
    for (const dt of dates) {
      const dp = fromDayNum(dt.day);
      if (dt.weekday >= 0 && dt.weekday !== dp.dow) {
        flags.push({
          check: 'time', id: 'time.weekday_mismatch', severity: 'high', where: it.where, spans: [[dt.start, dt.end]],
          title: 'Weekday does not match the date',
          detail: '"' + dt.raw + '": ' + dp.d + ' ' + MON_SHORT[dp.m - 1] + ' ' + dp.y + ' is a ' + cap(DOW_LONG[dp.dow]) + ', not a ' + cap(DOW_LONG[dt.weekday]) + '.',
          fixes: [{ type: 'edit', label: 'Fix the date' }]
        });
      }
      if (dt.endDay < send.day) {
        const ago = send.day - dt.endDay;
        const wasFuture = created && dt.endDay >= created.day;
        const cue = FUTURE_CUE.test(masked.slice(Math.max(0, dt.start - 60), dt.end + 60));
        const strong = wasFuture || cue;
        const sev = strong ? 'high' : ago > 31 ? 'low' : 'medium';
        flags.push({
          check: 'time', id: 'time.past_date', severity: sev, where: it.where, spans: [[dt.start, dt.end]],
          title: S ? 'Date was already past when this went out' : 'Date will be in the past when this posts',
          detail: '"' + dt.raw + '" ' + (S ? 'was ' : 'is ') + ago + ' day' + (ago === 1 ? '' : 's') + ' before ' + (S ? 'the post went out' : 'the send time') + ', ' + when + '.' +
            (wasFuture ? ' It was still ahead when the post was written (' + fmtDay(created) + ').' : '') +
            (strong ? '' : S ? ' Fine if the post looked back; wrong if it was an invite or a deadline.' : ' Fine if you are looking back; wrong if it is an invite or a deadline.'),
          fixes: [{ type: 'edit', label: 'Update the date' }, { type: 'draft' }]
        });
      }
    }

    /* relative day words */
    for (const r of rels) {
      const rel = r.rel;
      let atSend, atWrite;
      if (rel.key === 'weekday') {
        /* skip a weekday that sits next to a written date: the date check covers it */
        if (dates.some((d) => (r.start < d.end && d.start < r.end) || Math.abs(d.start - r.end) <= 3 || Math.abs(r.start - d.end) <= 3)) continue;
        atSend = resolveWeekday(rel.mod, rel.wd, send);
        atWrite = created ? resolveWeekday(rel.mod, rel.wd, created) : null;
      } else {
        atSend = resolveRel(rel, send);
        atWrite = created ? resolveRel(rel, created) : null;
      }
      if (atSend == null) continue;
      const meaning = fmtDay(fromDayNum(atSend), send.y);
      const phrase = r.raw.toLowerCase();
      /* conflict with a date written right next to it: "tomorrow (Nov 6)" */
      const near = dates.find((d) => (d.start >= r.end && d.start - r.end <= 6) || (r.start >= d.end && r.start - d.end <= 6));
      const weekRel = rel.week != null || rel.weekend;
      if (near && !weekRel && near.day !== atSend) {
        flags.push({
          check: 'time', id: 'time.relative_conflict', severity: 'high', where: it.where, spans: [[r.start, r.end], [near.start, near.end]],
          title: '"' + r.raw + '" and "' + near.raw + '" ' + (S ? 'disagreed' : 'will disagree'),
          detail: (S ? 'This went out ' : 'This posts ') + when + ', when "' + phrase + '" ' + (S ? 'meant ' : 'means ') + meaning + ', not ' + fmtDay(fromDayNum(near.day), send.y) + '.',
          fixes: [{ type: 'edit', label: 'Fix the wording' }, { type: 'draft' }]
        });
        continue;
      }
      if (near) continue;
      if (queueSlot) {
        flags.push({
          check: 'time', id: 'time.relative_queue', severity: 'medium', where: it.where, spans: [[r.start, r.end]],
          title: '"' + r.raw + '" in a post with no fixed time',
          detail: 'This post sits in a queue slot, now ' + when + '. Queue times move when posts are added or removed, so day words drift. At the current slot "' + phrase + '" means ' + meaning + '.',
          fixes: [{ type: 'edit', label: 'Use a date instead' }, { type: 'draft' }]
        });
      } else if (atWrite != null && atWrite !== atSend) {
        flags.push({
          check: 'time', id: 'time.relative_shift', severity: 'low', where: it.where, spans: [[r.start, r.end]],
          title: S ? '"' + r.raw + '" meant ' + meaning + ' when it went out' : '"' + r.raw + '" will mean ' + meaning,
          detail: 'Written ' + fmtDay(created, send.y) + ', when "' + phrase + '" meant ' + fmtDay(fromDayNum(atWrite), send.y) + '. Readers ' + (S ? 'saw it ' : 'see it ') + when + ', when it ' + (S ? 'meant ' : 'means ') + meaning + '. Fine if that is what you intended.',
          fixes: [{ type: 'edit', label: 'Reword' }]
        });
      }
    }

    /* "today at 7pm" when the post goes out after 7pm */
    RE_TIME_TODAY.lastIndex = 0;
    let m;
    while ((m = RE_TIME_TODAY.exec(masked))) {
      const word = m[1] || m[8];
      /* need a real time marker: "at 7", "@7", "7pm", "19:30" (not "today, 3 new features") */
      if (m[1] && !/(?:\bat\b|@|\bfrom\b|:\d|am|pm|a\.m|p\.m)/i.test(m[0].slice(m[1].length))) continue;
      const mins = m[1] ? eventMinutes(word, m[2], m[3], m[4]) : eventMinutes(word, m[5], m[6], m[7]);
      if (mins == null) continue;
      const sendMins = send.hour * 60 + send.min;
      if (mins <= sendMins) {
        flags.push({
          check: 'time', id: 'time.event_passed', severity: 'high', where: it.where, spans: [[m.index, m.index + m[0].length]],
          title: S ? 'The time in the post had already passed' : 'The time in the post will have passed',
          detail: '"' + m[0].trim() + '", but the post ' + went + ' out at ' + fmtTime(send) + ' (' + tz + ').',
          fixes: [{ type: 'edit', label: 'Fix the time' }, { type: 'draft' }]
        });
      }
    }

    /* greetings for a time of day */
    for (const g of GREETINGS) {
      g.re.lastIndex = 0;
      let gm;
      while ((gm = g.re.exec(masked))) {
        if (g.ok(send.hour)) continue;
        const right = partOfDayWord(send.hour);
        const isGreeting = /^good|^morning/i.test(gm[0]);
        const fixText = isGreeting ? text.slice(0, gm.index) + gm[0].replace(/morning|afternoon|evening|night/i, (w) => (w[0] === w[0].toUpperCase() ? cap(right) : right)) + text.slice(gm.index + gm[0].length) : null;
        flags.push({
          check: 'time', id: 'time.greeting', severity: 'medium', where: it.where, spans: [[gm.index, gm.index + gm[0].length]],
          title: '"' + gm[0] + '" at ' + fmtTime(send),
          detail: 'The post ' + went + ' out at ' + fmtTime(send) + ' ' + tz + ', which is ' + right + ' there.',
          fixes: fixText && fixText !== text && it.where === 'text' ? [{ type: 'edit', label: 'Say "' + right + '"', text: fixText }] : [{ type: 'edit', label: 'Reword' }]
        });
      }
    }

    /* "Happy Friday", "#FridayFeeling", "TGIF" on the wrong day */
    const dayHits = [];
    RE_HAPPY_DAY.lastIndex = 0;
    while ((m = RE_HAPPY_DAY.exec(masked))) {
      const wd = m[2] ? DOW_LONG.indexOf(m[2].toLowerCase()) : 5;
      dayHits.push({ start: m.index, end: m.index + m[0].length, raw: m[0], wd, word: m[2] || null });
    }
    for (const [re, wd] of DAY_TAGS) {
      re.lastIndex = 0;
      while ((m = re.exec(masked))) dayHits.push({ start: m.index, end: m.index + m[0].length, raw: m[0], wd, word: null });
    }
    dayHits.sort((a, b) => a.start - b.start);
    let lastEnd = -1;
    for (const h of dayHits) {
      if (h.start < lastEnd) continue;
      lastEnd = h.end;
      if (h.wd === send.dow) continue;
      let fixText = null;
      if (h.word && it.where === 'text') {
        const right = cap(DOW_LONG[send.dow]);
        const seg = text.slice(h.start, h.end).replace(new RegExp(h.word, 'i'), (w) => (w === w.toLowerCase() ? right.toLowerCase() : right));
        fixText = text.slice(0, h.start) + seg + text.slice(h.end);
      }
      flags.push({
        check: 'time', id: 'time.wrong_day', severity: 'high', where: it.where, spans: [[h.start, h.end]],
        title: '"' + h.raw + '" ' + went + ' out on a ' + cap(DOW_LONG[send.dow]),
        detail: (S ? 'This went out ' : 'This posts ') + when + '.',
        fixes: fixText ? [{ type: 'edit', label: 'Say ' + cap(DOW_LONG[send.dow]), text: fixText }, { type: 'draft' }] : [{ type: 'edit', label: 'Reword' }, { type: 'draft' }]
      });
    }

    /* holiday greetings far from the holiday */
    for (const hd of HOLIDAYS) {
      hd.re.lastIndex = 0;
      while ((m = hd.re.exec(masked))) {
        if (hd.ok(send)) continue;
        flags.push({
          check: 'time', id: 'time.holiday', severity: 'medium', where: it.where, spans: [[m.index, m.index + m[0].length]],
          title: '"' + m[0] + '" on ' + fmtDay(send, send.y),
          detail: 'The post ' + went + ' out ' + when + ', not close to ' + hd.name + '.',
          fixes: [{ type: 'edit', label: 'Reword' }, { type: 'draft' }]
        });
      }
    }
  }
  return flags;
}

/* Later check: posts landing in the middle of the night for the channel's time zone */
export function checkNight(post, channel) {
  if (!post.dueAt) return [];
  const due = new Date(post.dueAt);
  if (isNaN(due)) return [];
  const tz = validTz((channel && channel.timezone) || DEFAULT_TZ);
  const p = localParts(due, tz);
  if (p.hour >= 1 && p.hour < 5) {
    return [{
      check: 'night', id: 'night.small_hours', severity: 'low', where: 'text',
      title: 'Goes out at ' + fmtTime(p) + ' at night',
      detail: 'That is ' + fmtTime(p) + ' in ' + tz + ', the channel\'s time zone. If your readers live there, most of them are asleep.',
      fixes: post.isCustomScheduled ? [{ type: 'draft' }] : []
    }];
  }
  return [];
}

/* ---------- after a queue reorder ----------
   movePostInQueue keeps a channel's slots and changes the order, so every post between the old and the new
   position gets a new send time, not only the one that was moved. A day word ("tomorrow", "tonight", "this
   Friday") was right, or at least reviewed, at the slot the post had before; at the new slot it can point to
   another day. This re-judges each word at the NEW slot against the day it meant at the OLD one, and suggests
   the word that still points to that day from the new slot ("tomorrow" -> "today", "Thursday", ...). */
const PART_WORDS = { tonight: 'night', 'this morning': 'morning', 'this afternoon': 'afternoon' };
/* the words that point to `target` (a local day number) from a post going out on `base` */
export function shiftPhrase(key, target, base) {
  const diff = target - base.day;
  if (diff < 0) return null;
  const part = PART_WORDS[key];
  if (part) {
    if (diff === 0) return key === 'tonight' ? 'tonight' : key;
    const dayWord = diff === 1 ? 'tomorrow' : diff < 7 ? cap(DOW_LONG[fromDayNum(target).dow]) : fmtDay(fromDayNum(target), base.y);
    return dayWord + ' ' + part;
  }
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff < 7) return cap(DOW_LONG[fromDayNum(target).dow]);
  return fmtDay(fromDayNum(target), base.y);
}
/* keep the case of the first letter of the word being replaced */
function matchCase(raw, word) {
  if (/^[A-Z]/.test(raw) && word) return word.charAt(0).toUpperCase() + word.slice(1);
  if (/^[a-z]/.test(raw) && word && !/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/.test(word)) return word.charAt(0).toLowerCase() + word.slice(1);
  return word;
}
export function checkSlotShift(post, channel, fromIso) {
  if (!post || !post.dueAt || !fromIso || post.dueAt === fromIso) return [];
  if (post.thread && post.thread.length > 1) return [];      /* threads are edited in Buffer */
  const was = new Date(fromIso); const now = new Date(post.dueAt);
  if (isNaN(was) || isNaN(now)) return [];
  const tz = validTz((channel && channel.timezone) || DEFAULT_TZ);
  const before = localParts(was, tz);
  const after = localParts(now, tz);
  const moved = 'The reorder moved this post from ' + fmtDay(before, after.y) + ' ' + fmtTime(before) + ' to ' + fmtDay(after, after.y) + ' ' + fmtTime(after) + ' (' + tz + ').';
  const text = clipForChecks(post.text || '');
  const dates = findDates(text, after);
  const flags = [];
  for (const r of findRelative(text)) {
    const rel = r.rel;
    let atOld, atNew;
    if (rel.key === 'weekday') {
      if (dates.some((d) => (r.start < d.end && d.start < r.end) || Math.abs(d.start - r.end) <= 3 || Math.abs(r.start - d.end) <= 3)) continue;
      atOld = resolveWeekday(rel.mod, rel.wd, before);
      atNew = resolveWeekday(rel.mod, rel.wd, after);
    } else {
      atOld = resolveRel(rel, before);
      atNew = resolveRel(rel, after);
    }
    if (atOld == null || atNew == null || atOld === atNew) continue;
    /* a date written right next to the word: the regular checks judge that pair */
    if (dates.some((d) => (d.start >= r.end && d.start - r.end <= 6) || (r.start >= d.end && r.start - d.end <= 6))) continue;
    const phrase = r.raw.toLowerCase();
    const meant = fmtDay(fromDayNum(atOld), after.y);
    const means = fmtDay(fromDayNum(atNew), after.y);
    const weekish = rel.week != null || !!rel.weekend;
    const word = weekish ? null : shiftPhrase(rel.key === 'weekday' ? 'day' : rel.key, atOld, after);
    const passed = atOld < after.day;
    const fixes = [];
    if (word && word.toLowerCase() !== phrase) {
      const repl = matchCase(r.raw, word);
      fixes.push({ type: 'edit', label: 'Say “' + repl + '”', text: text.slice(0, r.start) + repl + text.slice(r.end) });
    } else fixes.push({ type: 'edit', label: 'Reword' });
    if (passed) fixes.push({ type: 'move', position: 'top' });
    fixes.push({ type: 'draft' });
    flags.push({
      check: 'time', id: 'time.slot_shift', severity: 'high', where: 'text', spans: [[r.start, r.end]],
      title: '“' + r.raw + '” now means ' + means + (weekish ? '' : ', not ' + meant),
      detail: moved + ' At the old slot “' + phrase + '” meant ' + meant + '. ' + (passed ? 'By the new time that day has passed: move it back to the front, or to drafts.' : word ? 'Say “' + word + '” to keep that day.' : 'Reword it so it still points to the right week.'),
      fixes,
      data: { from: was.toISOString(), to: now.toISOString(), meant: atOld, means: atNew }
    });
  }
  return flags;
}

/* A post set to "share next" (Buffer: movePostInQueue to the top) has no time until it goes out, so its day words
   cannot be judged; say so instead of judging them at a made-up time. */
export function checkShareNext(post) {
  if (!post || !post.shareNext || post.status !== 'scheduled') return [];
  const text = clipForChecks(post.text || '');
  const words = findRelative(text);
  if (!words.length) return [];
  const w = words[0];
  return [{
    check: 'time', id: 'time.share_next', severity: 'medium', where: 'text', spans: words.map((r) => [r.start, r.end]),
    title: '“' + w.raw + '” in a post set to share next',
    detail: 'Buffer shares this post next and shows no time for it until then, so Last Look cannot say which day “' + w.raw.toLowerCase() + '” will mean. Check it still fits the day it goes out, or give the post a fixed time in Buffer.',
    fixes: [{ type: 'edit', label: 'Use a date instead' }, { type: 'draft' }]
  }];
}
