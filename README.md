# Last Look

A last look at your Buffer queue before it posts.

Last Look connects to Buffer with OAuth, reads every scheduled post, post awaiting approval and draft across your channels, and flags what would embarrass you once it is live. Each flag comes with a fix that goes through the Buffer API, only after you confirm it.

Live: https://lastlook.swiftbotlab.workers.dev · No-login demo: https://lastlook.swiftbotlab.workers.dev/try

Built for [Buffer Commit 2026](https://buffer.com/api/commit) from 3 November 2026, inside the build window (28 October to 13 November). There was no earlier code: every commit in this repository is from the window. MIT licensed.

## Try it without connecting

`/try` opens on **Your own post**: type or paste a post, pick a channel (X, LinkedIn, Bluesky, Threads, Instagram, Mastodon) and when it goes out (next Monday 09:30 in your time zone by default, in a queue slot or at a fixed time). As you type (150 ms after you stop), the same browser-side checks run on that one post: flagged words are marked, the flag cards and their fix buttons are the same as on a queue, and a fix opens the same edit dialog with its word diff (then Undo for two minutes). Three one-tap examples show a "Happy Friday" going out on a Monday, a "tomorrow" in a queue slot, and raw `**` on X. Links are listed as "will be opened on a real queue" and never fetched: the tab has no network code (`public/own.js`), input is capped at 3,000 characters, and the text is rendered as text nodes only.

Without JavaScript (or before the app loads), `/try` already shows the sample queue's results: the server runs the same check code on the sample at request time and sends them as plain, escaped HTML (`src/trystatic.js`). A small classic script in the head (`public/boot.js`) marks scripted pages before first paint, so that copy stays hidden when the interactive app takes over; it also applies the light or dark theme picked with the header button (kept in the browser's local storage, nothing sent). The landing page's motion (`public/site.js`) only toggles classes on finished HTML and rests under reduced motion; the digest pages carry no script at all.

The second tab, `/try#sample`, opens the same app on a sample queue: twelve posts from a made-up pottery studio on X, LinkedIn, Bluesky and Instagram, built relative to today so every check fires on any date. The page runs the same check code as the real app, and the edit (with diff and live count), move-to-drafts and queue-reorder fixes work on the sample. The sample's backend lives in the page (`public/sample.js`): it has no session, sends nothing to the server or to Buffer, and its link results are part of the sample (reserved `.example` domains, each flag identical to what the real checker produces for that result, held in step by a test).

## What it checks

| Check | What it catches |
| --- | --- |
| Links | 404 and 410, other 4xx, 5xx, no answer in 8 s, domains that do not exist, more than 3 redirects, links that now land on a sign-in page or a different site, links to localhost or other private addresses, bare IP links (noted, never opened). Checked in the text, thread parts, link preview cards, first comments and Pinterest destination links. |
| Time | Everything judged at the send time in the channel's time zone: written dates already past (and whether they were still ahead when the post was written), a weekday that does not match its date, "today at 7pm" going out at 9pm, "Good morning" at night, "Happy Friday" and #ThrowbackThursday on the wrong day, holiday greetings out of season, day words in queue-slot posts whose time can move, and posts landing between 1 and 5 a.m. |
| Formatting | **bold**, __bold__, ~~strike~~, # headings, [text](link), backticks, HTML tags and entities such as `&amp;` on networks that print them as typed (X, Bluesky, LinkedIn, Threads, Mastodon, Facebook, Instagram, TikTok, Pinterest, YouTube, Google Business Profile). Suggests a cleaned version. |
| Length | Each network's limit, counted the way that network counts it, following Buffer's published character limits (X weighted count with links as 23 and emoji as 2; Bluesky graphemes with shortened links; LinkedIn links as 24; Instagram line breaks as 2; Mastodon server limit; TikTok video limit; first comments). |
| Repeats | The same or nearly the same text (word-level similarity of 80% or more) queued twice on one channel; identical text on another channel at a different time. |
| Leftovers | Template placeholders ([link], {{first_name}}, TODO, lorem ipsum), images without alt text, hashtags cut short by a hyphen or apostrophe, a space after @ or #, unmatched brackets, too many hashtags. |
| Your channel rules | Per channel, phrases to avoid (`sneak peek => first look` suggests the word to use instead) and tags or phrases every post must include (`#ad`, a brand tag; the first comment counts). Case-insensitive, whole words, links skipped, matched literally (never as a pattern). The fix swaps the word in or adds the missing tag. |

