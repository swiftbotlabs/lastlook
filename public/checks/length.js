/* Check 4: text longer than the channel allows.

   Limits and counting rules come from Buffer's own documentation, because Buffer validates posts against them:
   Buffer API guide "Character Limits", https://developers.buffer.com/guides/character-limits.md
   (mirrored 2026-11-03), table "Limit per network" and "How Buffer counts characters":
     Facebook 5,000 · Instagram 2,196 (first comment 2,200) · X Free 280 / X Basic, Premium, Premium+ 25,000 ·
     LinkedIn 3,000 (first comment 1,250) · Pinterest 500 · TikTok 4,000, or 2,200 with a video · Threads 500 ·
     Bluesky 300 · YouTube description 5,000 · Google Business Profiles 4,000 · Mastodon: the server's limit,
     500 by default, read from MastodonMetadata.maxCharacters (Buffer caps it at 20,000) · Substack 10,000.
   Counting:
     most networks: UTF-16 code units (JavaScript string length)
     LinkedIn: UTF-16, every URL counts as 24
     Instagram: UTF-16, every line break counts as 2
     Mastodon: UTF-16, URLs count as 23, the server part of an @user@server mention is not counted
     X: X's weighted count (URLs 23, emoji 2): twitter-text v3 configuration, https://github.com/twitter/twitter-text
        (config/v3.json: scale 100, defaultWeight 200, transformedURLLength 23, weight 100 for code points
        0-4351, 8192-8205, 8208-8223, 8242-8247, emojiParsingEnabled true)
     Bluesky: graphemes; a URL counts as its host plus up to 16 more characters (Buffer guide), which matches the
        Bluesky app's short link display (bluesky-social/social-app src/lib/strings/url-helpers.ts toShortUrl:
        host + path, and when the path is longer than 15 characters, host + first 13 + "...").
*/
import { graphemes, findUrls, isEmojiGrapheme } from './text.js';

export const LIMITS = {
  facebook: 5000, instagram: 2196, twitter: 280, linkedin: 3000, pinterest: 500, tiktok: 4000,
  threads: 500, bluesky: 300, youtube: 5000, googlebusiness: 4000, mastodon: 500, substack: 10000
};
export const FIRST_COMMENT_LIMITS = { linkedin: 1250, instagram: 2200, facebook: 5000 };
const TWITTER_PREMIUM = 25000;
const TIKTOK_VIDEO = 2200;
const MASTODON_CAP = 20000;

export const SERVICE_NAMES = {
  facebook: 'Facebook', instagram: 'Instagram', twitter: 'X', linkedin: 'LinkedIn', pinterest: 'Pinterest', tiktok: 'TikTok',
  threads: 'Threads', bluesky: 'Bluesky', youtube: 'YouTube', googlebusiness: 'Google Business Profile', mastodon: 'Mastodon',
  substack: 'Substack', whatsapp: 'WhatsApp', startPage: 'Start Page'
};

/* the limit that applies to this channel and post */
export function limitFor(service, channel, post) {
  if (service === 'twitter') {
    const sub = channel && channel.metadata && channel.metadata.subscriptionType;
    if (sub && /basic|premium|plus|blue|verified/i.test(String(sub))) return TWITTER_PREMIUM;
    return LIMITS.twitter;
  }
  if (service === 'mastodon') {
    const m = channel && channel.metadata && Number(channel.metadata.maxCharacters);
    if (Number.isFinite(m) && m > 0) return Math.min(m, MASTODON_CAP);
    return LIMITS.mastodon;
  }
  if (service === 'tiktok' && post && Array.isArray(post.assets) && post.assets.some((a) => a && a.type === 'video')) return TIKTOK_VIDEO;
  return LIMITS[service] || null;
}

function utf16WithUrlWeight(text, urlWeight) {
  const s = String(text || '');
  let n = s.length;
  for (const u of findUrls(s)) n += urlWeight - (u.end - u.start);
  return n;
}

