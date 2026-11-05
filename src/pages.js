/* Server-rendered pages. Only static text and values escaped with esc(). Post content from Buffer is never rendered
   here: the app page is a shell, and public/app.js builds the queue view with textContent. The one exception is our
   own made-up /try sample, rendered escaped by trystatic.js for readers without JavaScript. */

import { trySample, heroSample } from './trystatic.js';

export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const V = '20261106a';

const LOGO = '<svg class="logo" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><rect x="1" y="1" width="30" height="30" rx="8" class="logo-bg"/><path d="M6 17.5c2.6-4.4 6-6.6 10-6.6s7.4 2.2 10 6.6c-2.6 4.4-6 6.6-10 6.6s-7.4-2.2-10-6.6z" class="logo-eye"/><circle cx="16" cy="17.5" r="3.4" class="logo-pupil"/><path d="M9 8.2h14" class="logo-line"/></svg>';

function shell(title, body, opts) {
  const o = opts || {};
  return `<!doctype html>
<html lang="en"${o.htmlAttrs || ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="A last look at your Buffer queue before it posts: dead links, day words that will be wrong, Markdown that shows raw, over-long posts and repeats, each with a one-click fix.">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f1f2ef" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#151617" media="(prefers-color-scheme: dark)">
${o.metas || ''}${o.csrf ? `<meta name="csrf" content="${esc(o.csrf)}">` : ''}
${o.expires ? `<meta name="session-exp" content="${esc(String(o.expires))}">` : ''}
${o.mode ? `<meta name="mode" content="${esc(o.mode)}">` : ''}
<link rel="icon" href="/icon.svg?v=${V}" type="image/svg+xml">
<link rel="preload" href="/fonts/archivo.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/app.css?v=${V}">
${o.bare ? '' : `<script src="/boot.js?v=${V}"></script>`}
${o.script ? `<script type="module" src="/app.js?v=${V}"></script>` : ''}${o.site ? `<script type="module" src="/site.js?v=${V}"></script>` : ''}
</head>
<body class="${o.bodyClass || ''}">
<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <div class="top-in">
    <a class="brand" href="/" aria-label="Last Look home">${LOGO}<span class="brand-name">Last Look</span></a>
    <nav class="top-nav" aria-label="Site">${o.nav || '<a href="/about">How it works</a><a href="/privacy">Privacy</a><a class="btn btn-small btn-primary top-cta" href="/oauth/start">Connect Buffer</a>'}</nav>
    ${o.bare ? '' : `<button type="button" class="theme" id="theme" aria-pressed="false" aria-label="Dark mode" title="Dark mode"><svg class="ic-sun" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></svg><svg class="ic-moon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M19.5 14.6A8 8 0 0 1 9.4 4.5a8 8 0 1 0 10.1 10.1z"/></svg></button>`}
  </div>
</header>
${body}
<footer class="foot">
  <div class="foot-in">
    <p>Last Look by Swift Bot Labs. Uses the Buffer API; not made by or affiliated with Buffer.</p>
    <p class="foot-links"><a href="/about">How it works</a><a href="/privacy">Privacy</a><a href="/try">Try it</a></p>
  </div>
</footer>
</body>
</html>`;
}

/* channel icons (real logos, self-hosted); X and Threads are one-colour marks and flip in dark mode */
const ICONS = { twitter: ['x', 'X', true], linkedin: ['linkedin', 'LinkedIn'], bluesky: ['bluesky', 'Bluesky'], instagram: ['instagram', 'Instagram'], threads: ['threads', 'Threads', true], mastodon: ['mastodon', 'Mastodon'] };
const icon = (svc, cls) => { const i = ICONS[svc]; return i ? `<img class="ic${i[2] ? ' ic-ink' : ''}${cls ? ' ' + cls : ''}" src="/icons/${i[0]}.svg?v=${V}" alt="" width="16" height="16" loading="lazy" decoding="async">` : ''; };

/* the edge print a frame carries: channel, send time, how it is scheduled */
const edge = (svc, name, when, slot) => `<div class="edge" aria-label="${esc(name + ', ' + when + ', ' + slot)}">${icon(svc)}<span class="edge-ch">${esc(name)}</span><span class="edge-when">${esc(when)}</span><span class="edge-slot">${esc(slot)}</span></div>`;

function heroFrame(f, i) {
  const flags = f.flags.map((x, k) => `<li class="flag ${x.sev === 'high' ? 'sev-high' : 'sev-med'}" data-k="${k}"><span class="dot" aria-hidden="true"></span><div class="flag-body"><span class="sev">${esc(x.word)}</span><strong>${esc(x.title)}</strong></div></li>`).join('');
  const body = f.flags.length
    ? `<ul class="flags">${flags}</ul>${f.fix ? `<div class="fix-row"><span class="btn btn-small hero-fix" aria-hidden="true">${esc(f.fix)}</span><span class="btn btn-small btn-quiet" aria-hidden="true">Edit text</span></div>` : ''}`
    : '<p class="clear-line"><svg class="ok-tick" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4.5 12.8l4.6 4.4L19.6 6.6"/></svg>Nothing to fix in this post.</p>';
  return `<article class="post frame${f.flags.length ? '' : ' is-clear'}" data-frame="${i}">${edge(f.service, f.channel, f.when, f.slot)}<p class="post-text">${f.textHtml}</p>${body}</article>`;
}

