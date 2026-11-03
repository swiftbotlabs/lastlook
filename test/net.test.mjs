/* SSRF guard and link checker. Every refusal test has a positive control: the same harness with a public
   address DOES reach fetch, so "fetch was not called" really means the guard stopped it. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkShape, checkLink, linkFlag, Refused, _clearDnsCache, siteOf } from '../src/net.js';

function harness(dns, responses) {
  const calls = [];
  const deps = {
    selfHost: 'lastlook.swiftbotlab.workers.dev', timeoutMs: 3000,
    spend: () => {},
    doh: async (name, type) => {
      const rec = dns[name];
      if (!rec) return { status: 3, addrs: [] };
      return { status: 0, addrs: rec.filter((a) => (type === 'A' ? !a.includes(':') : a.includes(':'))) };
    },
    fetch: async (url, init) => {
      calls.push({ url, method: init.method });
      const r = typeof responses === 'function' ? responses(url, init) : responses[url];
      if (!r) return new Response(null, { status: 200 });
      if (r === 'hang') return new Promise((res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
      return new Response(null, { status: r.status, headers: r.location ? { location: r.location } : {} });
    }
  };
  return { deps, calls };
}

test('shape: private and special addresses are refused without any network', () => {
  for (const u of ['http://127.0.0.1/', 'http://10.0.0.5/admin', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
    'http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://100.64.0.1/', 'http://[fd00::1]/', 'http://192.168.1.1:8080/']) {
    assert.throws(() => checkShape(u), (e) => e instanceof Refused && e.kind === 'private', u);
  }
  for (const u of ['http://localhost/', 'http://printer.local/', 'http://db.internal/', 'http://intranet/', 'http://metadata.google.internal/']) {
    assert.throws(() => checkShape(u), (e) => e instanceof Refused && e.kind === 'private', u);
  }
  assert.throws(() => checkShape('ftp://example.org/'), (e) => e.kind === 'scheme');
  assert.throws(() => checkShape('https://user:pw@example.org/'), (e) => e.kind === 'credentials');
  assert.throws(() => checkShape('http://example.org:22/'), (e) => e.kind === 'port');
  assert.throws(() => checkShape('https://lastlook.swiftbotlab.workers.dev/api/scan', 'lastlook.swiftbotlab.workers.dev'), (e) => e.kind === 'self');
  assert.equal(checkShape('https://8.8.8.8/').ip, true);
  assert.equal(checkShape('https://buffer.com:443/x').host, 'buffer.com');
});

test('SSRF positive control: a public name is fetched, the same name pointing at 127.0.0.1 is not', async () => {
  _clearDnsCache();
  const pub = harness({ 'good.example.net': ['93.184.215.14'] }, {});
  const ok = await checkLink('https://good.example.net/page', pub.deps);
  assert.equal(ok.kind, 'http');
  assert.equal(ok.status, 200);
  assert.equal(pub.calls.length, 1, 'control: the harness does reach fetch for a public address');

  _clearDnsCache();
  const priv = harness({ 'good.example.net': ['127.0.0.1'] }, {});
  const bad = await checkLink('https://good.example.net/page', priv.deps);
  assert.equal(bad.kind, 'refused');
  assert.equal(bad.refused, 'private');
  assert.equal(priv.calls.length, 0, 'guard: no request was made');
});

test('SSRF: one private address among public ones is enough to refuse (IPv6 too)', async () => {
  _clearDnsCache();
  const h = harness({ 'mixed.example.net': ['93.184.215.14', 'fd00::5'] }, {});
  const r = await checkLink('https://mixed.example.net/', h.deps);
  assert.equal(r.refused, 'private');
  assert.equal(h.calls.length, 0);
});

test('SSRF: a redirect to a private address is refused at that hop', async () => {
  _clearDnsCache();
  const h = harness({ 'pub.example.net': ['93.184.215.14'], 'rebind.example.net': ['10.1.2.3'] }, {
    'https://pub.example.net/go': { status: 302, location: 'http://rebind.example.net/admin' }
  });
  const r = await checkLink('https://pub.example.net/go', h.deps);
  assert.equal(r.kind, 'refused');
  assert.equal(r.refused, 'private');
  assert.deepEqual(h.calls.map((c) => c.url), ['https://pub.example.net/go']);
  _clearDnsCache();
  const h2 = harness({ 'pub.example.net': ['93.184.215.14'] }, { 'https://pub.example.net/go': { status: 301, location: 'http://169.254.169.254/latest/' } });
  assert.equal((await checkLink('https://pub.example.net/go', h2.deps)).refused, 'private');
  assert.equal(h2.calls.length, 1);
});

test('link results: 404, HEAD refused then GET ok, NXDOMAIN, timeout, loops', async () => {
  _clearDnsCache();
  const dns = { 'site.example.net': ['93.184.215.14'] };
  let h = harness(dns, { 'https://site.example.net/missing': { status: 404 } });
  let r = await checkLink('https://site.example.net/missing', h.deps);
  assert.deepEqual([r.kind, r.status], ['http', 404]);
  assert.deepEqual(h.calls.map((c) => c.method), ['HEAD', 'GET']);
  assert.equal(linkFlag(r).id, 'links.not_found');

  h = harness(dns, (url, init) => (init.method === 'HEAD' ? { status: 405 } : { status: 200 }));
  r = await checkLink('https://site.example.net/ok', h.deps);
  assert.equal(r.status, 200);
  assert.equal(linkFlag(r), null);

  h = harness({}, {});
  r = await checkLink('https://nope.example.net/', h.deps);
  assert.equal(r.refused, 'nxdomain');
  assert.equal(linkFlag(r).id, 'links.dns');

  h = harness(dns, () => 'hang');
  h.deps.timeoutMs = 300;
  r = await checkLink('https://site.example.net/slow', h.deps);
  assert.equal(r.kind, 'timeout');
  assert.equal(linkFlag(r).id, 'links.timeout');

  h = harness(dns, (url) => ({ status: 302, location: url + 'x' }));
  r = await checkLink('https://site.example.net/a', h.deps);
  assert.equal(r.kind, 'too_many_redirects');
  assert.equal(linkFlag(r).id, 'links.redirect_loop');
});

test('link flags: blocked checker is low, short links and off-site redirects are notes, 5xx is medium', () => {
  assert.equal(linkFlag({ url: 'https://x.org', kind: 'http', status: 403, hops: [], finalUrl: 'https://x.org' }).severity, 'low');
  assert.equal(linkFlag({ url: 'https://x.org', kind: 'http', status: 503, hops: [], finalUrl: 'https://x.org' }).severity, 'medium');
  assert.equal(linkFlag({ url: 'https://bit.ly/abc', kind: 'http', status: 200, hops: [{}], finalUrl: 'https://shop.org/p' }).id, 'links.short');
  assert.equal(linkFlag({ url: 'https://old.org/p', kind: 'http', status: 200, hops: [{}], finalUrl: 'https://parked.example/' }).id, 'links.offsite');
  assert.equal(linkFlag({ url: 'http://x.org/p', kind: 'http', status: 200, hops: [{}], finalUrl: 'https://www.x.org/p' }), null);
  assert.equal(linkFlag({ url: 'https://x.org/doc', kind: 'http', status: 200, hops: [{}], finalUrl: 'https://x.org/login?next=/doc' }).id, 'links.login');
  assert.equal(siteOf('a.b.example.co.uk'), 'example.co.uk');
});
