/* Last Look app. The server reads the queue (/api/scan); the checks run here in the browser, on the same code
   the server tests. The view is built with DOM nodes and textContent only: post text is third-party content and
   is never parsed as HTML. After a fix, only that post is updated from Buffer's answer; nothing is rescanned.
   Two modes, one code path: on /try (meta mode=try) the backend is the local sample (./sample.js) and api()
   refuses to run, so the sample page never calls the server, Buffer or the link checker. /try also has a first
   tab, "Your own post": one post the visitor types, checked in the tab (./own.js), with no network code at all. */
import { lengthFor, limitFor, SERVICE_NAMES } from './checks/length.js';
import { runAll } from './checks/index.js';
import { runLookback } from './checks/lookback.js';
import { checkOwn, clipOwn, ownChannel, defaultWhen, parseWhen, localZone, dayWords, OWN_EXAMPLES, OWN_SERVICES, OWN_DEBOUNCE_MS, OWN_MAX } from './own.js';

const $ = (id) => document.getElementById(id);
const meta = (n) => { if (typeof document === 'undefined') return ''; const m = document.querySelector('meta[name="' + n + '"]'); return m ? m.getAttribute('content') : ''; };
const CSRF = meta('csrf');
export const MODE = meta('mode') === 'try' ? 'try' : 'live';
const SESSION_EXP = Number(meta('session-exp')) || 0;
const SEV_RANK = { high: 0, medium: 1, low: 2 };
const SEV_CLASS = { high: 'sev-high', medium: 'sev-med', low: 'sev-low' };
const SEV_WORD = { high: 'Fix before it posts', medium: 'Worth a look', low: 'Note' };
const LINK_TTL = 10 * 60 * 1000;

const SCAN_GAP_MS = 60000;
const state = { raw: null, data: null, filter: 'flagged', notes: false, links: new Map(), linkQueue: [], linkRunning: false, busy: false, dialog: null, nextScanAt: 0,
  scanError: null, autoRetryUsed: false, ended: false, view: 'queue', back: null, backBusy: false, backError: null, backRetryAt: 0,
  undos: new Map(), undoBar: null, shiftsEdited: new Map(),
  /* after a queue reorder: post id -> the send time it had before (kept until the next scan or an edit of that post) */
  shifts: new Map(), lastShift: null,
  /* the daily digest tab (live only): its settings from /api/digest, which reads only the digest store */
  digest: null, digestBusy: false, digestError: null, digestConfirm: false };
/* seconds to wait after a refusal: the server's Retry-After, or a minute when there is none (never zero) */
export const waitFor = (retryAfter) => Math.min(3600, Math.max(5, Math.ceil(Number(retryAfter) || 60)));

/* run the checks on the current raw scan (after a scan, and after each fix) */
function recompute() {
  if (!state.raw) { state.data = null; return; }
  const res = runAll(state.raw.channels, state.raw.posts, new Date(), { shifts: new Map(Array.from(state.shifts, ([id, v]) => [id, v.from])) });
  state.data = Object.assign({}, state.raw, { posts: res.posts, meta: res.meta });
}