export function landingPage(now) {
  const h = heroSample(now);
  const back = h.back;
  const caught = back.issues ? 'Last Look would have caught ' + back.issues + ' issue' + (back.issues === 1 ? '' : 's') + ' in the studio’s last ' + back.checked + ' sent post' + (back.checked === 1 ? '' : 's') : '';
  const metas = '<meta name="page-type" content="software">\n<meta name="site-kind" content="software">\n';
  return shell('Last Look for Buffer', `
<main id="main" class="landing">
  <section class="hero" aria-labelledby="hero-h">
    <div class="wrap hero-grid">
      <div class="hero-copy">
        <p class="hero-fact">Up to 300 queued posts a scan, each judged at its own send time.</p>
        <h1 id="hero-h">Pre-publish checks for your Buffer queue</h1>
        <p class="lead">Last Look reads every post waiting in your Buffer queue and flags what would make you wince once it is live. Fix each one in a click. Nothing changes until you confirm.</p>
        <div class="cta-row hero-cta">
          <a class="btn btn-primary btn-lg" href="/oauth/start">Connect Buffer</a>
          <a class="btn btn-lg" href="/try">Try it on your own post</a>
        </div>
        <p class="hero-alt muted">Trying it needs no sign-in. Or <a href="/try#sample">browse a sample queue</a>.</p>
      </div>
      <div class="table" id="table" data-ui role="group" aria-label="Three posts from the sample queue, checked by Last Look">
        <div class="rebate rebate-top" aria-hidden="true"><span>Sample queue</span><span>Little Kiln Studio, made up for this demo</span><span>checked by the same code as /try</span></div>
        <div class="strip">${h.frames.slice(0, 2).map(heroFrame).join('')}</div>
        <div class="result" aria-live="off"><p class="result-h">${esc(h.headline)}</p><p class="result-s">${esc(h.subline)}</p><a class="result-a" href="/try#sample">Open the sample queue</a></div>
        <button type="button" class="replay" id="replay" hidden><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4.5v4h4"/></svg>Replay</button>
      </div>
    </div>
  </section>

  <section class="sheet" id="checks" aria-labelledby="checks-h">
    <div class="wrap">
      <h2 id="checks-h">What it looks for in every queued post</h2>
      <p class="sub">Every rule is plain code, judged at the moment the post goes out, in the channel’s time zone.</p>
      <div class="contact" data-ui>
        <article class="cframe big">
          ${edge('twitter', 'X', 'Mon 09:30', 'queue slot')}
          <p class="snip">Last pieces here: <mark class="hl hl-high">shop.littlekiln.example/autumn-sale</mark></p>
          <h3>Dead links</h3>
          <p>Every link is opened the way a reader would: 404s, server errors, domains that no longer exist, redirect loops, links to localhost.</p>
          <p class="cframe-result"><span class="code">404</span> Readers will land on an error page.</p>
        </article>
        <article class="cframe">
          ${edge('bluesky', 'Bluesky', 'Wed 19:30', 'custom time')}
          <p class="snip">Doors open <mark class="hl hl-high">today at 6pm</mark></p>
          <h3>Day words that drift</h3>
          <p>“Today”, “tonight”, “this weekend”, “Happy Friday” and dates that will already be past, judged at the moment the post goes out, in the channel’s time zone.</p>
        </article>
        <article class="cframe">
          ${edge('linkedin', 'LinkedIn', 'Tue 20:15', 'custom time')}
          <p class="snip"><mark class="hl hl-med">**We’re hiring**</mark></p>
          <h3>Formatting that shows raw</h3>
          <p>**bold**, # headings, [text](links), HTML tags and &amp;amp; codes on networks that print them as typed.</p>
        </article>
        <article class="cframe">
          ${edge('twitter', 'X', 'Fri 15:00', 'custom time')}
          <p class="snip"><span class="count over">328</span><span class="count-of"> / 280</span></p>
          <h3>Too long for the network</h3>
          <p>Counted the way each network counts: X weights links and emoji, Bluesky counts what you see, LinkedIn counts every link as 24.</p>
        </article>
        <article class="cframe">
          ${edge('twitter', 'X', 'Tue and Thu 09:30', 'queue slot')}
          <p class="snip"><span class="twice">The new speckled bowls are out of the kiln.</span><span class="twice ghost" aria-hidden="true">The new speckled bowls are out of the kiln.</span></p>
          <h3>Queued twice</h3>
          <p>The same or nearly the same text on one channel, and copies across channels at different times.</p>
        </article>
        <article class="cframe">
          ${edge('linkedin', 'LinkedIn', 'Mon 11:00', 'custom time')}
          <p class="snip">Hi <mark class="hl hl-high">{{first_name}}</mark>, … Grab a spot before they fill up: <mark class="hl hl-high">[link]</mark></p>
          <h3>Leftovers</h3>
          <p>[link], {{first_name}}, TODO, images without alt text, hashtags cut short by a hyphen.</p>
        </article>
        <article class="cframe">
          ${edge('instagram', 'Instagram', 'Thu 12:00', 'queue slot')}
          <p class="snip">Fresh out of the kiln: speckled mugs… <span class="rule-tag">#littlekiln</span></p>
          <h3>Your channel rules</h3>
          <p>Phrases a channel never uses, with a word to say instead, and tags every post must carry. Saved in your browser only.</p>
        </article>
      </div>
    </div>
  </section>

  <section class="how" id="how" aria-labelledby="how-h">
    <div class="wrap">
      <h2 id="how-h">How a last look works, from sign-in to fix</h2>
      <ol class="steps">
        <li class="step" data-step="connect">
          <div class="step-copy"><h3>Connect with Buffer</h3><p>You sign in with Buffer (OAuth with PKCE). Last Look gets a token that lasts about an hour: it can read your queue, and change a post only when you press a fix and confirm it.</p></div>
          <div data-ui class="stage stage-connect" aria-hidden="true">
            <div class="consent"><p class="consent-h">Last Look asks Buffer for</p><ul class="scopes"><li><span class="scope">account:read</span>your channels and their time zones</li><li><span class="scope">posts:read</span>scheduled posts, approvals and drafts</li><li><span class="scope">posts:write</span>only when you confirm a fix</li></ul><p class="consent-f">Never creates, publishes or deletes a post.</p></div>
          </div>
        </li>
        <li class="step" data-step="scan">
          <div class="step-copy"><h3>Scan the whole queue</h3><p>Every scheduled post, post awaiting approval and draft across your channels, in one to three requests. Your browser runs the checks in plain code, so the same post always gets the same answer.</p></div>
          <div data-ui class="stage stage-scan" aria-hidden="true">
            <div class="rows">
              <div class="row"><span class="r-when">Mon 09:30</span>${icon('twitter')}<span class="r-text">Happy Friday, makers! Our autumn glaze sale…</span><span class="r-n sev-high">3</span></div>
              <div class="row"><span class="r-when">Tue 20:15</span>${icon('linkedin')}<span class="r-text">Good morning, everyone! **We’re hiring**…</span><span class="r-n sev-med">3</span></div>
              <div class="row"><span class="r-when">Wed 12:30</span>${icon('linkedin')}<span class="r-text">Our spring term is now open for booking…</span><span class="r-n sev-ok">OK</span></div>
              <div class="row"><span class="r-when">Wed 19:30</span>${icon('bluesky')}<span class="r-text">Wheel-throwing taster night is back!…</span><span class="r-n sev-high">2</span></div>
            </div>
            <div class="scanbar"></div>
          </div>
        </li>
        <li class="step" data-step="fix">
          <div class="step-copy"><h3>Fixes through Buffer’s own API</h3><p>Edit the text with a suggested clean version and a word-by-word view of the change, move the post to drafts, or move it in the queue. Every change goes through Buffer’s own API, only when you press confirm, and only on the post you picked. Undo stays for two minutes after an edit.</p></div>
          <div data-ui class="stage stage-fix" aria-hidden="true">
            <p class="dlg-mini-h">What changes</p>
            <p class="diff-mini">Happy <del>Friday</del><ins>Monday</ins>, makers! Our autumn glaze sale ends tomorrow…</p>
            <div class="fix-row"><span class="btn btn-small btn-quiet">Cancel</span><span class="btn btn-small btn-primary">Save to Buffer</span></div>
          </div>
        </li>
        <li class="step" data-step="move">
          <div class="step-copy"><h3>Re-checks after a queue move</h3><p>Moved a post? Last Look reads that channel’s queue again and re-checks the day words of every post whose time changed: a “tomorrow” that meant Friday at the old slot is flagged when it now means Saturday, with a one-click word that keeps Friday.</p></div>
          <div data-ui class="stage stage-move" aria-hidden="true">
            <div class="board">
              <div class="b-row moved"><span class="b-text">Doors open <mark class="hl hl-med">tomorrow</mark> at noon</span><span class="b-time"><span class="b-old">Thu 09:30</span><span class="b-new">Fri 09:30</span></span></div>
              <div class="b-row"><span class="b-text">New mugs in the shop</span><span class="b-time"><span class="b-old">Fri 09:30</span><span class="b-new">Thu 09:30</span></span></div>
            </div>
            <p class="b-flag"><span class="dot" aria-hidden="true"></span>Moved to the end: “tomorrow” meant Friday, now Saturday. Say “Friday” to keep the day.</p>
          </div>
        </li>
      </ol>
    </div>
  </section>

  <section class="after" id="after" aria-labelledby="after-h">
    <div class="wrap after-grid">
      <h2 id="after-h">Look back and the daily digest</h2>
      <div class="after-back">
        <h3>Look back at sent posts</h3>
        <p>After you connect, Look back reads your most recent sent posts (up to 90) and runs the text checks on them, each judged at the moment it went out. It only reads.</p>
        ${caught ? `<div class="ledger" data-ui><p class="caught"><span class="caught-n">${esc(String(back.issues))}</span><span class="caught-t">${esc(caught)}, on the sample.</span></p><ul class="lb-rows">${h.groups.map((g) => `<li><span>${esc(g.title)}</span><span class="lb-n">${g.n}</span></li>`).join('')}</ul></div>` : ''}
        <p><a class="btn" href="/try#sample">See Look back on the sample</a></p>
      </div>
      <div class="after-digest">
        <h3>The daily digest, if you want it</h3>
        <p>Tomorrow’s catches every day at the hour you pick, on a private page and a feed for Slack, a feed reader or your inbox. Read-only, off until you turn it on, one click to turn off.</p>
        <div class="flow" data-ui aria-hidden="true">
          <div class="node n-queue"><span class="node-t">Your queue</span><span class="node-s">read once a day</span></div>
          <div class="wire w1"><i></i></div>
          <div class="node n-digest"><span class="node-t">Digest</span><span class="node-s">private page + Atom feed</span></div>
          <div class="fan">
            <div class="wire w2"><i></i></div>
            <div class="outs">
              <span class="out"><img class="ic" src="/icons/slack.svg?v=${V}" alt="" width="16" height="16" loading="lazy">Slack /feed</span>
              <span class="out"><svg class="ic ic-rss" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="6" cy="18" r="2.2"/><path d="M4 10.5a9.5 9.5 0 0 1 9.5 9.5M4 4a16 16 0 0 1 16 16"/></svg>Feed reader</span>
              <span class="out"><svg class="ic ic-mail" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3" y="5.5" width="18" height="13" rx="1.5"/><path d="M3.5 6.5l8.5 6.5 8.5-6.5"/></svg>Email</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <section class="close" id="close" aria-labelledby="close-h">
    <div class="wrap">
      <h2 id="close-h">Give your queue a last look before it posts</h2>
      <ul class="trust" aria-label="Promises">
        <li>Reads your queue, changes nothing on its own</li>
        <li>Never deletes a post</li>
        <li>Keeps no copy of your posts</li>
      </ul>
      <p class="cta-row"><a class="btn btn-primary btn-lg" href="/oauth/start">Connect Buffer</a><a class="btn btn-lg" href="/try">Try it on your own post</a></p>
    </div>
  </section>
  <div class="dock" id="dock" hidden><a class="btn btn-primary" href="/oauth/start">Connect Buffer</a><a class="btn" href="/try">Try it</a></div>
</main>`, { site: true, bodyClass: 'is-landing', metas, htmlAttrs: ' data-type="software"' });
}

