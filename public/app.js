/* Last Look app. The server reads the queue (/api/scan); the checks run here in the browser, on the same code
   the server tests. The view is built with DOM nodes and textContent only: post text is third-party content and
   is never parsed as HTML. After a fix, only that post is updated from Buffer's answer; nothing is rescanned.
   Two modes, one code path: on /try (meta mode=try) the backend is the local sample (./sample.js) and api()
   refuses to run, so the sample page never calls the server, Buffer or the link checker. */
import { lengthFor, limitFor, SERVICE_NAMES } from './checks/length.js';
import { runAll } from './checks/index.js';

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
const state = { raw: null, data: null, filter: 'flagged', notes: false, links: new Map(), linkQueue: [], linkRunning: false, busy: false, dialog: null, nextScanAt: 0 };

/* run the checks on the current raw scan (after a scan, and after each fix) */
function recompute() {
  if (!state.raw) { state.data = null; return; }
  const res = runAll(state.raw.channels, state.raw.posts, new Date());
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
  fix: (body) => api('/api/fix', body)
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

/* ---------- rendering ---------- */
function render() {
  const d = state.data;
  const q = $('queue');
  q.replaceChildren();
  if (!d) return;
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
  if (d.rateLow) q.append(el('div', { class: 'banner warn' }, 'Buffer’s request allowance for Last Look is nearly used up for now, so scans may pause for a while.'));
  if (!d.channels.length || !posts.length) {
    q.append(el('div', { class: 'empty' }, el('h2', { text: !d.channels.length ? 'No channels connected in Buffer' : 'Your queue is empty' }),
      el('p', { text: !d.channels.length ? 'Last Look checks posts queued in Buffer. Add a channel there first.' : 'Queue some posts in Buffer, then scan again for a last look before they go out.' }),
      el('div', { class: 'cta-row center' },
        el('a', { class: 'btn btn-primary', href: 'https://publish.buffer.com', rel: 'noopener noreferrer', target: '_blank' }, 'Open Buffer'),
        el('a', { class: 'btn', href: '/try' }, 'See a sample queue'))));
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
  if (flags.length) {
    const ul = el('ul', { class: 'flags' });
    const seenSugg = new Set();
    for (const f of flags) {
      const body = el('div', { class: 'flag-body' }, el('span', { class: 'sev' }, SEV_WORD[f.severity]), el('strong', null, f.title), el('p', null, f.detail));
      const sugg = (f.fixes || []).filter((x) => x.type === 'edit' && typeof x.text === 'string' && x.text !== p.text && !seenSugg.has(x.text));
      for (const x of sugg) seenSugg.add(x.text);
      if (sugg.length) body.append(el('div', { class: 'fix-row' }, sugg.map((x) => el('button', { type: 'button', class: 'btn btn-small', onclick: () => openEdit(p, ch, x.text, x.label) }, x.label || 'Apply suggestion'))));
      ul.append(el('li', { class: 'flag ' + SEV_CLASS[f.severity] }, el('span', { class: 'dot', 'aria-hidden': 'true' }), body));
    }
    art.append(ul);
  }
  if (hiddenNotes > 0 && !state.notes) art.append(el('p', { class: 'channel-sub' }, plural(hiddenNotes, 'note') + ' hidden'));
  /* general actions for posts with something to fix */
  const actions = [];
  const needed = new Set(all.flatMap((f) => (f.fixes || []).map((x) => x.type + (x.position ? ':' + x.position : ''))));
  if (flags.length || state.filter === 'all') {
    if (p.allowed && p.allowed.edit) actions.push(el('button', { type: 'button', class: 'btn btn-small', onclick: () => openEdit(p, ch, null, null) }, 'Edit text'));
    if (p.allowed && p.allowed.draft && (needed.has('draft') || state.filter === 'all' || flags.some((f) => f.severity === 'high'))) actions.push(el('button', { type: 'button', class: 'btn btn-small btn-quiet', onclick: () => openSimple(p, ch, 'draft') }, 'Move to drafts'));
    if (p.allowed && p.allowed.move && (needed.has('move:bottom') || state.filter === 'all')) actions.push(el('button', { type: 'button', class: 'btn btn-small btn-quiet', onclick: () => openSimple(p, ch, 'move', 'bottom') }, 'Move to end of queue'));
    if (p.allowed && p.allowed.move && state.filter === 'all') actions.push(el('button', { type: 'button', class: 'btn btn-small btn-quiet', onclick: () => openSimple(p, ch, 'move', 'top') }, 'Move to front of queue'));
    if (p.thread && p.thread.length > 1) actions.push(el('span', { class: 'channel-sub' }, 'Threads are edited in Buffer.'));
  }
  if (actions.length) art.append(el('div', { class: 'fix-row' }, actions));
  return art;
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
  $('dlg-ok').disabled = !changed || !text.trim() || (!!limit && n > limit);
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
  const btn = $('dlg-ok');
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = 'Saving…';
  $('dlg-error').hidden = true;
  try {
    const raw = state.raw && state.raw.posts.find((x) => x.id === cfg.post.id);
    if (!raw) throw new Error('Scan again before changing this post.');
    const body = { postId: raw.id, action: cfg.action, confirm: true, expectedHash: await sha256hex(raw.text || ''), ts: raw.pts, ptok: raw.ptok };
    if (cfg.action === 'edit') body.text = $('dlg-text').value;
    if (cfg.action === 'move') body.position = cfg.position;
    const res = await backend.fix(body);
    closeDialog();
    applyFixResult(res);
    toast((cfg.action === 'edit' ? T('Saved to Buffer.', 'Saved.') : cfg.action === 'draft' ? 'Moved to drafts.' : 'Moved in the queue.') + T('', ' Sample only: nothing was sent to Buffer.'));
  } catch (e) {
    if (e.status === 401) { closeDialog(); return sessionEnded(); }
    $('dlg-error').textContent = e.message;
    $('dlg-error').hidden = false;
    btn.textContent = old;
    btn.disabled = false;
  }
}

/* replace the one post with Buffer's answer and re-run the checks locally */
function applyFixResult(res) {
  if (!state.raw || !res || !res.post) return;
  const i = state.raw.posts.findIndex((x) => x.id === res.post.id);
  const updated = Object.assign({}, res.post, { pts: res.ts });
  if (i >= 0) state.raw.posts[i] = updated; else state.raw.posts.push(updated);
  /* the sample also reports the posts whose queue slot changed after a move (Buffer's answer has only the moved post) */
  for (const sp of res.shifted || []) {
    const k = state.raw.posts.findIndex((x) => x.id === sp.id);
    if (k >= 0) state.raw.posts[k] = Object.assign({}, sp, { pts: res.ts });
  }
  if (res.shifted && res.shifted.length) state.raw.posts.sort((a, b) => (Date.parse(a.dueAt) || Infinity) - (Date.parse(b.dueAt) || Infinity));
  for (const l of res.links || []) if (!state.links.has(l.url)) state.linkQueue.push({ url: l.url, sig: l.sig, ts: res.ts });
  recompute();
  render();
  runLinks();
}

/* ---------- scanning and link checks ---------- */
function sessionEnded() {
  state.data = null; state.raw = null;
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
  if (!quiet && !state.data) $('subline').textContent = T('Reading your queue from Buffer…', 'Loading the sample queue…');
  try {
    const d = await backend.scan();
    for (const p of d.posts) p.pts = d.ts;
    state.raw = d;
    state.nextScanAt = MODE === 'try' ? 0 : Date.now() + SCAN_GAP_MS;
    recompute();
    const now = Date.now();
    for (const [u, r] of state.links) if (now - r.at > LINK_TTL) state.links.delete(u);
    state.linkQueue = d.links.filter((l) => !state.links.has(l.url)).map((l) => ({ url: l.url, sig: l.sig, ts: d.ts }));
    render();
    runLinks();
  } catch (e) {
    if (e.status === 401) return sessionEnded();
    if (e.retryAfter) state.nextScanAt = Date.now() + Math.min(e.retryAfter, 3600) * 1000;
    const q = $('queue');
    if (!state.data) { $('headline').textContent = 'Could not read your queue'; $('subline').textContent = ''; q.replaceChildren(); }
    q.prepend(el('div', { class: 'banner err', role: 'alert' }, e.message));
  } finally {
    state.busy = false;
    scanButton();
  }
}
/* the server allows one scan a minute: the button counts down instead of failing */
function scanButton() {
  const b = $('rescan');
  if (state.busy) return;
  const left = Math.ceil((state.nextScanAt - Date.now()) / 1000);
  if (left > 0) { b.disabled = true; b.textContent = 'Scan again in ' + left + ' s'; } else { b.disabled = false; b.textContent = T('Scan again', 'Reset sample'); }
}
async function runLinks() {
  if (state.linkRunning) return;
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
        if (e.status === 429 && (e.retryAfter || 10) <= 60 && !batch.retried) { batch.retried = true; state.linkQueue.unshift(...batch); await new Promise((r) => setTimeout(r, Math.max(5, e.retryAfter || 10) * 1000)); continue; }
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
      render();
    }
    const broken = Array.from(state.links.values()).filter((r) => r.flag && r.flag.severity === 'high').length;
    status.textContent = total ? plural(total, 'link') + ' checked' + (broken ? ', ' + broken + ' broken' : ', none broken') + T('', ' (sample results)') : '';
  } finally {
    state.linkRunning = false;
    render();
  }
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
    backend = { scan: () => sample.scan(), checkLinks: (b) => sample.checkLinks(b), fix: (b) => sample.fix(b) };
    $('rescan').addEventListener('click', () => { sample.reset(); state.links.clear(); state.linkQueue = []; state.raw = null; state.data = null; doScan(false).then(() => toast('Sample reset.')); });
  } else {
    $('rescan').addEventListener('click', () => doScan(false));
  }
  $('f-flagged').addEventListener('click', () => setFilter('flagged'));
  $('f-all').addEventListener('click', () => setFilter('all'));
  $('f-notes').addEventListener('change', (e) => { state.notes = e.target.checked; render(); });
  $('dlg-text').addEventListener('input', updateEdit);
  $('dlg-ok').addEventListener('click', confirmDialog);
  $('dlg-cancel').addEventListener('click', closeDialog);
  $('dlg').addEventListener('close', () => { state.dialog = null; });
  $('dlg-form').addEventListener('submit', (e) => e.preventDefault());
  if (MODE === 'live') {
    $('disconnect').addEventListener('click', async () => {
      const b = $('disconnect');
      b.disabled = true; b.textContent = 'Disconnecting…';
      try { await api('/api/disconnect', {}); } catch (e) { /* the session may already be gone */ }
      location.replace('/');
    });
    sessionClock();
    setInterval(sessionClock, 30000);
  }
  setInterval(scanButton, 1000);
  doScan(false);
}
if (typeof document !== 'undefined' && document.getElementById('queue')) init();
