/* Daily digest: opt-in, off until the user turns it on. Once a day, at the hour the user picked in their own time
   zone, Last Look reads the posts going out before the end of the next day and lists what it would fix, on a
   private page and an Atom feed (follow it in Slack, any feed reader or an RSS-to-email service). It closes the
   gap of a pre-flight check that only works when someone remembers to open it.

   Security model (the rest of Last Look keeps no token beyond the one-hour session):
   - The digest has its OWN Buffer grant, asked for with read-only scopes: account:read posts:read offline_access.
     The stored credential cannot edit, publish or delete a post; fixes still go through the normal sign-in.
   - Its refresh token is stored only in this Durable Object, AES-256-GCM under a key derived from the server
     secret and the subscription id, and is never sent to a browser. Buffer rotates it on every use: the new one is
     saved before the access token is used, and this object is the only place that refreshes it, one build at a
     time, as Buffer's docs ask. The access token lives only for the build and is never stored.
   - The private address is 32 random bytes. Storage holds its SHA-256 as the index and a sealed copy, so the
     signed-in account owner can see it again in the app. It identifies one subscription and nothing else.
   - Turning it off (the page's button, the app, or automatically after 14 days in which nobody opened the page or
     the feed, or when Buffer refuses the token) deletes the subscription, its token and every stored digest at
     once; then the grant is revoked at Buffer by sending the old refresh token once more (Buffer revokes every
     token of a grant when an already-used refresh token comes back).
   - Stored per subscription: at most 7 digests (one a day), each with the send time, channel name and the first
     140 characters of each flagged post plus the flags, sealed like the token. Opening the page or the feed reads
     only this storage: it never calls Buffer and never opens a link, so a feed reader polling every minute costs
     Buffer nothing.
   - Limits: 300 subscriptions, 5 sign-ups per account a day, 4 builds per account a day inside the account's
     budget of Buffer requests (src/gate.js), a wider margin of the app's allowance than any interactive use, at
     most 4 links checked per digest through the same SSRF-guarded checker and per-site limits, 120 page or feed
     reads per subscription an hour.
   Health: every build writes one line (time, result) to the health record; /healthz reports the digest loop as
   failing after 6 builds in a row fail for reasons on our side, or when builds are due and no alarm ran for 2 h. */
import { gql, BufferError, Q_DIGEST, shapePost, shapeChannel } from './buffer.js';
import { runAll, postLinks } from './checks/index.js';
import { clearUrlCache } from './checks/text.js';
import { localParts, fromDayNum, fmtDay, fmtTime, validTz, zonedTime } from './checks/time.js';
import { checkLink, linkFlag, siteOf } from './net.js';
import { sealJSON, openJSON, randomToken, sha256hex } from './session.js';
import { gate } from './gate.js';

export const DIGEST_SCOPES = 'account:read posts:read offline_access';
export const DIGEST = {
  maxSubs: 300, keep: 7, idleMs: 14 * 864e5, maxPosts: 40, maxLinks: 4, maxOrgs: 2, signupsPerDay: 5,
  readsPerHour: 120, hours: [7, 12, 17, 20], defaultHour: 17, retryMs: 20 * 60000, maxFails: 6,
  excerpt: 140, staleAlarmMs: 2 * 3600e3, gapMs: 3000
};
const TOKEN = 'https://auth.buffer.com/token';
const RT_INFO = 'lastlook-digest-rt-v1';
const FT_INFO = 'lastlook-digest-ft-v1';
const ENTRY_INFO = 'lastlook-digest-entry-v1';
const INFO = { rt: RT_INFO, ft: FT_INFO, entry: ENTRY_INFO, rv: 'lastlook-digest-revoke-v1' };
export const FEED_RE = /^[A-Za-z0-9_-]{43}$/;
const feedKey = async (ft) => 'f:' + (await sha256hex('lastlook-digest-feed:' + ft));

export function validHour(h) { const n = Number(h); return DIGEST.hours.includes(n) ? n : DIGEST.defaultHour; }

/* next delivery: today at `hour` in tz if that is still more than a minute away, else tomorrow */
export function nextDelivery(now, tz, hour) {
  const t = localParts(new Date(now), tz);
  const today = zonedTime(t.day, hour, 0, tz);
  return today > now + 60000 ? today : zonedTime(t.day + 1, hour, 0, tz);
}
/* the window a digest covers: from now to the end of the next local day */
export function digestWindow(now, tz) {
  const t = localParts(new Date(now), tz);
  return { from: now, to: zonedTime(t.day + 2, 0, 0, tz) - 1000, tomorrow: t.day + 1, today: t.day };
}

