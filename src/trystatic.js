/* /try, first paint without JavaScript: the sample queue's results, checked on the server at request time by the
   same check code the page runs (src/checks), and served as plain HTML. Readers that do not run scripts (and
   anyone before app.js loads) see the real flagged posts at once; with JavaScript on, the page hides this block
   (html.js, set by /boot.js before first paint) and the interactive app takes over.
   Pure: no network, no Buffer call, no session. Every value from the sample goes through esc(). */
import { sampleQueue, sampleSent, SAMPLE_CHANNELS, SAMPLE_LINKS, SAMPLE_BRAND, SAMPLE_TZ, SAMPLE_RULES } from '../public/sample.js';
import { runAll } from './checks/index.js';
import { runLookback } from './checks/lookback.js';
import { SERVICE_NAMES } from './checks/length.js';
import { cleanRules, rulesSummary } from './checks/rules.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SEV_RANK = { high: 0, medium: 1, low: 2 };
const SEV_CLASS = { high: 'sev-high', medium: 'sev-med', low: 'sev-low' };
const SEV_WORD = { high: 'Fix before it posts', medium: 'Worth a look', low: 'Note' };
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
const svcName = (s) => SERVICE_NAMES[s] || s;

function fmtWhen(iso, tz) {
  if (!iso) return 'No time set';
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'UTC', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return f.format(new Date(iso)).replace(',', '').replace(' at ', ' · ');
}
function fromNow(iso, nowMs) {
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const ms = Date.parse(iso) - nowMs;
  const abs = Math.abs(ms);
  if (abs < 3600e3) return rtf.format(Math.round(ms / 60e3), 'minute');
  if (abs < 48 * 3600e3) return rtf.format(Math.round(ms / 3600e3), 'hour');
  return rtf.format(Math.round(ms / 864e5), 'day');
}

/* the sample's link results, placed the way app.js places them (linkFlagsFor) */
function linkFlags(post) {
  const out = [];
  for (const l of post.links || []) {
    const s = SAMPLE_LINKS[l.url];
    if (!s || !s.flag) continue;
    const place = l.places[0];
    const f = Object.assign({}, s.flag, { where: place.where, spans: place.start != null ? [[place.start, place.end]] : [] });
    f.fixes = (f.fixes || []).filter((x) => post.allowed && post.allowed[x.type]);
    out.push(f);
  }
  return out;
}
const flagsOf = (p) => (p.flags || []).concat(linkFlags(p)).sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);

/* post text with the flagged words marked, as escaped HTML (the string twin of app.js highlighted()) */
export function markText(text, flags, where) {
  const s = String(text || '');
  const n = s.length;
  const sev = new Array(n).fill(9);
  for (const f of flags) {
    if (f.where !== where || !f.spans) continue;
    const rank = SEV_RANK[f.severity];
    for (const [a, b] of f.spans) for (let i = Math.max(0, a); i < Math.min(n, b); i++) if (rank < sev[i]) sev[i] = rank;
  }
  let out = '';
  let i = 0;
  while (i < n) {
    let j = i;
    while (j < n && sev[j] === sev[i]) j++;
    const chunk = esc(s.slice(i, j));
    out += sev[i] === 9 ? chunk : '<mark class="hl ' + (sev[i] === 0 ? 'hl-high' : sev[i] === 1 ? 'hl-med' : 'hl-low') + '">' + chunk + '</mark>';
    i = j;
  }
  return out;
}

/* what the interactive card would offer, written as text (no dead buttons without JavaScript) */
function fixWords(p, flags) {
  const words = [];
  const seen = new Set();
  for (const f of flags) for (const x of f.fixes || []) {
    if (x.type === 'edit' && typeof x.text === 'string' && x.text !== p.text && !seen.has(x.text)) { seen.add(x.text); words.push(x.label || 'a suggested edit'); }
  }
  const needed = new Set(flags.flatMap((f) => (f.fixes || []).map((x) => x.type + (x.position ? ':' + x.position : ''))));
  if (p.allowed && p.allowed.edit) words.push('Edit text');
  if (p.allowed && p.allowed.draft && (needed.has('draft') || flags.some((f) => f.severity === 'high'))) words.push('Move to drafts');
  if (p.allowed && p.allowed.move && needed.has('move:bottom')) words.push('Move to end of queue');
  if (p.allowed && p.allowed.move && needed.has('move:top')) words.push('Move to front of queue');
  return words;
}

