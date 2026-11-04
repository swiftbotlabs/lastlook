# Security notes: Last Look

What the app protects: each user's Buffer access token and their queued posts, and the app's shared Buffer request allowance. What it touches: Buffer's API on the user's behalf, and every link in their queue.

## Sign-in
- Authorization Code + PKCE (S256), confidential client: the client secret exists only as a Worker secret and is sent only to `auth.buffer.com/token`.
- `state` = random nonce + HMAC tag. It and the PKCE verifier travel in a 10-minute AES-GCM sealed, HttpOnly, Secure, SameSite=Lax `__Host-` cookie. The callback refuses a missing or expired cookie, a state that does not match it, and a wrong HMAC tag, before any token request.
- Redirect URI is a constant; there is no user-controlled redirect anywhere.
- Each sign-in attempt is single-use: right after the state checks, the callback records a hash of the state's nonce in the gate, for at least the cookie's 10 minutes (cleared within 30 by the next sign-in or the gate's alarm), and refuses a second callback with the same nonce before any token request.
- A sign-in spends one Buffer request (the account query). Before the token exchange the callback only peeks at the app allowance; the request is reserved only after Buffer has returned a real access token, just before the account query. Forged or replayed codes therefore cost the shared allowance nothing (each forged attempt still costs one refused request to Buffer's token endpoint, and needs its own `/oauth/start`). Sign-ins keep a smaller reserve than scans and count toward a per-account daily limit (20) and the per-account request budget. `/oauth/start` peeks too (nothing reserved) and shows a calm "short pause" page with a retry estimate instead of sending the visitor through Buffer's consent screen for nothing.

## Sessions and tokens
- Session id: 32 random bytes in a `__Host-` cookie (HttpOnly, Secure, SameSite=Lax, at most 1 hour).
- KV key = SHA-256(session id); KV value = AES-256-GCM ciphertext under a key derived with HKDF from `SESSION_SECRET` and the session id.
- One live session per Buffer account: the gate (Durable Object, strongly consistent) maps a hash of the account id to the hash of the current session id. A new sign-in replaces the older session; Disconnect unregisters it at once, and the KV record is deleted right after the reply (`ctx.waitUntil`, since KV deletes can take seconds). Every page load and API call checks the registry, so a deleted session that KV still caches elsewhere for up to ~60 s is refused anyway.
- The interactive session asks for no refresh token (`offline_access` is not requested on that sign-in). Buffer 401 deletes and unregisters the session. Only the opt-in daily digest holds a long-lived credential (below).

## Shared Buffer allowance (availability)
- The gate records Buffer's `RateLimit` headers from every response (15-minute and 24-hour windows) and holds the calls an operation may spend before it runs. The operation's own Buffer reply settles its hold; calls reserved but not made go back; a hold that no reply settles lapses after 30 s. Scans and fixes are refused below 20 / 150 remaining; sign-ins below 5 / 30.
- Per account (by account hash, not session): one budget of real Buffer requests, 15 per 15 minutes and 60 per UTC day, for sign-ins, scans, Look backs, fixes and undos together; on top of it one scan per 60 s, 20 scans, 40 fixes, 300 link checks, 20 sign-ins per UTC day, 10 fixes and 30 link batches per minute.
- A scan spends at most 3 Buffer requests; a Look back at most 2 (one per organization, first two), at most once per 2 minutes and 6 times a day per account, with the same app-wide margins as scans.
- Look back is a query only (`status: [sent]`). Its posts carry no post token, so none of them can be passed to `/api/fix`; the `externalLink` it shows is kept only when it parses as an `https:` URL without credentials (checked again in the browser). Links in sent posts are never fetched. After a fix, the page updates that one post from the mutation result instead of rescanning.
- `/api/fix` spends a Buffer request only on a post id the session's own scan returned: each scanned post carries an HMAC token bound to the session and scan time (1 hour); anything else is refused with no Buffer call.
- Per IP: 120 page and API requests per minute (Workers rate-limiting binding), checked before any session lookup; sign-in (start and callback) 10 per minute. The key is the IPv4 address or, for IPv6, the /64 prefix (one host or line usually holds a whole /64), hashed before it reaches the limiter.

## Requests from the browser
- Every POST needs the session cookie, `Origin: https://lastlook.swiftbotlab.workers.dev`, `content-type: application/json` and the per-session CSRF token (constant-time compare).
- Bodies capped at 64 KB while streaming; ids `^[A-Za-z0-9_-]{6,64}$`; an edit's new text 1-30,000 characters, no control characters. Undo does not take new text: it restores the exact previous text, whose SHA-256 must match the one bound into the undo token (the text the server re-read before the edit).
- The page paces itself: every pause waits for the server's `Retry-After`, or a minute when there is none; a first scan refused for a short pause is retried by itself once (the flag clears only after a successful scan); a link to `/#lookback` opens the tab but reads nothing until a click, and tab clicks wait out a running countdown; a refused link check is retried once, then shown as not checked.

## Writes to Buffer
- Only `editPost` (text, or text + saveToDraft) and `movePostInQueue` exist in the code. No create, publish, share-now or delete path. The digest has no write path at all, and no write scope.
- Undo is an `editPost` back to the previous text and passes every write guard below. It also needs the undo token from the edit's answer: an HMAC (key derived per session) over edit time, post id, SHA-256 of the text Buffer returned after our edit and SHA-256 of the text the server re-read before it. So Undo can only restore that exact previous text, only on that post, only from that session, only within 2 minutes (+15 s slack), and only while Buffer still holds our text (re-read before writing; anything else is 409). A wrong token, text or time is refused before any Buffer request.
- Each write needs `confirm: true`, the post token, and the SHA-256 of the text the user saw; the server re-reads the post and refuses on any mismatch, on a send time under 3 minutes away, on threads, on statuses other than scheduled/awaiting approval/draft, and when Buffer's `allowedActions` do not include the action.

## Daily digest (opt-in)
- Its own grant, asked for on a separate sign-in (`/digest/start`) with `account:read posts:read offline_access`. The callback refuses to store anything if Buffer returns no refresh token or a scope that includes `posts:write`; every later refresh is checked the same way. The stored credential can read the queue and nothing else. The interactive session's write scope never reaches the digest store, and no browser session is created by the digest sign-in.
- The refresh token lives only in the `Digest` Durable Object, AES-256-GCM sealed under an HKDF key from `SESSION_SECRET` and the subscription id (a copy of the storage alone cannot be decrypted). It is never sent to a browser or logged. The access token from each refresh is used for that build and dropped.
- Rotation: Buffer issues a new refresh token on every use and treats a reused one as theft (it revokes the grant). The new token is stored before the access token is used; builds run one at a time per subscription inside the one object that refreshes, so there are no concurrent refreshes.
- Off: the page's button (a same-origin POST; a GET of the off link only shows a confirm page, so chat unfurlers and link prefetchers cannot trigger it; a cross-site form gets 403), the app's button (session + CSRF), the 14-day idle rule, or Buffer refusing the token. Each deletes the subscription, token, digests and indexes at once; the refresh token is then revoked at Buffer from the object's alarm (used once, then reused, which revokes every token of the grant). A revocation that is still queued is sealed the same way.
- The private address is 32 random bytes; storage holds `SHA-256('lastlook-digest-feed:' + address)` as the index and a sealed copy (shown again only to the signed-in owner through `/api/digest`, which looks up by the session's account hash). Pages and feeds are `noindex`, `no-referrer`, and the feed has `sandbox` CSP. Every value in the page and the Atom feed is escaped (twice inside the feed's HTML content); the page has no script.
- Reading the page or feed touches storage only: no Buffer call, no link fetch. 120 reads per hour per digest, plus the per-IP limit.
- Builds: one per alarm, admitted by the gate with margins of 30 (15 minutes) and 200 (24 hours) of the app allowance, at most 4 per account a day inside the account's request budget; at most 2 organizations, 40 posts, 4 links (same SSRF guard and per-site limits as the app). Stored per digest: send time, channel name, the first 140 characters of each flagged post and its flags; 7 digests at most. 300 subscriptions in all, 5 sign-ups per account a day.
- Watchdog: each build records its result; `/healthz` returns 503 after 6 builds in a row fail on our side, or when a build is two hours overdue. An hourly cron re-arms the alarm loop.

## After a reorder
- `movePostInQueue` is followed by one query of that channel's scheduled posts, only in an organization of the session's own (the page names it; any other is ignored and the re-check is skipped). The move is reported as done even if that read fails (`shiftedError`). The re-check itself runs in the browser on the returned posts.

## The /try sample page
- Served without a session and without a CSRF token; it never reads the session store or asks the gate.
- "Your own post" (the first tab) renders text the visitor types. It is built only from DOM text nodes and `<mark>` wrappers (`textContent`, never `innerHTML`; the test DOM throws on any `innerHTML` use), capped at 3,000 characters, checked by the same pure check code, and never sent anywhere: `public/own.js` and the tab's part of `public/app.js` contain no `fetch`, XHR, WebSocket, beacon, dynamic import, storage or `src=`, and links in the text are listed, not opened (a test drives typing, examples, fixes and tab switches and asserts zero network calls; a live check with Chrome's network log saw zero requests after load). No new inline script or style: the composer is static markup under the unchanged CSP.
- In try mode the page's backend is `public/sample.js`, which has no network code; `api()` refuses to run before any `fetch`, so the sample page cannot reach `/api/*`, Buffer or the link checker (tests cover both). Sample links use reserved `.example` names and their results are fixed data.

## Showing third-party text
- The checks and the view run in the browser; post text, channel names and Buffer messages are rendered only through `textContent` (a test fails if `innerHTML` and friends appear in `public/app.js`). Server pages escape every dynamic value.
- CSP: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:` plus Buffer's avatar hosts only; `connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`. Avatar URLs from other hosts are dropped server-side. Plus nosniff, no-referrer, HSTS, X-Frame-Options DENY, COOP.

## Link checker (SSRF and abuse)
- Only links from the session's own scan: `/api/scan` returns an HMAC per link over `scan time + URL`, valid 10 minutes.
- Per batch: at most 6 links, duplicates dropped, 40 outbound requests.
- Gate limits: one check per account per URL per 60 s, 20 checks per minute per target site across all users, 300 per account per day.
- Per hop: http/https only; ports 80, 443, 8080, 8443; no credentials; IP-literal hosts never fetched (private ones reported as private, public ones as "bare IP"); internal names refused; trailing dots stripped; the host is resolved with DNS-over-HTTPS (A and AAAA) and every address must be public; at most 3 redirects, each re-checked; HEAD first, GET only on 405 or 501; bodies cancelled unread; 8 s per link.
- `compatibility_flags = ["global_fetch_strictly_public"]`: every `fetch()` is routed as a request on the public internet (no shortcut into Cloudflare-internal or same-zone routing). Workers cannot reach private networks, which is what covers DNS rebinding between our lookup and the request; the guard does not rely on it otherwise.
- Positive controls: unit tests prove the harness reaches fetch for a public address and not for names resolving to private addresses or redirects to them; `ops/ssrf_live_probe.mjs` repeats this with real DNS.

## CPU
- Checks run in the browser. Their cost is bounded anyway: pattern checks read at most 30,000 characters and run each pattern once; identical texts are grouped with a hash map; near-duplicates are compared only within a channel, between texts within 20% in length, on at most 120 words, and stop after 4 million table steps (counted, not timed), which the page reports. Crafted 30,000-character texts and 300-post crafted queues are covered by tests.

## Logs
- Workers Logs / invocation logs are off (`[observability] enabled = false`). Event lines (`connected`, `fix`, `disconnected`, `token_exchange_failed` with Buffer's error code) carry no ids, text, links or tokens and are only visible live through `wrangler tail`.

## Known limits
- Cloudflare's rate-limiting binding counts per data center, so per-IP limits are looser than configured; the account and app-wide limits live in the Durable Object and are exact.
- The gate is a single Durable Object: every API call passes through it. Fine at this scale; it would need sharding by account for heavy traffic. Holds live in its memory; if the object is evicted they are dropped, and Buffer's next reply sets the true count again.
- Buffer's per-app allowance is small (100 + 10 per authorized user per 15 minutes); a higher limit has to be requested from Buffer.