/* one refresh-token request. Returns {kind: 'ok', at, rt} | {kind: 'revoked'} | {kind: 'error'} */
export async function refreshToken(env, rt) {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    const r = await fetch(TOKEN, {
      method: 'POST', signal: ctl.signal, redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ client_id: env.BUFFER_CLIENT_ID, client_secret: env.BUFFER_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: rt })
    });
    clearTimeout(timer);
    const text = await r.text();
    if (text.length > 65536) return { kind: 'error' };
    let j = null;
    try { j = JSON.parse(text); } catch (e) { j = null; }
    if (r.status === 200 && j && typeof j.access_token === 'string' && typeof j.refresh_token === 'string' && j.access_token.length <= 8192 && j.refresh_token.length <= 8192) {
      /* the stored grant must stay read-only: refuse a token that could write */
      if (/posts:write/.test(String(j.scope || ''))) return { kind: 'error', why: 'scope' };
      return { kind: 'ok', at: j.access_token, rt: j.refresh_token };
    }
    if ((r.status === 400 || r.status === 401) && j && (j.error === 'invalid_grant' || j.error === 'unauthorized_client' || j.error === 'invalid_client')) return { kind: 'revoked' };
    return { kind: 'error' };
  } catch (e) {
    return { kind: 'error' };
  }
}
/* revoke a grant at Buffer: use the refresh token once (it rotates), then send the used one again, which Buffer
   answers by revoking every token of the grant. Best effort: the token is already deleted from storage. */
export async function revokeGrant(env, rt) {
  if (typeof rt !== 'string' || !rt) return false;
  const first = await refreshToken(env, rt);
  if (first.kind === 'revoked') return true;
  const again = await refreshToken(env, rt);
  return again.kind === 'revoked';
}

const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const SVC = { twitter: 'X', linkedin: 'LinkedIn', bluesky: 'Bluesky', threads: 'Threads', instagram: 'Instagram', mastodon: 'Mastodon', facebook: 'Facebook', tiktok: 'TikTok', pinterest: 'Pinterest', youtube: 'YouTube', googlebusiness: 'Google Business', substack: 'Substack' };

/* the digest for one build: plain data, rendered later (src/digest_pages.js escapes every value) */
export function composeEntry(channels, checked, linkStats, w, tz, now, extra) {
  const chMap = new Map(channels.map((c) => [c.id, c]));
  const posts = [];
  let high = 0;
  for (const p of checked) {
    const flags = (p.flags || []).filter((f) => f.severity === 'high' || f.severity === 'medium');
    if (!flags.length) continue;
    const ch = chMap.get(p.channelId) || { name: 'Unknown channel', service: p.channelService, timezone: tz };
    const lp = localParts(new Date(p.dueAt), ch.timezone);
    high += flags.filter((f) => f.severity === 'high').length;
    posts.push({
      when: fmtDay(lp, lp.y) + ' ' + fmtTime(lp),
      ch: clip(ch.displayName || ch.name, 60) + ' (' + (SVC[ch.service] || ch.service || 'channel') + ')',
      slot: p.status === 'needs_approval' ? 'awaiting approval' : (p.isCustomScheduled || p.shareMode === 'customScheduled') ? 'custom time' : 'queue slot',
      excerpt: clip(p.text, DIGEST.excerpt),
      flags: flags.slice(0, 6).map((f) => ({ s: f.severity, t: clip(f.title, 160), d: clip(f.detail, 320) }))
    });
  }
  const tp = fromDayNum(w.tomorrow);
  return {
    v: 1, builtAt: now, tz, tomorrow: fmtDay(tp, tp.y), day: w.tomorrow,
    scanned: checked.length, flagged: posts.length, high, posts,
    links: linkStats, more: !!(extra && extra.more), orgsSkipped: (extra && extra.orgsSkipped) || 0
  };
}

export class DigestCore {
  constructor(storage, env, opts) {
    this.storage = storage;                 /* {get, put, delete, setAlarm?} */
    this.env = env;
    this.now = (opts && opts.now) || (() => Date.now());
    this.gate = (opts && opts.gate) || ((msg) => gate(env, msg));
    this.building = new Set();
    this.reads = new Map();                 /* sub id -> {n, reset} page and feed reads this hour */
  }
  seal(kind, id, obj) { return sealJSON(this.env, 'digest-' + kind + ':' + id, INFO[kind], obj); }
  open(kind, id, sealed) { return openJSON(this.env, 'digest-' + kind + ':' + id, INFO[kind], sealed); }
  async ids() { return (await this.storage.get('ids')) || []; }
  async sub(id) { return id ? (await this.storage.get('u:' + id)) || null : null; }
  async del(key) { if (typeof this.storage.delete === 'function') await this.storage.delete(key); else await this.storage.put(key, undefined); }