Every rule is plain code that runs in the browser (`src/checks/`, copied to `public/checks/` by `ops/build.sh`). There is no AI model in the product, so the same post always gets the same answer.

## Channel rules

Each channel header has **Add rules**: a box of phrases this channel never uses, one per line (add `=> word` to suggest a replacement), and a box of tags or phrases every post on it must carry. Rules are cleaned and capped in `src/checks/rules.js` (20 phrases and 10 must-haves per channel, 2 to 60 characters each, control and invisible characters removed, unsafe ids such as `__proto__` refused) and saved in the browser's `localStorage` only: they are never sent to the server or to Buffer, so the daily digest (built on the server) does not use them yet. On `/try` the sample studio has its own rules (X: never "sneak peek", say "first look"; Instagram: always #littlekiln), kept in the tab.

## Look back

After you connect, the Look back tab reads your most recent sent posts (up to 90) and runs the text checks on them: formatting the network showed as raw text, length counted the network's way, leftover placeholders, the same post sent twice on one channel, day and time words judged against the moment the post actually went out (`sentAt`) in the channel's time zone, and images sent without alt text. The headline reads "Last Look would have caught N issues in your last M sent posts", grouped by check, each linking to the post. It only reads: sent posts carry no fix tokens, and their links are listed, not opened (old links cannot be edited, and fetching them would spend the link-check budget the live queue needs). The rules are the same modules as the queue checks (`src/checks/lookback.js` wraps them with past-tense wording).

## Fixes

- **Edit text**: a suggested version where one can be made (cleaned formatting, the right weekday, the right greeting, a fixed hashtag), or your own edit, with a live character count for the channel and a word-by-word diff. Only the text changes; the schedule stays.
- **Move to drafts**: takes the post out of the schedule without losing it.
- **Move in queue**: sends a queue-slot post to the front or the end of its channel's queue.
- **Re-check after a reorder**: moving a post in its queue changes when it goes out. Moved to the end, it takes the last slot, often days later; moved to the front, Buffer sets it to share next and reports no time for it (its `dueAt` comes back as 1970-01-01). After every `movePostInQueue`, Last Look reads that channel's queue once more (one query), compares each post's new time with the one it had, and re-judges the day words of every post whose time changed against the day they meant at the old slot. "Our sale ends tomorrow", moved from Thursday to Friday, now means Saturday: the flag says so and offers the word that keeps Friday ("today"). If that day has passed at the new time, it offers the front of the queue or drafts instead. Posts set to share next are shown as "Shares next · no time yet" and their day words are flagged for a human to check, never judged at a made-up time. The /try sample behaves the same way.
- **Undo** (two minutes after an edit): puts the previous text back. The edit's answer carries an undo token, an HMAC over the session, post id, time, the hash of the text Buffer now holds and the hash of the text the server re-read before editing. Undo re-reads the post and restores only if the post still holds exactly what Last Look wrote, and only to that previous text.

Before any write, the server reads the post again and refuses if the text changed since the scan, if it goes out in the next three minutes, if it is a thread (edited in Buffer so all parts stay in step) or if Buffer does not allow the action for that account. Last Look never creates, publishes or deletes a post.

## Daily digest (opt-in)

A pre-flight check only helps if someone opens it. The **Daily digest** tab turns on, once a day at an hour you pick in your own time zone (07:00, 12:00, 17:00 or 20:00), a short list of what Last Look would fix in the posts going out before the end of the next day: on a private page and an Atom feed you can follow in Slack (`/feed subscribe <feed address>`), any feed reader, or an RSS-to-email service.

