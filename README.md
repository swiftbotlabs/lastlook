# Last Look

A last look at your Buffer queue before it posts.

Last Look connects to Buffer with OAuth, reads every scheduled post, post awaiting approval and draft across your channels, and flags what would embarrass you once it is live. Each flag comes with a fix that goes through the Buffer API, only after you confirm it.

Live: https://lastlook.swiftbotlab.workers.dev · No-login demo: https://lastlook.swiftbotlab.workers.dev/try

## Try it without connecting

`/try` opens the same app on a sample queue: twelve posts from a made-up pottery studio on X, LinkedIn, Bluesky and Instagram, built relative to today so every check fires on any date. The page runs the same check code as the real app, and the edit (with diff and live count), move-to-drafts and queue-reorder fixes work on the sample. The sample's backend lives in the page (`public/sample.js`): it has no session, sends nothing to the server or to Buffer, and its link results are part of the sample (reserved `.example` domains, each flag identical to what the real checker produces for that result, held in step by a test).

## What it checks

| Check | What it catches |
| --- | --- |
| Links | 404 and 410, other 4xx, 5xx, no answer in 8 s, domains that do not exist, more than 3 redirects, links that now land on a sign-in page or a different site, links to localhost or other private addresses, bare IP links (noted, never opened). Checked in the text, thread parts, link preview cards, first comments and Pinterest destination links. |
| Time | Everything judged at the send time in the channel's time zone: written dates already past (and whether they were still ahead when the post was written), a weekday that does not match its date, "today at 7pm" going out at 9pm, "Good morning" at night, "Happy Friday" and #ThrowbackThursday on the wrong day, holiday greetings out of season, day words in queue-slot posts whose time can move, and posts landing between 1 and 5 a.m. |
| Formatting | **bold**, __bold__, ~~strike~~, # headings, [text](link), backticks, HTML tags and entities such as `&amp;` on networks that print them as typed (X, Bluesky, LinkedIn, Threads, Mastodon, Facebook, Instagram, TikTok, Pinterest, YouTube, Google Business Profile). Suggests a cleaned version. |
| Length | Each network's limit, counted the way that network counts it, following Buffer's published character limits (X weighted count with links as 23 and emoji as 2; Bluesky graphemes with shortened links; LinkedIn links as 24; Instagram line breaks as 2; Mastodon server limit; TikTok video limit; first comments). |
| Repeats | The same or nearly the same text (word-level similarity of 80% or more) queued twice on one channel; identical text on another channel at a different time. |
| Leftovers | Template placeholders ([link], {{first_name}}, TODO, lorem ipsum), images without alt text, hashtags cut short by a hyphen or apostrophe, a space after @ or #, unmatched brackets, too many hashtags. |

Every rule is plain code that runs in the browser (`src/checks/`, copied to `public/checks/` by `ops/build.sh`). There is no AI model in the product, so the same post always gets the same answer.

## Fixes

- **Edit text**: a suggested version where one can be made (cleaned formatting, the right weekday, the right greeting, a fixed hashtag), or your own edit, with a live character count for the channel and a word-by-word diff. Only the text changes; the schedule stays.
- **Move to drafts**: takes the post out of the schedule without losing it.
- **Move in queue**: sends a queue-slot post to the front or the end of its channel's queue.

Before any write, the server reads the post again and refuses if the text changed since the scan, if it goes out in the next three minutes, if it is a thread (edited in Buffer so all parts stay in step) or if Buffer does not allow the action for that account. Last Look never creates, publishes or deletes a post.

## How it uses the Buffer API

- OAuth 2.0 Authorization Code with PKCE (S256), confidential client, scopes `account:read posts:read posts:write`.
- `account { organizations }` once at sign-in.
- One GraphQL request per scan page: `channels` and `posts(filter: { status: [scheduled, needs_approval, draft] }, sort: dueAt asc)` together, 100 posts per page, at most 3 requests per scan.
- Fixes: `post(input: { id })` to re-read, then `editPost(input: { id, text })`, `editPost(input: { id, text, saveToDraft: true })` or `movePostInQueue(input: { id, position })`. The mutation returns the whole post, so the page updates that post without a new scan.
- A Durable Object (`src/gate.js`) guards the per-app allowance: it records the `RateLimit` headers of every Buffer response and refuses new scans and fixes when fewer than 20 requests (15-minute window) or 150 (24-hour window) remain; sign-ins keep a smaller reserve. Per account: one scan a minute, 20 scans, 40 fixes, 300 link checks and 20 sign-ins a day, one live session at a time.

## Development

```
npm ci                          # pinned wrangler (package-lock.json)
ops/build.sh                    # copy the check modules to public/checks
node --test test/*.test.mjs     # unit tests, offline (Buffer, DNS, KV and the Durable Object are mocked)
node ops/ssrf_live_probe.mjs    # live-DNS check that private-resolving names are refused
npx wrangler deploy             # with CLOUDFLARE_API_TOKEN in the environment
```

Layout: `public/sample.js` (the /try sample and its local backend), `src/index.js` (routes, OAuth, scan, fixes), `src/gate.js` (Durable Object: sessions registry, allowance, budgets, link limits), `src/session.js` (encrypted sessions), `src/buffer.js` (GraphQL client and queries), `src/net.js` + `src/ip.js` (link checker and SSRF guard), `src/checks/*` (the checks), `src/pages.js` (server pages), `public/` (browser app and styles).

Runs on Cloudflare Workers with one KV namespace for sessions, one Durable Object class, the Workers rate-limiting binding (per IP) and `global_fetch_strictly_public`. Request logging is off. Worker secrets: `BUFFER_CLIENT_ID`, `BUFFER_CLIENT_SECRET`, `SESSION_SECRET`.

By Swift Bot Labs. Uses the Buffer API; not made by or affiliated with Buffer.