  /* turn it on: one subscription per account (a new one replaces the old), returns the private address */
  async subscribe(m) {
    const now = this.now();
    if (typeof m.acct !== 'string' || !/^[0-9a-f]{64}$/.test(m.acct)) return { ok: false, code: 'bad_input' };
    if (typeof m.rt !== 'string' || !m.rt || m.rt.length > 8192) return { ok: false, code: 'bad_input' };
    const day = new Date(now).toISOString().slice(0, 10);
    const su = (await this.storage.get('su:' + m.acct)) || {};
    if (su.day !== day) { su.day = day; su.n = 0; }
    if (su.n >= DIGEST.signupsPerDay) return { ok: false, code: 'signup_budget', message: 'Too many digest sign-ups for this account today. Try again tomorrow.' };
    const ids = await this.ids();
    const oldId = await this.storage.get('a:' + m.acct);
    if (!oldId && ids.length >= DIGEST.maxSubs) return { ok: false, code: 'full', message: 'The daily digest is full for now. Try again in a few days.' };
    let oldRt = null;
    if (oldId) oldRt = await this.remove(oldId);
    su.n++;
    await this.storage.put('su:' + m.acct, su);
    const id = randomToken(16);
    const ft = randomToken(32);
    const tz = validTz(m.tz);
    const hour = validHour(m.hour);
    const record = {
      id, acct: m.acct, tz, hour, created: now, lastBuilt: 0, lastRead: now, nextAt: now, fails: 0, builds: 0,
      orgs: (Array.isArray(m.orgs) ? m.orgs : []).slice(0, 5).map((o) => ({ id: String(o.id).slice(0, 64), name: String(o.name || '').slice(0, 80) })),
      rt: await this.seal('rt', id, { rt: m.rt }),
      ft: await this.seal('ft', id, { ft }),
      fk: await feedKey(ft)
    };
    await this.storage.put('u:' + id, record);
    await this.storage.put(record.fk, id);
    await this.storage.put('a:' + m.acct, id);
    await this.storage.put('ids', (await this.ids()).filter((x) => x !== id).concat([id]));
    if (oldRt) await this.queueRevoke(oldRt);
    await this.arm(now);
    return { ok: true, ft, id, hour, tz, replaced: !!oldId };
  }

  /* delete everything of one subscription at once; returns the refresh token (for revocation) */
  async remove(id) {
    const s = await this.sub(id);
    if (!s) return null;
    let rt = null;
    try { const o = await this.open('rt', id, s.rt); rt = o && o.rt; } catch (e) { rt = null; }
    await this.del('u:' + id);
    await this.del('e:' + id);
    if (s.fk) await this.del(s.fk);
    if ((await this.storage.get('a:' + s.acct)) === id) await this.del('a:' + s.acct);
    await this.storage.put('ids', (await this.ids()).filter((x) => x !== id));
    this.reads.delete(id);
    return rt;
  }
  async off(id) {
    const rt = await this.remove(id);
    if (rt) await this.queueRevoke(rt);
    return { ok: true, was: !!rt };
  }
  /* revocations run from the alarm, right after the reply (they need two requests to Buffer); until then the token
     waits sealed in a queue of its own, so a revocation survives a restart of this object */
  async queueRevoke(rt) {
    const k = randomToken(12);
    const q = (await this.storage.get('rv')) || [];
    q.push({ k, rt: await this.seal('rv', k, { rt }) });
    await this.storage.put('rv', q.slice(-500));
    await this.arm(this.now());
  }
  async runRevokes(max) {
    const q = (await this.storage.get('rv')) || [];
    if (!q.length) return 0;
    const batch = q.slice(0, max);
    await this.storage.put('rv', q.slice(batch.length));
    for (const x of batch) {
      const o = await this.open('rv', x.k, x.rt);
      if (o && o.rt) { try { await revokeGrant(this.env, o.rt); } catch (e) { /* best effort; the token is gone from storage */ } }
    }
    return batch.length;
  }
  async offByFeed(ft) {
    if (!FEED_RE.test(String(ft || ''))) return { ok: false, code: 'not_found' };
    const id = await this.storage.get(await feedKey(ft));
    if (!id) return { ok: false, code: 'not_found' };
    return this.off(id);
  }
  async offByAcct(acct) {
    const id = await this.storage.get('a:' + acct);
    if (!id) return { ok: true, was: false };
    return this.off(id);
  }