/* /try "Your own post": the composer is static markup; public/app.js reads it and renders the check result */
const OWN_PILLS = [['twitter', 'X'], ['linkedin', 'LinkedIn'], ['bluesky', 'Bluesky'], ['threads', 'Threads'], ['instagram', 'Instagram'], ['mastodon', 'Mastodon']]
  .map(([v, n], i) => `<label class="pill"><input type="radio" name="own-ch" id="own-ch-${v}" value="${v}"${i === 0 ? ' checked' : ''}><span>${n}</span></label>`).join('');
const OWN = `
  <section class="own" id="own" aria-labelledby="own-h">
    <div class="own-grid">
      <div class="own-compose">
        <h1 id="own-h">Check a post before it goes out</h1>
        <p class="own-intro muted">Type or paste a post. Last Look checks it as you type, with the same code it runs on a real Buffer queue. Nothing you type leaves this page.</p>
        <div class="own-examples" role="group" aria-labelledby="own-ex-l">
          <span class="lbl" id="own-ex-l">Try an example</span>
          <button type="button" class="chip" id="own-ex-slip">Weekday slip</button>
          <button type="button" class="chip" id="own-ex-tomorrow">“tomorrow” that moves</button>
          <button type="button" class="chip" id="own-ex-raw">Raw ** on X</button>
        </div>
        <fieldset class="own-field">
          <legend class="lbl">Channel</legend>
          <div class="pills">${OWN_PILLS}</div>
        </fieldset>
        <label class="lbl own-text-l" for="own-text">Your post</label>
        <textarea id="own-text" class="own-text" rows="5" maxlength="3000" spellcheck="true" placeholder="Happy Friday! Our sale ends tomorrow…"></textarea>
        <div class="own-meter"><p class="own-status" id="own-status" aria-live="polite"></p><p class="counter" id="own-count"></p></div>
      </div>
      <div class="own-preview" id="own-preview">
        <p class="lbl own-preview-l">How Last Look sees it</p>
        <div class="own-result" id="own-result"><div class="own-empty"><p class="own-empty-title">Your post shows up here, checked as you type.</p><p>Or tap an example. Nothing you type leaves this page.</p></div></div>
        <p class="own-real"><a href="/oauth/start">Run this on your real Buffer queue</a><span aria-hidden="true"> →</span></p>
      </div>
      <div class="own-settings">
        <fieldset class="own-field">
          <legend class="lbl">Goes out</legend>
          <div class="own-when">
            <input type="datetime-local" id="own-when" class="own-when-input" aria-label="Date and time it goes out" aria-describedby="own-zone">
            <div class="pills" role="radiogroup" aria-label="How it is scheduled">
              <label class="pill"><input type="radio" name="own-mode" id="own-mode-queue" value="queue" checked><span>Queue slot</span></label>
              <label class="pill"><input type="radio" name="own-mode" id="own-mode-fixed" value="fixed"><span>Fixed time</span></label>
            </div>
          </div>
          <p class="own-zone muted" id="own-zone">Next Monday at 09:30, in your time zone.</p>
        </fieldset>
      </div>
    </div>
    <noscript><p class="banner warn">Checking a post of your own needs JavaScript: the checks run in your browser. Below is the sample queue, checked on our server when this page was sent.</p></noscript>
  </section>`;