- **Off by default.** Turning it on asks Buffer for a second, separate grant with read-only scopes, `account:read posts:read offline_access`: it can read the queue on its own once a day, and it cannot change, publish or delete anything. Fixes still happen in the app, after you confirm.
- **One click off.** The button on the digest page (a POST from our own page; a GET of the off link only asks, so link previews in chat apps cannot turn it off) or in the app deletes the subscription, its stored token and every stored digest at once. Then the grant is revoked at Buffer: the refresh token is used once more after it was rotated, and Buffer answers a reused refresh token by revoking every token of that grant. It also switches itself off the same way when nobody opened the page or feed for 14 days, or when Buffer refuses the token (you removed Last Look in Buffer).
- **What is stored**: the refresh token, AES-256-GCM encrypted under a key derived from the server secret and the digest's id, in one Durable Object, never sent to a browser; Buffer rotates it on every use and the new one is saved before the access token is used (one build at a time, in the one place that refreshes it). The last 7 digests (one a day): send time, channel name, the first 140 characters of each flagged post, the flags. The private address is stored as a SHA-256 index plus an encrypted copy that only the signed-in account owner can see again in the app.
- **Two grants, one rule from Buffer.** Measured on the live API (2026-11-04): a new read-only `offline_access` consent ends the user's earlier sign-in to the same app about two minutes later, while a new sign-in leaves the digest's grant working (refresh and reads), and revoking the digest leaves the sign-in working. So the digest page, the app's digest tab and the sign-in-ended message all say it: after turning the digest on, connect again to keep fixing posts.
- **Opening the page or the feed never calls Buffer** and never opens a link: it reads storage only, so a feed reader polling every minute costs Buffer nothing. Reads are limited to 120 an hour per digest.
- **Builds** run in the Durable Object, one digest per alarm (each with its own CPU budget): refresh, one query per organization (`posts` with `status: [scheduled, needs_approval, draft]`, sorted by `dueAt`, first 100; drafts and posts outside the window are dropped after reading, at most 40 kept; `draft` has to be in the list because Buffer returns no scheduled posts for `[scheduled, needs_approval]` alone), the same checks as the app, and up to 4 links through the same SSRF-guarded checker. Each build is admitted by the gate with a wider margin of the app's allowance than anything a person is waiting for, and at most 4 builds per account a day inside the account's budget of Buffer requests. An hourly cron re-arms the alarm loop; `/healthz` returns 503 when 6 builds in a row fail on our side or builds are two hours overdue.

## How it uses the Buffer API

- OAuth 2.0 Authorization Code with PKCE (S256), confidential client, scopes `account:read posts:read posts:write`. Each sign-in attempt can be used once, and nothing of the shared allowance is reserved until Buffer has returned a real access token.
- `account { organizations }` once at sign-in.
- One GraphQL request per scan page: `channels` and `posts(filter: { status: [scheduled, needs_approval, draft] }, sort: dueAt asc)` together, 100 posts per page, at most 3 requests per scan.
- Look back: one request per organization (first two organizations): `channels` and `posts(filter: { status: [sent] }, sort: dueAt desc, first: 90)` with `sentAt` and `externalLink`. A query only; one per account every two minutes, six a day.
- Fixes: `post(input: { id })` to re-read, then `editPost(input: { id, text })`, `editPost(input: { id, text, saveToDraft: true })` or `movePostInQueue(input: { id, position })`. The mutation returns the whole post, so the page updates that post without a new scan. After `movePostInQueue`, one more query reads the channel's queue (`posts(filter: { status: [scheduled], channelIds: [channel] })`) so the page can re-check every post that got a new slot.
- Daily digest: OAuth with `account:read posts:read offline_access` (its own grant), `account { organizations }` once, then per day a refresh-token exchange and `channels` + `posts(filter: { status: [scheduled, needs_approval, draft] }, sort: dueAt asc)` per organization; the window (now to the end of the next local day, plus posts set to share next) is applied after reading.
- A Durable Object (`src/gate.js`) guards the per-app allowance: it records the `RateLimit` headers of every Buffer response and refuses new scans and fixes when fewer than 20 requests (15-minute window) or 150 (24-hour window) remain; sign-ins keep a smaller reserve. Per account: one scan a minute, 20 scans, 40 fixes, 300 link checks, 6 look-backs (one per 2 minutes) and 20 sign-ins a day, one live session at a time, and one budget of real Buffer requests across all of them: 15 per 15 minutes and 60 a day. A typical visit (sign-in 1 request, a scan 1-3, a look-back 1-2) takes 3-6 requests, inside the 10 per 15 minutes that each authorized user adds to the app's allowance; a heavy account can spend more than it adds (15 against 10 per 15 minutes, 60 against 25 a day), and the app-wide margins are what keep that from reaching everyone else.

## When Buffer says "not now"