  /* the page or feed: read-only, never Buffer */
  async read(ft) {
    if (!FEED_RE.test(String(ft || ''))) return { ok: false, code: 'not_found' };
    const id = await this.storage.get(await feedKey(ft));
    const s = await this.sub(id);
    if (!s) return { ok: false, code: 'not_found' };
    const now = this.now();
    let r = this.reads.get(id);
    if (!r || r.reset < now) { r = { n: 0, reset: now + 3600e3 }; this.reads.set(id, r); }
    if (++r.n > DIGEST.readsPerHour) return { ok: false, code: 'slow_down', retryAfter: Math.ceil((r.reset - now) / 1000) };
    if (this.reads.size > 5000) for (const [k, v] of this.reads) if (v.reset < now) this.reads.delete(k);
    /* "someone still reads this": at most one write an hour */
    if (now - (s.lastRead || 0) > 3600e3) { s.lastRead = now; await this.storage.put('u:' + id, s); }
    return { ok: true, view: await this.view(s) };
  }
  async view(s) {
    const sealed = (await this.storage.get('e:' + s.id)) || [];
    const entries = [];
    for (const x of sealed) { const e = await this.open('entry', s.id, x); if (e) entries.push(e); }
    return { id: s.id, tz: s.tz, hour: s.hour, created: s.created, lastBuilt: s.lastBuilt, nextAt: s.nextAt, fails: s.fails, entries, note: s.note || null };
  }
  /* for the signed-in account owner in the app: on or off, and the private address again */
  async status(acct) {
    const id = await this.storage.get('a:' + acct);
    const s = await this.sub(id);
    if (!s) return { ok: true, on: false };
    const f = await this.open('ft', s.id, s.ft);
    const v = await this.view(s);
    const last = v.entries[0] || null;
    return { ok: true, on: true, ft: f && f.ft, tz: s.tz, hour: s.hour, lastBuilt: s.lastBuilt, nextAt: s.nextAt, last: last ? { tomorrow: last.tomorrow, flagged: last.flagged, scanned: last.scanned, high: last.high } : null };
  }

  /* ---------- builds ---------- */
  async arm(at) {
    if (typeof this.storage.setAlarm !== 'function') return;
    const cur = typeof this.storage.getAlarm === 'function' ? await this.storage.getAlarm() : null;
    if (cur == null || cur > at) await this.storage.setAlarm(Math.max(at, this.now() + 50));
  }
  async health(patch) {
    const h = Object.assign((await this.storage.get('health')) || {}, patch);
    await this.storage.put('health', h);
    return h;
  }
  async healthView() {
    const now = this.now();
    const h = (await this.storage.get('health')) || {};
    const ids = await this.ids();
    let due = 0;
    for (const id of ids) { const s = await this.sub(id); if (s && s.nextAt <= now - DIGEST.staleAlarmMs) due++; }
    const failing = (h.ourFails || 0) >= DIGEST.maxFails;
    const stale = due > 0;
    return { ok: !failing && !stale, subs: ids.length, lastTick: h.lastTick || null, lastResult: h.lastResult || null, consecutiveFailures: h.ourFails || 0, overdue: due };
  }
  /* the next subscription that is due, oldest first */
  async nextDue() {
    const now = this.now();
    let best = null;
    let soonest = null;
    for (const id of await this.ids()) {
      const s = await this.sub(id);
      if (!s) continue;
      if (s.nextAt <= now && !this.building.has(id) && (!best || s.nextAt < best.nextAt)) best = s;
      if (soonest == null || s.nextAt < soonest) soonest = s.nextAt;
    }
    return { best, soonest };
  }
  /* one alarm builds one digest (each alarm has its own CPU budget), then sets the next alarm */
  async alarm() {
    const revoked = await this.runRevokes(3);
    if (revoked) { const left = ((await this.storage.get('rv')) || []).length; if (left) { await this.arm(this.now() + DIGEST.gapMs); return; } }
    const { best } = await this.nextDue();
    if (best) {
      let res;
      try { res = await this.build(best.id); } catch (e) { res = { result: 'error', ours: true }; }
      const h = (await this.storage.get('health')) || {};
      await this.health({ lastTick: this.now(), lastResult: res.result, ourFails: res.ours ? (h.ourFails || 0) + 1 : 0 });
      console.log(JSON.stringify({ ev: 'digest_build', result: res.result }));
    } else {
      await this.health({ lastTick: this.now() });
    }
    const { best: more, soonest } = await this.nextDue();
    if (more) await this.arm(this.now() + DIGEST.gapMs);
    else if (soonest != null) await this.arm(soonest);
  }
  async tick() { const { soonest } = await this.nextDue(); if (soonest != null) await this.arm(soonest); return { ok: true }; }