function postHtml(p, ch, nowMs) {
  const all = flagsOf(p);
  const flags = all.filter((f) => f.severity !== 'low');
  const badge = p.status === 'draft' ? '<span class="badge draft">draft</span>'
    : p.status === 'needs_approval' ? '<span class="badge">awaiting approval</span>'
      : '<span class="badge">' + (p.shareNext ? 'share next' : p.isCustomScheduled ? 'custom time' : 'queue slot') + '</span>';
  const extras = [];
  if (p.assets && p.assets.length) extras.push(plural(p.assets.length, 'attachment'));
  const items = flags.map((f) => '<li class="flag ' + SEV_CLASS[f.severity] + '"><span class="dot" aria-hidden="true"></span><div class="flag-body"><span class="sev">' + SEV_WORD[f.severity] + '</span><strong>' + esc(f.title) + '</strong><p>' + esc(f.detail) + '</p></div></li>').join('');
  const fixes = fixWords(p, flags);
  return '<article class="post">'
    + '<div class="post-meta"><span class="when">' + esc(fmtWhen(p.dueAt, ch.timezone)) + '</span>' + (p.dueAt ? '<span>' + esc(fromNow(p.dueAt, nowMs)) + '</span>' : '') + badge + '<span class="svc">' + esc(svcName(ch.service)) + '</span></div>'
    + '<p class="post-text">' + markText(p.text, all, 'text') + '</p>'
    + (extras.length ? '<p class="channel-sub">' + esc(extras.join(' · ')) + '</p>' : '')
    + '<ul class="flags">' + items + '</ul>'
    + (fixes.length ? '<p class="fix-words"><span class="lbl">Fixes offered</span> ' + fixes.map(esc).join(' · ') + '</p>' : '')
    + '</article>';
}

/* the numbers and the HTML of the sample at `now` (a Date); used by /try and by the tests. The checks take a few ms
   of CPU, so the result is kept for the rest of that minute (per isolate): at most one build a minute. */
