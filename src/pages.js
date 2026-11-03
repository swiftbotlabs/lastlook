/* Server-rendered pages. Only static text and values escaped with esc(). Post content is never rendered here:
   the app page is a shell, and public/app.js builds the queue view with textContent. */

export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const V = '20261103d';

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
      <div class="post-meta"><span class="when">Fri 14 Nov · 09:30</span><span class="badge">queue slot</span><span class="svc">X</span></div>
      <p class="post-text">Our spring sale ends <mark class="hl hl-high">tomorrow</mark>! <mark class="hl hl-med">**Everything**</mark> is 30% off. Shop now: <mark class="hl hl-high">shop.example/sprng-sale</mark></p>
      <ul class="flags">
        <li class="flag sev-high"><span class="dot" aria-hidden="true"></span><div><strong>Broken link (404 Not Found)</strong><p>Readers will land on an error page.</p></div></li>
        <li class="flag sev-high"><span class="dot" aria-hidden="true"></span><div><strong>“tomorrow” in a post with no fixed time</strong><p>At the current queue slot it means Sat 15 Nov. The sale ends Fri.</p></div></li>
        <li class="flag sev-med"><span class="dot" aria-hidden="true"></span><div><strong>Markdown bold will show as asterisks</strong><p>X does not render **bold**.</p></div></li>
      </ul>
      <div class="fix-row"><span class="btn btn-small" aria-hidden="true">Clean up formatting</span><span class="btn btn-small btn-quiet" aria-hidden="true">Move to drafts</span></div>
    </article>
  </section>

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
  <p class="lead">Last Look is a tool by Swift Bot Labs that checks the posts waiting in your Buffer queue. This page says exactly what it reads, what it keeps and for how long.</p>
  <h2>What Last Look asks Buffer for</h2>
  <ul>
    <li><strong>account:read</strong>: your organizations and channels (names, network, time zone, avatar), so posts can be judged per channel.</li>
    <li><strong>posts:read</strong>: your scheduled posts, posts awaiting approval and drafts: text, scheduled time, attached media type and alt text, link previews and first comments.</li>
    <li><strong>posts:write</strong>: used only when you press a fix button and then confirm. It edits that post’s text, moves it to drafts or moves it in the queue. Last Look never creates, publishes or deletes posts.</li>
  </ul>
  <h2>What is stored</h2>
  <ul>
    <li>A session record holding your Buffer access token, its expiry, a security token for your browser and your organization ids. It is encrypted (AES-256-GCM) with a key that needs both our server secret and the random session id in your browser cookie.</li>
    <li>It lives for at most one hour, matching Buffer’s access token, and is deleted the moment you press <strong>Disconnect</strong>.</li>
    <li>Your browser gets one cookie with the session id (HttpOnly, Secure, SameSite=Lax). During sign-in a second short-lived cookie (10 minutes) holds the one-time sign-in values.</li>
  </ul>
  <h2>What is not stored</h2>
  <ul>
    <li>Post text, media, links and check results exist only while a request is answered and in your open browser tab. Nothing is written to a database, a log or an analytics tool.</li>
    <li>No tracking, no ads, no third-party scripts. The page loads only from this site; channel avatars load from Buffer’s image host.</li>
    <li>Operational logs record events such as “connected” or “fix applied” with no post text, no links and no account details.</li>
  </ul>
  <h2>Links in your posts</h2>
  <p>To check a link, Last Look’s server asks a public DNS resolver (Cloudflare) for the link’s address and then requests the page once, the way a reader’s browser would, identifying itself as “LastLook”. Only the status (for example 200 or 404) and where it redirected are used. Links to private or internal addresses are never opened.</p>
  <h2>Disconnecting</h2>
  <p>Press <strong>Disconnect</strong> in the app to delete the session and token at once. You can also remove Last Look from the connected apps in your Buffer account settings, which revokes its access on Buffer’s side.</p>
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
  <p>Last Look reads every scheduled post, post awaiting approval and draft across your channels in one or two requests, then runs its checks in plain code. There is no AI model involved: every flag comes from a rule you can read below, so the same post always gets the same answer.</p>
  <h2>3. The checks</h2>
  <ul>
    <li><strong>Links.</strong> Each link is opened once (a HEAD request, then GET if the site refuses HEAD), following up to five redirects. Flags: 404 and 410, other 4xx errors, 5xx errors, no answer within 8 seconds, domains that do not exist, redirect loops, links that land on a sign-in page or on a different site, and links to private addresses such as localhost.</li>
    <li><strong>Time.</strong> Everything is judged at the scheduled send time in the channel’s time zone. Flags: written dates that will already be past (and whether they were still ahead when you wrote the post), a weekday that does not match its date, “today at 7pm” going out at 9pm, “Good morning” at night, “Happy Friday” or #ThrowbackThursday on the wrong day, holiday greetings out of season, and day words such as “tomorrow” in posts that sit in a queue slot, where the send time can move.</li>
    <li><strong>Formatting.</strong> **bold**, __bold__, ~~strike~~, # headings, [text](link), backticks, HTML tags and HTML codes such as &amp;amp;, on networks that show them as typed (X, Bluesky, LinkedIn, Threads, Mastodon, Facebook, Instagram, TikTok, Pinterest, YouTube, Google Business Profile). The fix suggests a clean version.</li>
    <li><strong>Length.</strong> Each network’s limit, counted the way that network counts, following Buffer’s published character limits: X 280 (25,000 on paid plans) with links as 23 and emoji as 2, Bluesky 300 counted as visible characters with links shortened, LinkedIn 3,000 with links as 24, Threads 500, Instagram 2,196 with line breaks as 2, Mastodon your server’s limit, and the rest.</li>
    <li><strong>Repeats.</strong> The same text, or text at least 80% alike, queued twice on one channel; and identical text on other channels at different times.</li>
    <li><strong>Leftovers.</strong> Template placeholders ([link], {{first_name}}, TODO), images without alt text, hashtags cut short by a hyphen or apostrophe, a space after @ or #, unmatched brackets, too many hashtags, and posts landing between 1 and 5 a.m.</li>
  </ul>
  <h2>4. Fix</h2>
  <p>Each flag offers the fixes that make sense for it: edit the text (with a suggested version where one can be made, a live character count and a word-by-word view of the change), move the post to drafts, or move a queue post to the top or bottom of its queue. Nothing is saved until you confirm. Before saving, Last Look reads the post again and stops if it changed in Buffer since your scan, or if it goes out in the next three minutes. Threads are left to Buffer’s editor so every part stays in step. Last Look never deletes a post.</p>
  <h2>Limits</h2>
  <ul>
    <li>Up to 300 queued posts per organization per scan.</li>
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
