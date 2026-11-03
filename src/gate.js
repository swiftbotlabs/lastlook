/* The gate: one Durable Object instance ("global") that every Buffer-spending or link-checking request asks first.
   It holds, with strong consistency:
   - the session registry: exactly one live session per Buffer account (a new sign-in replaces the old one,
     Disconnect clears it), keyed by a hash of the account id, storing only a hash of the session id;
   - the app-wide Buffer allowance, fed by the RateLimit headers of every Buffer response; new scans and fixes are
     refused when the 15-minute or 24-hour window runs low, sign-ins keep a smaller reserve;
   - per-account budgets: one scan per 60 s, 20 scans, 40 fixes, 300 link checks and 20 sign-ins per UTC day,
     10 fixes and 30 link batches per minute; one Look back per 2 minutes and 6 per day;
   - link-check limits: one check per account per URL per 60 s, 20 checks per minute per target site across all users.
   Nothing here holds post text, links in clear (URLs are hashed), tokens or session ids. */

export const LIMITS = {
  scanGapMs: 60000, lookbackGapMs: 120000,
  scansPerDay: 20, fixesPerDay: 40, linksPerDay: 300, signinsPerDay: 20, lookbacksPerDay: 6,
  fixesPerMin: 10, linkBatchesPerMin: 30,
  urlGapMs: 60000, sitePerMin: 20,
  /* keep this many requests of Buffer's per-app allowance free (15-minute window, 24-hour window) */
  margin: { scan: [20, 150], fix: [20, 150], lookback: [20, 150], signin: [5, 30] }
};
const W15 = 900, W24 = 86400;

const day = (now) => new Date(now).toISOString().slice(0, 10);