  async build(id) {
    if (this.building.has(id)) return { result: 'busy' };
    this.building.add(id);
    try { return await this.buildOne(id); } finally { this.building.delete(id); clearUrlCache(); }
  }
  async reschedule(s, ms, fails) { s.nextAt = this.now() + ms; if (fails != null) s.fails = fails; if (await this.sub(s.id)) await this.storage.put('u:' + s.id, s); }
  async buildOne(id) {
    const now = this.now();
    let s = await this.sub(id);
    if (!s) return { result: 'gone' };
    /* nobody opened the page or the feed for two weeks: switch it off and revoke */
    if (now - Math.max(s.lastRead || 0, s.created || 0) > DIGEST.idleMs) { await this.off(id); return { result: 'idle_off' }; }
    const orgs = (s.orgs || []).slice(0, DIGEST.maxOrgs);
    if (!orgs.length) { await this.reschedule(s, nextDelivery(now, s.tz, s.hour) - now, s.fails); return { result: 'no_orgs' }; }
    const adm = await this.gate({ op: 'admit', kind: 'digest', acct: s.acct, calls: orgs.length });
    if (!adm || !adm.ok) {
      /* the app's allowance is busy (people come first): try again in 20 minutes, or tomorrow if the day is over */
      const retry = adm && adm.code === 'digest_budget' ? nextDelivery(now, s.tz, s.hour) - now : DIGEST.retryMs;
      await this.reschedule(s, retry, s.fails);
      return { result: 'deferred:' + ((adm && adm.code) || 'gate') };
    }
    let rate = null; let used = 0;
    try {
      const sealed = await this.open('rt', id, s.rt);
      const tok = sealed && sealed.rt ? await refreshToken(this.env, sealed.rt) : { kind: 'revoked' };
      if (tok.kind === 'revoked') {
        /* the user removed Last Look in Buffer, or the grant ended: nothing more can be read; turn it off */
        await this.remove(id);
        return { result: 'revoked' };
      }
      if (tok.kind !== 'ok') {
        const fails = (s.fails || 0) + 1;
        await this.reschedule(s, fails >= DIGEST.maxFails ? nextDelivery(now, s.tz, s.hour) - now : DIGEST.retryMs * fails, fails >= DIGEST.maxFails ? 0 : fails);
        return { result: 'refresh_failed', ours: false };
      }
      /* Buffer has rotated the token: save the new one before anything else uses the grant */
      s = await this.sub(id);
      if (!s) { await this.queueRevoke(tok.rt); return { result: 'gone' }; }
      s.rt = await this.seal('rt', id, { rt: tok.rt });
      await this.storage.put('u:' + id, s);

      const w = digestWindow(now, s.tz);
      const channels = []; const posts = [];
      let more = false;
      for (const org of orgs) {
        used++;
        const r = await gql(tok.at, Q_DIGEST, { org: org.id, start: new Date(w.from).toISOString(), end: new Date(w.to).toISOString(), first: DIGEST.maxPosts });
        rate = r.rate;
        for (const c of (r.data.channels || []).slice(0, 100)) channels.push(shapeChannel(c));
        const edges = ((r.data.posts || {}).edges || []);
        if (edges.length >= DIGEST.maxPosts) more = true;
        for (const e of edges) if (e && e.node) posts.push(shapePost(e.node));
      }
      await this.gate({ op: 'record', windows: (rate && rate.windows) || {}, hold: adm.hold, used });
      const live = posts.filter((p) => (p.status === 'scheduled' || p.status === 'needs_approval') && p.dueAt && Date.parse(p.dueAt) >= w.from && Date.parse(p.dueAt) <= w.to).slice(0, DIGEST.maxPosts);
      const checked = runAll(channels, live, new Date(now)).posts;
      const linkStats = await this.links(s.acct, checked);
      const entry = composeEntry(channels, checked, linkStats, w, s.tz, now, { more, orgsSkipped: Math.max(0, (s.orgs || []).length - orgs.length) });
      /* one digest per local day: a rebuild the same day replaces it */
      s = await this.sub(id);
      if (!s) return { result: 'gone' };
      const prev = (await this.storage.get('e:' + id)) || [];
      const kept = [];
      for (const x of prev) { const e = await this.open('entry', id, x); if (e && e.day !== entry.day) kept.push(x); }
      await this.storage.put('e:' + id, [await this.seal('entry', id, entry)].concat(kept).slice(0, DIGEST.keep));
      s.lastBuilt = now; s.builds = (s.builds || 0) + 1; s.fails = 0; s.nextAt = nextDelivery(now, s.tz, s.hour);
      await this.storage.put('u:' + id, s);
      return { result: 'built', flagged: entry.flagged, scanned: entry.scanned };
    } catch (e) {
      if (e instanceof BufferError) {
        if (e.rate) rate = e.rate;
        await this.gate({ op: 'record', windows: (rate && rate.windows) || {}, hold: adm.hold, used });
        if (e.kind === 'auth') { await this.remove(id); return { result: 'revoked' }; }
        const cur = await this.sub(id);
        if (cur) { const fails = (cur.fails || 0) + 1; await this.reschedule(cur, e.kind === 'rate' ? Math.max(DIGEST.retryMs, (e.retryAfter || 60) * 1000) : DIGEST.retryMs * fails, fails >= DIGEST.maxFails ? 0 : fails); }
        return { result: 'buffer_' + e.kind, ours: false };
      }
      await this.gate({ op: 'record', windows: {}, hold: adm.hold, used });
      const cur = await this.sub(id);
      if (cur) await this.reschedule(cur, DIGEST.retryMs, (cur.fails || 0) + 1);
      return { result: 'error', ours: true };
    }
  }
  /* up to 4 links per digest, through the same checker and limits as the live queue (high-severity posts first) */
  async links(acct, checked) {
    const seen = new Set(); const list = [];
    for (const p of checked) for (const l of postLinks(p)) { if (!seen.has(l.url) && list.length < 25) { seen.add(l.url); list.push({ url: l.url, post: p }); } }
    const stats = { found: list.length, checked: 0, skipped: 0 };
    if (!list.length) return stats;
    const pick = list.slice(0, DIGEST.maxLinks);
    stats.skipped = list.length - pick.length;
    const items = [];
    for (const it of pick) {
      let host = '';
      try { host = new URL(it.url).hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase(); } catch (e) { host = ''; }
      items.push({ h: (await sha256hex(it.url)).slice(0, 32), site: siteOf(host || 'invalid') });
    }
    const g = await this.gate({ op: 'links', acct, digest: true, items });
    const verdicts = (g && g.ok && g.results) || [];
    let budget = 24;
    const deps = { selfHost: 'lastlook.swiftbotlab.workers.dev', timeoutMs: 8000, spend: (n) => { budget -= n; if (budget < 0) throw new Error('budget'); } };
    for (let i = 0; i < pick.length; i++) {
      if (verdicts[i] !== 'ok') { stats.skipped++; continue; }
      const r = await checkLink(pick[i].url, deps);
      stats.checked++;
      const f = linkFlag(r);
      if (f && (f.severity === 'high' || f.severity === 'medium')) {
        pick[i].post.flags = (pick[i].post.flags || []).concat([f]);
      }
    }
    return stats;
  }

  async dispatch(msg) {
    switch (msg && msg.op) {
      case 'subscribe': return this.subscribe(msg);
      case 'read': return this.read(msg.ft);
      case 'status': return this.status(msg.acct);
      case 'off_feed': return this.offByFeed(msg.ft);
      case 'off_acct': return this.offByAcct(msg.acct);
      case 'tick': return this.tick();
      case 'health': return this.healthView();
      default: return { ok: false, code: 'bad_op' };
    }
  }
}

/* Durable Object wrapper: one instance ("global") holds every subscription */
export class Digest {
  constructor(state, env) {
    this.state = state;
    this.core = new DigestCore(state.storage, env);
  }
  async alarm() { await this.core.alarm(); }
  async fetch(request) {
    let msg;
    try { msg = await request.json(); } catch (e) { return new Response('{"ok":false}', { status: 400 }); }
    const out = await this.core.dispatch(msg);
    return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
  }
}
export async function digest(env, msg) {
  const ns = env.DIGEST;
  const stub = ns.get(ns.idFromName('global'));
  const r = await stub.fetch('https://digest.internal/op', { method: 'POST', body: JSON.stringify(msg) });
  return r.json();
}
