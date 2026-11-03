/* IPv4 / IPv6 parsing and special-purpose range classification (IANA special-purpose registries).
   Pure. Adapted from Swift Bot Labs' own toolbox code. Used by the link checker to refuse private,
   loopback, link-local, metadata and other non-public addresses after DNS resolution. */
const V4_MAX = (1n << 32n) - 1n;
const V6_MAX = (1n << 128n) - 1n;

export function parseIPv4(s) {
  if (typeof s !== 'string' || s.length > 15) return null;
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return null;   /* no leading zeros: avoids octal ambiguity */
    const v = Number(p);
    if (v > 255) return null;
    n = (n << 8n) | BigInt(v);
  }
  return n;
}
export function parseIPv6(s) {
  if (typeof s !== 'string' || s.length > 45 || s.length < 2) return null;
  if (s.includes('%')) return null;                        /* zone ids are not addresses */
  let str = s.toLowerCase();
  let tailV4 = null;
  const lastColon = str.lastIndexOf(':');
  if (str.slice(lastColon + 1).includes('.')) {
    tailV4 = parseIPv4(str.slice(lastColon + 1));
    if (tailV4 === null) return null;
    str = str.slice(0, lastColon + 1) + '0:0';
  }
  const dbl = str.split('::');
  if (dbl.length > 2) return null;
  const head = dbl[0] ? dbl[0].split(':') : [];
  const tail = dbl.length === 2 ? (dbl[1] ? dbl[1].split(':') : []) : [];
  const groups = dbl.length === 2 ? head.length + tail.length : head.length;
  if (dbl.length === 1 && groups !== 8) return null;
  if (dbl.length === 2 && groups > 7) return null;
  const all = dbl.length === 2 ? [...head, ...Array(8 - groups).fill('0'), ...tail] : head;
  let n = 0n;
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  if (tailV4 !== null) n = (n & ~V4_MAX) | tailV4;
  return n;
}
export function parseIP(s) {
  const t = String(s || '').trim().replace(/^\[|\]$/g, '');
  const v4 = parseIPv4(t);
  if (v4 !== null) return { version: 4, value: v4, bits: 32 };
  const v6 = parseIPv6(t);
  if (v6 !== null) return { version: 6, value: v6, bits: 128 };
  return null;
}
export function formatIPv4(n) {
  return [24n, 16n, 8n, 0n].map((sh) => String((n >> sh) & 255n)).join('.');
}
export function expandIPv6(n) {
  const g = [];
  for (let i = 7; i >= 0; i--) g.push(((n >> BigInt(i * 16)) & 0xffffn).toString(16).padStart(4, '0'));
  return g.join(':');
}
/* RFC 5952 canonical text */
export function formatIPv6(n) {
  const g = [];
  for (let i = 7; i >= 0; i--) g.push(Number((n >> BigInt(i * 16)) & 0xffffn));
  let bestStart = -1, bestLen = 0;
  for (let i = 0; i < 8;) {
    if (g[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) { bestStart = i; bestLen = j - i; }
    i = j;
  }
  const hex = g.map((x) => x.toString(16));
  if (bestStart < 0) return hex.join(':');
  const left = hex.slice(0, bestStart).join(':');
  const right = hex.slice(bestStart + bestLen).join(':');
  return left + '::' + right;
}
export function formatIP(version, n) { return version === 4 ? formatIPv4(n) : formatIPv6(n); }

/* special-purpose ranges (IANA IPv4/IPv6 special-purpose registries) */
const V4_RANGES = [
  ['0.0.0.0/8', 'this-network'], ['10.0.0.0/8', 'private'], ['100.64.0.0/10', 'shared-cgnat'], ['127.0.0.0/8', 'loopback'],
  ['169.254.0.0/16', 'link-local'], ['172.16.0.0/12', 'private'], ['192.0.0.0/24', 'ietf-protocol'], ['192.0.2.0/24', 'documentation'],
  ['192.31.196.0/24', 'as112'], ['192.52.193.0/24', 'amt'], ['192.88.99.0/24', 'deprecated-6to4-relay'], ['192.168.0.0/16', 'private'],
  ['192.175.48.0/24', 'as112'], ['198.18.0.0/15', 'benchmarking'], ['198.51.100.0/24', 'documentation'], ['203.0.113.0/24', 'documentation'],
  ['224.0.0.0/4', 'multicast'], ['240.0.0.0/4', 'reserved'], ['255.255.255.255/32', 'broadcast']
];
const V6_RANGES = [
  ['::/128', 'unspecified'], ['::1/128', 'loopback'], ['::ffff:0:0/96', 'ipv4-mapped'], ['64:ff9b::/96', 'nat64'], ['64:ff9b:1::/48', 'nat64-local'],
  ['100::/64', 'discard'], ['2001::/32', 'teredo'], ['2001:2::/48', 'benchmarking'], ['2001:db8::/32', 'documentation'], ['2001:10::/28', 'orchid'],
  ['2001:20::/28', 'orchid-v2'], ['2002::/16', '6to4'], ['3fff::/20', 'documentation'], ['5f00::/16', 'srv6-sid'], ['fc00::/7', 'unique-local'],
  ['fe80::/10', 'link-local'], ['fec0::/10', 'site-local-deprecated'], ['ff00::/8', 'multicast'], ['::/96', 'ipv4-compatible-deprecated']
];
function compile(list, version) {
  return list.map(([c, label]) => { const p = parseCIDR(c, true); return { net: p.network, prefix: p.prefix, version, label, cidr: c }; })
    .sort((a, b) => b.prefix - a.prefix);   /* most specific first */
}
let V4C = null, V6C = null;
function inRange(value, r, bits) {
  const shift = BigInt(bits - r.prefix);
  return (value >> shift) === (r.net >> shift);
}
/* returns {scope, range, global} ; for embedded IPv4 (mapped / nat64 / 6to4) the embedded address decides */
export function classify(ip) {
  if (!V4C) { V4C = compile(V4_RANGES, 4); V6C = compile(V6_RANGES, 6); }
  if (ip.version === 4) {
    for (const r of V4C) if (inRange(ip.value, r, 32)) return { scope: r.label, range: r.cidr, global: false };
    return { scope: 'global', range: null, global: true };
  }
  for (const r of V6C) {
    if (!inRange(ip.value, r, 128)) continue;
    if (r.label === 'ipv4-mapped' || r.label === 'nat64' || r.label === 'ipv4-compatible-deprecated') {
      const inner = classify({ version: 4, value: ip.value & V4_MAX });
      return { scope: r.label, range: r.cidr, global: false, embeddedIPv4: formatIPv4(ip.value & V4_MAX), embeddedScope: inner.scope };
    }
    if (r.label === '6to4') {
      const v4 = (ip.value >> 80n) & V4_MAX;
      return { scope: r.label, range: r.cidr, global: false, embeddedIPv4: formatIPv4(v4), embeddedScope: classify({ version: 4, value: v4 }).scope };
    }
    return { scope: r.label, range: r.cidr, global: false };
  }
  /* only 2000::/3 is allocated global unicast */
  if ((ip.value >> 125n) === 1n) return { scope: 'global', range: null, global: true };
  return { scope: 'reserved', range: null, global: false };
}
export function isPublicIP(s) {
  const ip = parseIP(s);
  return !!ip && classify(ip).global;
}

function parseCIDR(s) {
  const str = String(s || '').trim();
  const slash = str.indexOf('/');
  const ip = parseIP(slash < 0 ? str : str.slice(0, slash));
  if (!ip) throw new Error('bad cidr ' + s);
  const prefix = slash >= 0 ? Number(str.slice(slash + 1)) : ip.bits;
  const hostBits = BigInt(ip.bits - prefix);
  const mask = ((1n << BigInt(ip.bits)) - 1n) ^ ((1n << hostBits) - 1n);
  return { version: ip.version, bits: ip.bits, prefix, network: ip.value & mask };
}
