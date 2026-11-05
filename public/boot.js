/* Runs before first paint on every page (a classic script in <head>, same origin, no inline code, no network):
   marks the page as scripted, so the plain-HTML copy of the /try sample (#try-static, for readers without
   JavaScript) stays hidden while app.js builds the interactive view; and applies the colour theme picked with the
   header button (light or dark), remembered in this browser only. Without a pick the system setting is used. */
(function () {
  var d = document.documentElement;
  d.classList.add('js');
  var KEY = 'lastlook-theme';
  var picked = null;
  try { picked = window.localStorage.getItem(KEY); } catch (e) { picked = null; }
  if (picked === 'light' || picked === 'dark') d.setAttribute('data-theme', picked);
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function isDark() { var t = d.getAttribute('data-theme'); return t ? t === 'dark' : !!(mq && mq.matches); }
  function sync() {
    var b = document.getElementById('theme');
    if (!b) return;
    var dark = isDark();
    b.setAttribute('aria-pressed', dark ? 'true' : 'false');
    b.setAttribute('title', dark ? 'Light mode' : 'Dark mode');
  }
  document.addEventListener('DOMContentLoaded', sync);
  if (mq && mq.addEventListener) mq.addEventListener('change', sync);
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('#theme') : null;
    if (!b) return;
    var next = isDark() ? 'light' : 'dark';
    var apply = function () { d.setAttribute('data-theme', next); sync(); };
    var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (document.startViewTransition && !still) document.startViewTransition(apply); else apply();
    try { window.localStorage.setItem(KEY, next); } catch (e2) { /* private mode: the pick lasts for this page */ }
  });
})();