function appBody(o) {
  const hide = o.sample ? ' hidden' : '';
  const banner = o.sample ? `
  <div class="banner try" id="try-banner" role="note" hidden><strong>Sample queue, made up for this demo.</strong> These are the queued posts of Little Kiln Studio, a fictional pottery studio, checked by the same code Last Look runs on a real Buffer queue. Nothing here is sent to Buffer; fixes change only this page. <a href="/oauth/start">Connect Buffer</a> to check your own.</div>` : '';
  return `
<main id="main" class="app">
  <div class="views" role="group" aria-label="View">${o.sample ? `
    <button type="button" class="view-tab" id="v-own" aria-pressed="true">Your own post</button>` : ''}
    <button type="button" class="view-tab" id="v-queue" aria-pressed="${o.sample ? 'false' : 'true'}">${o.sample ? 'Sample queue' : 'Your queue'}</button>
    <button type="button" class="view-tab" id="v-back" aria-pressed="false">Look back</button>${o.sample ? '' : `
    <button type="button" class="view-tab" id="v-digest" aria-pressed="false">Daily digest</button>`}
  </div>${o.sample ? OWN : ''}${o.staticHtml || ''}${banner}
  <section class="summary" id="summary" aria-live="polite"${hide}>
    <div class="summary-main">
      <h1 id="headline">${o.sample ? 'Sample queue' : 'Reading your queue…'}</h1>
      <p id="subline" class="muted">${o.sample ? 'Little Kiln Studio, a made-up pottery studio.' : 'This takes a few seconds.'}</p>
    </div>
    <div class="summary-actions">
      <button type="button" class="btn" id="rescan" disabled>${o.sample ? 'Reset sample' : 'Scan again'}</button>
    </div>
  </section>
  <div class="toolbar" id="toolbar" role="group" aria-label="Show"${hide}>
    <button type="button" class="chip" id="f-flagged" aria-pressed="true">Needs a look</button>
    <button type="button" class="chip" id="f-all" aria-pressed="false">All posts</button>
    <label class="toggle"><input type="checkbox" id="f-notes"> Show notes</label>
    <span class="links-status muted" id="links-status" aria-live="polite"></span>
  </div>
  <div id="queue" class="queue"${hide}><div class="skeleton" aria-hidden="true"><div></div><div></div><div></div></div></div>
  <p class="session-note muted" id="session-note"${hide}>${o.sample ? 'The sample lives only in this tab. Reset sample or reload to start over.' : ''}</p>
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
      <button type="button" class="btn btn-primary" id="dlg-ok">${o.sample ? 'Save to sample' : 'Save to Buffer'}</button>
    </div>
  </form>
</dialog>
<dialog id="rules-dlg" aria-labelledby="rules-title">
  <form method="dialog" class="dlg-body" id="rules-form">
    <h2 id="rules-title">Rules for this channel</h2>
    <p class="muted">Last Look checks every post on this channel against them and offers the fix.</p>
    <label for="rules-banned" class="lbl">Never say</label>
    <p class="hint muted" id="rules-banned-hint">One phrase per line. To suggest a word instead, add =&gt; and the word: sneak peek =&gt; first look</p>
    <textarea id="rules-banned" rows="4" maxlength="2000" spellcheck="false" aria-describedby="rules-banned-hint"></textarea>
    <label for="rules-required" class="lbl">Every post includes</label>
    <p class="hint muted" id="rules-required-hint">One tag or phrase per line, such as #ad or your brand tag. The first comment counts.</p>
    <textarea id="rules-required" rows="3" maxlength="800" spellcheck="false" aria-describedby="rules-required-hint"></textarea>
    <p class="dlg-error" id="rules-error" role="alert" hidden></p>
    <p class="hint muted" id="rules-where"></p>
    <div class="dlg-actions">
      <button type="button" class="btn btn-quiet" id="rules-cancel">Cancel</button>
      <button type="button" class="btn btn-primary" id="rules-save">Save rules</button>
    </div>
  </form>
</dialog>
<div class="undo-bar" id="undo-bar" role="status" aria-live="polite" hidden><span id="undo-msg"></span><button type="button" class="btn btn-small" id="undo-btn">Undo</button></div>
<div class="toast" id="toast" role="status" aria-live="polite" hidden></div>`;
}