let memo = null;
export function trySample(now) {
  const at = now || new Date();
  const nowMs = at.getTime();
  const minute = Math.floor(nowMs / 60000);
  if (memo && memo.minute === minute) return memo.out;
  const out = build(at, nowMs);
  memo = { minute, out };
  return out;
}
function build(at, nowMs) {
  const rules = cleanRules(SAMPLE_RULES);
  const res = runAll(SAMPLE_CHANNELS, sampleQueue(at), at, { rules });
  const posts = res.posts.slice().sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  const live = posts.filter((p) => p.status !== 'draft');
  const flagged = posts.filter((p) => flagsOf(p).some((f) => f.severity !== 'low'));
  const high = posts.reduce((n, p) => n + flagsOf(p).filter((f) => f.severity === 'high').length, 0);
  const issues = posts.reduce((n, p) => n + flagsOf(p).filter((f) => f.severity !== 'low').length, 0);
  const drafts = posts.length - live.length;
  const back = runLookback(SAMPLE_CHANNELS, sampleSent(at), at);
  const headline = plural(flagged.length, 'post') + ' need' + (flagged.length === 1 ? 's' : '') + ' a look';
  const subline = plural(live.length, 'queued post') + (drafts ? ' and ' + plural(drafts, 'draft') : '') + ' across ' + plural(SAMPLE_CHANNELS.length, 'channel') + (high ? ' · ' + plural(high, 'problem') + ' to fix before posting' : '') + '.';
  let sections = '';
  for (const ch of SAMPLE_CHANNELS) {
    const list = posts.filter((p) => p.channelId === ch.id);
    if (!list.length) continue;
    const shown = list.filter((p) => flagsOf(p).some((f) => f.severity !== 'low'));
    sections += '<section class="channel" aria-label="' + esc(ch.displayName + ' on ' + svcName(ch.service)) + '">'
      + '<div class="channel-head"><span class="avatar-fallback" aria-hidden="true">' + esc(ch.name.slice(0, 1).toUpperCase()) + '</span>'
      + '<div><h3>' + esc(ch.displayName) + '</h3><div class="channel-sub">' + esc(svcName(ch.service) + ' · ' + ch.timezone) + '</div></div>'
      + '<span class="channel-count">' + esc(plural(list.length, 'post') + (shown.length ? ' · ' + shown.length + ' flagged' : '')) + '</span></div>'
      + (rules[ch.id] ? '<p class="channel-rules"><span class="lbl">Channel rules</span> ' + esc(rulesSummary(rules[ch.id])) + '</p>' : '')
      + (shown.length ? shown.map((p) => postHtml(p, ch, nowMs)).join('') : '<p class="clear-line">✓ ' + (list.length === 1 ? 'This post looks good.' : 'All ' + list.length + ' posts look good.') + '</p>')
      + '</section>';
  }
  const t = back.totals;
  const groups = back.groups.filter((g) => g.items.length).map((g) => '<li><strong>' + esc(g.title) + '</strong> <span class="lb-count">' + g.items.length + '</span></li>').join('');
  const checkedAt = new Intl.DateTimeFormat('en-GB', { timeZone: SAMPLE_TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at).replace(',', '');
  const html = '<section class="try-static" id="try-static" aria-labelledby="ts-h">'
    + '<div class="banner try" role="note"><strong>Sample queue, made up for this demo.</strong> These are the queued posts of ' + esc(SAMPLE_BRAND) + ', a fictional pottery studio, checked on ' + esc(checkedAt) + ' (studio time) by the same code Last Look runs on a real Buffer queue. Nothing here is sent to Buffer. <a href="/oauth/start">Connect Buffer</a> to check your own.</div>'
    + '<div class="summary"><div class="summary-main"><h2 id="ts-h">' + esc(headline) + '</h2><p class="muted">' + esc(subline) + ' ' + esc(plural(issues, 'flag')) + ' in all.</p></div></div>'
    + '<div class="queue">' + sections + '</div>'
    + '<section class="ts-back" aria-labelledby="ts-back-h"><h2 id="ts-back-h">Look back: ' + esc(t.issues ? 'Last Look would have caught ' + plural(t.issues, 'issue') + ' in the studio’s last ' + plural(t.checked, 'sent post') : 'Nothing to catch in the studio’s last ' + plural(t.checked, 'sent post')) + '</h2>'
    + '<p class="muted">' + esc(plural(t.postsWithIssues, 'post') + ' affected. Each one is judged at the moment it went out, in its channel’s time zone. Read-only: sent posts cannot be changed.') + '</p>'
    + (groups ? '<ul class="ts-groups">' + groups + '</ul>' : '') + '</section>'
    + '<p class="muted ts-foot">With JavaScript on, this page runs the checks in your browser: each flag gets a one-click fix with a word-by-word diff and two minutes of Undo, and you can check a post of your own. <a href="/about">How it works</a>.</p>'
    + '</section>';
  return { html, headline, subline, flagged: flagged.length, posts: posts.length, issues, high, back: t };
}

/* The landing page's light table: three posts of the same made-up sample queue, checked by the same code at request
   time (no network), as escaped HTML; plus the sample's headline and its Look back totals. Kept for the minute, like
   trySample. Frames: the sale post (three flags and a one-click word fix), the hiring post (raw formatting) and the
   spring-term post (nothing to fix). */
const HERO_IDS = ['s-sale', 's-hiring', 's-spring'];
let heroMemo = null;
export function heroSample(now) {
  const at = now || new Date();
  const minute = Math.floor(at.getTime() / 60000);
  if (heroMemo && heroMemo.minute === minute) return heroMemo.out;
  const all = trySample(at);
  const res = runAll(SAMPLE_CHANNELS, sampleQueue(at), at, { rules: cleanRules(SAMPLE_RULES) });
  const byId = new Map(res.posts.map((p) => [p.id, p]));
  const frames = HERO_IDS.map((id) => {
    const p = byId.get(id);
    const ch = SAMPLE_CHANNELS.find((c) => c.id === p.channelId);
    const every = flagsOf(p);
    const flags = every.filter((f) => f.severity !== 'low');
    const words = [];
    for (const f of flags) for (const x of f.fixes || []) if (x.type === 'edit' && typeof x.text === 'string' && x.text !== p.text && x.label && !words.includes(x.label)) words.push(x.label);
    const slot = p.status === 'needs_approval' ? 'awaiting approval' : p.isCustomScheduled ? 'custom time' : 'queue slot';
    return {
      id, service: ch.service, channel: svcName(ch.service), when: fmtWhen(p.dueAt, ch.timezone).replace(' · ', ' '), slot,
      textHtml: markText(p.text, every, 'text'),
      flags: flags.map((f) => ({ sev: f.severity, word: SEV_WORD[f.severity], title: f.title, detail: f.detail })),
      fix: words[0] || null
    };
  });
  const lb = runLookback(SAMPLE_CHANNELS, sampleSent(at), at);
  const groups = lb.groups.filter((g) => g.items.length).map((g) => ({ title: g.title, n: g.items.length }));
  const out = { frames, headline: all.headline, subline: all.subline, back: all.back, groups };
  heroMemo = { minute, out };
  return out;
}
