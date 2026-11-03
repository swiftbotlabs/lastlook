/* Buffer GraphQL API client (https://api.buffer.com). Every call carries the user's OAuth access token.
   Request budget: one call per scan page (channels + posts together), two per fix (re-read + mutation).
   Rate-limit headers are read on every response so the app slows down before Buffer has to say no. */

export const API = 'https://api.buffer.com';
const TIMEOUT_MS = 15000;
const MAX_BODY = 4 * 1024 * 1024;

export class BufferError extends Error {
  constructor(kind, message, extra) { super(message); this.kind = kind; Object.assign(this, extra || {}); }
}

/* RateLimit: "15m"; r=144; t=374, "24h"; r=594; t=85874 ...  (fetch joins repeated headers with ", ") */
export function parseRate(headers) {
  const live = String(headers.get('ratelimit') || '');
  const pol = String(headers.get('ratelimit-policy') || '');
  const windows = {};
  for (const part of live.split(/,\s*(?=")/)) {
    const name = (part.match(/"([^"]+)"/) || [])[1];
    if (!name) continue;
    windows[name] = { r: Number((part.match(/\br=(\d+)/) || [])[1]), t: Number((part.match(/\bt=(\d+)/) || [])[1]) };
  }
  for (const part of pol.split(/,\s*(?=")/)) {
    const name = (part.match(/"([^"]+)"/) || [])[1];
    if (!name || !windows[name]) continue;
    windows[name].q = Number((part.match(/\bq=(\d+)/) || [])[1]);
    windows[name].w = Number((part.match(/\bw=(\d+)/) || [])[1]);
  }
  let low = null;
  for (const [name, w] of Object.entries(windows)) {
    if (!Number.isFinite(w.r)) continue;
    const ratio = Number.isFinite(w.q) && w.q > 0 ? w.r / w.q : null;
    if (w.r < 3 || (ratio !== null && ratio < 0.05)) { if (!low || w.t > low.t) low = { name, r: w.r, t: w.t }; }
  }
  return { windows, low };
}

async function readCapped(res) {
  const reader = res.body && res.body.getReader();
  if (!reader) return '';
  const chunks = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MAX_BODY) { try { await reader.cancel(); } catch (e) { /* ignore */ } throw new BufferError('upstream', 'Buffer sent an unexpectedly large response'); }
    chunks.push(value);
  }
  const out = new Uint8Array(n); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return new TextDecoder().decode(out);
}

export async function gql(token, query, variables, deps) {
  const f = (deps && deps.fetch) || fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await f(API, {
      method: 'POST', signal: ctl.signal, redirect: 'manual',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'LastLook/1.0 (+https://lastlook.swiftbotlab.workers.dev/about)' },
      body: JSON.stringify({ query, variables: variables || {} })
    });
  } catch (e) {
    clearTimeout(timer);
    throw new BufferError('network', ctl.signal.aborted ? 'Buffer did not answer in time' : 'Could not reach Buffer');
  }
  try {
    const rate = parseRate(res.headers);
    /* never follow a redirect with the user's token (Workers support only 'follow' and 'manual') */
    if (res.status >= 300 && res.status < 400) throw new BufferError('upstream', 'Buffer redirected the request', { rate });
    if (res.status === 401 || res.status === 403) throw new BufferError('auth', 'Your Buffer connection has expired or was revoked', { rate });
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'));
      throw new BufferError('rate', 'Buffer asked us to slow down', { retryAfter: Number.isFinite(ra) ? Math.min(ra, 86400) : 60, rate });
    }
    const text = await readCapped(res);
    if (res.status !== 200) throw new BufferError('upstream', 'Buffer returned an error (' + res.status + ')', { rate });
    let j;
    try { j = JSON.parse(text); } catch (e) { throw new BufferError('upstream', 'Buffer sent a response we could not read', { rate }); }
    if (j && Array.isArray(j.errors) && j.errors.length && !j.data) {
      const msg = String((j.errors[0] && j.errors[0].message) || 'error');
      const code = String((j.errors[0] && j.errors[0].extensions && j.errors[0].extensions.code) || '');
      if (/unauth|forbidden|not authorized|invalid token|expired/i.test(msg + ' ' + code)) throw new BufferError('auth', 'Your Buffer connection has expired or was revoked', { rate });
      throw new BufferError('graphql', 'Buffer could not answer that request', { detail: msg.slice(0, 200), rate });
    }
    return { data: j.data || {}, errors: j.errors || null, rate };
  } finally { clearTimeout(timer); }
}

/* ---------- queries ---------- */
export const Q_ACCOUNT = 'query Me { account { id name timezone organizations { id name } } }';