export class GateCore {
  constructor(storage, now) {
    this.storage = storage;            /* {get(key), put(key, value)} */
    this.now = now || (() => Date.now());
    this.rate = null;                  /* {900: {r, resetAt}, 86400: {r, resetAt}} */
    this.recentUrls = new Map();       /* acct + '|' + urlHash -> ts */
    this.sites = new Map();            /* site -> {n, reset} */
    this.minute = new Map();           /* acct + '|' + kind -> {n, reset} */
  }
  async account(acct) {
    const a = (await this.storage.get('a:' + acct)) || {};
    const today = day(this.now());
    if (a.day !== today) Object.assign(a, { day: today, scans: 0, fixes: 0, links: 0, signins: 0, lookbacks: 0 });
    return a;
  }
  async saveAccount(acct, a) { await this.storage.put('a:' + acct, a); }
  async loadRate() {
    if (!this.rate) this.rate = (await this.storage.get('rate')) || {};
    return this.rate;
  }
  /* remaining requests in a window, or null when unknown or already reset */
  remaining(w) {
    const x = this.rate && this.rate[w];
    if (!x || !(x.resetAt > this.now())) return null;
    return x.r;
  }
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
  /* reserve Buffer calls for an operation */
  async admit(op, acct, sk, calls) {
    const now = this.now();
    await this.loadRate();
    const margin = LIMITS.margin[op];
    if (!margin) return this.refuse('bad_op', 'Unknown operation.', 60);
    let a = null;
    if (op !== 'signin') {
      a = await this.account(acct);
      if (!sk || a.sk !== sk) return this.refuse('replaced', 'This session was replaced by a newer sign-in or was disconnected.', 1);
    }
    const r15 = this.remaining(W15); const r24 = this.remaining(W24);
    if (r15 !== null && r15 - calls < margin[0]) return this.refuse('app_busy', 'Last Look is busy right now (Buffer’s request allowance for this app is nearly used). Try again in a few minutes.', (this.rate[W15].resetAt - now) / 1000);
    if (r24 !== null && r24 - calls < margin[1]) return this.refuse('app_busy_day', 'Last Look has used most of today’s Buffer allowance. Try again later.', Math.min(this.rate[W24].resetAt - now, 3600000) / 1000);
    if (op === 'scan') {
      if (a.lastScan && now - a.lastScan < LIMITS.scanGapMs) return this.refuse('scan_gap', 'You scanned less than a minute ago.', (LIMITS.scanGapMs - (now - a.lastScan)) / 1000);
      if (a.scans >= LIMITS.scansPerDay) return this.refuse('scan_budget', 'That is today’s limit of ' + LIMITS.scansPerDay + ' scans for your account.', 3600);
      a.scans++; a.lastScan = now;
    } else if (op === 'lookback') {
      if (a.lastLookback && now - a.lastLookback < LIMITS.lookbackGapMs) return this.refuse('lookback_gap', 'You looked back less than two minutes ago.', (LIMITS.lookbackGapMs - (now - a.lastLookback)) / 1000);
      if ((a.lookbacks || 0) >= LIMITS.lookbacksPerDay) return this.refuse('lookback_budget', 'That is today’s limit of ' + LIMITS.lookbacksPerDay + ' look-backs for your account.', 3600);
      a.lookbacks = (a.lookbacks || 0) + 1; a.lastLookback = now;
    } else if (op === 'fix') {
      if (a.fixes >= LIMITS.fixesPerDay) return this.refuse('fix_budget', 'That is today’s limit of ' + LIMITS.fixesPerDay + ' fixes for your account.', 3600);
      const wait = this.perMinute(acct + '|fix', LIMITS.fixesPerMin);
      if (wait) return this.refuse('fix_rate', 'Too many changes in a minute.', wait);
      a.fixes++;
    }
    if (a) await this.saveAccount(acct, a);
    /* reserve the calls so parallel requests cannot overshoot before the next headers arrive */
    for (const w of [W15, W24]) if (this.remaining(w) !== null) this.rate[w].r -= calls;
    return { ok: true };
  }
  /* Buffer's RateLimit headers, parsed: {windows: {name: {r, t, q, w}}} */
  async record(windows) {
    await this.loadRate();
    const now = this.now();
    let changed = false;
    for (const x of Object.values(windows || {})) {
      const w = Number(x.w) || ({ '15m': W15, '24h': W24 })[x.name];
      if (w !== W15 && w !== W24) continue;
      if (!Number.isFinite(x.r) || !Number.isFinite(x.t)) continue;
      this.rate[w] = { r: x.r, resetAt: now + x.t * 1000, q: Number.isFinite(x.q) ? x.q : null };
      changed = true;
    }
    if (changed) await this.storage.put('rate', this.rate);
    return { ok: true };
  }
  /* sign-in: the account's new session replaces any older one; returns the old session key to delete */
  async bind(acct, sk) {
    const a = await this.account(acct);
    if (a.signins >= LIMITS.signinsPerDay) return this.refuse('signin_budget', 'Too many sign-ins for this account today.', 3600);
    const old = a.sk && a.sk !== sk ? a.sk : null;
    a.sk = sk; a.signins++;
    await this.saveAccount(acct, a);
    return { ok: true, old };
  }
  async unbind(acct, sk) {
    const a = await this.account(acct);
    if (a.sk === sk) { delete a.sk; await this.saveAccount(acct, a); }
    return { ok: true };
  }
  /* link checks: items [{h (url hash), site}] -> allowed flags */
  async admitLinks(acct, sk, items) {
    const now = this.now();
    const a = await this.account(acct);
    if (!sk || a.sk !== sk) return this.refuse('replaced', 'This session was replaced by a newer sign-in or was disconnected.', 1);
    const wait = this.perMinute(acct + '|links', LIMITS.linkBatchesPerMin);
    if (wait) return this.refuse('link_rate', 'Too many link checks at once.', wait);
    const out = [];
    for (const it of items) {
      const key = acct + '|' + it.h;
      const last = this.recentUrls.get(key);
      if (last && now - last < LIMITS.urlGapMs) { out.push('recent'); continue; }
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
      case 'record': return this.record(msg.windows);
      case 'bind': return this.bind(msg.acct, msg.sk);
      case 'unbind': return this.unbind(msg.acct, msg.sk);
      case 'links': return this.admitLinks(msg.acct, msg.sk, Array.isArray(msg.items) ? msg.items.slice(0, 10) : []);
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
