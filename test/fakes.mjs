/* In-memory stand-ins for the Worker bindings: KV, the gate Durable Object (the real Gate class over a Map) */
import { Gate } from '../src/gate.js';
import { createSession, SESSION_COOKIE } from '../src/session.js';

export function kv() {
  const m = new Map();
  return { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); }, _m: m };
}
export function memStorage() {
  const m = new Map();
  return { get: async (k) => (m.has(k) ? structuredClone(m.get(k)) : undefined), put: async (k, v) => { m.set(k, structuredClone(v)); }, _m: m };
}
/* a Durable Object namespace with one real Gate instance */
export function gateNamespace() {
  const obj = new Gate({ storage: memStorage() }, {});
  const ns = {
    calls: 0,
    obj,
    idFromName: (n) => n,
    ops: [],
    get: () => ({ fetch: async (url, init) => { ns.calls++; try { const m = JSON.parse(init.body); ns.ops.push(m.op + (m.kind ? ':' + m.kind : '')); } catch (e) { /* not json */ } return obj.fetch(new Request(url, init)); } })
  };
  return ns;
}
export function makeEnv() {
  return { SESSIONS: kv(), GATE: gateNamespace(), SESSION_SECRET: 's'.repeat(32) + 'secret-for-tests', BUFFER_CLIENT_ID: 'client-id-test', BUFFER_CLIENT_SECRET: 'client-secret-test' };
}
/* what the OAuth callback does: create a session and register it as the account's live one */
export async function signIn(env, account, extra) {
  const acct = account || 'acct-hash-1';
  const { sid, sk, record } = await createSession(env, Object.assign({ at: 'access-token-test', acct, orgs: [{ id: 'org1', name: 'Org' }], name: 'Tester', canWrite: true }, extra || {}), 3600);
  const obj = env.GATE.obj;
  const r = await obj.core.bind(acct, sk);
  if (r.old) await env.SESSIONS.delete('s:' + r.old);
  return { sid, sk, csrf: record.csrf, cookie: SESSION_COOKIE + '=' + sid, acct };
}
