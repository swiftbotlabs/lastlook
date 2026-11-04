/* The gate: one Durable Object instance ("global") that every Buffer-spending or link-checking request asks first.
   It holds, with strong consistency:
   - the session registry: exactly one live session per Buffer account (a new sign-in replaces the old one,
     Disconnect clears it), keyed by a hash of the account id, storing only a hash of the session id;
   - the app-wide Buffer allowance, fed by the RateLimit headers of every Buffer response; new scans and fixes are
     refused when the 15-minute or 24-hour window runs low, sign-ins keep a smaller reserve. An operation holds the
     calls it may spend until its own Buffer reply is recorded; a hold with no reply lapses after 30 s;
   - sign-in attempts: a hash of each attempt's one-time value, kept at least for the OAuth cookie's 10 minutes and
     cleared within 30 (next sign-in or the alarm), so a callback can be used once;
   - per-account budgets: one budget of real Buffer calls (15 per 15 minutes, 60 per UTC day, sign-ins included)
     on top of one scan per 60 s, 20 scans, 40 fixes, 300 link checks and 20 sign-ins per UTC day,
     10 fixes and 30 link batches per minute; one Look back per 2 minutes and 6 per day;
   - link-check limits: one check per account per URL per 60 s, 20 checks per minute per target site across all users;
   - the daily digest (src/digest.js, opt-in): its builds have no browser session, so they are admitted per account
     (at most 4 a day, inside the same budget of real Buffer calls) and keep a wider margin of the app's allowance
     than anything a person is waiting for.
   Nothing here holds post text, links in clear (URLs are hashed), tokens or session ids. */

export const LIMITS = {
  scanGapMs: 60000, lookbackGapMs: 120000, digestsPerDay: 4,
  scansPerDay: 20, fixesPerDay: 40, linksPerDay: 300, signinsPerDay: 20, lookbacksPerDay: 6,
  fixesPerMin: 10, linkBatchesPerMin: 30,
  urlGapMs: 60000, sitePerMin: 20,
  /* real Buffer calls per account (sign-in, scans, Look backs, fixes and undos together) */
  callsPer15: 15, callsPerDay: 60,
  /* a reservation that no Buffer reply settles stops counting after this long */
  holdMs: 30000,
  /* sign-in attempts: one-time values are remembered for the OAuth cookie's lifetime, in 10-minute slots */
  nonceMs: 600000, noncesPerSlot: 2000,
  /* keep this many requests of Buffer's per-app allowance free (15-minute window, 24-hour window) */
  margin: { scan: [20, 150], fix: [20, 150], lookback: [20, 150], signin: [5, 30], digest: [30, 200] }
};
const W15 = 900, W24 = 86400;
const W15_MS = W15 * 1000;

const day = (now) => new Date(now).toISOString().slice(0, 10);

