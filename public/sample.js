/* The /try sample: a made-up pottery studio's Buffer queue, and a local stand-in for the server.
   Nothing in this file talks to the network. The page runs the same checks (./checks/index.js) on these posts
   that it runs on a real queue; link results come from SAMPLE_LINKS below (each flag is exactly what the real
   checker's linkFlag() returns for that result; test/sample.test.mjs holds them in step).
   Send times are built relative to "now" in the studio's time zone, so every day-word check fires on any date. */
import { localParts, dayNum, fromDayNum } from './checks/time.js';

export const SAMPLE_TZ = 'America/New_York';
export const SAMPLE_BRAND = 'Little Kiln Studio';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MAX_TEXT = 30000;
const LIVE = new Set(['scheduled', 'needs_approval']);

/* the wall-clock time hh:mm on local day number n in the sample zone, as an ISO instant */
export function zoned(n, hh, mm, tz) {
  const zone = tz || SAMPLE_TZ;
  const { y, m, d } = fromDayNum(n);
  let guess = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 4; i++) {
    const p = localParts(new Date(guess), zone);
    const diff = (p.day - n) * 1440 + (p.hour * 60 + p.min) - (hh * 60 + mm);
    if (!diff) break;
    guess -= diff * 60000;
  }
  return new Date(guess).toISOString();
}
const short = (n) => { const p = fromDayNum(n); return MON[p.m - 1] + ' ' + p.d; };

export const SAMPLE_CHANNELS = [
  { id: 'kiln-x', name: 'littlekiln', displayName: 'Little Kiln (X)', service: 'twitter', type: 'profile', timezone: SAMPLE_TZ, avatar: null, isQueuePaused: false, isDisconnected: false, isLocked: false, metadata: { maxCharacters: null, subscriptionType: null } },
  { id: 'kiln-li', name: 'Little Kiln Studio', displayName: 'Little Kiln Studio (LinkedIn)', service: 'linkedin', type: 'page', timezone: SAMPLE_TZ, avatar: null, isQueuePaused: false, isDisconnected: false, isLocked: false, metadata: { maxCharacters: null, subscriptionType: null } },
  { id: 'kiln-bsky', name: 'littlekiln.example', displayName: 'Little Kiln (Bluesky)', service: 'bluesky', type: 'profile', timezone: SAMPLE_TZ, avatar: null, isQueuePaused: false, isDisconnected: false, isLocked: false, metadata: { maxCharacters: null, subscriptionType: null } },
  { id: 'kiln-ig', name: 'littlekiln', displayName: 'Little Kiln (Instagram)', service: 'instagram', type: 'business', timezone: SAMPLE_TZ, avatar: null, isQueuePaused: false, isDisconnected: false, isLocked: false, metadata: { maxCharacters: null, subscriptionType: null } }
];

const TAGS32 = '#pottery #ceramics #handmade #wheelthrown #stoneware #mugs #handmademugs #potterylove #ceramicart #clay #studiopottery #makersgonnamake #smallbatch #shopsmall #handmadeceramics #glaze #potterystudio #ceramicmug #coffeemug #tableware #kitchenware #homedecor #giftideas #craft #artisan #madebyhand #slowliving #potteryofinstagram #ceramicstudio #wheelthrowing #speckled #mugshot';
const BOWLS = 'The new speckled bowls are out of the kiln. First pick goes fast, so come by the studio or grab one online.';

