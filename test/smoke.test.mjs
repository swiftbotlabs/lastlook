import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const kv = () => { const m = new Map(); return { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); }, _m: m }; };
const env = () => ({ SESSIONS: kv(), SESSION_SECRET: 'x'.repeat(48), BUFFER_CLIENT_ID: 'cid', BUFFER_CLIENT_SECRET: 'csecret' });

test('landing page renders with CSP', async () => {
  const r = await worker.fetch(new Request('https://lastlook.swiftbotlab.workers.dev/'), env());
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(await r.text(), /Connect Buffer/);
});
