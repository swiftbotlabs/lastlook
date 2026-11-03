// Live-DNS positive control for the SSRF guard: real DNS-over-HTTPS answers, a spy instead of the page fetch.
// localtest.me and 127.0.0.1.nip.io resolve to 127.0.0.1 in public DNS; buffer.com resolves to public addresses.
import { checkLink, _clearDnsCache } from '../src/net.js';
const seen = [];
const spyFetch = async (url, init) => { seen.push(init.method + ' ' + url); return new Response(null, { status: 200 }); };
for (const u of ['http://localtest.me/admin', 'http://127.0.0.1.nip.io/', 'https://buffer.com/']) {
  _clearDnsCache();
  const before = seen.length;
  const r = await checkLink(u, { spend: () => {}, timeoutMs: 8000, fetch: spyFetch });
  console.log(u, '->', r.kind, r.refused || '', r.reason || '', '| page requests made:', seen.length - before);
}