const ASSET = 'type mimeType source ... on ImageAsset { image { altText } }';
const THREAD = 'threadCount thread { text assets { ' + ASSET + ' } }';
export const POST_FIELDS = `
  id channelId channelService status dueAt createdAt updatedAt shareMode isCustomScheduled schedulingType text allowedActions
  error { message }
  assets { ${ASSET} }
  metadata {
    __typename
    ... on BlueskyPostMetadata { linkAttachment { url } ${THREAD} }
    ... on TwitterPostMetadata { ${THREAD} }
    ... on ThreadsPostMetadata { linkAttachment { url } ${THREAD} }
    ... on MastodonPostMetadata { ${THREAD} }
    ... on LinkedInPostMetadata { firstComment linkAttachment { url } }
    ... on FacebookPostMetadata { firstComment linkAttachment { url } }
    ... on InstagramPostMetadata { firstComment }
    ... on PinterestPostMetadata { url }
    ... on SubstackPostMetadata { linkAttachment { url } }
  }`;
export const CHANNEL_FIELDS = `id name displayName service type timezone avatar isQueuePaused isDisconnected isLocked
  metadata { __typename ... on MastodonMetadata { maxCharacters } ... on TwitterMetadata { subscriptionType } }`;

export function scanQuery(withChannels) {
  return `query Scan($org: OrganizationId!, $first: Int!, $after: String) {
  ${withChannels ? 'channels(input: { organizationId: $org }) { ' + CHANNEL_FIELDS + ' }' : ''}
  posts(first: $first, after: $after, input: { organizationId: $org, filter: { status: [scheduled, needs_approval, draft] }, sort: [{ field: dueAt, direction: asc }] }) {
    pageInfo { hasNextPage endCursor }
    edges { node { ${POST_FIELDS} } }
  }
}`;
}
export const Q_POST = `query One($id: PostId!) { post(input: { id: $id }) { ${POST_FIELDS} } }`;

const RESULT = '__typename ... on PostActionSuccess { post { id status dueAt text shareMode isCustomScheduled } } ... on MutationError { message }';
export const M_EDIT_TEXT = `mutation EditText($id: PostId!, $text: String!) { editPost(input: { id: $id, text: $text }) { ${RESULT} } }`;
/* Buffer validates the edited post as a whole: an edit that sends only saveToDraft is refused with
   "Post must have either text or media", so the current text (re-read and hash-checked just before) is sent along. */
export const M_TO_DRAFT = `mutation ToDraft($id: PostId!, $text: String!) { editPost(input: { id: $id, text: $text, saveToDraft: true }) { ${RESULT} } }`;
export const M_MOVE = `mutation Move($id: PostId!, $position: QueuePosition!) { movePostInQueue(input: { id: $id, position: $position }) { ${RESULT} } }`;

/* ---------- shaping ---------- */
function assetOut(a) {
  if (!a || typeof a !== 'object') return null;
  return { type: String(a.type || ''), altText: a.image ? String(a.image.altText || '') : null };
}
export function shapePost(n) {
  const md = n.metadata || {};
  const thread = Array.isArray(md.thread) ? md.thread.slice(0, 50).map((t) => ({ text: String((t && t.text) || ''), assets: (t && Array.isArray(t.assets) ? t.assets : []).slice(0, 10).map(assetOut).filter(Boolean) })) : [];
  return {
    id: String(n.id), channelId: String(n.channelId), channelService: String(n.channelService || ''),
    status: String(n.status || ''), dueAt: n.dueAt || null, createdAt: n.createdAt || null, updatedAt: n.updatedAt || null,
    shareMode: n.shareMode || null, isCustomScheduled: !!n.isCustomScheduled, schedulingType: n.schedulingType || null,
    text: String(n.text || ''), allowedActions: Array.isArray(n.allowedActions) ? n.allowedActions.map(String).slice(0, 40) : [],
    publishError: n.error && n.error.message ? String(n.error.message).slice(0, 300) : null,
    assets: (Array.isArray(n.assets) ? n.assets : []).slice(0, 20).map(assetOut).filter(Boolean),
    thread: thread.length > 1 ? thread : [],
    linkAttachment: md.linkAttachment && md.linkAttachment.url ? String(md.linkAttachment.url) : null,
    firstComment: md.firstComment ? String(md.firstComment) : null,
    pinUrl: md.url ? String(md.url) : null
  };
}
export function shapeChannel(c) {
  const md = c.metadata || {};
  return {
    id: String(c.id), name: String(c.name || ''), displayName: c.displayName ? String(c.displayName) : null, service: String(c.service || ''),
    type: String(c.type || ''), timezone: String(c.timezone || 'Europe/London'), avatar: /^https:\/\//.test(String(c.avatar || '')) ? String(c.avatar) : null,
    isQueuePaused: !!c.isQueuePaused, isDisconnected: !!c.isDisconnected, isLocked: !!c.isLocked,
    metadata: { maxCharacters: md.maxCharacters != null ? Number(md.maxCharacters) : null, subscriptionType: md.subscriptionType ? String(md.subscriptionType) : null }
  };
}
