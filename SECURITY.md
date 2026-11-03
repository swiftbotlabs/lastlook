# Security notes: Last Look

What the app protects: each user's Buffer access token and their queued posts. What it touches: Buffer's API on the user's behalf, and every link in their queue.

## Sign-in
- Authorization Code + PKCE (S256), confidential client: the client secret exists only as a Worker secret and is sent only to `auth.buffer.com/token`.
- `state` = random nonce + HMAC tag. It and the PKCE verifier travel in a 10-minute AES-GCM sealed, HttpOnly, Secure, SameSite=Lax `__Host-` cookie, never in clear. The callback refuses a missing or expired cookie, a state that does not match the cookie, and a state whose HMAC tag is wrong, before any token request.
- Redirect URI is a constant; there is no user-controlled redirect anywhere (no open redirect).

## Sessions and tokens
- Session id: 32 random bytes in a `__Host-` cookie (HttpOnly, Secure, SameSite=Lax, Max-Age = token life, at most 1 hour).
- KV key = SHA-256(session id); KV value = AES-256-GCM ciphertext under a key derived with HKDF from `SESSION_SECRET` and the session id. A copy of the KV store alone cannot be decrypted; the cookie alone cannot be decrypted without the server secret.
- TTL = Buffer's `expires_in` minus 60 s, capped at 1 hour. No refresh tokens are requested (`offline_access` is not asked for), so nothing long-lived is stored.
- Disconnect deletes the KV record and clears the cookie. A Buffer 401 deletes the session too.
- Stored: access token, expiry, CSRF token, organization ids and names, account display name. Never post text, links or results.

## Requests from the browser
- Every POST needs: the session cookie, `Origin: https://lastlook.swiftbotlab.workers.dev`, `content-type: application/json` and the per-session CSRF token in `x-csrf-token` (constant-time compare).
- Bodies are capped at 64 KB while streaming; JSON must be an object; ids must match `^[A-Za-z0-9_-]{6,64}$`; new text is 1-30,000 characters with no control characters.
- Rate limits (Workers rate-limiting binding, per session or per IP): sign-in 10/min/IP, scan 4/min, link batches 30/min, fixes 10/min.

## Writes to Buffer
- Only three mutations exist in the code: `editPost` (text only, or text + saveToDraft) and `movePostInQueue`. No create, publish, share-now or delete path exists.
- Each write needs `confirm: true` from the confirm dialog and the SHA-256 of the text the user saw; the server re-reads the post and refuses on any mismatch (409), on a send time under 3 minutes away, on threads, on statuses other than scheduled/awaiting approval/draft, and when Buffer's `allowedActions` do not include the action.

## Showing third-party text
- Post text, channel names and Buffer error messages are rendered in the browser only through `textContent`/text nodes (a unit test fails if `innerHTML` and friends appear in `public/app.js`).
- Server pages escape every dynamic value. CSP: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`. Plus nosniff, no-referrer, HSTS, X-Frame-Options DENY, COOP.

## Link checker (SSRF)
- Only links found by a scan of the user's own queue can be checked: `/api/scan` returns an HMAC signature per link bound to the session, and `/api/links` refuses unsigned links (tested with a metadata URL).
- Per hop: http/https only; ports 80, 443, 8080, 8443; no credentials in URLs; IP literals must be public unicast (IANA special-purpose registries, IPv4-mapped/NAT64/6to4 judged by the embedded IPv4); internal names (localhost, .local, .internal, metadata.google.internal ...) refused; the host is resolved with DNS-over-HTTPS (A and AAAA) and every address must be public; at most 5 redirects, each checked again; HEAD first, GET only if HEAD is refused, body never read (cancelled), 8 s per link, 40 subrequests per batch, 6 links per batch.
- Positive controls: unit tests prove the same harness does reach fetch for a public address and does not for a name resolving to 127.0.0.1 / fd00::, or for a redirect to 10.x / 169.254.169.254. `ops/ssrf_live_probe.mjs` repeats this with real DNS (localtest.me and 127.0.0.1.nip.io refused with 0 requests; buffer.com checked).
- Residual risk: DNS can change between our lookup and the runtime's (rebinding). Cloudflare Workers cannot reach private networks, which covers that window; the guard does not depend on it otherwise.

## Logs
- Only event names and counts (`connected`, `fix applied`, `token_exchange_failed` with Buffer's error code). No tokens, post text, links, emails or error messages that could echo input.

## Known limits
- KV is eventually consistent: a disconnected session can stay readable in another Cloudflare location for up to about 60 seconds.
- Channel avatars load from Buffer's image host (img-src https:).
- The link checker identifies itself as `LastLook/1.0`; some sites block it, and those links are reported as "probably fine" rather than broken.
