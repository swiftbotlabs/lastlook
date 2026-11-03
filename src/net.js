/* Link checker with an SSRF guard.
   Rules for every hop (the first URL and every redirect):
   - http and https only, default ports (80, 443) plus 8080 and 8443, no user:password in the URL
   - IP-literal hosts must be public unicast; internal-looking names (localhost, *.local, *.internal ...) are refused
   - the hostname is resolved first with DNS-over-HTTPS (A and AAAA) and EVERY address must be public unicast,
     so names that point at 127.0.0.1, 10.x, 169.254.169.254 (cloud metadata), fc00::/7 etc. are refused
   - redirects are followed by hand, at most 5, each one checked again
   - HEAD first, GET only when HEAD is refused; no cookies, no caller headers; time cap per URL; the body is never
     read beyond a few kilobytes and never returned
   The Worker runtime adds its own layer (Workers cannot reach private networks), but the guard does not rely on it.
   Residual risk, documented in SECURITY.md: DNS can change between our lookup and the platform's (rebinding); the
   platform layer is what covers that window. */
import { parseIP, classify } from './ip.js';

export const UA = 'Mozilla/5.0 (compatible; LastLook/1.0; +https://lastlook.swiftbotlab.workers.dev/about)';
const BLOCKED_NAMES = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|private|onion|test|invalid|example|home\.arpa|in-addr\.arpa|ip6\.arpa|metadata|metadata\.google\.internal)$/i;
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);
const MAX_URL = 2048;

export class Refused extends Error { constructor(kind, msg) { super(msg); this.kind = kind; } }

/* shape check without network. returns {url, host, ip} or throws Refused */
export function checkShape(raw, selfHost) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (e) { throw new Refused('invalid', 'not a valid link'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Refused('scheme', 'only http and https links are checked');
  if (u.username || u.password) throw new Refused('credentials', 'link contains a user name or password');
  if (!ALLOWED_PORTS.has(u.port)) throw new Refused('port', 'unusual port ' + u.port + ', not checked');
  if (u.href.length > MAX_URL) throw new Refused('too_long', 'link is longer than ' + MAX_URL + ' characters');
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const ip = parseIP(host);
  if (ip) {
    const c = classify(ip);
    if (!c.global) throw new Refused('private', host + ' is a ' + c.scope + ' address');
    return { url: u, host, ip: true };
  }
  if (!host.includes('.') || BLOCKED_NAMES.test(host)) throw new Refused('private', host.slice(0, 80) + ' is not a public host name');
  if (selfHost && (host === selfHost || host.endsWith('.' + selfHost))) throw new Refused('self', 'links to this site are not fetched');
  return { url: u, host, ip: false };
}

/* DNS over HTTPS with a tiny per-isolate cache */
const dnsCache = new Map();
export async function resolve(host, deps) {
  const key = host;
  const hit = dnsCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.v;
  const doh = deps.doh || defaultDoh;
  const [a, aaaa] = await Promise.all([doh(host, 'A', deps), doh(host, 'AAAA', deps)]);
  const v = { status: a.status === 0 || aaaa.status === 0 ? 0 : a.status, addrs: [...a.addrs, ...aaaa.addrs] };
  if (dnsCache.size > 500) dnsCache.clear();
  dnsCache.set(key, { v, exp: Date.now() + 30000 });
  return v;
}
async function defaultDoh(name, type, deps) {
  deps.spend(1);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 4000);
  try {
    const r = await fetch('https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(name) + '&type=' + type, { headers: { accept: 'application/dns-json' }, signal: ctl.signal });
    if (r.status !== 200) throw new Error('doh status ' + r.status);
    const text = await r.text();
    if (text.length > 65536) throw new Error('doh too large');
    const j = JSON.parse(text);
    const want = type === 'A' ? 1 : 28;
    const addrs = (Array.isArray(j.Answer) ? j.Answer : []).filter((x) => x && x.type === want).map((x) => String(x.data)).slice(0, 32);
    return { status: Number(j.Status), addrs };
  } finally { clearTimeout(t); }
}
export function _clearDnsCache() { dnsCache.clear(); }

/* every address public, else Refused */
export async function resolvePublic(host, deps) {
  const r = await resolve(host, deps);
  if (r.status === 3) throw new Refused('nxdomain', 'the domain ' + host.slice(0, 80) + ' does not exist');
  if (!r.addrs.length) throw new Refused('dns', 'the domain ' + host.slice(0, 80) + ' has no address');
  for (const a of r.addrs) {
    const ip = parseIP(a);
    if (!ip || !classify(ip).global) throw new Refused('private', host.slice(0, 80) + ' points to a private address (' + (ip ? classify(ip).scope : 'unknown') + ')');
  }
  return r.addrs;
}

async function oneRequest(url, method, deps, msLeft) {
  deps.spend(1);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), Math.max(500, msLeft));
  try {
    const res = await (deps.fetch || fetch)(url, { method, redirect: 'manual', signal: ctl.signal, headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'en' } });
    try { if (res.body) await res.body.cancel(); } catch (e) { /* closed */ }
    return { status: res.status, location: res.headers.get('location') };
  } catch (e) {
    if (ctl.signal.aborted) return { status: 0, error: 'timeout' };
    return { status: 0, error: 'connect' };
  } finally { clearTimeout(t); }
}