/* X weighted length (twitter-text v3) */
function inRange(cp) {
  return (cp >= 0 && cp <= 4351) || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247);
}
export function twitterLength(text) {
  const s = String(text || '').normalize('NFC');
  const urls = findUrls(s);
  let weight = 0;
  let pos = 0;
  const parts = [];
  for (const u of urls) { parts.push(s.slice(pos, u.start)); weight += 23 * 100; pos = u.end; }
  parts.push(s.slice(pos));
  for (const part of parts) {
    for (const g of graphemes(part)) {
      if (isEmojiGrapheme(g)) { weight += 200; continue; }
      for (const ch of g) weight += inRange(ch.codePointAt(0)) ? 100 : 200;
    }
  }
  return Math.ceil(weight / 100);
}

/* Bluesky: graphemes, links counted as their short display form */
export function blueskyShortUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return url;
    const path = (u.pathname === '/' ? '' : u.pathname) + u.search + u.hash;
    if (path.length > 15) return u.host + path.slice(0, 13) + '...';
    return u.host + path;
  } catch (e) { return url; }
}
export function blueskyLength(text) {
  const s = String(text || '');
  let n = 0;
  let pos = 0;
  for (const u of findUrls(s)) {
    n += graphemes(s.slice(pos, u.start)).length + graphemes(blueskyShortUrl(u.url)).length;
    pos = u.end;
  }
  return n + graphemes(s.slice(pos)).length;
}

export function mastodonLength(text) {
  let s = String(text || '');
  /* @user@server.example -> only @user counts */
  s = s.replace(/(^|[^\w@])(@[A-Za-z0-9_]+)@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '$1$2');
  return utf16WithUrlWeight(s, 23);
}

export function lengthFor(service, text) {
  const s = String(text || '');
  switch (service) {
    case 'twitter': return twitterLength(s);
    case 'bluesky': return blueskyLength(s);
    case 'linkedin': return utf16WithUrlWeight(s, 24);
    case 'mastodon': return mastodonLength(s);
    case 'instagram': return s.length + (s.match(/\r\n|\n|\r/g) || []).length;
    default: return s.length;
  }
}

/* how the count works, in plain words, for the flag detail */
export function countingNote(service) {
  switch (service) {
    case 'twitter': return 'X counts every link as 23 and most emoji as 2.';
    case 'bluesky': return 'Bluesky counts characters as you see them; links count as their short form.';
    case 'linkedin': return 'LinkedIn counts every link as 24.';
    case 'instagram': return 'Instagram counts each line break as 2.';
    case 'mastodon': return 'Mastodon counts links as 23.';
    default: return 'Emoji and styled (bold/italic) letters count as 2.';
  }
}

/* returns a list of flags for one post */
export function checkLength(post, channel) {
  const service = (channel && channel.service) || post.channelService;
  const limit = limitFor(service, channel, post);
  const flags = [];
  if (!limit) return flags;
  const name = SERVICE_NAMES[service] || service;
  const items = post.thread && post.thread.length > 1 ? post.thread.map((t, i) => ({ text: t.text, where: 'thread:' + i })) : [{ text: post.text, where: 'text' }];
  for (const it of items) {
    const n = lengthFor(service, it.text);
    if (n > limit) {
      const over = n - limit;
      flags.push({
        check: 'length', id: 'length.over', severity: 'high', where: it.where,
        title: 'Too long for ' + name + ' by ' + over,
        detail: name + ' allows ' + limit.toLocaleString('en-US') + ' and this ' + (it.where === 'text' ? 'post' : 'thread part') + ' counts ' + n.toLocaleString('en-US') + '. ' + countingNote(service) + ' Buffer will refuse to send it as it is.',
        data: { count: n, limit, service },
        fixes: it.where === 'text' ? [{ type: 'edit', label: 'Shorten it' }, { type: 'draft' }] : [{ type: 'draft' }]
      });
    }
  }
  const fc = post.firstComment;
  const fcl = FIRST_COMMENT_LIMITS[service];
  if (fc && fcl) {
    const n = service === 'linkedin' ? utf16WithUrlWeight(fc, 24) : String(fc).length;
    if (n > fcl) flags.push({
      check: 'length', id: 'length.first_comment', severity: 'high', where: 'firstComment',
      title: 'First comment too long by ' + (n - fcl),
      detail: name + ' allows ' + fcl.toLocaleString('en-US') + ' in a first comment; this one counts ' + n.toLocaleString('en-US') + '.',
      data: { count: n, limit: fcl, service }, fixes: [{ type: 'draft' }]
    });
  }
  return flags;
}