/* the queue: 12 posts, every check type fires at least once */
export function sampleQueue(now) {
  const t = localParts(now || new Date(), SAMPLE_TZ);
  /* d0 = the first Monday at least two days ahead */
  let d0 = t.day + 2;
  while (fromDayNum(d0).dow !== 1) d0++;
  const written = new Date((now || new Date()).getTime() - 26 * 3600e3).toISOString();
  const live = ['updatePost', 'movePostToDraft'];
  const P = (id, channelId, service, extra) => Object.assign({
    id, channelId, channelService: service, status: 'scheduled', createdAt: written, updatedAt: written,
    shareMode: 'addToQueue', isCustomScheduled: false, schedulingType: null, allowedActions: live.slice(), publishError: null,
    assets: [], thread: [], linkAttachment: null, firstComment: null, pinUrl: null
  }, extra);
  const custom = { shareMode: 'customScheduled', isCustomScheduled: true };
  return [
    P('s-sale', 'kiln-x', 'twitter', { dueAt: zoned(d0, 9, 30), text: 'Happy Friday, makers! Our autumn glaze sale ends tomorrow: every mug, bowl and vase is 20% off until midnight. Last pieces here: https://shop.littlekiln.example/autumn-sale' }),
    P('s-hiring', 'kiln-li', 'linkedin', Object.assign({ dueAt: zoned(d0 + 1, 20, 15), text: 'Good morning, everyone! **We\'re hiring**: a part-time studio assistant to help with firing days, glazing and our weekend classes.\n\n## How to apply\nRead the role on our site: [Studio assistant](https://littlekiln.example/jobs/studio-assistant) &amp; send us three photos of your work.' }, custom)),
    P('s-taster', 'kiln-bsky', 'bluesky', Object.assign({ dueAt: zoned(d0 + 2, 19, 30), text: 'Wheel-throwing taster night is back! Doors open today at 6pm, tickets here: https://tickets.littlekiln.example/taster-night' }, custom)),
    P('s-mugs', 'kiln-ig', 'instagram', { dueAt: zoned(d0 + 3, 12, 0), text: 'Fresh out of the kiln: speckled mugs in oat, moss and midnight blue. Each one is thrown and glazed by hand, so no two are alike.\n\nShop link in bio.\n\n' + TAGS32, assets: [{ type: 'image', altText: '' }] }),
    P('s-classes', 'kiln-x', 'twitter', Object.assign({ dueAt: zoned(d0 + 4, 15, 0), text: 'Winter class schedule sneak peek! We\'re adding three new evening courses: Wheel Throwing for Beginners (6 weeks), Glaze Chemistry Made Simple (4 weeks), and Hand-Building Holiday Gifts (3 weeks). Each class is capped at eight people so everyone gets time at the wheel and one-on-one help. Full timetable: http://localhost:8080/winter-classes' }, custom)),
    P('s-market', 'kiln-bsky', 'bluesky', { dueAt: zoned(d0 + 5, 10, 0), text: 'Find us at the Riverside Makers Market on ' + short(d0 + 3) + ' with a table full of seconds and one-off pieces. Come say hi!' }),
    P('s-booking', 'kiln-li', 'linkedin', Object.assign({ dueAt: zoned(d0 + 7, 11, 0), text: 'Hi {{first_name}}, our winter class calendar is open for booking. Grab a spot before they fill up: [link] #pottery-classes #ceramics' }, custom)),
    P('s-bowls-1', 'kiln-x', 'twitter', { dueAt: zoned(d0 + 1, 9, 30), text: BOWLS }),
    P('s-bowls-2', 'kiln-x', 'twitter', { dueAt: zoned(d0 + 3, 9, 30), text: BOWLS }),
    P('s-bowls-night', 'kiln-bsky', 'bluesky', Object.assign({ dueAt: zoned(d0 + 1, 3, 10), text: BOWLS }, custom)),
    P('s-open', 'kiln-ig', 'instagram', { status: 'draft', allowedActions: ['updatePost'], dueAt: zoned(d0 + 9, 18, 0), text: 'Open studio night: join us Thursday, ' + short(d0 + 11) + ' from 6 to 9pm for tea, demos and a peek inside the kiln.' }),
    P('s-spring', 'kiln-li', 'linkedin', Object.assign({ status: 'needs_approval', dueAt: zoned(d0 + 2, 12, 30), text: 'Our spring term is now open for booking. Small classes, all materials included, and a finished piece to take home every week. Details and dates: https://littlekiln.example/classes' }, custom))
  ];
}

/* what the link checker would have answered for each sample link (the domains are reserved .example names, so
   these results are part of the sample, never fetched); flag = linkFlag(result) from src/net.js */