/* check one link. deps: {fetch, doh, spend(n), selfHost, timeoutMs}. Never throws; returns a result object */
export async function checkLink(raw, deps) {
  const t0 = Date.now();
  const timeout = deps.timeoutMs || 8000;
  const hops = [];
  let current = raw;
  try {
    for (let hop = 0; hop <= 5; hop++) {
      const { url, host, ip } = checkShape(current, deps.selfHost);
      if (!ip) await resolvePublic(host, deps);
      const left = timeout - (Date.now() - t0);
      if (left <= 0) return result(raw, 'timeout', 0, url.href, hops, t0);
      let r = await oneRequest(url.href, 'HEAD', deps, left);
      /* many servers refuse HEAD; ask again with GET before calling a link broken */
      if (r.status === 0 && r.error === 'timeout') return result(raw, 'timeout', 0, url.href, hops, t0);
      if (r.status === 0 || r.status === 405 || r.status === 501 || r.status >= 400) {
        const left2 = timeout - (Date.now() - t0);
        if (left2 > 300) {
          const g = await oneRequest(url.href, 'GET', deps, left2);
          if (g.status !== 0 || r.status === 0) r = g;
        }
      }
      if (r.status === 0) return result(raw, r.error === 'timeout' ? 'timeout' : 'connect', 0, url.href, hops, t0);
      if (r.status >= 300 && r.status < 400 && r.location) {
        let next;
        try { next = new URL(r.location, url).href; } catch (e) { return result(raw, 'bad_redirect', r.status, url.href, hops, t0); }
        hops.push({ status: r.status, to: next.slice(0, 300) });
        if (!/^https?:/i.test(next)) return result(raw, 'ok', r.status, next, hops, t0);
        current = next;
        continue;
      }
      return result(raw, 'http', r.status, url.href, hops, t0);
    }
    return result(raw, 'too_many_redirects', 0, current, hops, t0);
  } catch (e) {
    if (e instanceof Refused) return Object.assign(result(raw, 'refused', 0, current, hops, t0), { refused: e.kind, reason: e.message });
    if (e && e.message === 'budget') return result(raw, 'unchecked', 0, current, hops, t0);
    return Object.assign(result(raw, 'unchecked', 0, current, hops, t0), { reason: 'could not complete the check' });
  }
}
function result(url, kind, status, finalUrl, hops, t0) {
  return { url, kind, status, finalUrl: String(finalUrl || '').slice(0, 500), hops, ms: Date.now() - t0 };
}

/* ---- turning a result into a flag (pure) ---- */
const SHORTENERS = /(^|\.)(bit\.ly|buff\.ly|t\.co|tinyurl\.com|ow\.ly|goo\.gl|lnkd\.in|rb\.gy|is\.gd|cutt\.ly|shorturl\.at|t\.ly|dub\.sh|bl\.ink|rebrand\.ly|amzn\.to|youtu\.be|fb\.me|trib\.al|spoti\.fi|apple\.co)$/i;
const TWO_LEVEL = /\.(co|com|net|org|gov|ac|edu)\.[a-z]{2}$/i;
export function siteOf(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  return TWO_LEVEL.test(h) ? parts.slice(-3).join('.') : parts.slice(-2).join('.');
}
function hostOf(u) { try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; } }