/* ---------- helpers ---------- */
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
}
async function api(path, body) {
  if (MODE === 'try') throw new Error('The sample queue never talks to the server.');
  let r;
  try {
    r = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': CSRF }, body: JSON.stringify(body || {}) });
  } catch (e) { const err = new Error('Could not reach Last Look. Check your connection.'); err.status = 0; throw err; }
  let j = null;
  try { j = await r.json(); } catch (e) { /* not json */ }
  if (!r.ok || !j || j.ok === false) {
    const err = new Error((j && j.message) || 'Something went wrong (' + r.status + ').');
    err.status = r.status; err.code = j && j.error;
    err.retryAfter = Number(r.headers.get('retry-after')) || 0;
    throw err;
  }
  return j;
}
/* where scans, link checks and fixes go: the Worker for a real account, the local sample on /try */
const liveBackend = {
  scan: () => api('/api/scan', {}),
  checkLinks: (body) => api('/api/links', body),
  fix: (body) => api('/api/fix', body),
  lookback: () => api('/api/lookback', {})
};
let backend = liveBackend;
const T = (liveText, tryText) => (MODE === 'try' ? tryText : liveText);
async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('');
}
function toast(msg, ms) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms || 3500);
}
const fmtCache = new Map();
function fmtWhen(iso, tz) {
  if (!iso) return 'No time set';
  const key = tz || 'UTC';
  let f = fmtCache.get(key);
  if (!f) {
    try { f = new Intl.DateTimeFormat('en-GB', { timeZone: key, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
    catch (e) { f = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
    fmtCache.set(key, f);
  }
  return f.format(new Date(iso)).replace(',', '').replace(' at ', ' · ');
}
const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
function fromNow(iso) {
  if (!iso) return '';
  const ms = Date.parse(iso) - Date.now();
  const abs = Math.abs(ms);
  if (abs < 3600e3) return rtf.format(Math.round(ms / 60e3), 'minute');
  if (abs < 48 * 3600e3) return rtf.format(Math.round(ms / 3600e3), 'hour');
  return rtf.format(Math.round(ms / 864e5), 'day');
}
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
const svcName = (s) => SERVICE_NAMES[s] || s;

/* ---------- flags ---------- */
function linkFlagsFor(post) {
  const out = [];
  for (const l of post.links || []) {
    const r = state.links.get(l.url);
    if (!r || !r.flag) continue;
    for (const place of l.places) {
      const f = Object.assign({}, r.flag, { where: place.where, spans: place.start != null ? [[place.start, place.end]] : [] });
      if (place.where === 'linkAttachment') f.detail = 'Link preview card: ' + f.detail;
      if (place.where === 'firstComment') f.detail = 'In the first comment: ' + f.detail;
      f.fixes = (f.fixes || []).filter((x) => post.allowed && post.allowed[x.type]);
      out.push(f);
      break;
    }
  }
  return out;
}
function flagsFor(post) {
  return (post.flags || []).concat(linkFlagsFor(post)).sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
}
function visibleFlags(post) { return flagsFor(post).filter((f) => state.notes || f.severity !== 'low'); }
function pendingLinks(post) { return (post.links || []).filter((l) => !state.links.has(l.url)).length; }

/* ---------- text with highlights ---------- */
function highlighted(text, flags, where) {
  const n = text.length;
  const sev = new Array(n).fill(9);
  for (const f of flags) {
    if (f.where !== where || !f.spans) continue;
    const rank = SEV_RANK[f.severity];
    for (const [a, b] of f.spans) for (let i = Math.max(0, a); i < Math.min(n, b); i++) if (rank < sev[i]) sev[i] = rank;
  }
  const frag = document.createDocumentFragment();
  let i = 0;
  while (i < n) {
    let j = i;
    while (j < n && sev[j] === sev[i]) j++;
    const chunk = text.slice(i, j);
    if (sev[i] === 9) frag.append(document.createTextNode(chunk));
    else frag.append(el('mark', { class: 'hl ' + (sev[i] === 0 ? 'hl-high' : sev[i] === 1 ? 'hl-med' : 'hl-low') }, chunk));
    i = j;
  }
  return frag;
}

/* ---------- problems: limits and Buffer's 429 read as a short pause, with the time to come back ---------- */
const CALM = {
  app_busy: 'Buffer gives Last Look a shared allowance of requests, and it is nearly used up for the next few minutes.',
  app_busy_day: 'Last Look has used most of today’s shared Buffer allowance.',
  buffer_rate: 'Buffer asked Last Look to slow down for a moment.',
  gate_down: 'Last Look is catching its breath.',
  slow_down: 'Lots of requests came from your network just now.',
  scan_gap: 'Scans are spaced a minute apart.',
  scan_budget: 'That is today’s scan limit for your account.',
  lookback_gap: 'Look back runs at most once every two minutes.',
  lookback_budget: 'That is today’s Look back limit for your account.',
  fix_rate: 'That was a lot of changes in one minute.',
  fix_budget: 'That is today’s limit of fixes for your account.',
  link_rate: 'Link checks are paced for a moment.',
  call_rate: 'Your account has made many Buffer requests in the last 15 minutes.',
  call_budget: 'That is today’s Buffer request limit for your account.'
};
export function retryText(sec, now) {
  const s = Math.max(1, Math.ceil(Number(sec) || 60));
  if (s <= 90) return 'Try again in about a minute';
  const at = new Date((now || Date.now()) + s * 1000);
  const hm = String(at.getHours()).padStart(2, '0') + ':' + String(at.getMinutes()).padStart(2, '0');
  if (s < 3600) return 'Try again at ' + hm + ', in about ' + Math.round(s / 60) + ' minutes';
  return 'Try again after ' + hm;
}
export function isCalm(e) { return !!e && (e.status === 429 || e.status === 503 || Object.prototype.hasOwnProperty.call(CALM, e.code)); }
export function calmText(e) {
  return (CALM[e.code] || e.message || 'Last Look needs a short pause.') + ' ' + retryText(e.retryAfter) + '. Nothing was changed.';
}
function problemBanner(e) {
  if (isCalm(e)) return el('div', { class: 'banner calm', role: 'status' }, el('strong', null, 'A short pause. '), calmText(e));
  return el('div', { class: 'banner err', role: 'alert' }, e.message);
}
const skeleton = () => el('div', { class: 'skeleton', 'aria-hidden': 'true' }, el('div'), el('div'), el('div'));

/* ---------- rendering ---------- */
function render() {
  if (state.ended || state.view === 'own') return;
  $('rescan').hidden = state.view !== 'queue';
  $('links-status').hidden = state.view !== 'queue';
  $('toolbar').hidden = state.view === 'digest';
  if (state.view === 'back') return renderBack();
  if (state.view === 'digest') return renderDigest();
  const d = state.data;
  const q = $('queue');
  q.replaceChildren();
  if (!d) {
    if (!state.scanError) {
      $('headline').textContent = T('Reading your queue…', 'Loading the sample…');
      $('subline').textContent = T('This takes a few seconds.', 'One moment.');
      q.append(skeleton());
      return;
    }
    const calm = isCalm(state.scanError);
    $('headline').textContent = calm ? 'A short pause' : 'Could not read your queue';
    $('subline').textContent = calm ? (canAutoRetry() ? 'Last Look will scan again on its own when the button is ready.' : 'Last Look will be ready to scan again later.') : '';
    q.append(problemBanner(state.scanError));
    q.append(el('div', { class: 'empty' }, el('h2', { text: 'Meanwhile' }),
      el('p', { text: 'Look back at what already went out, or see what Last Look catches on a sample queue.' }),
      el('div', { class: 'cta-row center' },
        MODE === 'live' ? el('button', { type: 'button', class: 'btn', onclick: () => setView('back') }, 'Look back at sent posts') : null,
        el('a', { class: 'btn', href: '/try#sample' }, 'See a sample queue'))));
    return;
  }
  if (state.scanError) q.append(problemBanner(state.scanError));
  const posts = d.posts;
  const live = posts.filter((p) => p.status !== 'draft');
  const flaggedPosts = posts.filter((p) => flagsFor(p).some((f) => f.severity !== 'low'));
  const highCount = posts.reduce((n, p) => n + flagsFor(p).filter((f) => f.severity === 'high').length, 0);
  const drafts = posts.length - live.length;
  /* headline */
  if (!d.channels.length) {
    $('headline').textContent = 'No channels yet';
    $('subline').textContent = 'Connect a social account in Buffer, queue a few posts, then come back.';
  } else if (!posts.length) {
    $('headline').textContent = 'Nothing in your queue';
    $('subline').textContent = 'There are no scheduled posts or drafts on ' + plural(d.channels.length, 'channel') + '.';
  } else if (!flaggedPosts.length) {
    $('headline').textContent = 'All clear';
    $('subline').textContent = plural(live.length, 'queued post') + (drafts ? ' and ' + plural(drafts, 'draft') : '') + ' across ' + plural(d.channels.length, 'channel') + ' look good' + (state.linkQueue.length || state.linkRunning ? ', links still being checked.' : '.');
  } else {
    $('headline').textContent = plural(flaggedPosts.length, 'post') + ' need' + (flaggedPosts.length === 1 ? 's' : '') + ' a look';
    $('subline').textContent = plural(live.length, 'queued post') + (drafts ? ' and ' + plural(drafts, 'draft') : '') + ' across ' + plural(d.channels.length, 'channel') + (highCount ? ' · ' + plural(highCount, 'problem') + ' to fix before posting' : '') + '.';
  }
  if (d.truncated) q.append(el('div', { class: 'banner warn' }, 'Your queue is large, so this scan stopped at the first posts. Scan again after fixing these to see the rest.'));
  if (d.meta && d.meta.repeatsPartial) q.append(el('div', { class: 'banner warn' }, 'Your queue is large, so repeated posts were only partly checked.'));
  if (d.rateLow) q.append(el('div', { class: 'banner calm', role: 'status' }, el('strong', null, 'Heads up. '), 'Buffer’s shared request allowance for Last Look is nearly used for now, so the next scan may have to wait a few minutes. Your posts are safe either way.'));
  if (state.lastShift) q.append(shiftBanner(d));
  if (!d.channels.length || !posts.length) {
    const noCh = !d.channels.length;
    q.append(el('div', { class: 'empty' }, el('h2', { text: noCh ? 'No channels connected in Buffer' : 'Your queue is empty' }),
      el('p', { text: noCh ? 'Last Look checks posts queued in Buffer. Add a channel there first, or see what it catches on a sample queue.' : 'Nothing is waiting to go out, so there is nothing to check yet. Look back at what already went out to see what Last Look would have caught, or try it on a sample queue.' }),
      el('div', { class: 'cta-row center' },
        noCh ? null : el('button', { type: 'button', class: 'btn btn-primary', onclick: () => setView('back') }, 'Look back at sent posts'),
        el('a', { class: 'btn', href: '/try#sample' }, 'See a sample queue'),
        el('a', { class: noCh ? 'btn btn-primary' : 'btn btn-quiet', href: 'https://publish.buffer.com', rel: 'noopener noreferrer', target: '_blank' }, 'Open Buffer'))));
    return;
  }
  const byChannel = new Map(d.channels.map((c) => [c.id, []]));
  for (const p of posts) { if (!byChannel.has(p.channelId)) byChannel.set(p.channelId, []); byChannel.get(p.channelId).push(p); }
  let shown = 0;
  for (const [cid, list] of byChannel) {
    if (!list.length) continue;
    const ch = d.channels.find((c) => c.id === cid) || { id: cid, name: 'Unknown channel', service: list[0].channelService, timezone: 'Europe/London' };
    const visible = list.filter((p) => state.filter === 'all' || visibleFlags(p).length);
    const nFlag = list.filter((p) => flagsFor(p).some((f) => f.severity !== 'low')).length;
    const sec = el('section', { class: 'channel', 'aria-label': (ch.displayName || ch.name) + ' on ' + svcName(ch.service) });
    const avatar = ch.avatar ? el('img', { src: ch.avatar, alt: '', width: 34, height: 34, loading: 'lazy', referrerpolicy: 'no-referrer' }) : el('span', { class: 'avatar-fallback', 'aria-hidden': 'true' }, (ch.name || '?').slice(0, 1).toUpperCase());
    sec.append(el('div', { class: 'channel-head' }, avatar,
      el('div', null, el('h2', { text: ch.displayName || ch.name }), el('div', { class: 'channel-sub' }, svcName(ch.service) + ' · ' + ch.timezone + (ch.isQueuePaused ? ' · queue paused' : '') + (ch.isDisconnected ? ' · disconnected' : ''))),
      el('span', { class: 'channel-count' }, plural(list.length, 'post') + (nFlag ? ' · ' + nFlag + ' flagged' : ''))));
    if (!visible.length) {
      sec.append(el('p', { class: 'clear-line' }, '✓ ' + (list.length === 1 ? 'This post looks good.' : 'All ' + list.length + ' posts look good.')));
    }
    for (const p of visible) { sec.append(renderPost(p, ch)); shown++; }
    q.append(sec);
  }
  if (!shown && state.filter === 'flagged') q.append(el('p', { class: 'muted' }, 'Nothing needs a look. Switch to “All posts” to see everything in the queue.'));
}

/* after a reorder: how many other posts Buffer gave a new time, and how many of them now say the wrong day */
function shiftBanner(d) {
  const ls = state.lastShift;
  const ch = d.channels.find((c) => c.id === ls.channelId);
  const name = ch ? (ch.displayName || ch.name) : 'this channel';
  if (ls.error) return el('div', { class: 'banner calm', role: 'status' }, el('strong', null, 'Moved. '), 'Last Look could not read the queue again just now, so the new times of the other posts on ' + name + ' are not checked yet. Scan again in a minute.');
  const ids = new Set(ls.ids.concat([ls.moved]));
  const wrong = d.posts.filter((p) => ids.has(p.id) && flagsFor(p).some((f) => f.id === 'time.slot_shift'));
  const n = ls.ids.length;
  const lead = n ? 'Reordered. Buffer gave ' + plural(n, 'other post') + ' on ' + name + ' a new time. ' : 'Reordered. No other post on ' + name + ' changed time. ';
  const tail = wrong.length ? plural(wrong.length, 'post') + ' now say' + (wrong.length === 1 ? 's' : '') + ' the wrong day: Last Look re-checked “tomorrow”, “tonight” and weekday words against each new slot.' : 'Last Look re-checked their day words against each new slot: they still point to the right days.';
  return el('div', { class: 'banner ' + (wrong.length ? 'warn shift' : 'calm shift'), role: 'status', id: 'shift-banner' }, el('strong', null, lead), tail);
}

/* the flag cards, each with its suggested-text buttons (the same cards on a queue post and on your own post);
   extra(f, hasSuggestion) may return one more button for a card */
function flagList(p, flags, onSuggest, extra) {
  const ul = el('ul', { class: 'flags' });
  const seenSugg = new Set();
  for (const f of flags) {
    const body = el('div', { class: 'flag-body' }, el('span', { class: 'sev' }, SEV_WORD[f.severity]), el('strong', null, f.title), el('p', null, f.detail));
    const sugg = (f.fixes || []).filter((x) => x.type === 'edit' && typeof x.text === 'string' && x.text !== p.text && !seenSugg.has(x.text));
    for (const x of sugg) seenSugg.add(x.text);
    const btns = sugg.map((x) => el('button', { type: 'button', class: 'btn btn-small', onclick: () => onSuggest(x) }, x.label || 'Apply suggestion'));
    const more = extra ? extra(f, sugg.length > 0) : null;
    if (more) btns.push(more);
    if (btns.length) body.append(el('div', { class: 'fix-row' }, btns));
    ul.append(el('li', { class: 'flag ' + SEV_CLASS[f.severity] }, el('span', { class: 'dot', 'aria-hidden': 'true' }), body));
  }
  return ul;
}

function renderPost(p, ch) {
  const flags = visibleFlags(p);
  const all = flagsFor(p);
  const hiddenNotes = all.length - flags.length;
  const art = el('article', { class: 'post' + (flags.length ? '' : ' is-clear'), 'aria-label': 'Post ' + (p.dueAt ? 'going out ' + fmtWhen(p.dueAt, ch.timezone) : 'without a time') });
  const badges = [];
  if (p.status === 'draft') badges.push(el('span', { class: 'badge draft' }, 'draft'));
  if (p.status === 'needs_approval') badges.push(el('span', { class: 'badge' }, 'awaiting approval'));
  if (p.status === 'scheduled') badges.push(el('span', { class: 'badge' }, p.isCustomScheduled ? 'custom time' : 'queue slot'));
  art.append(el('div', { class: 'post-meta' },
    el('span', { class: 'when' }, p.dueAt ? fmtWhen(p.dueAt, ch.timezone) : (p.status === 'draft' ? 'Not scheduled' : 'No time set')),
    p.dueAt ? el('span', null, fromNow(p.dueAt)) : null, ...badges, el('span', { class: 'svc' }, svcName(ch.service))));
  if (p.thread && p.thread.length > 1) {
    p.thread.forEach((t, i) => {
      art.append(el('div', { class: 'thread-part' }, el('p', { class: 'thread-label' }, 'Part ' + (i + 1) + ' of ' + p.thread.length), el('p', { class: 'post-text' }, highlighted(t.text, all, 'thread:' + i))));
    });
  } else {
    const txt = el('p', { class: 'post-text' }, highlighted(p.text || '', all, 'text'));
    art.append(txt);
    if ((p.text || '').length > 700) {
      txt.classList.add('is-long');
      const more = el('button', { type: 'button', class: 'more', 'aria-expanded': 'false' }, 'Show all');
      more.addEventListener('click', () => { const open = txt.classList.toggle('is-long'); more.textContent = open ? 'Show all' : 'Show less'; more.setAttribute('aria-expanded', String(!open)); });
      art.append(more);
    }
  }
  const extras = [];
  if (p.assets && p.assets.length) extras.push(plural(p.assets.length, 'attachment'));
  if (p.linkAttachment) extras.push('link preview');
  if (p.firstComment) extras.push('first comment');
  const pend = pendingLinks(p);
  if (pend) extras.push('checking ' + plural(pend, 'link') + '…');
  if (extras.length) art.append(el('p', { class: 'channel-sub' }, extras.join(' · ')));
  if (flags.length) art.append(flagList(p, flags, (x) => openEdit(p, ch, x.text, x.label)));
  if (hiddenNotes > 0 && !state.notes) art.append(el('p', { class: 'channel-sub' }, plural(hiddenNotes, 'note') + ' hidden'));
  /* general actions for posts with something to fix */
  const actions = [];
  const needed = new Set(all.flatMap((f) => (f.fixes || []).map((x) => x.type + (x.position ? ':' + x.position : ''))));
  const u = state.undos.get(p.id);
  if (u && Date.now() < u.until) actions.push(el('button', { type: 'button', class: 'btn btn-small undo-btn', 'data-undo': p.id, onclick: () => doUndo(p.id) }, undoLabel(u)));
  if (flags.length || state.filter === 'all') {
    if (p.allowed && p.allowed.edit) actions.push(el('button', { type: 'button', class: 'btn btn-small', onclick: () => openEdit(p, ch, null, null) }, 'Edit text'));
    if (p.allowed && p.allowed.draft && (needed.has('draft') || state.filter === 'all' || flags.some((f) => f.severity === 'high'))) actions.push(el('button', { type: 'button', class: 'btn btn-small btn-quiet', onclick: () => openSimple(p, ch, 'draft') }, 'Move to drafts'));
    if (p.allowed && p.allowed.move && (needed.has('move:bottom') || state.filter === 'all')) actions.push(el('button', { type: 'button', class: 'btn btn-small btn-quiet', onclick: () => openSimple(p, ch, 'move', 'bottom') }, 'Move to end of queue'));
    if (p.allowed && p.allowed.move && (needed.has('move:top') || state.filter === 'all')) actions.push(el('button', { type: 'button', class: 'btn btn-small btn-quiet', onclick: () => openSimple(p, ch, 'move', 'top') }, 'Move to front of queue'));
    if (p.thread && p.thread.length > 1) actions.push(el('span', { class: 'channel-sub' }, 'Threads are edited in Buffer.'));
  }
  if (actions.length) art.append(el('div', { class: 'fix-row' }, actions));
  return art;
}

/* ---------- Daily digest (live only): opt-in, off by default ---------- */
const DIGEST_HOURS = [7, 12, 17, 20];
async function loadDigest() {
  state.digestBusy = true; state.digestError = null;
  render();
  try { state.digest = await api('/api/digest', { op: 'status' }); } catch (e) { if (e.status === 401) return sessionEnded(); state.digestError = e; }
  state.digestBusy = false;
  if (state.view === 'digest') render();
}
function digestStartHref(hour) { return '/digest/start?hour=' + encodeURIComponent(String(hour)) + '&tz=' + encodeURIComponent(localZone()); }
function renderDigest() {
  const q = $('queue');
  q.replaceChildren();
  if (!state.digest) {
    if (!state.digestBusy && !state.digestError) { loadDigest(); return; }
    $('headline').textContent = 'Daily digest';
    $('subline').textContent = state.digestError ? 'Could not read the digest settings.' : 'One moment…';
    if (state.digestError) q.append(problemBanner(state.digestError), el('p', null, el('button', { type: 'button', class: 'btn', onclick: () => loadDigest() }, 'Try again')));
    else q.append(skeleton());
    return;
  }
  const d = state.digest;
  const two = (h) => String(h).padStart(2, '0') + ':00';
  if (!d.on) {
    $('headline').textContent = 'Daily digest';
    $('subline').textContent = 'Tomorrow’s catches every day, without opening Last Look. Off until you turn it on.';
    let hour = 17;
    const go = el('a', { class: 'btn btn-primary', id: 'digest-on', href: digestStartHref(hour) }, 'Turn on the daily digest');
    const sel = el('select', { id: 'digest-hour', class: 'digest-hour', 'aria-label': 'Time of day' }, DIGEST_HOURS.map((h) => el('option', { value: String(h), selected: h === hour }, two(h))));
    sel.addEventListener('change', () => { hour = Number(sel.value) || 17; go.setAttribute('href', digestStartHref(hour)); });
    q.append(el('div', { class: 'digest-card' },
      el('h2', { text: 'What you get' }),
      el('ul', { class: 'digest-points' },
        el('li', null, el('strong', null, 'Every day at the time you pick: '), 'the posts going out before the end of the next day that Last Look would fix, with the reason for each.'),
        el('li', null, el('strong', null, 'Where you already look: '), 'a private page and a feed. Follow it in Slack (/feed subscribe), any feed reader, or an RSS-to-email service.'),
        el('li', null, el('strong', null, 'Read-only: '), 'it asks Buffer for a separate connection that can read your queue and never change it. Fixes still happen here, after you confirm.'),
        el('li', null, el('strong', null, 'One click off: '), 'turning it off deletes its Buffer access and every stored digest at once. It also turns itself off after 14 days nobody opens it.')),
      el('div', { class: 'digest-row' }, el('label', { class: 'lbl', for: 'digest-hour' }, 'Every day at'), sel, el('span', { class: 'muted' }, localZone())),
      el('div', { class: 'cta-row' }, go),
      el('p', { class: 'muted digest-fine' }, 'Buffer asks you to approve the read-only connection. Stored: a sealed copy of its key, and the last 7 digests with the first 140 characters of each flagged post. See Privacy.')));
    return;
  }
  $('headline').textContent = 'Daily digest is on';
  $('subline').textContent = 'Every day at ' + two(d.hour) + ' (' + d.tz + ')' + (d.nextAt ? '. Next: ' + fmtWhen(new Date(d.nextAt).toISOString(), d.tz) + '.' : '.');
  const last = d.last ? 'Latest: tomorrow (' + d.last.tomorrow + '), ' + (d.last.flagged ? plural(d.last.flagged, 'post') + ' to fix' : 'nothing to fix') + ' in ' + plural(d.last.scanned, 'post') + ' checked.' : 'The first digest is being built now.';
  const off = el('button', { type: 'button', class: 'btn btn-danger', id: 'digest-off' }, state.digestConfirm ? 'Yes, turn it off' : 'Turn off');
  off.addEventListener('click', async () => {
    if (!state.digestConfirm) { state.digestConfirm = true; render(); return; }
    off.disabled = true; off.textContent = 'Turning off…';
    try { await api('/api/digest', { op: 'off' }); state.digest = { ok: true, on: false }; state.digestConfirm = false; toast('The digest is off. Its Buffer access and stored digests were deleted.'); }
    catch (e) { if (e.status === 401) return sessionEnded(); toast(e.message, 6000); }
    render();
  });
  q.append(el('div', { class: 'digest-card' },
    el('p', { class: 'digest-last' }, last),
    el('div', { class: 'cta-row' }, d.page ? el('a', { class: 'btn btn-primary', href: d.page, target: '_blank', rel: 'noopener noreferrer' }, 'Open the digest page') : null, off),
    state.digestConfirm ? el('p', { class: 'muted' }, 'This deletes the digest’s Buffer access and every stored digest. Your posts are not touched.') : null,
    d.feed ? el('div', { class: 'digest-feed' }, el('p', { class: 'lbl' }, 'Feed address (private: share it only with your team)'), el('code', { class: 'feed-url' }, d.feed), el('p', { class: 'muted' }, 'Slack: /feed subscribe followed by this address. Or add it to any feed reader or RSS-to-email service.')) : null));
}

/* ---------- Look back (read-only, sent posts) ---------- */
const cardId = (p) => 'lb-' + String(p.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
const snippet = (t, n) => { const x = String(t || '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
const sentIso = (p) => p.sentAt || p.dueAt;
function backChannel(p) {
  const chs = (state.back && state.back.raw.channels) || [];
  return chs.find((c) => c.id === p.channelId) || { id: p.channelId, name: 'Unknown channel', service: p.channelService, timezone: 'Europe/London' };
}
function jumpTo(e, p) {
  e.preventDefault();
  const c = document.getElementById(cardId(p));
  if (!c) return;
  const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  c.scrollIntoView({ block: 'start', behavior: still ? 'auto' : 'smooth' });
  c.focus({ preventScroll: true });
  c.classList.add('flash');
  setTimeout(() => c.classList.remove('flash'), 1600);
}
async function loadBack() {
  if (state.backBusy) return;
  state.backBusy = true; state.backError = null;
  render();
  try {
    const d = await backend.lookback();
    state.back = { raw: d, res: runLookback(d.channels, d.posts, new Date()) };
  } catch (e) {
    if (e.status === 401) { state.backBusy = false; return sessionEnded(); }
    state.backError = e;
    state.backRetryAt = isCalm(e) || e.retryAfter ? Date.now() + waitFor(e.retryAfter) * 1000 : 0;
  }
  state.backBusy = false;
  render();
}
/* the Look back "Try again" button waits out Retry-After with a countdown instead of failing again */
function retryButton() {
  const b = document.getElementById('back-retry');
  if (!b) return;
  const left = Math.ceil(((state.backRetryAt || 0) - Date.now()) / 1000);
  b.disabled = left > 0;
  b.textContent = left > 0 ? 'Try again in ' + (left > 90 ? Math.ceil(left / 60) + ' min' : left + ' s') : 'Try again';
}
function renderBack() {
  const q = $('queue');
  q.replaceChildren();
  if (!state.back) {
    if (state.backError) {
      const calm = isCalm(state.backError);
      $('headline').textContent = calm ? 'A short pause' : 'Could not look back right now';
      $('subline').textContent = calm ? 'Look back will be ready again shortly. Your queue tab still works.' : 'Your queue tab still works.';
      q.append(problemBanner(state.backError));
      q.append(el('p', null, el('button', { type: 'button', class: 'btn', id: 'back-retry', onclick: () => loadBack() }, 'Try again')));
      retryButton();
      return;
    }
    if (!state.backBusy) {
      /* opened from a link (#lookback): nothing is read until the user asks */
      $('headline').textContent = 'Look back at sent posts';
      $('subline').textContent = 'Last Look reads your most recent sent posts (up to 90) and shows what it would have caught. Read-only.';
      q.append(el('p', null, el('button', { type: 'button', class: 'btn btn-primary', id: 'back-go', onclick: () => loadBack() }, 'Look back now')));
      return;
    }
    $('headline').textContent = 'Looking back…';
    $('subline').textContent = T('Reading your most recent sent posts from Buffer…', 'Reading the sample studio’s sent posts…');
    q.append(skeleton());
    return;
  }
  const { raw, res } = state.back;
  const t = res.totals;
  if (!t.checked) {
    $('headline').textContent = 'No sent posts yet';
    $('subline').textContent = 'Once Buffer has sent posts for you, Look back checks them here.';
    q.append(el('div', { class: 'empty' }, el('h2', { text: 'Nothing to look back on' }), el('p', { text: 'Meanwhile, see what Last Look catches on a sample queue.' }), el('a', { class: 'btn', href: '/try#sample' }, 'See a sample queue')));
    return;
  }
  $('headline').textContent = t.issues ? 'Last Look would have caught ' + plural(t.issues, 'issue') + ' in your last ' + plural(t.checked, 'sent post') : 'Nothing to catch in your last ' + plural(t.checked, 'sent post');
  $('subline').textContent = (t.issues ? plural(t.postsWithIssues, 'post') + ' affected. ' : 'No formatting, length, placeholder, repeat, day-word or alt-text problems. ') + 'Read-only: sent posts cannot be changed, and nothing was.';
  if (raw.orgsSkipped) q.append(el('div', { class: 'banner warn' }, 'Look back read your first two organizations; ' + plural(raw.orgsSkipped, 'more organization was', 'more organizations were') + ' left out to save requests.'));
  if (res.meta && res.meta.repeatsPartial) q.append(el('div', { class: 'banner warn' }, 'Repeats were only partly checked across this many posts.'));
  q.append(el('p', { class: 'lb-note muted' }, 'Each post is judged at the moment it actually went out, in its channel’s time zone.' + (t.links ? ' ' + plural(t.links, 'link') + ' in these posts ' + (t.links === 1 ? 'was' : 'were') + ' not opened: Look back reads text only.' : '')));
  const byId = new Map(res.posts.map((p) => [p.id, p]));
  const groups = res.groups.filter((g) => g.items.length || (state.notes && g.notes.length));
  if (groups.length) {
    const wrap = el('div', { class: 'lb-groups' });
    for (const g of groups) {
      const items = g.items.concat(state.notes ? g.notes : []);
      const ul = el('ul', { class: 'lb-list' });
      for (const it of items) {
        const p = byId.get(it.postId);
        if (!p) continue;
        const ch = backChannel(p);
        ul.append(el('li', { class: 'lb-item ' + SEV_CLASS[it.flag.severity] },
          el('a', { href: '#' + cardId(p), onclick: (e) => jumpTo(e, p) }, el('span', { class: 'lb-when' }, fmtWhen(sentIso(p), ch.timezone)), ' · ' + svcName(ch.service) + ' · “' + snippet(p.text, 64) + '”'),
          el('span', { class: 'lb-why' }, it.flag.title)));
      }
      wrap.append(el('section', { class: 'lb-group', 'aria-label': g.title },
        el('h2', null, g.title, ' ', el('span', { class: 'lb-count' }, String(g.items.length + (state.notes ? g.notes.length : 0)))),
        el('p', { class: 'muted' }, g.explain), ul));
    }
    q.append(wrap);
  }
  const visible = res.posts.filter((p) => state.filter === 'all' || p.flags.some((f) => state.notes || f.severity !== 'low'));
  if (visible.length) {
    q.append(el('h2', { class: 'lb-heading' }, state.filter === 'all' ? 'All ' + plural(t.checked, 'sent post') + ', newest first' : 'The posts, newest first'));
    for (const p of visible) q.append(renderSent(p, backChannel(p)));
  } else {
    q.append(el('p', { class: 'clear-line' }, '✓ ' + (t.checked === 1 ? 'Your last sent post was clean.' : 'All ' + t.checked + ' were clean.') + ' Switch to “All posts” to read them.'));
  }
}
function renderSent(p, ch) {
  const flags = p.flags.filter((f) => state.notes || f.severity !== 'low');
  const art = el('article', { class: 'post sent' + (flags.length ? '' : ' is-clear'), id: cardId(p), tabindex: '-1', 'aria-label': 'Post sent ' + fmtWhen(sentIso(p), ch.timezone) });
  const link = typeof p.externalLink === 'string' && /^https:\/\//.test(p.externalLink) ? p.externalLink : null;
  art.append(el('div', { class: 'post-meta' },
    el('span', { class: 'when' }, 'Sent ' + fmtWhen(sentIso(p), ch.timezone)), el('span', null, fromNow(sentIso(p))),
    el('span', { class: 'badge' }, ch.displayName || ch.name), el('span', { class: 'svc' }, svcName(ch.service)),
    link ? el('a', { class: 'lb-open', href: link, rel: 'noopener noreferrer', target: '_blank' }, 'Open post') : null));
  if (p.thread && p.thread.length > 1) {
    p.thread.forEach((t, i) => art.append(el('div', { class: 'thread-part' }, el('p', { class: 'thread-label' }, 'Part ' + (i + 1) + ' of ' + p.thread.length), el('p', { class: 'post-text' }, highlighted(t.text, p.flags, 'thread:' + i)))));
  } else {
    art.append(el('p', { class: 'post-text' }, highlighted(p.text || '', p.flags, 'text')));
  }
  if (p.assets && p.assets.length) art.append(el('p', { class: 'channel-sub' }, plural(p.assets.length, 'attachment')));
  if (flags.length) {
    art.append(el('ul', { class: 'flags' }, flags.map((f) => el('li', { class: 'flag ' + SEV_CLASS[f.severity] }, el('span', { class: 'dot', 'aria-hidden': 'true' }),
      el('div', { class: 'flag-body' }, el('span', { class: 'sev' }, f.severity === 'low' ? 'Note' : 'Would have caught'), el('strong', null, f.title), el('p', null, f.detail))))));
  }
  return art;
}
/* a tab click reads at once, except while a refusal's countdown runs; opening from a link (load: false) waits for a click.
   On /try the first tab is "Your own post" (no hash), the sample queue is #sample. */
function setView(v, opts) {
  const load = !opts || opts.load !== false;
  state.view = v === 'back' ? 'back' : v === 'own' && MODE === 'try' ? 'own' : v === 'digest' && MODE === 'live' ? 'digest' : 'queue';
  if (MODE === 'try') $('v-own').setAttribute('aria-pressed', String(state.view === 'own'));
  if (MODE === 'live') $('v-digest').setAttribute('aria-pressed', String(state.view === 'digest'));
  $('v-queue').setAttribute('aria-pressed', String(state.view === 'queue'));
  $('v-back').setAttribute('aria-pressed', String(state.view === 'back'));
  try { history.replaceState(null, '', state.view === 'back' ? '#lookback' : state.view === 'digest' ? '#digest' : state.view === 'queue' && MODE === 'try' ? '#sample' : location.pathname); } catch (e) { /* not important */ }
  if (MODE === 'try') {
    const mine = state.view === 'own';
    $('own').hidden = !mine;
    for (const id of ['try-banner', 'summary', 'toolbar', 'queue', 'session-note']) $(id).hidden = mine;
  }
  showUndoBar();
  if (state.view === 'own') return;
  if (state.view === 'back' && load && !state.back && !state.backBusy && Date.now() >= state.backRetryAt) { loadBack(); return; }
  render();
  if (state.view === 'queue' && state.data) $('links-status').textContent = state.linkRunning ? $('links-status').textContent : linkSummary();
}

/* ---------- word diff (LCS on word tokens) ---------- */
function tokens(s) { return s.match(/\s+|[\p{L}\p{N}_'’@#.:/?=&%-]+|[^\s]/gu) || []; }
export function diffTokens(a, b) {
  const A = tokens(a); const B = tokens(b);
  if (A.length * B.length > 360000) return [{ t: 'del', s: a }, { t: 'ins', s: b }];
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  const push = (t, s) => { const last = out[out.length - 1]; if (last && last.t === t) last.s += s; else out.push({ t, s }); };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { push('eq', A[i]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) { push('del', A[i]); i++; } else { push('ins', B[j]); j++; }
  }
  while (i < n) push('del', A[i++]);
  while (j < m) push('ins', B[j++]);
  return out;
}

/* ---------- dialogs ---------- */
function openDialog(cfg) {
  const dlg = $('dlg');
  state.dialog = cfg;
  $('dlg-title').textContent = cfg.title;
  $('dlg-desc').textContent = cfg.desc;
  $('dlg-edit').hidden = !cfg.edit;
  $('dlg-ok').textContent = cfg.ok;
  $('dlg-ok').disabled = false;
  $('dlg-error').hidden = true;
  if (cfg.edit) {
    $('dlg-text').value = cfg.text;
    updateEdit();
  }
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  setTimeout(() => (cfg.edit ? $('dlg-text') : $('dlg-ok')).focus(), 30);
}
function closeDialog() {
  const dlg = $('dlg');
  if (dlg.open) { if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open'); }
  state.dialog = null;
}
function updateEdit() {
  const cfg = state.dialog;
  if (!cfg || !cfg.edit) return;
  const text = $('dlg-text').value;
  const svc = cfg.channel.service;
  const limit = limitFor(svc, cfg.channel, cfg.post);
  const n = lengthFor(svc, text);
  const c = $('dlg-count');
  c.textContent = limit ? n.toLocaleString('en-US') + ' / ' + limit.toLocaleString('en-US') + ' for ' + svcName(svc) : n.toLocaleString('en-US') + ' characters';
  c.classList.toggle('over', !!limit && n > limit);
  const diffBox = $('dlg-diff');
  diffBox.replaceChildren();
  const parts = diffTokens(cfg.post.text || '', text);
  const changed = parts.some((x) => x.t !== 'eq');
  if (!changed) diffBox.append(el('span', { class: 'muted' }, 'No changes yet.'));
  for (const x of parts) diffBox.append(x.t === 'eq' ? document.createTextNode(x.s) : el(x.t, null, x.s));
  /* a post in a queue must fit before it is saved; your own post is only text in this page, so it may stay over */
  $('dlg-ok').disabled = !changed || !text.trim() || (!cfg.own && !!limit && n > limit);
}
function openEdit(post, channel, suggestion, label) {
  openDialog({
    edit: true, action: 'edit', post, channel,
    title: suggestion ? (label || 'Apply suggestion') : 'Edit post',
    desc: suggestion ? 'Here is the suggested text. Change anything you like; nothing is saved until you press Save.' : 'Change the text below. Nothing is saved until you press Save. The schedule stays as it is.',
    text: suggestion != null ? suggestion : post.text,
    ok: T('Save to Buffer', 'Save to sample')
  });
}
function openSimple(post, channel, action, position) {
  const snippet = (post.text || '').replace(/\s+/g, ' ').slice(0, 90) + ((post.text || '').length > 90 ? '…' : '');
  if (action === 'draft') {
    openDialog({ edit: false, action, post, channel, title: 'Move to drafts?', desc: '“' + snippet + '” will stop being scheduled and wait in your Buffer drafts, where you can edit and schedule it again.', ok: 'Move to drafts' });
  } else {
    openDialog({ edit: false, action, position, post, channel,
      title: position === 'top' ? 'Move to the front of the queue?' : 'Move to the end of the queue?',
      desc: '“' + snippet + '” will take the ' + (position === 'top' ? 'next' : 'last') + ' slot in this channel’s queue, so its send time will change' + (post.dueAt ? ' (now ' + fmtWhen(post.dueAt, channel.timezone) + ')' : '') + '. Buffer picks the new time from your posting schedule.',
      ok: position === 'top' ? 'Move to front' : 'Move to end' });
  }
}
async function confirmDialog() {
  const cfg = state.dialog;
  if (!cfg) return;
  if (cfg.own) {
    const next = clipOwn($('dlg-text').value);
    closeDialog();
    ownSetText(next);
    return;
  }
  const btn = $('dlg-ok');
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = 'Saving…';
  $('dlg-error').hidden = true;
  try {
    const raw = state.raw && state.raw.posts.find((x) => x.id === cfg.post.id);
    if (!raw) throw new Error('Scan again before changing this post.');
    const before = raw.text || '';
    const body = { postId: raw.id, action: cfg.action, confirm: true, expectedHash: await sha256hex(before), ts: raw.pts, ptok: raw.ptok };
    if (cfg.action === 'edit') body.text = $('dlg-text').value;
    if (cfg.action === 'move') { body.position = cfg.position; if (cfg.channel && cfg.channel.orgId) body.orgId = cfg.channel.orgId; }
    const res = await backend.fix(body);
    closeDialog();
    if (cfg.action === 'edit' && res.undo && res.post) {
      state.undos.set(res.post.id, { oldText: before, newHash: await sha256hex(res.post.text || ''), uts: res.undo.uts, token: res.undo.token, until: Date.now() + Math.max(0, Math.min(res.undo.until - res.undo.uts, 120000)), busy: false });
      state.undoBar = res.post.id;
    }
    applyFixResult(res);
    if (cfg.action === 'edit' && res.undo) showUndoBar(); else toast((cfg.action === 'edit' ? T('Saved to Buffer.', 'Saved.') : cfg.action === 'draft' ? 'Moved to drafts.' : 'Moved in the queue.') + T('', ' Sample only: nothing was sent to Buffer.'));
  } catch (e) {
    if (e.status === 401) { closeDialog(); return sessionEnded(); }
    $('dlg-error').textContent = isCalm(e) ? calmText(e) : e.message;
    $('dlg-error').hidden = false;
    btn.textContent = old;
    btn.disabled = false;
  }
}

/* ---------- Undo: for two minutes after an edit, back to the text the post had before ---------- */
function undoLabel(u) {
  if (u.busy) return 'Undoing…';
  const left = Math.max(0, Math.ceil((u.until - Date.now()) / 1000));
  return 'Undo edit · ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
}
function showUndoBar() {
  const bar = $('undo-bar');
  if (state.view === 'own') {
    const o = own.undo;
    if (!o || Date.now() >= o.until) { own.undo = null; bar.hidden = true; return; }
    $('undo-msg').textContent = 'Text updated.';
    $('undo-btn').textContent = 'Undo';
    $('undo-btn').disabled = false;
    bar.hidden = false;
    return;
  }
  const id = state.undoBar;
  const u = id && state.undos.get(id);
  if (!u || Date.now() >= u.until) { bar.hidden = true; state.undoBar = null; return; }
  $('undo-msg').textContent = T('Saved to Buffer.', 'Saved to the sample.');
  $('undo-btn').textContent = undoLabel(u).replace('Undo edit', 'Undo');
  $('undo-btn').disabled = !!u.busy;
  bar.hidden = false;
}
function undoTick() {
  let expired = false;
  for (const [id, u] of state.undos) if (Date.now() >= u.until && !u.busy) { state.undos.delete(id); expired = true; }
  for (const b of document.querySelectorAll('button[data-undo]')) { const u = state.undos.get(b.getAttribute('data-undo')); if (u) b.textContent = undoLabel(u); }
  showUndoBar();
  if (expired && state.view === 'queue') render();
}
async function doUndo(postId) {
  const u = state.undos.get(postId);
  if (!u || u.busy) return;
  if (Date.now() >= u.until) { undoTick(); return; }
  const raw = state.raw && state.raw.posts.find((x) => x.id === postId);
  if (!raw) return;
  u.busy = true; undoTick();
  try {
    const res = await backend.fix({ postId, action: 'undo', confirm: true, expectedHash: u.newHash, text: u.oldText, uts: u.uts, undo: u.token, ts: raw.pts, ptok: raw.ptok });
    state.undos.delete(postId);
    if (state.undoBar === postId) state.undoBar = null;
    showUndoBar();
    applyFixResult(res);
    toast(T('Restored the previous text in Buffer.', 'Restored the previous text. Sample only: nothing was sent to Buffer.'));
  } catch (e) {
    u.busy = false;
    if (e.status === 401) return sessionEnded();
    /* changed in Buffer since, expired or refused: Undo is off for this post */
    if (e.status === 409 || e.status === 410 || e.status === 403) { state.undos.delete(postId); if (state.undoBar === postId) state.undoBar = null; }
    showUndoBar();
    if (state.view === 'queue') render();
    toast(isCalm(e) ? calmText(e) : e.message, 7000);
  }
}

/* replace the one post with Buffer's answer and re-run the checks locally */
function applyFixResult(res) {
  if (!state.raw || !res || !res.post) return;
  /* the send times before this change: a reorder moves every post between the two slots, and their day words are
     then re-judged against what they meant at the slot they had (see checkSlotShift) */
  const before = new Map(state.raw.posts.map((x) => [x.id, x.dueAt]));
  if (res.action === 'edit' || res.action === 'undo') {
    /* an edit is written for the post's current slot: its old slot no longer says what the words should mean.
       Undo brings the old text back, so it also brings the reorder note back */
    if (res.action === 'edit' && state.shifts.has(res.post.id)) state.shiftsEdited.set(res.post.id, state.shifts.get(res.post.id));
    if (res.action === 'edit') state.shifts.delete(res.post.id);
    if (res.action === 'undo' && state.shiftsEdited.has(res.post.id)) { state.shifts.set(res.post.id, state.shiftsEdited.get(res.post.id)); state.shiftsEdited.delete(res.post.id); }
  }
  const i = state.raw.posts.findIndex((x) => x.id === res.post.id);
  const updated = Object.assign({}, res.post, { pts: res.ts });
  if (i >= 0) state.raw.posts[i] = updated; else state.raw.posts.push(updated);
  /* the sample also reports the posts whose queue slot changed after a move (Buffer's answer has only the moved post) */
  for (const sp of res.shifted || []) {
    const k = state.raw.posts.findIndex((x) => x.id === sp.id);
    if (k >= 0) state.raw.posts[k] = Object.assign({}, sp, { pts: res.ts });
  }
  if (res.shifted && res.shifted.length) state.raw.posts.sort((a, b) => (Date.parse(a.dueAt) || Infinity) - (Date.parse(b.dueAt) || Infinity));
  if (res.action === 'move') {
    const moved = [];
    for (const p of [res.post].concat(res.shifted || [])) {
      const was = before.get(p.id);
      if (!was || !p.dueAt || was === p.dueAt) continue;
      const keep = state.shifts.get(p.id);
      /* moved twice: the words still mean what they meant at the slot the user first saw */
      if (keep && keep.from === p.dueAt) state.shifts.delete(p.id); else state.shifts.set(p.id, { from: keep ? keep.from : was, to: p.dueAt });
      moved.push(p.id);
    }
    state.lastShift = { moved: res.post.id, channelId: res.post.channelId, ids: moved.filter((id) => id !== res.post.id), error: !!res.shiftedError };
  }
  for (const l of res.links || []) if (!state.links.has(l.url)) state.linkQueue.push({ url: l.url, sig: l.sig, ts: res.ts });
  recompute();
  render();
  if (!state.linkQueue.length) $('links-status').textContent = linkSummary();
  runLinks();
}

/* ---------- Your own post (/try): one post typed here and checked in this tab; nothing is sent anywhere ---------- */
const own = { service: OWN_SERVICES[0], queue: true, tz: 'Europe/London', timer: 0, undo: null, last: null, expanded: false };
const OWN_SHOWN = 12;
const ownNow = () => new Date(Date.now());
/* the count updates on every keystroke; the checks run 150 ms after typing stops */
function ownCounter() {
  const text = clipOwn($('own-text').value);
  const ch = ownChannel(own.service, own.tz);
  const limit = limitFor(ch.service, ch, null);
  const n = lengthFor(ch.service, text);
  const c = $('own-count');
  c.textContent = (limit ? n.toLocaleString('en-US') + ' / ' + limit.toLocaleString('en-US') + ' for ' + svcName(ch.service) : n.toLocaleString('en-US') + ' characters') + (text.length >= OWN_MAX ? ' · this box takes up to 3,000' : '');
  c.classList.toggle('over', !!limit && n > limit);
}
function ownRun() {
  clearTimeout(own.timer);
  own.timer = 0;
  const r = checkOwn({ text: $('own-text').value, service: own.service, when: $('own-when').value, queue: own.queue, now: ownNow(), tz: own.tz });
  own.last = r;
  renderOwn(r);
  return r;
}
function ownSoon() { clearTimeout(own.timer); own.timer = setTimeout(ownRun, OWN_DEBOUNCE_MS); }
function ownStatus(r) {
  const s = $('own-status');
  const c = r.counts;
  const parts = [];
  if (c.high) parts.push(c.high + (c.medium || c.low ? ' to fix' : ' to fix before it posts'));
  if (c.medium) parts.push(c.medium + ' worth a look');
  if (c.low) parts.push(plural(c.low, 'note'));
  s.textContent = !r.text.trim() ? '' : parts.length ? parts.join(' · ') : '✓ Nothing to catch';
  s.classList.toggle('is-high', !!c.high);
  s.classList.toggle('is-med', !c.high && !!c.medium);
  s.classList.toggle('is-ok', !!r.text.trim() && !c.high && !c.medium);
}
/* the flagged words, selected in the text box (for flags without a suggested text) */
function ownSelect(span) {
  const box = $('own-text');
  if (!span || typeof box.setSelectionRange !== 'function') return;
  box.focus();
  try { box.setSelectionRange(span[0], span[1]); } catch (e) { /* not important */ }
}
function renderOwn(r) {
  ownCounter();
  ownStatus(r);
  const zone = $('own-zone');
  const picked = String($('own-when').value || '');
  const note = r.usedDefault ? (picked ? 'That date could not be read, so this uses next Monday at 09:30: ' : 'No time picked, so this uses next Monday at 09:30: ') : r.past ? 'That time has already passed; Buffer only schedules ahead. ' : '';
  zone.textContent = note + dayWords(r.dueAt, r.tz) + ', in your time zone (' + r.tz + ').';
  zone.classList.toggle('is-past', r.past || r.usedDefault);
  const out = $('own-result');
  if (!r.text.trim()) {
    out.replaceChildren(el('div', { class: 'own-empty' }, el('p', { class: 'own-empty-title' }, 'Your post shows up here, checked as you type.'), el('p', null, 'Or tap an example. Nothing you type leaves this page.')));
    return;
  }
  const p = r.post;
  const ch = r.channel;
  const flags = p.flags;
  const art = el('article', { class: 'post own-card' + (flags.length ? '' : ' is-clear'), 'aria-label': 'Your post, going out ' + fmtWhen(p.dueAt, ch.timezone) });
  art.append(el('div', { class: 'post-meta' },
    el('span', { class: 'when' }, fmtWhen(p.dueAt, ch.timezone)), el('span', null, fromNow(p.dueAt)),
    el('span', { class: 'badge' }, r.queue ? 'queue slot' : 'custom time'), el('span', { class: 'svc' }, svcName(ch.service))));
  /* the visitor's text, as text nodes; flagged words become <mark> elements around text nodes */
  const txt = el('p', { class: 'post-text' }, highlighted(p.text, flags, 'text'));
  art.append(txt);
  if (p.text.length > 700) {
    if (!own.expanded) txt.classList.add('is-long');
    const more = el('button', { type: 'button', class: 'more', 'aria-expanded': String(own.expanded) }, own.expanded ? 'Show less' : 'Show all');
    more.addEventListener('click', () => { own.expanded = !own.expanded; renderOwn(own.last); });
    art.append(more);
  }
  if (flags.length) {
    art.append(flagList(p, flags.slice(0, OWN_SHOWN), (x) => openOwnEdit(r, x),
      (f, hasSugg) => (!hasSugg && f.where === 'text' && f.spans && f.spans.length ? el('button', { type: 'button', class: 'btn btn-small btn-quiet', onclick: () => ownSelect(f.spans[0]) }, 'Show in the text') : null)));
    if (flags.length > OWN_SHOWN) art.append(el('p', { class: 'channel-sub own-more' }, plural(flags.length - OWN_SHOWN, 'more flag') + ' in this post, of the same kinds as above.'));
  } else {
    art.append(el('p', { class: 'clear-line' }, '✓ Looks good for ' + svcName(ch.service) + ', going out ' + fmtWhen(p.dueAt, ch.timezone) + '.'));
  }
  /* links are listed, never opened: the real link check needs the server, and this tab sends nothing */
  const links = p.links || [];
  if (links.length) {
    const n = links.length;
    art.append(el('ul', { class: 'flags own-links' }, el('li', { class: 'flag sev-info' }, el('span', { class: 'dot', 'aria-hidden': 'true' }),
      el('div', { class: 'flag-body' }, el('span', { class: 'sev' }, n === 1 ? 'Link' : 'Links'),
        el('strong', null, (n === 1 ? 'Link' : n + ' links') + ' will be opened on a real queue'),
        el('p', null, 'Not opened here: ' + links.slice(0, 3).map((l) => snippet(l.url, 60)).join(', ') + (n > 3 ? ' and ' + (n - 3) + ' more' : '') + '. On a real queue Last Look opens ' + (n === 1 ? 'it' : 'each one') + ' like a reader would and flags 404s, dead domains and sign-in walls.')))));
  }
  out.replaceChildren(art);
}
function openOwnEdit(r, x) {
  openDialog({ edit: true, own: true, action: 'edit', post: r.post, channel: r.channel, title: x.label || 'Apply suggestion',
    desc: 'Here is the suggested text. Change anything you like; your post changes only when you press Use this text.', text: x.text, ok: 'Use this text' });
}
/* a suggestion was accepted: the box takes the new text, and Undo puts the old text back for two minutes */
function ownSetText(next) {
  const box = $('own-text');
  own.undo = { prev: box.value, until: Date.now() + 2 * 60 * 1000 };
  box.value = next;
  ownRun();
  showUndoBar();
}
function ownUndo() {
  const o = own.undo;
  own.undo = null;
  if (o && Date.now() < o.until) { $('own-text').value = o.prev; ownRun(); toast('Back to your text.'); }
  showUndoBar();
}
function ownService(svc) { own.service = OWN_SERVICES.includes(svc) ? svc : OWN_SERVICES[0]; for (const s of OWN_SERVICES) $('own-ch-' + s).checked = s === own.service; }
function ownQueue(q) { own.queue = q !== false; $('own-mode-queue').checked = own.queue; $('own-mode-fixed').checked = !own.queue; }
function ownExample(key) {
  const ex = OWN_EXAMPLES[key];
  if (!ex) return;
  ownService(ex.service);
  ownQueue(ex.queue);
  $('own-when').value = defaultWhen(ownNow(), own.tz);
  $('own-text').value = ex.text;
  own.undo = null; own.expanded = false;
  showUndoBar();
  ownRun();
  /* one column (phones): bring the result up, unless it is already in view */
  const res = $('own-preview');
  if (typeof matchMedia === 'function' && matchMedia('(max-width: 899px)').matches && typeof res.getBoundingClientRect === 'function' && res.getBoundingClientRect().top > innerHeight * 0.55) {
    res.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
}
function initOwn() {
  own.tz = localZone();
  /* the browser may restore the form after a reload: keep its text, channel and mode */
  const restored = OWN_SERVICES.find((s) => $('own-ch-' + s).checked);
  if (restored) own.service = restored;
  if ($('own-mode-fixed').checked) own.queue = false;
  if (!parseWhen($('own-when').value, own.tz)) $('own-when').value = defaultWhen(ownNow(), own.tz);
  $('own-text').addEventListener('input', () => { if (own.undo) { own.undo = null; showUndoBar(); } ownCounter(); ownSoon(); });
  for (const s of OWN_SERVICES) $('own-ch-' + s).addEventListener('change', () => { own.service = s; ownRun(); });
  $('own-mode-queue').addEventListener('change', () => { own.queue = true; ownRun(); });
  $('own-mode-fixed').addEventListener('change', () => { own.queue = false; ownRun(); });
  $('own-when').addEventListener('input', ownSoon);
  $('own-when').addEventListener('change', ownRun);
  for (const k of Object.keys(OWN_EXAMPLES)) $('own-ex-' + k).addEventListener('click', () => ownExample(k));
  $('v-own').addEventListener('click', () => setView('own'));
  ownRun();
}

/* ---------- scanning and link checks ---------- */
function sessionEnded() {
  state.data = null; state.raw = null; state.ended = true;
  $('headline').textContent = 'Your session ended';
  $('subline').textContent = 'Sessions last an hour at most. Connect again to keep going.';
  $('rescan').disabled = true;
  $('queue').replaceChildren(el('div', { class: 'empty' }, el('h2', { text: 'Connect again' }), el('p', { text: 'Nothing was changed. Your posts are safe in Buffer.' }), el('a', { class: 'btn btn-primary', href: '/oauth/start' }, 'Connect Buffer')));
}
async function doScan(quiet) {
  if (state.busy || Date.now() < state.nextScanAt) return;
  state.busy = true;
  $('rescan').disabled = true;
  $('rescan').textContent = 'Scanning…';
  if (!quiet && !state.data && state.view === 'queue') $('subline').textContent = T('Reading your queue from Buffer…', 'Loading the sample queue…');
  try {
    const d = await backend.scan();
    for (const p of d.posts) p.pts = d.ts;
    state.raw = d;
    state.shifts.clear(); state.lastShift = null;
    state.scanError = null;
    state.autoRetryUsed = false;
    state.nextScanAt = MODE === 'try' ? 0 : Date.now() + SCAN_GAP_MS;
    recompute();
    const now = Date.now();
    for (const [u, r] of state.links) if (now - r.at > LINK_TTL) state.links.delete(u);
    state.linkQueue = d.links.filter((l) => !state.links.has(l.url)).map((l) => ({ url: l.url, sig: l.sig, ts: d.ts }));
    if (!state.linkQueue.length) $('links-status').textContent = linkSummary();
    if (state.view === 'queue') render();
    runLinks();
  } catch (e) {
    if (e.status === 401) return sessionEnded();
    /* every pause waits (Retry-After, or a minute without one); other errors wait only when the server says so */
    if (isCalm(e) || e.retryAfter) state.nextScanAt = Date.now() + waitFor(e.retryAfter) * 1000;
    state.scanError = e;
    if (state.view === 'queue') render();
  } finally {
    state.busy = false;
    scanButton();
  }
}
/* a first scan refused for a short pause runs again by itself once, when the wait is over (waits up to 2 minutes);
   the one-shot flag is cleared only by a scan that succeeds */
function canAutoRetry() {
  const e = state.scanError;
  return MODE === 'live' && !state.data && !!e && isCalm(e) && (e.retryAfter || 60) <= 120 && !state.autoRetryUsed;
}
/* the server allows one scan a minute: the button counts down instead of failing */
function scanButton() {
  const b = $('rescan');
  if (state.busy) return;
  const left = Math.ceil((state.nextScanAt - Date.now()) / 1000);
  if (left <= 0 && canAutoRetry()) { state.autoRetryUsed = true; doScan(false); return; }
  if (left > 0) { b.disabled = true; b.textContent = 'Scan again in ' + left + ' s'; } else { b.disabled = false; b.textContent = T('Scan again', 'Reset sample'); }
}
async function runLinks() {
  /* nothing new to check (e.g. after a fix that added no link): keep the last summary line */
  if (state.linkRunning || !state.linkQueue.length) return;
  state.linkRunning = true;
  const total = state.linkQueue.length;
  let done = 0;
  const status = $('links-status');
  try {
    while (state.linkQueue.length) {
      status.textContent = 'Checking links ' + done + ' of ' + total + '…';
      /* one batch = up to 6 links from the same scan (they share its timestamp) */
      const ts = state.linkQueue[0].ts;
      const batch = [];
      for (let i = 0; i < state.linkQueue.length && batch.length < 6;) {
        if (state.linkQueue[i].ts === ts) batch.push(state.linkQueue.splice(i, 1)[0]); else i++;
      }
      let res;
      try { res = await backend.checkLinks({ ts, items: batch.map((b) => ({ url: b.url, sig: b.sig })) }); } catch (e) {
        if (e.status === 401) return sessionEnded();
        /* one retry per link: the mark sits on the queued items, which survive the re-queue */
        if (e.status === 429 && (e.retryAfter || 10) <= 60 && batch.every((b) => !b.retried)) {
          for (const b of batch) b.retried = true;
          state.linkQueue.unshift(...batch);
          await new Promise((r) => setTimeout(r, Math.max(5, e.retryAfter || 10) * 1000));
          continue;
        }
        for (const b of batch) state.links.set(b.url, { at: Date.now(), flag: unchecked(b.url, e.status === 410 ? 'the check expired; scan again to check it' : e.message) });
        done += batch.length; continue;
      }
      for (const r of res.results) {
        if (r.skipped) {
          if (state.links.has(r.url)) continue;
          const why = { recent: 'it was checked less than a minute ago; check again later', site: 'that site has had many checks in the last minute; scan again later', budget: 'today’s link-check limit for your account is reached' }[r.skipped] || 'it was not checked';
          state.links.set(r.url, { at: Date.now(), flag: unchecked(r.url, why) });
          continue;
        }
        state.links.set(r.url, { at: Date.now(), flag: r.flag || null, kind: r.kind, status: r.status });
      }
      done += batch.length;
      if (state.view === 'queue') render();
    }
    status.textContent = linkSummary();
  } finally {
    state.linkRunning = false;
    if (state.view === 'queue') render();
  }
}

/* "5 links checked, 3 broken": over the links in the posts on screen now */
function linkSummary() {
  if (!state.data) return '';
  const urls = new Set(state.data.posts.flatMap((p) => (p.links || []).map((l) => l.url)));
  let checked = 0; let broken = 0;
  for (const u of urls) {
    const r = state.links.get(u);
    if (!r) continue;
    checked++;
    if (r.flag && r.flag.severity === 'high') broken++;
  }
  return checked ? plural(checked, 'link') + ' checked' + (broken ? ', ' + broken + ' broken' : ', none broken') + T('', ' (sample results)') : '';
}
function unchecked(url, why) {
  return { check: 'links', id: 'links.unchecked', severity: 'low', title: 'Link not checked', detail: String(url).slice(0, 120) + ': ' + why + '.', fixes: [] };
}

/* ---------- wiring ---------- */
function setFilter(f) {
  state.filter = f;
  $('f-flagged').setAttribute('aria-pressed', String(f === 'flagged'));
  $('f-all').setAttribute('aria-pressed', String(f === 'all'));
  render();
}
function sessionClock() {
  const note = $('session-note');
  if (!SESSION_EXP) return;
  const left = SESSION_EXP - Date.now();
  if (left <= 0) { note.textContent = 'Session ended.'; return; }
  note.textContent = 'This session ends in ' + plural(Math.max(1, Math.round(left / 60000)), 'minute') + '. Disconnect deletes it now. Last Look keeps no copy of your posts.';
}
async function init() {
  if (MODE === 'try') {
    const { SampleBackend } = await import('./sample.js');
    const sample = new SampleBackend();
    backend = { scan: () => sample.scan(), checkLinks: (b) => sample.checkLinks(b), fix: (b) => sample.fix(b), lookback: () => sample.lookback() };
    $('rescan').addEventListener('click', () => { sample.reset(); state.links.clear(); state.linkQueue = []; state.raw = null; state.data = null; doScan(false).then(() => toast('Sample reset.')); });
  } else {
    $('rescan').addEventListener('click', () => doScan(false));
  }
  $('v-queue').addEventListener('click', () => setView('queue'));
  $('v-back').addEventListener('click', () => setView('back'));
  if (MODE === 'live') $('v-digest').addEventListener('click', () => { state.digest = null; setView('digest'); });
  $('f-flagged').addEventListener('click', () => setFilter('flagged'));
  $('f-all').addEventListener('click', () => setFilter('all'));
  $('f-notes').addEventListener('change', (e) => { state.notes = e.target.checked; render(); });
  $('dlg-text').addEventListener('input', updateEdit);
  $('dlg-ok').addEventListener('click', confirmDialog);
  $('dlg-cancel').addEventListener('click', closeDialog);
  $('dlg').addEventListener('close', () => { state.dialog = null; });
  $('dlg-form').addEventListener('submit', (e) => e.preventDefault());
  if (MODE === 'live') {
    $('disconnect') && $('disconnect').addEventListener('click', async () => {
      const b = $('disconnect');
      b.disabled = true; b.textContent = 'Disconnecting…';
      try { await api('/api/disconnect', {}); } catch (e) { /* the session may already be gone */ }
      location.replace('/');
    });
    sessionClock();
    setInterval(sessionClock, 30000);
  }
  setInterval(scanButton, 1000);
  setInterval(undoTick, 1000);
  setInterval(retryButton, 1000);
  $('undo-btn').addEventListener('click', () => { if (state.view === 'own') ownUndo(); else if (state.undoBar) doUndo(state.undoBar); });
  /* a link to #lookback opens the tab; on a real account the read waits for a click (the sample loads at once).
     /try opens on "Your own post"; /try#sample opens the sample queue */
  if (MODE === 'try') initOwn();
  if (location.hash === '#lookback') setView('back', { load: MODE === 'try' });
  else if (MODE === 'try') setView(location.hash === '#sample' ? 'queue' : 'own');
  else if (location.hash === '#digest') setView('digest');
  /* an in-page link to /try#sample or /try#lookback switches the tab without a reload */
  if (MODE === 'try' && typeof addEventListener === 'function') addEventListener('hashchange', () => setView(location.hash === '#lookback' ? 'back' : location.hash === '#sample' ? 'queue' : 'own'));
  doScan(false);
}
if (typeof document !== 'undefined' && document.getElementById('queue')) init();
