/* Server-rendered pages. Only static text and values escaped with esc(). Post content is never rendered here:
   the app page is a shell, and public/app.js builds the queue view with textContent. */

export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const V = '20261103e';

const LOGO = '<svg class="logo" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><rect x="1" y="1" width="30" height="30" rx="8" class="logo-bg"/><path d="M6 17.5c2.6-4.4 6-6.6 10-6.6s7.4 2.2 10 6.6c-2.6 4.4-6 6.6-10 6.6s-7.4-2.2-10-6.6z" class="logo-eye"/><circle cx="16" cy="17.5" r="3.4" class="logo-pupil"/><path d="M9 8.2h14" class="logo-line"/></svg>';

function shell(title, body, opts) {
  const o = opts || {};
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="A last look at your Buffer queue before it posts: dead links, day words that will be wrong, Markdown that shows raw, over-long posts and repeats, each with a one-click fix.">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f6f3ee" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#14161a" media="(prefers-color-scheme: dark)">
${o.csrf ? `<meta name="csrf" content="${esc(o.csrf)}">` : ''}
${o.expires ? `<meta name="session-exp" content="${esc(String(o.expires))}">` : ''}
<link rel="icon" href="/icon.svg?v=${V}" type="image/svg+xml">
<link rel="stylesheet" href="/app.css?v=${V}">
${o.script ? `<script type="module" src="/app.js?v=${V}"></script>` : ''}
</head>
<body class="${o.bodyClass || ''}">
<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <a class="brand" href="/" aria-label="Last Look home">${LOGO}<span class="brand-name">Last Look</span></a>
  <nav class="top-nav" aria-label="Site">${o.nav || '<a href="/about">How it works</a><a href="/privacy">Privacy</a>'}</nav>
</header>
${body}
<footer class="foot">
  <p>Last Look by Swift Bot Labs. Uses the Buffer API; not made by or affiliated with Buffer.</p>
  <p><a href="/about">How it works</a> · <a href="/privacy">Privacy</a></p>
</footer>
</body>
</html>`;
}

export function landingPage() {
  return shell('Last Look for Buffer', `
<main id="main" class="landing">
  <div class="hero-wrap">
  <section class="hero">
    <p class="eyebrow">For your Buffer queue</p>
    <h1>Catch the embarrassing post before your audience does.</h1>
    <p class="lead">Last Look reads every post waiting in your Buffer queue and flags what would make you wince once it is live: a dead link, a “tomorrow” that will mean the wrong day, Markdown that shows up as asterisks, a post too long for the network, the same post queued twice. Fix each one in a click. Nothing changes until you confirm.</p>
    <div class="cta-row">
      <a class="btn btn-primary btn-lg" href="/oauth/start">Connect Buffer</a>
      <a class="btn btn-quiet" href="/about">See how it works</a>
    </div>
    <ul class="trust" aria-label="Promises">
      <li>Reads your queue, changes nothing on its own</li>
      <li>Never deletes a post</li>
      <li>Keeps no copy of your posts</li>
    </ul>
  </section>

  <section class="demo" aria-label="Example of a flagged post">
    <article class="post demo-post">
      <div class="post-meta"><span class="when">Fri 13 Nov · 09:30</span><span class="badge">queue slot</span><span class="svc">X</span></div>
      <p class="post-text">Our autumn sale ends <mark class="hl hl-med">tomorrow</mark>! <mark class="hl hl-med">**Everything**</mark> is 30% off. Shop now: <mark class="hl hl-high">shop.example/sprng-sale</mark></p>
      <ul class="flags">
        <li class="flag sev-high"><span class="dot" aria-hidden="true"></span><div><strong>Broken link (404 Not Found)</strong><p>Readers will land on an error page.</p></div></li>
        <li class="flag sev-med"><span class="dot" aria-hidden="true"></span><div><strong>“tomorrow” in a post with no fixed time</strong><p>Queue times move. At the current slot “tomorrow” means Sat 14 Nov.</p></div></li>
        <li class="flag sev-med"><span class="dot" aria-hidden="true"></span><div><strong>Markdown bold will show as asterisks</strong><p>X does not render **bold**.</p></div></li>
      </ul>
      <div class="fix-row"><span class="btn btn-small" aria-hidden="true">Clean up formatting</span><span class="btn btn-small btn-quiet" aria-hidden="true">Move to drafts</span></div>
    </article>
  </section>
  </div>

  <section class="checks">
    <h2>What it looks for</h2>
    <div class="grid">
      <div class="card"><h3>Dead links</h3><p>Every link is opened the way a reader would: 404s, server errors, domains that no longer exist, redirect loops, links to localhost.</p></div>
      <div class="card"><h3>Day words that drift</h3><p>“Today”, “tonight”, “this weekend”, “Happy Friday” and dates that will already be past, judged at the moment the post goes out, in the channel’s time zone.</p></div>
      <div class="card"><h3>Formatting that shows raw</h3><p>**bold**, # headings, [text](links), HTML tags and &amp;amp; codes on networks that print them as typed.</p></div>
      <div class="card"><h3>Too long for the network</h3><p>Counted the way each network counts: X weights links and emoji, Bluesky counts what you see, LinkedIn counts every link as 24.</p></div>
      <div class="card"><h3>Queued twice</h3><p>The same or nearly the same text on one channel, and copies across channels at different times.</p></div>
      <div class="card"><h3>Leftovers</h3><p>[link], {{first_name}}, TODO, images without alt text, hashtags cut short by a hyphen.</p></div>
    </div>
  </section>

  <section class="fixes">
    <h2>One click to fix, one more to confirm</h2>
    <ol class="steps">
      <li><strong>Edit the text.</strong> Last Look suggests the cleaned-up version where it can and shows exactly what changes before anything is saved.</li>
      <li><strong>Move to drafts.</strong> Pull a post out of the schedule without losing it.</li>
      <li><strong>Move in the queue.</strong> Send a repeat to the back of the queue.</li>
    </ol>
    <p class="note">Every change goes through Buffer’s own API, only when you press confirm, and only on the post you picked.</p>
    <p><a class="btn btn-primary" href="/oauth/start">Connect Buffer</a></p>
  </section>
</main>`, {});
}

export function appPage(o) {
  const nav = '<span class="who" id="who">' + (o.name ? 'Connected as ' + esc(o.name) : 'Connected to Buffer') + '</span><button type="button" class="btn btn-small btn-quiet" id="disconnect">Disconnect</button>';
  return shell('Last Look: your queue', `
<main id="main" class="app">
  <section class="summary" aria-live="polite">
    <div class="summary-main">
      <h1 id="headline">Reading your queue…</h1>
      <p id="subline" class="muted">This takes a few seconds.</p>
    </div>
    <div class="summary-actions">
      <button type="button" class="btn" id="rescan" disabled>Scan again</button>
    </div>
  </section>
  <div class="toolbar" role="group" aria-label="Show">
    <button type="button" class="chip" id="f-flagged" aria-pressed="true">Needs a look</button>
    <button type="button" class="chip" id="f-all" aria-pressed="false">All posts</button>
    <label class="toggle"><input type="checkbox" id="f-notes"> Show notes</label>
    <span class="links-status muted" id="links-status" aria-live="polite"></span>
  </div>
  <div id="queue" class="queue"><div class="skeleton" aria-hidden="true"><div></div><div></div><div></div></div></div>
  <p class="session-note muted" id="session-note"></p>
</main>
<dialog id="dlg" aria-labelledby="dlg-title">
  <form method="dialog" class="dlg-body" id="dlg-form">
    <h2 id="dlg-title">Edit post</h2>
    <p id="dlg-desc" class="muted"></p>
    <div id="dlg-edit">
      <label for="dlg-text" class="lbl">New text</label>
      <textarea id="dlg-text" rows="7" spellcheck="true"></textarea>
      <p class="counter" id="dlg-count" aria-live="polite"></p>
      <p class="lbl">What changes</p>
      <div class="diff" id="dlg-diff" aria-live="polite"></div>
    </div>
    <p class="dlg-error" id="dlg-error" role="alert" hidden></p>
    <div class="dlg-actions">
      <button type="button" class="btn btn-quiet" id="dlg-cancel" value="cancel">Cancel</button>
      <button type="button" class="btn btn-primary" id="dlg-ok">Save to Buffer</button>
    </div>
  </form>
</dialog>
<div class="toast" id="toast" role="status" aria-live="polite" hidden></div>`, { csrf: o.csrf, expires: o.expires, script: true, nav, bodyClass: 'is-app' });
}

export function privacyPage() {
  return shell('Privacy · Last Look', `
<main id="main" class="prose">
  <h1>Privacy</h1>
  <p class="lead">Last Look is a tool by Swift Bot Labs that checks the posts waiting in your Buffer queue. This page says exactly what it reads, what it keeps, for how long, and what it logs.</p>

  <h2>What Last Look asks Buffer for</h2>
  <ul>
    <li><strong>account:read</strong>: your account id and display name, and your organizations and channels (name, network, time zone, avatar), so posts can be judged per channel.</li>
    <li><strong>posts:read</strong>: your scheduled posts, posts awaiting approval and drafts: text, scheduled time, attached media type and alt text, link previews and first comments.</li>
    <li><strong>posts:write</strong>: used only when you press a fix button and then confirm. It edits that one post’s text, moves it to drafts, or moves it to the front or end of its queue. Last Look never creates, publishes or deletes posts.</li>
  </ul>

  <h2>Where the checks run</h2>
  <p>Our server fetches your queue from Buffer and passes it straight to your browser. The checks themselves run in your browser tab. The server does not keep the posts after answering.</p>

  <h2>What is stored, and for how long</h2>
  <ul>
    <li><strong>Your session</strong> (encrypted with AES-256-GCM, under a key that needs both our server secret and the random session id held only in your browser’s cookie): your Buffer access token and its expiry, a security token for your browser, a one-way hash of your Buffer account id, your organizations’ ids and names (up to five), your Buffer display name, whether Buffer granted editing, and when the session started. It lives at most one hour, matching Buffer’s access token.</li>
    <li><strong>Usage counters</strong>, stored under the one-way hash of your account id: a hash of your current session id, the time of your last scan, and today’s number of scans, fixes, link checks and sign-ins. They contain no content and reset every day (UTC); they let us limit use so the app stays available to everyone.</li>
    <li><strong>For one minute only</strong>: a hash of each link we checked for you (so the same link is not fetched twice within a minute) and, per linked website (for example “example.com”), how many checks it received in that minute across all users.</li>
    <li><strong>App-wide</strong>: how many requests Buffer still allows this app, read from Buffer’s replies.</li>
    <li><strong>In your browser</strong>: one cookie with the session id (HttpOnly, Secure, SameSite=Lax). During sign-in a second cookie lives for at most 10 minutes with one-time sign-in values.</li>
  </ul>

  <h2>What is not stored</h2>
  <ul>
    <li>Post text, media, links in readable form, and check results are not written to any database, file or log.</li>
    <li>No tracking, no ads, no third-party scripts. The page loads only from this site. Channel avatars load in your browser from Buffer’s image hosts (buffer-channel-avatars-bucket.s3.amazonaws.com, *.buffer.com, *.bufferapp.com); avatars hosted anywhere else are not shown.</li>
  </ul>

  <h2>Logs</h2>
  <p>Request logging on Cloudflare (Workers Logs and invocation logs) is switched off for Last Look, so no request URLs, IP addresses or headers are kept by us. Our code writes short event lines such as “connected”, “fix applied” or “disconnected”, with no ids, text, links or tokens; with logging off they are not stored and can only be watched live by the operator. Cloudflare still keeps aggregate counts (requests, errors, CPU time) for the service.</p>

  <h2>How links in your posts are checked</h2>
  <p>Our server looks the link’s domain up with Cloudflare’s public DNS resolver, then sends one HEAD request, identifying itself as “LastLook”. Only if the site answers that it does not support HEAD (405 or 501) does it send one GET request, and the response body is never read. It follows at most three redirects, checking each one the same way. Only the status (for example 200 or 404) and where it redirected are used. Links to private or internal addresses, and links written as bare IP addresses, are never opened. Each link is checked at most once a minute for your account, up to 300 checks a day.</p>

  <h2>Disconnecting</h2>
  <p>Press <strong>Disconnect</strong> to delete your session and its Buffer token from our store and unregister it at once. From that moment the session is refused, even though a cached copy of the deleted record can linger in Cloudflare’s storage for up to about a minute. Signing in again also ends any older Last Look session of the same Buffer account. To revoke Last Look’s access on Buffer’s side, remove it from the connected apps in your Buffer account settings.</p>

  <h2>Limits</h2>
  <p>To keep Last Look available for everyone: one scan a minute, 20 scans and 40 fixes a day per account, and new scans pause when Buffer’s request allowance for this app runs low.</p>

  <h2>Who runs it</h2>
  <p>Swift Bot Labs, contact <a href="mailto:swiftbotlabs@gmail.com">swiftbotlabs@gmail.com</a>. Last Look runs on Cloudflare Workers. It is not made by or affiliated with Buffer.</p>
  <p class="muted">Last updated 3 November 2026.</p>
</main>`, {});
}

export function aboutPage() {
  return shell('How it works · Last Look', `
<main id="main" class="prose">
  <h1>How Last Look works</h1>
  <p class="lead">Scheduling posts in advance is how good social media gets done, and it is also how a post that was right on Monday goes out wrong on Thursday. Last Look is the pre-flight check: one look at everything queued, with the problems pulled to the top.</p>
  <h2>1. Connect</h2>
  <p>You sign in with Buffer (OAuth with PKCE). Last Look gets a token that lasts about an hour. It can read your queue, and it can change a post only when you press a fix and confirm it.</p>
  <h2>2. Scan</h2>
  <p>Last Look reads every scheduled post, post awaiting approval and draft across your channels in one to three requests, and your browser runs the checks in plain code. There is no AI model involved: every flag comes from a rule you can read below, so the same post always gets the same answer.</p>
  <h2>3. The checks</h2>
  <ul>
    <li><strong>Links.</strong> Each link gets one HEAD request (one GET only if the site says it does not support HEAD), following up to three redirects. Flags: 404 and 410, other 4xx errors, 5xx errors, no answer within 8 seconds, domains that do not exist, more than three redirects, links that land on a sign-in page or on a different site, links to private addresses such as localhost, and links written as bare IP addresses (noted, not opened).</li>
    <li><strong>Time.</strong> Everything is judged at the scheduled send time in the channel’s time zone. Flags: written dates that will already be past (and whether they were still ahead when you wrote the post), a weekday that does not match its date, “today at 7pm” going out at 9pm, “Good morning” at night, “Happy Friday” or #ThrowbackThursday on the wrong day, holiday greetings out of season, and day words such as “tomorrow” in posts that sit in a queue slot, where the send time can move.</li>
    <li><strong>Formatting.</strong> **bold**, __bold__, ~~strike~~, # headings, [text](link), backticks, HTML tags and HTML codes such as &amp;amp;, on networks that show them as typed (X, Bluesky, LinkedIn, Threads, Mastodon, Facebook, Instagram, TikTok, Pinterest, YouTube, Google Business Profile). The fix suggests a clean version.</li>
    <li><strong>Length.</strong> Each network’s limit, counted the way that network counts, following Buffer’s published character limits: X 280 (25,000 on paid plans) with links as 23 and emoji as 2, Bluesky 300 counted as visible characters with links shortened, LinkedIn 3,000 with links as 24, Threads 500, Instagram 2,196 with line breaks as 2, Mastodon your server’s limit, and the rest.</li>
    <li><strong>Repeats.</strong> The same text, or text at least 80% alike, queued twice on one channel; and identical text on other channels at different times. On very large queues the near-match comparison stops early and says so.</li>
    <li><strong>Leftovers.</strong> Template placeholders ([link], {{first_name}}, TODO), images without alt text, hashtags cut short by a hyphen or apostrophe, a space after @ or #, unmatched brackets, too many hashtags, and posts landing between 1 and 5 a.m.</li>
  </ul>
  <h2>4. Fix</h2>
  <p>Each flag offers the fixes that make sense for it: edit the text (with a suggested version where one can be made, a live character count and a word-by-word view of the change), move the post to drafts, or move a queue post to the top or bottom of its queue. Nothing is saved until you confirm. Before saving, Last Look reads the post again and stops if it changed in Buffer since your scan, or if it goes out in the next three minutes. Threads are left to Buffer’s editor so every part stays in step. After a fix, that one post is updated on the page from Buffer’s answer and checked again; nothing else is re-read. Last Look never deletes a post.</p>
  <h2>Limits</h2>
  <ul>
    <li>Up to 300 queued posts per scan (three requests to Buffer), one scan a minute, 20 scans and 40 fixes a day per account.</li>
    <li>Some sites block automated visitors; those links are marked as “probably fine, open it once” rather than broken.</li>
    <li>Day words are a judgment call. When a post has its own fixed time, Last Look only notes what “tomorrow” will mean, it does not call it wrong.</li>
  </ul>
  <p><a class="btn btn-primary" href="/oauth/start">Connect Buffer</a></p>
</main>`, {});
}

export function errorPage(title, message, withRetry) {
  return shell(title + ' · Last Look', `
<main id="main" class="prose narrow">
  <h1>${esc(title)}</h1>
  <p class="lead">${esc(message)}</p>
  <p>${withRetry ? '<a class="btn btn-primary" href="/oauth/start">Start again</a> ' : ''}<a class="btn btn-quiet" href="/">Back to Last Look</a></p>
</main>`, {});
}