export function linkFlag(res) {
  const shown = String(res.url).slice(0, 120);
  const base = { check: 'links', where: 'text', data: { url: res.url, status: res.status, finalUrl: res.finalUrl, kind: res.kind } };
  const fixes = [{ type: 'edit', label: 'Replace the link' }, { type: 'draft' }];
  if (res.kind === 'refused') {
    if (res.refused === 'private' || res.refused === 'credentials') return Object.assign(base, { id: 'links.private', severity: 'high', title: 'Link points to a private address', detail: shown + ': ' + res.reason + '. Your readers cannot open it; it only works on your own network.', fixes });
    if (res.refused === 'nxdomain' || res.refused === 'dns') return Object.assign(base, { id: 'links.dns', severity: 'high', title: 'Link goes nowhere: ' + res.reason.replace(/^the domain /, ''), detail: shown + ': ' + res.reason + '. Check the spelling.', fixes });
    return Object.assign(base, { id: 'links.unchecked', severity: 'low', title: 'Link not checked', detail: shown + ': ' + res.reason + '.', fixes: [] });
  }
  if (res.kind === 'timeout') return Object.assign(base, { id: 'links.timeout', severity: 'medium', title: 'Link did not answer', detail: shown + ' gave no answer within 8 seconds. The site may be down or very slow.', fixes });
  if (res.kind === 'connect') return Object.assign(base, { id: 'links.connect', severity: 'medium', title: 'Could not connect to the link', detail: shown + ' refused the connection or has a broken certificate.', fixes });
  if (res.kind === 'too_many_redirects' || res.kind === 'bad_redirect') return Object.assign(base, { id: 'links.redirect_loop', severity: 'high', title: 'Link redirects in circles', detail: shown + ' keeps redirecting and never lands on a page.', fixes });
  if (res.kind === 'unchecked') return Object.assign(base, { id: 'links.unchecked', severity: 'low', title: 'Link not checked yet', detail: shown + ': ' + (res.reason || 'the check did not finish') + '. Run the check again.', fixes: [] });
  if (res.kind === 'http') {
    const s = res.status;
    if (s === 404 || s === 410) return Object.assign(base, { id: 'links.not_found', severity: 'high', title: 'Broken link (' + s + (s === 404 ? ' Not Found' : ' Gone') + ')', detail: shown + (res.hops.length ? ' redirects to ' + String(res.finalUrl).slice(0, 120) + ', which' : '') + ' returns ' + s + '. Readers will land on an error page.', fixes });
    if (s >= 500) return Object.assign(base, { id: 'links.server_error', severity: 'medium', title: 'Link returns a server error (' + s + ')', detail: shown + ' answered ' + s + ' just now. It may be a short outage; check again before it posts.', fixes });
    if (s === 401 || s === 403 || s === 429 || s === 999) return Object.assign(base, { id: 'links.blocked', severity: 'low', title: 'Site would not let the checker in (' + s + ')', detail: shown + ' blocks automated checks. It is probably fine; open it once to be sure.', fixes: [] });
    if (s >= 400) return Object.assign(base, { id: 'links.client_error', severity: 'high', title: 'Link returns an error (' + s + ')', detail: shown + ' answers ' + s + '. Readers will see an error page.', fixes });
    /* 2xx: look at where it ended up */
    const from = hostOf(res.url); const to = hostOf(res.finalUrl);
    if (res.hops.length && to && siteOf(from) !== siteOf(to)) {
      if (SHORTENERS.test(from)) return Object.assign(base, { id: 'links.short', severity: 'low', title: 'Short link opens ' + to, detail: shown + ' leads to ' + String(res.finalUrl).slice(0, 160) + '. Make sure that is the page you meant.', fixes: [] });
      return Object.assign(base, { id: 'links.offsite', severity: 'low', title: 'Link now redirects to ' + to, detail: shown + ' ends up at ' + String(res.finalUrl).slice(0, 160) + '. If you did not expect that site, the page may have moved or the domain changed hands.', fixes });
    }
    if (res.hops.length && /\/(login|log-in|signin|sign-in|auth|account\/login|sso)\b/i.test(String(res.finalUrl))) return Object.assign(base, { id: 'links.login', severity: 'medium', title: 'Link lands on a sign-in page', detail: shown + ' redirects to ' + String(res.finalUrl).slice(0, 160) + '. Readers without an account hit a wall.', fixes });
    return null;
  }
  return null;
}
