/* shared test helpers */
export function post(text, extra) {
  return Object.assign({
    id: 'p' + Math.random().toString(36).slice(2, 10), channelId: 'c1', channelService: 'bluesky', status: 'scheduled',
    dueAt: '2026-11-30T15:42:00.000Z', createdAt: '2026-11-03T03:00:00.000Z', shareMode: 'customScheduled', isCustomScheduled: true,
    text, allowedActions: ['updatePost', 'movePostToDraft'], assets: [], thread: []
  }, extra || {});
}
export const BSKY = { id: 'c1', service: 'bluesky', timezone: 'Asia/Kolkata', name: 'SBL', metadata: {} };
export const X = { id: 'c2', service: 'twitter', timezone: 'America/New_York', name: 'X', metadata: {} };
export const ids = (flags) => flags.map((f) => f.id);