export function appPage(o) {
  const nav = '<span class="who" id="who">' + (o.name ? 'Connected as ' + esc(o.name) : 'Connected to Buffer') + '</span><button type="button" class="btn btn-small btn-quiet" id="disconnect">Disconnect</button>';
  return shell('Last Look: your queue', appBody({}), { csrf: o.csrf, expires: o.expires, script: true, nav, bodyClass: 'is-app' });
}

/* /try: your own post (first tab) and the same app on a made-up queue. No session, no CSRF token: the page has
   nothing to send to the server. The sample's results are also rendered here as plain HTML (src/trystatic.js), so
   the first paint without JavaScript shows the real flagged posts; /boot.js hides that copy when scripts run. */
export function tryPage(now) {
  const nav = '<span class="who">No sign-in, nothing sent</span><a class="btn btn-small btn-primary" href="/oauth/start">Connect Buffer</a>';
  return shell('Try Last Look on your own post', appBody({ sample: true, staticHtml: trySample(now).html }), { script: true, boot: true, nav, bodyClass: 'is-app is-try', mode: 'try' });
}

/* Read pages: each h2 gets an id, and a contents rail lists them (sticky on wide screens) */
function withToc(inner, label) {
  const items = [];
  const body = inner.replace(/<h2>([\s\S]*?)<\/h2>/g, (m, t) => {
    const id = 's-' + (items.length + 1);
    items.push([id, t.replace(/<[^>]+>/g, '')]);
    return `<h2 id="${id}">${t}</h2>`;
  });
  return `<div class="read"><nav class="toc" aria-label="${esc(label)}"><p class="toc-h">On this page</p><ol>${items.map(([id, t]) => `<li><a href="#${id}">${t}</a></li>`).join('')}</ol></nav><div class="read-body">${body}</div></div>`;
}