export class GateCore {
  constructor(storage, now) {
    this.storage = storage;            /* {get(key), put(key, value)} */
    this.now = now || (() => Date.now());
    this.rate = null;                  /* {900: {r, resetAt}, 86400: {r, resetAt}} */
    this.recentUrls = new Map();       /* acct + '|' + urlHash -> ts */
    this.sites = new Map();            /* site -> {n, reset} */
    this.minute = new Map();           /* acct + '|' + kind -> {n, reset} */
    this.holds = new Map();            /* hold id -> {at, n, n0, acct, day, q15} (calls reserved, not yet settled) */
    this.holdSeq = 0;
    this.nonces = new Map();           /* 'n:' + slot % 3 -> {slot, list, set} (hashes of used sign-in values) */
  }
  async account(acct) {
    const a = (await this.storage.get('a:' + acct)) || {};
    const today = day(this.now());
    if (a.day !== today) Object.assign(a, { day: today, scans: 0, fixes: 0, links: 0, signins: 0, lookbacks: 0, calls: 0, digests: 0 });
    return a;
  }
  async saveAccount(acct, a) { await this.storage.put('a:' + acct, a); }
  async loadRate() {
    if (!this.rate) this.rate = (await this.storage.get('rate')) || {};
    return this.rate;
  }
  /* remaining requests in a window (Buffer's last count minus calls held by operations still running),
     or null when unknown or already reset */
  remaining(w) {
    const x = this.rate && this.rate[w];
    if (!x || !(x.resetAt > this.now())) return null;
    return x.r - this.held();
  }
  held() {
    const now = this.now();
    let n = 0;
    for (const [id, h] of this.holds) { if (now - h.at >= LIMITS.holdMs) this.holds.delete(id); else n += h.n; }
    return n;
  }
  /* the account's 15-minute window of Buffer calls (starts at its first call) */
  q15(a, now) {
    if (!a.q15 || !(now - a.q15.start < W15_MS) || now < a.q15.start) a.q15 = { start: now, n: 0 };
    return a.q15;
  }
  callRefusal(a, calls, now) {
    const q = this.q15(a, now);
    if ((a.calls || 0) + calls > LIMITS.callsPerDay) {
      const midnight = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1);
      return this.refuse('call_budget', 'That is today’s limit of Buffer requests for your account.', (midnight - now) / 1000);
    }
    if (q.n + calls > LIMITS.callsPer15) return this.refuse('call_rate', 'Your account has made many Buffer requests in the last 15 minutes.', (q.start + W15_MS - now) / 1000);
    return null;
  }
  spend(a, calls, now) { a.calls = (a.calls || 0) + calls; this.q15(a, now).n += calls; }
  perMinute(key, limit) {
    const now = this.now();
    let e = this.minute.get(key);
    if (!e || e.reset < now) { e = { n: 0, reset: now + 60000 }; this.minute.set(key, e); }
    if (e.n >= limit) return Math.ceil((e.reset - now) / 1000);
    e.n++;
    if (this.minute.size > 5000) for (const [k, v] of this.minute) if (v.reset < now) this.minute.delete(k);
    return 0;
  }
  refuse(code, message, retryAfter) { return { ok: false, code, message, retryAfter: Math.max(1, Math.ceil(retryAfter || 60)) }; }

  /* is this session the account's live one */
  async current(acct, sk) {
    if (!acct || !sk) return { ok: false };
    const a = await this.account(acct);
    return { ok: a.sk === sk };
  }
  /* reserve Buffer calls for an operation; the answer carries a hold id that the operation's record() settles */
  async admit(op, acct, sk, calls) {
    const now = this.now();
    await this.loadRate();
    const margin = LIMITS.margin[op];
    if (!margin) return this.refuse('bad_op', 'Unknown operation.', 60);
    let a = null;
    if (op !== 'signin') {
      if (!acct || typeof acct !== 'string') return this.refuse('bad_op', 'Unknown account.', 60);
      a = await this.account(acct);
      /* digest builds run from the digest's own stored grant, with no browser session */
      if (op !== 'digest' && (!sk || a.sk !== sk)) return this.refuse('replaced', 'This session was replaced by a newer sign-in or was disconnected.', 1);
    }
    const r15 = this.remaining(W15); const r24 = this.remaining(W24);
    if (r15 !== null && r15 - calls < margin[0]) return this.refuse('app_busy', 'Last Look is busy right now (Buffer’s request allowance for this app is nearly used). Try again in a few minutes.', (this.rate[W15].resetAt - now) / 1000);
    if (r24 !== null && r24 - calls < margin[1]) return this.refuse('app_busy_day', 'Last Look has used most of today’s Buffer allowance. Try again later.', Math.min(this.rate[W24].resetAt - now, 3600000) / 1000);
    /* per-kind limits first (nothing is counted until every check has passed) */
    if (op === 'scan') {
      if (a.lastScan && now - a.lastScan < LIMITS.scanGapMs) return this.refuse('scan_gap', 'You scanned less than a minute ago.', (LIMITS.scanGapMs - (now - a.lastScan)) / 1000);
      if (a.scans >= LIMITS.scansPerDay) return this.refuse('scan_budget', 'That is today’s limit of ' + LIMITS.scansPerDay + ' scans for your account.', 3600);
    } else if (op === 'lookback') {
      if (a.lastLookback && now - a.lastLookback < LIMITS.lookbackGapMs) return this.refuse('lookback_gap', 'You looked back less than two minutes ago.', (LIMITS.lookbackGapMs - (now - a.lastLookback)) / 1000);
      if ((a.lookbacks || 0) >= LIMITS.lookbacksPerDay) return this.refuse('lookback_budget', 'That is today’s limit of ' + LIMITS.lookbacksPerDay + ' look-backs for your account.', 3600);
    } else if (op === 'fix') {
      if (a.fixes >= LIMITS.fixesPerDay) return this.refuse('fix_budget', 'That is today’s limit of ' + LIMITS.fixesPerDay + ' fixes for your account.', 3600);
    } else if (op === 'digest') {
      if ((a.digests || 0) >= LIMITS.digestsPerDay) return this.refuse('digest_budget', 'That is today’s limit of digests for this account.', 3600);
    }
    /* then the account's budget of real Buffer calls */
    if (a) { const no = this.callRefusal(a, calls, now); if (no) return no; }
    if (op === 'fix') {
      const wait = this.perMinute(acct + '|fix', LIMITS.fixesPerMin);
      if (wait) return this.refuse('fix_rate', 'Too many changes in a minute.', wait);
    }
    if (op === 'scan') { a.scans++; a.lastScan = now; }
    else if (op === 'lookback') { a.lookbacks = (a.lookbacks || 0) + 1; a.lastLookback = now; }
    else if (op === 'fix') a.fixes++;
    else if (op === 'digest') a.digests = (a.digests || 0) + 1;
    if (a) { this.spend(a, calls, now); await this.saveAccount(acct, a); }
    /* hold the calls so parallel requests cannot overshoot before this operation's Buffer reply is recorded */
    const id = 'h' + (++this.holdSeq);
    this.holds.set(id, { at: now, n: calls, n0: calls, acct: a ? acct : null, day: a ? a.day : null, q15: a ? a.q15.start : null });
    if (this.holds.size > 5000) this.held();
    return { ok: true, hold: id };
  }
  /* would a sign-in be admitted now? (no reservation, no account state: lets /oauth/start say "busy" before the
     user goes through Buffer's consent screen for nothing) */
  async peekSignin() {
    const now = this.now();
    await this.loadRate();
    const [m15, m24] = LIMITS.margin.signin;
    const r15 = this.remaining(W15); const r24 = this.remaining(W24);
    if (r15 !== null && r15 - 1 < m15) return this.refuse('app_busy', 'Last Look is busy right now: Buffer’s shared request allowance for this app is nearly used.', (this.rate[W15].resetAt - now) / 1000);
    if (r24 !== null && r24 - 1 < m24) return this.refuse('app_busy_day', 'Last Look has used most of today’s shared Buffer allowance.', Math.min(this.rate[W24].resetAt - now, 3600000) / 1000);
    return { ok: true };
  }
  /* Buffer's RateLimit headers, parsed: {windows: {name: {r, t, q, w}}}. With the operation's hold id and the number
     of Buffer calls it really made: a reply with headers settles the hold (the new count includes those calls);
     without headers only the calls made stay held until the hold lapses. Calls reserved but not made go back to
     the account's budget. */
  async record(windows, hold, used) {
    await this.loadRate();
    const now = this.now();
    let changed = false;
    for (const x of Object.values(windows || {})) {
      if (!x || typeof x !== 'object') continue;
      const w = Number(x.w) || ({ '15m': W15, '24h': W24 })[x.name];
      if (w !== W15 && w !== W24) continue;
      if (!Number.isFinite(x.r) || !Number.isFinite(x.t)) continue;
      this.rate[w] = { r: x.r, resetAt: now + x.t * 1000, q: Number.isFinite(x.q) ? x.q : null };
      changed = true;
    }
    if (changed) await this.storage.put('rate', this.rate);
    const h = typeof hold === 'string' ? this.holds.get(hold) : null;
    if (h && !h.settled) {
      h.settled = true;
      const u = Number.isFinite(used) ? Math.max(0, Math.min(h.n0, Math.floor(used))) : h.n0;
      if (changed) this.holds.delete(hold); else h.n = u;
      if (h.acct && u < h.n0) {
        const a = await this.account(h.acct);
        if (a.day === h.day) a.calls = Math.max(0, (a.calls || 0) - (h.n0 - u));
        if (a.q15 && a.q15.start === h.q15) a.q15.n = Math.max(0, a.q15.n - (h.n0 - u));
        await this.saveAccount(h.acct, a);
      }
    }
    return { ok: true };
  }
  /* sign-in attempts are single-use: h = hash of the attempt's one-time value (from the sealed state) */
  async nonceSlot(slot) {
    const key = 'n:' + (((slot % 3) + 3) % 3);
    let m = this.nonces.get(key);
    if (m && m.slot === slot) return m;
    const stored = await this.storage.get(key);
    m = this.nonces.get(key);
    if (m && m.slot === slot) return m;
    m = stored && stored.slot === slot && Array.isArray(stored.list) ? { slot, list: stored.list.slice(), set: new Set(stored.list) } : { slot, list: [], set: new Set() };
    this.nonces.set(key, m);
    return m;
  }
  async useNonce(h) {
    if (typeof h !== 'string' || !/^[0-9a-f]{32}$/.test(h)) return this.refuse('bad_nonce', 'Start again.', 1);
    const slot = Math.floor(this.now() / LIMITS.nonceMs);
    const prev = await this.nonceSlot(slot - 1);
    const cur = await this.nonceSlot(slot);
    /* a value is used within the cookie's 10 minutes, so this slot and the one before cover every earlier use */
    if (cur.set.has(h) || prev.set.has(h)) return this.refuse('replayed', 'This sign-in was already used. Start again.', 1);
    cur.set.add(h); cur.list.push(h);
    if (cur.list.length > LIMITS.noncesPerSlot) for (const d of cur.list.splice(0, cur.list.length - LIMITS.noncesPerSlot)) cur.set.delete(d);
    await this.storage.put('n:' + (((slot % 3) + 3) % 3), { slot, list: cur.list });
    /* the third key holds a slot no longer needed: clear it now, and have an alarm clear the rest once they expire,
       so a hash is kept at most 30 minutes even when no further sign-ins come */
    await this.sweepNonces();
    if (typeof this.storage.setAlarm === 'function') await this.storage.setAlarm((slot + 2) * LIMITS.nonceMs + 1000);
    return { ok: true };
  }
  async sweepNonces() {
    const slot = Math.floor(this.now() / LIMITS.nonceMs);
    for (let k = 0; k < 3; k++) {
      const key = 'n:' + k;
      const stored = await this.storage.get(key);
      if (!stored || stored.slot >= slot - 1) continue;
      if (typeof this.storage.delete === 'function') await this.storage.delete(key); else await this.storage.put(key, { slot: -1, list: [] });
      this.nonces.delete(key);
    }
  }
  /* sign-in: the account's new session replaces any older one; returns the old session key to delete */
  async bind(acct, sk) {
    const a = await this.account(acct);
    if (a.signins >= LIMITS.signinsPerDay) return this.refuse('signin_budget', 'Too many sign-ins for this account today.', 3600);
    const old = a.sk && a.sk !== sk ? a.sk : null;
    a.sk = sk; a.signins++;
    this.spend(a, 1, this.now());       /* the account query this sign-in made */
    await this.saveAccount(acct, a);
    return { ok: true, old };
  }
  async unbind(acct, sk) {
    const a = await this.account(acct);
    if (a.sk === sk) { delete a.sk; await this.saveAccount(acct, a); }
    return { ok: true };
  }
  /* link checks: items [{h (url hash), site}] -> allowed flags */
  async admitLinks(acct, sk, items, digest) {
    const now = this.now();
    if (!acct || typeof acct !== 'string') return this.refuse('bad_op', 'Unknown account.', 60);
    const a = await this.account(acct);
    if (!digest && (!sk || a.sk !== sk)) return this.refuse('replaced', 'This session was replaced by a newer sign-in or was disconnected.', 1);
    const wait = this.perMinute(acct + '|links', LIMITS.linkBatchesPerMin);
    if (wait) return this.refuse('link_rate', 'Too many link checks at once.', wait);
    const out = [];
    for (const it of items) {
      const key = acct + '|' + it.h;
      const last = this.recentUrls.get(key);
      /* a digest build runs once a day per account, so it is not held back by a check the user ran a minute ago */
      if (!digest && last && now - last < LIMITS.urlGapMs) { out.push('recent'); continue; }
      if (a.links >= LIMITS.linksPerDay) { out.push('budget'); continue; }
      let s = this.sites.get(it.site);
      if (!s || s.reset < now) { s = { n: 0, reset: now + 60000 }; this.sites.set(it.site, s); }
      if (s.n >= LIMITS.sitePerMin) { out.push('site'); continue; }
      s.n++; a.links++;
      this.recentUrls.set(key, now);
      out.push('ok');
    }
    if (this.recentUrls.size > 20000) for (const [k, v] of this.recentUrls) if (now - v > LIMITS.urlGapMs) this.recentUrls.delete(k);
    if (this.sites.size > 20000) for (const [k, v] of this.sites) if (v.reset < now) this.sites.delete(k);
    await this.saveAccount(acct, a);
    return { ok: true, results: out };
  }
  async dispatch(msg) {
    switch (msg && msg.op) {
      case 'current': return this.current(msg.acct, msg.sk);
      case 'admit': return this.admit(msg.kind, msg.acct, msg.sk, Math.max(1, Math.min(10, Number(msg.calls) || 1)));
      case 'record': return this.record(msg.windows, msg.hold, Number(msg.used));
      case 'peek': return this.peekSignin();
      case 'nonce': return this.useNonce(msg.h);
      case 'bind': return this.bind(msg.acct, msg.sk);
      case 'unbind': return this.unbind(msg.acct, msg.sk);
      case 'links': return this.admitLinks(msg.acct, msg.sk, Array.isArray(msg.items) ? msg.items.slice(0, 10) : [], msg.digest === true);
      default: return { ok: false, code: 'bad_op' };
    }
  }
}

/* Durable Object wrapper (classic fetch interface, so the core runs unchanged in Node tests) */
export class Gate {
  constructor(state, env) {
    this.state = state;
    this.core = new GateCore(state.storage);
  }
  /* clears expired sign-in records (set by useNonce) */
  async alarm() { await this.core.sweepNonces(); }
  async fetch(request) {
    let msg;
    try { msg = await request.json(); } catch (e) { return new Response('{"ok":false}', { status: 400 }); }
    const out = await this.core.dispatch(msg);
    return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
  }
}

/* client side, used by the Worker */
export async function gate(env, msg) {
  const ns = env.GATE;
  const stub = ns.get(ns.idFromName('global'));
  const r = await stub.fetch('https://gate.internal/op', { method: 'POST', body: JSON.stringify(msg) });
  return r.json();
}
