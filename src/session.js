/* Sessions, cookies and the crypto behind them (Web Crypto only).
   - Session id: 32 random bytes in an HttpOnly, Secure, SameSite=Lax __Host- cookie.
   - KV key: "s:" + SHA-256(session id), so the store never holds the cookie value.
   - KV value: AES-256-GCM ciphertext under a key derived (HKDF-SHA-256) from SESSION_SECRET and the session id,
     so a copy of the store alone cannot be decrypted. It holds the Buffer access token, its expiry, the CSRF token
     and the organization ids. Never post text.
   - TTL: the access token's own lifetime (Buffer: about an hour), capped at one hour. Disconnect deletes it. */

const enc = new TextEncoder();
const dec = new TextDecoder();
export const SESSION_COOKIE = '__Host-lastlook';
export const OAUTH_COOKIE = '__Host-lastlook-oauth';
export const MAX_TTL = 3600;

export function b64url(bytes) {
  let s = '';
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromB64url(str) {
  const s = String(str || '');
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length > 8192) return null;
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  try {
    const bin = atob(pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch (e) { return null; }
}
export function randomToken(n) { const b = new Uint8Array(n || 32); crypto.getRandomValues(b); return b64url(b); }
export async function sha256(str) { return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(str)))); }
export async function sha256hex(str) { return Array.from(await sha256(str), (x) => x.toString(16).padStart(2, '0')).join(''); }

/* constant-time string compare */
export function safeEqual(a, b) {
  const x = enc.encode(String(a || '')); const y = enc.encode(String(b || ''));
  if (x.length !== y.length || x.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function secretBytes(env) {
  const s = env && env.SESSION_SECRET;
  if (!s || String(s).length < 32) throw new Error('SESSION_SECRET missing or too short');
  return enc.encode(String(s));
}
async function deriveKey(env, salt, info, usage) {
  const base = await crypto.subtle.importKey('raw', secretBytes(env), 'HKDF', false, ['deriveKey']);
  const algo = usage === 'hmac' ? { name: 'HMAC', hash: 'SHA-256', length: 256 } : { name: 'AES-GCM', length: 256 };
  const uses = usage === 'hmac' ? ['sign', 'verify'] : ['encrypt', 'decrypt'];
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(salt), info: enc.encode(info) }, base, algo, false, uses);
}
export async function sealJSON(env, salt, info, obj) {
  const key = await deriveKey(env, salt, info, 'aes');
  const iv = new Uint8Array(12); crypto.getRandomValues(iv);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(info) }, key, enc.encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length); out.set(iv, 0); out.set(ct, 12);
  return b64url(out);
}
export async function openJSON(env, salt, info, sealed) {
  const raw = fromB64url(sealed);
  if (!raw || raw.length < 29) return null;
  try {
    const key = await deriveKey(env, salt, info, 'aes');
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: enc.encode(info) }, key, raw.slice(12));
    return JSON.parse(dec.decode(pt));
  } catch (e) { return null; }
}
export async function hmac(env, info, data) {
  const key = await deriveKey(env, 'lastlook-hmac', info, 'hmac');
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(String(data)))));
}

/* ---------- cookies ---------- */
export function parseCookies(request) {
  const out = {};
  const h = request.headers.get('cookie') || '';
  if (h.length > 8192) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim(); const v = part.slice(i + 1).trim();
    if (k && !(k in out)) out[k] = v;
  }
  return out;
}
export function setCookie(name, value, maxAge) {
  return name + '=' + value + '; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=' + Math.max(0, Math.floor(maxAge));
}
export const clearCookie = (name) => setCookie(name, '', 0);

/* ---------- session store ---------- */
const INFO = 'lastlook-session-v1';
const kvKey = async (sid) => 's:' + await sha256hex(sid);

export async function createSession(env, data, ttl) {
  const sid = randomToken(32);
  const life = Math.max(120, Math.min(MAX_TTL, Math.floor(ttl || MAX_TTL)));
  const record = Object.assign({}, data, { csrf: randomToken(24), created: Date.now(), exp: Date.now() + life * 1000 });
  const sealed = await sealJSON(env, sid, INFO, record);
  await env.SESSIONS.put(await kvKey(sid), sealed, { expirationTtl: Math.max(60, life) });
  return { sid, record, life };
}
export async function readSession(env, request) {
  const sid = parseCookies(request)[SESSION_COOKIE];
  if (!sid || !/^[A-Za-z0-9_-]{43}$/.test(sid)) return null;
  const sealed = await env.SESSIONS.get(await kvKey(sid));
  if (!sealed) return null;
  const record = await openJSON(env, sid, INFO, sealed);
  if (!record || typeof record.at !== 'string' || !(record.exp > Date.now())) return null;
  return { sid, record };
}
export async function deleteSession(env, sid) {
  if (!sid) return;
  await env.SESSIONS.delete(await kvKey(sid));
}