export function privacyPage() {
  return shell('Privacy · Last Look', `
<main id="main" class="prose has-toc">${withToc(`
  <h1>Privacy</h1>
  <p class="lead">Last Look is a tool by Swift Bot Labs that checks the posts waiting in your Buffer queue. This page says exactly what it reads, what it keeps, for how long, and what it logs.</p>

  <h2>What Last Look asks Buffer for</h2>
  <ul>
    <li><strong>account:read</strong>: your account id and display name, and your organizations and channels (name, network, time zone, avatar), so posts can be judged per channel.</li>
    <li><strong>posts:read</strong>: your scheduled posts, posts awaiting approval and drafts: text, scheduled time, attached media type and alt text, link previews and first comments. When you open <strong>Look back</strong>, also your most recent sent posts (up to 90): the same fields plus when each went out and the link to it on the network.</li>
    <li><strong>posts:write</strong>: used only when you press a fix button and then confirm, or press Undo within two minutes of an edit. It edits that one post’s text, moves it to drafts, or moves it to the front or end of its queue. After a move, it reads that channel’s queue once more, to see which posts Buffer gave a new time. Last Look never creates, publishes or deletes posts.</li>
  </ul>
  <p>The <strong>daily digest</strong>, only if you turn it on, asks Buffer for a second, separate connection with <strong>account:read posts:read offline_access</strong>: it can read your queue on its own once a day, and it cannot change, publish or delete anything.</p>

  <h2>Where the checks run</h2>
  <p>Our server fetches your queue (and, for Look back, your recent sent posts) from Buffer and passes it straight to your browser. The checks themselves run in your browser tab. The server does not keep the posts after answering. Look back only reads: sent posts cannot be changed, and links in them are not opened.</p>
  <p>The try page at <a href="/try">/try</a> needs no sign-in. A post you type there is checked in your browser and is not sent anywhere: not to our server, not to Buffer, and links in it are not opened. The sample queue there is made-up data that lives in the page, and it sends nothing either.</p>

  <h2>What is stored, and for how long</h2>
  <ul>
    <li><strong>Your session</strong> (encrypted with AES-256-GCM, under a key that needs both our server secret and the random session id held only in your browser’s cookie): your Buffer access token and its expiry, a security token for your browser, a one-way hash of your Buffer account id, your organizations’ ids and names (up to five), your Buffer display name, whether Buffer granted editing, and when the session started. It lives at most one hour, matching Buffer’s access token.</li>
    <li><strong>Usage counters</strong>, stored under the one-way hash of your account id: a hash of your current session id, the time of your last scan and last Look back, today’s number of scans, Look backs, fixes, link checks and sign-ins, and how many Buffer requests were made for your account today and in the current 15 minutes. They contain no content and reset every day (UTC); they let us limit use so the app stays available to everyone.</li>
    <li><strong>For one minute only</strong>: a hash of each link we checked for you (so the same link is not fetched twice within a minute) and, per linked website (for example “example.com”), how many checks it received in that minute across all users. Cloudflare’s rate limiter also counts requests per network for a minute, under a one-way hash of your IP address (for IPv6, of its /64 block); the address itself is not stored.</li>
    <li><strong>For at most 30 minutes</strong>: a one-way hash of each sign-in attempt’s one-time value, so the same sign-in response cannot be used twice.</li>
    <li><strong>App-wide</strong>: how many requests Buffer still allows this app, read from Buffer’s replies.</li>
    <li><strong>In your browser</strong>: one cookie with the session id (HttpOnly, Secure, SameSite=Lax). During sign-in a second cookie lives for at most 10 minutes with one-time sign-in values. Channel rules you set (phrases to avoid, tags every post needs) are saved in your browser’s local storage under your channels’ ids; they are never sent to our server or to Buffer, and clearing a channel’s rules or your site data removes them. The light or dark theme you pick with the button in the header is saved there too.</li>
  </ul>

  <h2>The daily digest (only if you turn it on)</h2>
  <ul>
    <li><strong>Its Buffer key</strong>: the long-lived refresh token of the digest’s read-only connection, encrypted (AES-256-GCM, under a key derived from our server secret and the digest’s own id) in one Cloudflare Durable Object. It never goes to a browser. Buffer replaces it each time it is used; the old one stops working. The short-lived access token it gives is used for that one daily read and not stored.</li>
    <li><strong>The digests</strong>: the last 7 (one a day), each with the send time, channel name and the first 140 characters of each flagged post, plus the flags. Encrypted the same way. A post with nothing to fix is only counted.</li>
    <li><strong>Settings</strong>: the hour you picked, your time zone, your organizations’ ids and names, a one-way hash of your Buffer account id, when the digest was last built and last opened.</li>
    <li><strong>The private address</strong>: stored as a one-way hash, plus an encrypted copy so you can see it again in the app when signed in. Anyone who has the address can read the digest, so share it only with your team.</li>
    <li><strong>Off</strong>: the button on the digest page or in the app deletes all of the above at once, and Last Look then revokes the connection at Buffer. It also switches itself off, the same way, if nobody opens the page or the feed for 14 days, or if you remove Last Look in your Buffer settings.</li>
    <li>Opening the page or the feed reads only what is stored: it never calls Buffer and never opens a link. Up to 4 links in tomorrow’s posts are checked when the digest is built, the same way as below.</li>
  </ul>

  <h2>What is not stored</h2>
  <ul>
    <li>Outside the daily digest (above), post text, media, links in readable form, and check results are not written to any database, file or log.</li>
    <li>No tracking, no ads, no third-party scripts. The page loads only from this site. Channel avatars load in your browser from Buffer’s image hosts (buffer-channel-avatars-bucket.s3.amazonaws.com, *.buffer.com, *.bufferapp.com); avatars hosted anywhere else are not shown.</li>
  </ul>

  <h2>Logs</h2>
  <p>Request logging on Cloudflare (Workers Logs and invocation logs) is switched off for Last Look, so no request URLs, IP addresses or headers are kept by us. Our code writes short event lines such as “connected”, “fix applied” or “disconnected”, with no ids, text, links or tokens; with logging off they are not stored and can only be watched live by the operator. Cloudflare still keeps aggregate counts (requests, errors, CPU time) for the service.</p>

  <h2>How links in your posts are checked</h2>
  <p>Our server looks the link’s domain up with Cloudflare’s public DNS resolver, then sends one HEAD request, identifying itself as “LastLook”. Only if the site answers that it does not support HEAD (405 or 501) does it send one GET request, and the response body is never read. It follows at most three redirects, checking each one the same way. Only the status (for example 200 or 404) and where it redirected are used. Links to private or internal addresses, and links written as bare IP addresses, are never opened. Each link is checked at most once a minute for your account, up to 300 checks a day.</p>

  <h2>Disconnecting</h2>
  <p>Press <strong>Disconnect</strong> and your session is refused from that moment; its record, with the Buffer token, is deleted from our store right after (within seconds), and a cached copy can linger in Cloudflare’s storage for up to about a minute without being usable. Signing in again also ends any older Last Look session of the same Buffer account. To revoke Last Look’s access on Buffer’s side, remove it from the connected apps in your Buffer account settings.</p>

  <h2>Limits</h2>
  <p>To keep Last Look available for everyone: one scan a minute, 20 scans and 40 fixes a day per account, one Look back every two minutes and 6 a day, at most 15 Buffer requests per 15 minutes and 60 a day per account, and new requests pause when Buffer’s request allowance for this app runs low.</p>

  <h2>Who runs it</h2>
  <p>Swift Bot Labs, contact <a href="mailto:swiftbotlabs@gmail.com">swiftbotlabs@gmail.com</a>. Last Look runs on Cloudflare Workers. It is not made by or affiliated with Buffer.</p>
  <p class="muted">Last updated 6 November 2026.</p>
`, 'Privacy sections')}</main>`, {});
}