const LINK_FIXES = [{ type: 'edit', label: 'Replace the link' }, { type: 'draft' }];
export const SAMPLE_LINKS = {
  'https://shop.littlekiln.example/autumn-sale': {
    result: { kind: 'http', status: 404, finalUrl: 'https://shop.littlekiln.example/autumn-sale', hops: [], ms: 212 },
    flag: { check: 'links', where: 'text', data: { url: 'https://shop.littlekiln.example/autumn-sale', status: 404, finalUrl: 'https://shop.littlekiln.example/autumn-sale', kind: 'http' }, id: 'links.not_found', severity: 'high', title: 'Broken link (404 Not Found)', detail: 'https://shop.littlekiln.example/autumn-sale returns 404. Readers will land on an error page.', fixes: LINK_FIXES }
  },
  'https://littlekiln.example/jobs/studio-assistant': {
    result: { kind: 'http', status: 200, finalUrl: 'https://littlekiln.example/account/login?next=%2Fjobs%2Fstudio-assistant', hops: [{ status: 302, to: 'https://littlekiln.example/account/login?next=%2Fjobs%2Fstudio-assistant' }], ms: 341 },
    flag: { check: 'links', where: 'text', data: { url: 'https://littlekiln.example/jobs/studio-assistant', status: 200, finalUrl: 'https://littlekiln.example/account/login?next=%2Fjobs%2Fstudio-assistant', kind: 'http' }, id: 'links.login', severity: 'medium', title: 'Link lands on a sign-in page', detail: 'https://littlekiln.example/jobs/studio-assistant redirects to https://littlekiln.example/account/login?next=%2Fjobs%2Fstudio-assistant. Readers without an account hit a wall.', fixes: LINK_FIXES }
  },
  'https://tickets.littlekiln.example/taster-night': {
    result: { kind: 'refused', status: 0, finalUrl: 'https://tickets.littlekiln.example/taster-night', hops: [], ms: 38, refused: 'nxdomain', reason: 'the domain tickets.littlekiln.example does not exist' },
    flag: { check: 'links', where: 'text', data: { url: 'https://tickets.littlekiln.example/taster-night', status: 0, finalUrl: 'https://tickets.littlekiln.example/taster-night', kind: 'refused' }, id: 'links.dns', severity: 'high', title: 'Link goes nowhere: tickets.littlekiln.example does not exist', detail: 'https://tickets.littlekiln.example/taster-night: the domain tickets.littlekiln.example does not exist. Check the spelling.', fixes: LINK_FIXES }
  },
  'http://localhost:8080/winter-classes': {
    result: { kind: 'refused', status: 0, finalUrl: 'http://localhost:8080/winter-classes', hops: [], ms: 0, refused: 'private', reason: 'localhost is not a public host name' },
    flag: { check: 'links', where: 'text', data: { url: 'http://localhost:8080/winter-classes', status: 0, finalUrl: 'http://localhost:8080/winter-classes', kind: 'refused' }, id: 'links.private', severity: 'high', title: 'Link points to a private address', detail: 'http://localhost:8080/winter-classes: localhost is not a public host name. Your readers cannot open it; it only works on your own network.', fixes: LINK_FIXES }
  },
  'https://littlekiln.example/classes': {
    result: { kind: 'http', status: 200, finalUrl: 'https://littlekiln.example/classes', hops: [], ms: 187 },
    flag: null
  }
};

const clone = (x) => JSON.parse(JSON.stringify(x));
async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('');
}
function refuse(status, code, message) { const e = new Error(message); e.status = status; e.code = code; return e; }

/* A local stand-in for the Worker's /api routes, with the same guards and the same answer shapes.
   Changes live only in this object (and so only in this browser tab). */