Every limit (Buffer's 429, the app-wide allowance margin, per-account budgets, the per-IP limit) reads as a short pause, not an error: what is happening, when to try again (the `Retry-After` turned into a local time), and that nothing was changed. The Scan and Look back buttons count down instead of failing again, sign-in says so before Buffer's consent screen, and an empty or paused state points to Look back and the sample queue.

## Build log (all dates UTC, all inside the build window)

Every commit is public in [the commit history](https://github.com/swiftbotlabs/lastlook/commits/master). Day by day:

- **3 November** (12 commits, 03:01 to 06:16): first commit. OAuth sign-in, the queue scan with link, time, formatting, length, repeat and leftover checks, fixes through the Buffer API after you confirm, SSRF-safe link checks, the shared Buffer rate limiter in a Durable Object, `/try` on a sample queue, Look back on the last 90 sent posts, two-minute Undo, calm pause states.
- **4 November** (12 commits, 06:48 to 18:25): `/try` "Your own post" tab, day words re-checked after a queue reorder (the post's new slot, read back from Buffer), the opt-in daily digest on its own read-only grant, moves that behave the way Buffer does, per-channel rules, `/try` results without JavaScript, MIT licence and setup steps for your own copy.

There was no code before 3 November.

## Development

```
npm ci                          # pinned wrangler (package-lock.json)
npm test                        # copies the check modules to public/checks, then runs the unit tests offline
                                # (Buffer, DNS, KV and both Durable Objects are mocked)
node ops/ssrf_live_probe.mjs    # live-DNS check that private-resolving names are refused
```

## Run your own copy

1. **Buffer OAuth client.** In Buffer's developer settings, create a confidential client with the scopes `account:read`, `posts:read` and `posts:write`, the redirect URI `https://<your host>/oauth/callback` and your privacy page URL. The daily digest asks for `offline_access` on its own sign-in; no other client is needed.
2. **Cloudflare.** `npx wrangler login` (or set `CLOUDFLARE_API_TOKEN`), then `npx wrangler kv namespace create SESSIONS` and put the id in `wrangler.toml`, together with your `account_id` and your own `namespace_id` values for the two rate limiters.
3. **Your host name.** Replace `lastlook.swiftbotlab.workers.dev` with your host in `src/index.js` (`ORIGIN`, `SELF_HOST`), `src/digest.js` (`selfHost`), `src/pages.js` (feed ids) and the user agents in `src/net.js` and `src/buffer.js`.
4. **Secrets** (never in a file): `npx wrangler secret put BUFFER_CLIENT_ID`, `npx wrangler secret put BUFFER_CLIENT_SECRET`, and `npx wrangler secret put SESSION_SECRET` with at least 32 random characters (for example `openssl rand -base64 48`). Changing `SESSION_SECRET` signs everyone out and makes stored digest tokens unreadable, which is the right move after a suspected leak.
5. **Deploy**: `npm test && npx wrangler deploy`. The migrations create the `Gate` and `Digest` Durable Objects (SQLite-backed, available on the Workers free plan) and the hourly cron trigger.
6. **Check**: `/healthz` answers `{"ok":true,...}`; sign in, scan, and try a fix on a test post with a custom time far in the future (Last Look never publishes, but a queue-slot post will go out at its slot unless the queue is paused).

Layout: `public/sample.js` (the /try sample and its local backend), `src/index.js` (routes, OAuth, scan, fixes, digest pages), `src/gate.js` (Durable Object: sessions registry, allowance, budgets, link limits), `src/digest.js` (Durable Object: daily digest subscriptions, sealed tokens, builds, revocation), `src/session.js` (encrypted sessions), `src/buffer.js` (GraphQL client and queries), `src/net.js` + `src/ip.js` (link checker and SSRF guard), `src/checks/*` (the checks), `src/pages.js` (server pages), `public/` (browser app and styles).

Runs on Cloudflare Workers with one KV namespace for sessions, two Durable Object classes (the gate and the digest), an hourly cron trigger, the Workers rate-limiting binding (per IP) and `global_fetch_strictly_public`. Request logging is off. Worker secrets: `BUFFER_CLIENT_ID`, `BUFFER_CLIENT_SECRET`, `SESSION_SECRET`.

By Swift Bot Labs. Uses the Buffer API; not made by or affiliated with Buffer.
