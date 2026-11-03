# Security notes: Last Look

What the app protects: each user's Buffer access token and their queued posts, and the app's shared Buffer request allowance. What it touches: Buffer's API on the user's behalf, and every link in their queue.

## Sign-in
- Authorization Code + PKCE (S256), confidential client: the client secret exists only as a Worker secret and is sent only to `auth.buffer.com/token`.
- `state` = random nonce + HMAC tag. It and the PKCE verifier travel in a 10-minute AES-GCM sealed, HttpOnly, Secure, SameSite=Lax `__Host-` cookie. The callback refuses a missing or expired cookie, a state that does not match it, and a wrong HMAC tag, before any token request.
- Redirect URI is a constant; there is no user-controlled redirect anywhere.
- A sign-in spends one Buffer request, so it asks the gate first (smaller reserve than scans) and counts toward a per-account daily limit (20).

## Sessions and tokens
- Session id: 32 random bytes in a `__Host-` cookie (HttpOnly, Secure, SameSite=Lax, at most 1 hour).
- KV key = SHA-256(session id); KV value = AES-256-GCM ciphertext under a key derived with HKDF from `SESSION_SECRET` and the session id.
- One live session per Buffer account: the gate (Durable Object, strongly consistent) maps a hash of the account id to the hash of the current session id. A new sign-in replaces the older session; Disconnect unregisters it at once, and the KV record is deleted right after the reply (`ctx.waitUntil`, since KV deletes can take seconds). Every page load and API call checks the registry, so a deleted session that KV still caches elsewhere for up to ~60 s is refused anyway.
- No refresh tokens (`offline_access` is not requested). Buffer 401 deletes and unregisters the session.

## Shared Buffer allowance (availability)
- The gate records Buffer's `RateLimit` headers from every response (15-minute and 24-hour windows) and reserves the calls an operation may spend before it runs. Scans and fixes are refused below 20 / 150 remaining; sign-ins below 5 / 30.
- Per account (by account hash, not session): one scan per 60 s, 20 scans, 40 fixes, 300 link checks, 20 sign-ins per UTC day, 10 fixes and 30 link batches per minute.
- A scan spends at most 3 Buffer requests; a Look back at most 2 (one per organization, first two), at most once per 2 minutes and 6 times a day per account, with the same app-wide margins as scans.
- Look back is a query only (`status: [sent]`). Its posts carry no post token, so none of them can be passed to `/api/fix`; the `externalLink` it shows is kept only when it parses as an `https:` URL without credentials (checked again in the browser). Links in sent posts are never fetched. After a fix, the page updates that one post from the mutation result instead of rescanning.
- `/api/fix` spends a Buffer request only on a post id the session's own scan returned: each scanned post carries an HMAC token bound to the session and scan time (1 hour); anything else is refused with no Buffer call.
- Per IP: 120 page and API requests per minute (Workers rate-limiting binding), checked before any session lookup; sign-in 10 per minute.

## Requests from the browser
- Every POST needs the session cookie, `Origin: https://lastlook.swiftbotlab.workers.dev`, `content-type: application/json` and the per-session CSRF token (constant-time compare).
- Bodies capped at 64 KB while streaming; ids `^[A-Za-z0-9_-]{6,64}$`; new text 1-30,000 characters, no control characters.

## Writes to Buffer
- Only `editPost` (text, or text + saveToDraft) and `movePostInQueue` exist in the code. No create, publish, share-now or delete path.
- Each write needs `confirm: true`, the post token, and the SHA-256 of the text the user saw; the server re-reads the post and refuses on any mismatch, on a send time under 3 minutes away, on threads, on statuses other than scheduled/awaiting approval/draft, and when Buffer's `allowedActions` do not include the action.

## The /try sample page
- Served without a session and without a CSRF token; it never reads the session store or asks the gate.
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
- The gate is a single Durable Object: every API call passes through it. Fine at this scale; it would need sharding by account for heavy traffic.
- Buffer's per-app allowance is small (100 + 10 per authorized user per 15 minutes); a higher limit has to be requested from Buffer.
