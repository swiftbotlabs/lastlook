/* Runs before first paint (a classic script in <head>, same origin, no inline code): marks the page as scripted so the
   plain-HTML copy of the /try sample (#try-static, for readers without JavaScript) stays hidden while app.js builds
   the interactive view. */
document.documentElement.classList.add('js');
