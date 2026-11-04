# Last Look: how to demo it safely

## Without an account
Open https://lastlook.swiftbotlab.workers.dev/try. "Your own post" checks what you type as you type; "Sample queue" is a made-up studio's queue with every check firing, where edits, drafts and reorders work (switch to "All posts" and press "Move to end of queue" on the sale post: it takes the last slot, days later, and its "tomorrow" is re-checked). Nothing on /try talks to a server.

## On a real Buffer account, without anything going out
1. Use a test channel. In Buffer, open the channel's settings, General, and turn **Pause Queue** on. Buffer: "A paused queue means scheduled posts won't be published."
2. Add a few posts to the queue (queue slots, not "share now"), for example:
   - `Open studio night is tomorrow at 7pm: wheel demos, tea and the new glazes. See you there!`
   - `Last call: our autumn sale ends tomorrow. Every mug and bowl is 20% off until midnight.`
   - `**New** speckled mugs are in the shop: https://httpbin.org/status/404`
3. Connect Last Look with Buffer. The scan flags the 404, the raw `**` on Bluesky and the day words in queue slots.
4. Fix: "Clean up formatting" on the mugs post (an `editPost`, with a word diff and Undo for two minutes).
5. Reorder: "Move to end of queue" on the sale post (a `movePostInQueue`). Buffer gives it the last slot, a day later; Last Look re-reads the queue and re-checks every post that moved: "ends tomorrow" now means the day after the sale, and "Say today" fixes it. (Moving a post to the front sets it to share next, with no time: on a queue that is not paused that can mean right away.)
6. Daily digest tab: turn it on (a separate, read-only Buffer connection), open the digest page and the feed; turn it off with one click.
7. Afterwards: delete the test posts in Buffer, then turn Pause Queue off again.