export function aboutPage() {
  return shell('How it works · Last Look', `
<main id="main" class="prose has-toc">${withToc(`
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
    <li><strong>Your channel rules.</strong> Per channel, set phrases to avoid (with a word to say instead, such as “sneak peek” =&gt; “first look”) and tags or phrases every post must include (#ad, your brand tag; the first comment counts). Matching ignores case, works on whole words and skips links. A post that breaks a rule gets the fix: the suggested word swapped in, or the missing tag added. Rules are saved in your browser only, so the daily digest does not use them yet.</li>
  </ul>
  <h2>4. Fix</h2>
  <p>Each flag offers the fixes that make sense for it: edit the text (with a suggested version where one can be made, a live character count and a word-by-word view of the change), move the post to drafts, or move a queue post to the top or bottom of its queue. Nothing is saved until you confirm. Before saving, Last Look reads the post again and stops if it changed in Buffer since your scan, or if it goes out in the next three minutes. Threads are left to Buffer’s editor so every part stays in step. After a fix, that one post is updated on the page from Buffer’s answer and checked again; nothing else is re-read. After an edit, <strong>Undo</strong> stays available for two minutes: it reads the post again and puts the previous text back only if the post still holds exactly what Last Look wrote. Last Look never deletes a post.</p>
  <h2>Reorders move more than one post</h2>
  <p>Moving a post in its queue changes when it goes out. Moved to the end, it takes the last slot, often days later; moved to the front, Buffer sets it to share next, with no time until it goes out. After every move, Last Look reads that channel’s queue again and re-checks the day words of every post whose time changed: a “tomorrow” that meant Friday at the old slot but now means Saturday is flagged, with a one-click word that keeps Friday (“today”, a weekday, or a date). If that day has already passed at the new time, it offers the front of the queue or drafts instead. A post set to share next has no time to judge, so its day words are flagged for you to check.</p>
  <h2>5. Look back</h2>
  <p>After you connect, the Look back tab reads your most recent sent posts (up to 90, one request per organization) and runs the text checks on them, each judged at the moment it actually went out in its channel’s time zone: formatting that showed as raw text, posts longer than the network allows, leftover placeholders, the same post sent twice, day and time words that were wrong when it went out, and images sent without alt text. The result reads “Last Look would have caught N issues in your last M sent posts”, grouped by check, each linking to the post. It only reads: sent posts cannot be changed, and their links are not opened.</p>
  <h2>6. Daily digest (opt-in)</h2>
  <p>A pre-flight check only helps if someone opens it. Turn on the daily digest and, every day at the hour you pick, Last Look reads the posts going out before the end of the next day and lists what it would fix, on a private page and an Atom feed: follow it in Slack (<code>/feed subscribe</code>), any feed reader or an RSS-to-email service. It uses its own read-only Buffer connection, keeps the last 7 digests, and one click turns it off and deletes everything.</p>
  <h2>Limits</h2>
  <ul>
    <li>Up to 300 queued posts per scan (three requests to Buffer), one scan a minute, 20 scans and 40 fixes a day per account, and at most 15 Buffer requests per 15 minutes and 60 a day per account.</li>
    <li>Some sites block automated visitors; those links are marked as “probably fine, open it once” rather than broken.</li>
    <li>Day words are a judgment call. When a post has its own fixed time, Last Look only notes what “tomorrow” will mean, it does not call it wrong.</li>
  </ul>
  <p class="cta-row"><a class="btn btn-primary" href="/oauth/start">Connect Buffer</a><a class="btn" href="/try">Try it on your own post</a><a class="btn btn-quiet" href="/try#sample">Sample queue</a></p>
`, 'How it works sections')}</main>`, {});
}

export function errorPage(title, message, withRetry, opts) {
  const o = opts || {};
  return shell(title + ' · Last Look', `
<main id="main" class="prose narrow">
  <h1>${esc(title)}</h1>
  <p class="lead">${esc(message)}</p>
  ${o.calm ? '<p class="muted">Nothing was read or changed. Meanwhile, check a post of your own or browse a sample queue, without signing in.</p>' : ''}
  <p class="cta-row">${o.calm ? '<a class="btn btn-primary" href="/try">Check a post</a><a class="btn" href="/try#sample">Sample queue</a>' : withRetry ? '<a class="btn btn-primary" href="/oauth/start">Start again</a>' : ''}<a class="btn btn-quiet" href="/">Back to Last Look</a></p>
</main>`, {});
}
/* "in about 7 minutes" for a Retry-After in seconds (the server does not know the visitor's clock or zone) */
export function retryHint(sec) {
  const s = Math.max(1, Math.ceil(Number(sec) || 60));
  if (s <= 90) return 'Try again in about a minute.';
  if (s < 5400) return 'Try again in about ' + Math.round(s / 60) + ' minutes.';
  return 'Try again in about ' + Math.round(s / 3600) + ' hours.';
}

/* ---------- daily digest (src/digest.js): a private page and an Atom feed, both static (no script) ---------- */
const SEV_WORDS = { high: 'Fix before it posts', medium: 'Worth a look' };

const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/* "Wed 5 Nov, 17:02" in a zone (server side, no visitor clock) */
export function stamp(ms, tz) {
  try {
    const o = {};
    for (const p of new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(new Date(ms))) o[p.type] = p.value;
    return o.weekday + ' ' + Number(o.day) + ' ' + MON3[Number(o.month) - 1] + ', ' + String(Number(o.hour) % 24).padStart(2, '0') + ':' + o.minute;
  } catch (e) { return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; }
}

export function digestTitle(e) {
  if (!e.scanned) return 'Tomorrow (' + e.tomorrow + '): nothing queued to check';
  if (!e.flagged) return 'Tomorrow (' + e.tomorrow + '): ' + (e.scanned === 1 ? 'the 1 post looks fine' : 'all ' + e.scanned + ' posts look fine');
  return 'Tomorrow (' + e.tomorrow + '): ' + e.flagged + ' post' + (e.flagged === 1 ? '' : 's') + ' to fix before ' + (e.flagged === 1 ? 'it goes' : 'they go') + ' out';
}
function digestEntryHtml(e, origin) {
  const posts = e.posts.map((p) => `
      <article class="post digest-post">
        <div class="post-meta"><span class="when">${esc(p.when)}</span><span class="badge">${esc(p.slot)}</span><span class="svc">${esc(p.ch)}</span></div>
        <p class="post-text">${esc(p.excerpt)}</p>
        <ul class="flags">${p.flags.map((f) => `<li class="flag ${f.s === 'high' ? 'sev-high' : 'sev-med'}"><span class="dot" aria-hidden="true"></span><div class="flag-body"><span class="sev">${esc(SEV_WORDS[f.s] || 'Worth a look')}</span><strong>${esc(f.t)}</strong><p>${esc(f.d)}</p></div></li>`).join('')}</ul>
      </article>`).join('');
  const l = e.links || { found: 0, checked: 0, skipped: 0 };
  const facts = [
    e.scanned ? 'Checked ' + e.scanned + ' post' + (e.scanned === 1 ? '' : 's') + ' going out before the end of ' + e.tomorrow : 'No posts are queued before the end of ' + e.tomorrow,
    l.found ? l.checked + ' of ' + l.found + ' link' + (l.found === 1 ? '' : 's') + ' opened' + (l.found > l.checked ? ' (the rest are checked when you open Last Look)' : '') : null,
    e.more ? 'more posts than one digest holds: open Last Look for the full queue' : null,
    e.orgsSkipped ? e.orgsSkipped + ' more organization' + (e.orgsSkipped === 1 ? '' : 's') + ' not covered' : null,
    'built ' + stamp(e.builtAt, e.tz)
  ].filter(Boolean).join(' · ');
  return `<p class="muted digest-facts">${esc(facts)}</p>${posts || `<p class="clear-line">✓ Nothing to fix in tomorrow’s queue.</p>`}
      ${e.flagged ? `<p class="digest-go"><a class="btn btn-primary btn-small" href="${esc(origin)}/">Fix them in Last Look</a></p>` : ''}`;
}
export function digestPage(o) {
  const v = o.view;
  const base = o.origin + '/digest/' + o.ft;
  const latest = v.entries[0];
  const hourText = String(v.hour).padStart(2, '0') + ':00';
  const welcome = o.welcome ? `
  <div class="banner calm" role="status"><strong>Your daily digest is on.</strong> Every day at ${esc(hourText)} (${esc(v.tz)}) this page and its feed get the posts Last Look would fix before the end of the next day. Bookmark this page, or follow the feed below. The address is private: anyone with it can read the digest, so share it only with your team.</div>
  <div class="banner calm" role="status"><strong>To keep fixing posts, connect again.</strong> Buffer ends Last Look’s earlier sign-in a minute or two after this read-only connection is added; a new sign-in leaves the digest on. <a class="btn btn-small" href="/oauth/start">Connect again</a></div>` : '';
  const entries = v.entries.map((e, i) => `
  <section class="digest-entry" aria-labelledby="d-${i}">
    <h2 id="d-${i}">${esc(digestTitle(e))}</h2>
    ${digestEntryHtml(e, o.origin)}
  </section>`).join('');
  return shell('Daily digest · Last Look', `
<main id="main" class="digest">
  <p class="eyebrow">Daily digest · private page</p>
  <h1>${latest ? esc(digestTitle(latest)) : 'Your first digest is on its way'}</h1>
  <p class="lead">Every day at ${esc(hourText)} (${esc(v.tz)}), Last Look reads what goes out before the end of the next day and lists what it would fix. ${v.nextAt ? 'Next one: ' + esc(stamp(v.nextAt, v.tz)) + '.' : ''}</p>${welcome}
  ${latest ? '' : '<p class="muted">The first digest is built within a few minutes. Reload this page soon.</p>'}
  ${entries}
  <section class="digest-follow" aria-labelledby="follow-h">
    <h2 id="follow-h">Get it where you already look</h2>
    <p>Feed address: <code class="feed-url">${esc(base)}/feed.xml</code></p>
    <ul>
      <li><strong>Slack:</strong> in a channel, type <code>/feed subscribe ${esc(base)}/feed.xml</code></li>
      <li><strong>A feed reader</strong> (Feedly, Inoreader, NetNewsWire): add the feed address.</li>
      <li><strong>Email:</strong> any RSS-to-email service sends it to your inbox.</li>
    </ul>
    <p class="muted">Opening this page or the feed never calls Buffer and never opens a link. The digest has its own read-only Buffer connection: it can read your queue, never change it.</p>
  </section>
  <section class="digest-off" aria-labelledby="off-h">
    <h2 id="off-h">Turn it off</h2>
    <form method="post" action="/digest/${esc(o.ft)}/off"><button type="submit" class="btn btn-danger">Turn off the daily digest</button></form>
    <p class="muted">One click: it deletes the digest’s Buffer access and every digest stored for you, at once. It also turns itself off if nobody opens this page or the feed for 14 days.</p>
  </section>
</main>`, { bodyClass: 'is-digest', bare: true });
}
export function digestOffConfirm(ft) {
  return shell('Turn off the digest · Last Look', `
<main id="main" class="prose narrow">
  <h1>Turn off the daily digest?</h1>
  <p class="lead">This deletes the digest’s Buffer access and every digest stored for you. Your Buffer posts are not touched.</p>
  <form method="post" action="/digest/${esc(ft)}/off" class="cta-row"><button type="submit" class="btn btn-primary">Turn it off</button><a class="btn btn-quiet" href="/digest/${esc(ft)}">Keep it</a></form>
</main>`, { bare: true });
}
export function digestOffDone() {
  return shell('Digest is off · Last Look', `
<main id="main" class="prose narrow">
  <h1>The daily digest is off</h1>
  <p class="lead">Its Buffer access was deleted and is being revoked at Buffer now; every stored digest is gone. Nothing in your Buffer queue was changed.</p>
  <p class="cta-row"><a class="btn btn-primary" href="/">Back to Last Look</a></p>
</main>`, { bare: true });
}
/* Atom feed: one entry per stored digest. Text content only (type="html" with escaped markup), no script. */
export function digestFeed(o) {
  const v = o.view;
  const base = o.origin + '/digest/' + o.ft;
  const idBase = 'tag:lastlook.swiftbotlab.workers.dev,2026:digest:' + v.id;
  const iso = (ms) => new Date(ms).toISOString();
  const updated = v.entries[0] ? v.entries[0].builtAt : (v.created || Date.now());
  const entries = v.entries.map((e) => {
    const body = '<p>' + esc(digestTitle(e)) + '</p>' + e.posts.map((p) => '<p><strong>' + esc(p.when) + ' · ' + esc(p.ch) + '</strong><br>' + esc(p.excerpt) + '</p><ul>' + p.flags.map((f) => '<li><strong>' + esc(f.t) + '</strong>: ' + esc(f.d) + '</li>').join('') + '</ul>').join('') +
      '<p><a href="' + esc(o.origin) + '/">Fix them in Last Look</a> · <a href="' + esc(base) + '">Digest page</a> · <a href="' + esc(base) + '/off">Turn off this digest</a></p>';
    return `
  <entry>
    <id>${esc(idBase + ':' + e.day)}</id>
    <title>${esc(digestTitle(e))}</title>
    <updated>${iso(e.builtAt)}</updated>
    <link rel="alternate" type="text/html" href="${esc(base)}"/>
    <content type="html">${esc(body)}</content>
  </entry>`;
  }).join('');
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${esc(idBase)}</id>
  <title>Last Look: tomorrow’s queue</title>
  <subtitle>What Last Look would fix in your Buffer queue before it goes out</subtitle>
  <updated>${iso(updated)}</updated>
  <link rel="self" type="application/atom+xml" href="${esc(base)}/feed.xml"/>
  <link rel="alternate" type="text/html" href="${esc(base)}"/>
  <author><name>Last Look</name></author>${entries}
</feed>
`;
}