export class SampleBackend {
  constructor(now) { this.now = now || (() => new Date()); this.reset(); }
  reset() { this.posts = sampleQueue(this.now()); this.version = 0; }
  links() {
    const seen = new Set(); const out = [];
    for (const u of Object.keys(SAMPLE_LINKS)) if (!seen.has(u)) { seen.add(u); out.push({ url: u, sig: 'sample' }); }
    return out;
  }
  async scan() {
    const ts = this.now().getTime();
    /* Buffer's scan order: by send time */
    const posts = this.posts.map((p) => Object.assign(clone(p), { ptok: 'sample' })).sort((a, c) => Date.parse(a.dueAt) - Date.parse(c.dueAt));
    return { ok: true, sample: true, channels: clone(SAMPLE_CHANNELS), posts, links: this.links(), ts, truncated: false, rateLow: false, scannedAt: new Date(ts).toISOString() };
  }
  async checkLinks(body) {
    const items = Array.isArray(body && body.items) ? body.items.slice(0, 6) : [];
    const results = [];
    for (const it of items) {
      const s = SAMPLE_LINKS[it && it.url];
      if (!s) { results.push({ url: String(it && it.url), skipped: 'not_admitted' }); continue; }
      results.push(Object.assign({ url: it.url }, clone(s.result), { hops: s.result.hops.length, flag: s.flag ? clone(s.flag) : null }));
    }
    return { ok: true, results };
  }
  /* the same checks as POST /api/fix, applied to the sample */
  async fix(body) {
    const b = body || {};
    const post = this.posts.find((p) => p.id === b.postId);
    if (!post) throw refuse(404, 'not_found', 'That post is gone. Reset the sample.');
    if (!['edit', 'draft', 'move', 'undo'].includes(b.action)) throw refuse(400, 'bad_input', 'Unknown fix.');
    if (b.confirm !== true) throw refuse(400, 'not_confirmed', 'Confirm the change first.');
    if (await sha256hex(post.text) !== b.expectedHash) throw refuse(409, 'changed', 'This post changed after your scan. Reset the sample.');
    const acts = new Set(post.allowedActions);
    const shifted = [];
    if (b.action === 'edit' || b.action === 'undo') {
      const text = typeof b.text === 'string' ? b.text.replace(/\r\n?/g, '\n') : '';
      if (!text.trim()) throw refuse(400, 'bad_input', 'The new text is empty. To pull the post, move it to drafts instead.');
      if (text.length > MAX_TEXT) throw refuse(400, 'bad_input', 'The new text is too long.');
      if (!(LIVE.has(post.status) || post.status === 'draft')) throw refuse(409, 'not_editable', 'Only queued posts and drafts can be edited here.');
      if (!acts.has('updatePost')) throw refuse(403, 'not_allowed', 'This post cannot be edited.');
      if (text === post.text) throw refuse(400, 'no_change', 'The text is unchanged.');
      post.text = text;
    } else if (b.action === 'draft') {
      if (!LIVE.has(post.status)) throw refuse(409, 'not_queued', 'Only queued posts can be moved to drafts.');
      post.status = 'draft';
      post.allowedActions = ['updatePost'];
    } else {
      if (post.status !== 'scheduled' || post.isCustomScheduled) throw refuse(409, 'not_queue', 'Only posts in queue slots can be moved in the queue. This one has its own time.');
      if (b.position !== 'top' && b.position !== 'bottom') throw refuse(400, 'bad_input', 'Pick top or bottom.');
      /* like Buffer: the queue keeps its slots, the order changes */
      const slots = this.posts.filter((p) => p.channelId === post.channelId && p.status === 'scheduled' && !p.isCustomScheduled).sort((a, c) => Date.parse(a.dueAt) - Date.parse(c.dueAt));
      const times = slots.map((p) => p.dueAt);
      const order = slots.filter((p) => p !== post);
      if (b.position === 'top') order.unshift(post); else order.push(post);
      order.forEach((p, i) => { if (p.dueAt !== times[i]) { p.dueAt = times[i]; if (p !== post) shifted.push(p); } });
    }
    post.updatedAt = this.now().toISOString();
    this.version++;
    const ts = this.now().getTime();
    const out = (p) => Object.assign(clone(p), { ptok: 'sample' });
    const links = Object.keys(SAMPLE_LINKS).filter((u) => post.text.includes(u)).map((u) => ({ url: u, sig: 'sample' }));
    return { ok: true, action: b.action, post: out(post), shifted: shifted.map(out), ts, links };
  }
}
