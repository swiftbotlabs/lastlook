# Last Look

A last look at your Buffer queue before it posts.

Last Look connects to Buffer with OAuth, reads every scheduled post, post awaiting approval and draft across your channels, and flags what would embarrass you once it is live. Each flag comes with a fix that goes through the Buffer API, only after you confirm it.

Live: https://lastlook.swiftbotlab.workers.dev

## What it checks

| Check | What it catches |
| --- | --- |
| Links | 404 and 410, other 4xx, 5xx, no answer in 8 s, domains that do not exist, redirect loops, links that now land on a sign-in page or a different site, links to localhost or other private addresses. Checked in links in the text, thread parts, link preview cards, first comments and Pinterest destination links. |
| Time | Everything judged at the send time in the channel's time zone: written dates already past (and whether they were still ahead when the post was written), a weekday that does not match its date, "today at 7pm" going out at 9pm, "Good morning" at night, "Happy Friday" and #ThrowbackThursday on the wrong day, holiday greetings out of season, day words in queue-slot posts whose time can move, and posts landing between 1 and 5 a.m. |
| Formatting | **bold**, __bold__, ~~strike~~, # headings, [text](link), backticks, HTML tags and entities such as `&amp;` on networks that print them as typed (X, Bluesky, LinkedIn, Threads, Mastodon, Facebook, Instagram, TikTok, Pinterest, YouTube, Google Business Profile). Suggests a cleaned version. |
| Length | Each network's limit, counted the way that network counts it, following Buffer's published character limits (X weighted count with links as 23 and emoji as 2; Bluesky graphemes with shortened links; LinkedIn links as 24; Instagram line breaks as 2; Mastodon server limit; TikTok video limit; first comments). |
| Repeats | The same or nearly the same text (word-level similarity of 80% or more) queued twice on one channel; identical text on another channel at a different time. |
| Leftovers | Template placeholders ([link], {{first_name}}, TODO, lorem ipsum), images without alt text, hashtags cut short by a hyphen or apostrophe, a space after @ or #, unmatched brackets, too many hashtags. |

Every rule is plain code. There is no AI model in the product, so the same post always gets the same answer.

## Fixes

- **Edit text**: a suggested version where one can be made (cleaned formatting, the right weekday, the right greeting, a fixed hashtag), or your own edit, with a live character count for the channel and a word-by-word diff. Only the text changes; the schedule stays.
- **Move to drafts**: takes the post out of the schedule without losing it.
- **Move in queue**: sends a queue-slot post to the front or the end of its channel's queue.

Before any write, the server reads the post again and refuses if the text changed since the scan, if it goes out in the next three minutes, if it is a thread (edited in Buffer so all parts stay in step) or if Buffer does not allow the action for that account. Last Look never creates, publishes or deletes a post.

## How it uses the Buffer API

- OAuth 2.0 Authorization Code with PKCE (S256), confidential client, scopes `account:read posts:read posts:write`.
- `account { organizations }` once at sign-in.
- One GraphQL request per scan page: `channels` and `posts(filter: { status: [scheduled, needs_approval, draft] }, sort: dueAt asc)` together, 100 posts per page, up to 3 pages per organization.
- Fixes: `post(input: { id })` to re-read, then `editPost(input: { id, text })`, `editPost(input: { id, text, saveToDraft: true })` or `movePostInQueue(input: { id, position })`.
- `RateLimit` and `RateLimit-Policy` headers are read on every response; scans stop paging and warn when a window runs low, and a 429 is passed on with its `Retry-After`.

## Development

```
node --test test/*.test.mjs     # 60+ unit tests, offline (Buffer, DNS and pages are mocked)
node ops/ssrf_live_probe.mjs    # live-DNS check that private-resolving names are refused
ops/deploy.sh                   # build browser modules, run tests, deploy the Worker
```

Layout: `src/index.js` (routes, OAuth, scan, fixes), `src/session.js` (encrypted sessions), `src/buffer.js` (GraphQL client and queries), `src/net.js` + `src/ip.js` (link checker and SSRF guard), `src/checks/*` (the checks), `src/pages.js` (server pages), `public/` (browser app and styles).

Runs on Cloudflare Workers with one KV namespace for sessions and the Workers rate-limiting binding. Worker secrets: `BUFFER_CLIENT_ID`, `BUFFER_CLIENT_SECRET`, `SESSION_SECRET`.

By Swift Bot Labs. Uses the Buffer API; not made by or affiliated with Buffer.
