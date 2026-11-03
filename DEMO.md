# Last Look: 3-minute demo script

Screen recording at 1280x800 (desktop) plus one 390 px phone segment. Narration in plain sentences; captions optional.

## Before recording (2 minutes)

1. Seed the queue on a test channel with the posts below. Schedule each with a **custom time at least 20 days out** (never "add to queue", never "share now") and put one in drafts. `ops/testposts.py create` does exactly this through the API.
   - Links: `Launch notes are up: https://httpbin.org/status/404 and the old admin page http://127.0.0.1:8080/admin plus https://buffer.com/ and https://lastlook-no-such-domain-zz9.com/x`
   - Formatting: `**Big news**: our [new guide](https://buffer.com/resources) is live.` / `## Read it now &amp; share`
   - Time (send on a Monday evening): `Sale ends Friday, November 20! Last chance was Nov 2. Happy Friday and good morning, everyone.`
   - Near-duplicates (two days apart): `We just shipped dark mode. Try it and tell us what you think!` and `We just shipped dark mode! Try it today and tell us what you think.`
   - Edit target: `Edit me: **this** should become plain text.`
   - Over-length draft: any text over 300 characters on Bluesky.
2. Sign out of Last Look (Disconnect) so the recording starts on the landing page.
3. After recording: delete every seeded post (`ops/testposts.py delete` checks the marker first) and confirm the queue is back to what it was.

## Script

| Time | Screen | Say |
| --- | --- | --- |
| 0:00-0:12 | Landing page, hero | "You schedule posts days ahead. By the time they go out, a link has died, 'tomorrow' means the wrong day, or the Markdown you pasted shows up as asterisks. Last Look is the pre-flight check for your Buffer queue." |
| 0:12-0:30 | Click **Connect Buffer**; Buffer consent screen, expand the permissions; tick the URL box; **Connect** | "It signs in with Buffer OAuth and PKCE. It asks to read your account and posts, and to manage posts, which it only uses when you press a fix and confirm it." |
| 0:30-0:45 | App loads: "6 posts need a look", link status counting up | "One request reads every scheduled post, approval and draft across your channels. Links are checked while you read." |
| 0:45-1:05 | Links post: 404, private address, domain that does not exist | "Every link is opened the way a reader would: this one is a 404, this one points at localhost, and this domain does not exist. Links to private addresses are never fetched." |
| 1:05-1:25 | Time post: past date, "Happy Friday" on a Monday, "good morning" at 21:42 | "Time is judged at the send time, in the channel's time zone. This sale ended ten days before the post goes out, it says Happy Friday on a Monday, and good morning at 9:42 at night." Click **Say Monday**, show the diff, Cancel. |
| 1:25-1:55 | Formatting post: one grouped flag. Click **Clean up formatting**: diff shows ** and ## removed, the link rewritten, &amp; fixed; counter "x / 300 for Bluesky"; **Save to Buffer**; toast; rescan, the post leaves the list | "Bluesky does not render Markdown or HTML. Last Look suggests the clean version, shows exactly what changes, and saves only the text: the schedule stays as it is." |
| 1:55-2:15 | Over-length draft: "Too long for Bluesky by 123". **Edit text**, trim, the counter turns from red to normal | "Length is counted the way each network counts: Bluesky counts what you see and shortens links, X weights links and emoji, LinkedIn counts every link as 24." |
| 2:15-2:35 | Near-duplicate: "Nearly the same text queued twice (93% alike)" on the later post; **Move to drafts**, confirm dialog, toast | "Two almost identical posts two days apart. Move the later one to drafts: it stays in Buffer, out of the schedule. Last Look never deletes anything." |
| 2:35-2:50 | Phone (390 px): same queue, flags, a fix button; then **Disconnect** | "It works on a phone. Sessions last an hour at most and Disconnect deletes the token at once. No copy of your posts is kept." |
| 2:50-3:00 | About page, the list of checks | "Plain rules, no guesswork, built on Buffer's GraphQL API: posts, editPost and movePostInQueue. Last Look." |

## Shots to capture for the write-up
- Consent screen with permissions expanded.
- Desktop queue with the links post and the time post.
- Edit dialog with the diff and the counter.
- Phone view of a flagged post.
