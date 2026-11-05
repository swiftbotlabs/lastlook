/* Landing page motion: the light-table sequence in the hero, the lit step in "How a last look works", the pulses on
   the digest wires and the phone action bar. Everything here is decoration over finished HTML: without this file, or
   with reduced motion, the page shows every mark, flag and stage in its final state. Only classes change here (and
   one length variable per wire); CSS moves transform, opacity and clip-path. No network. */
const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

/* ---------- hero: marks drawn, flags in, the fix applied ---------- */
const table = $('#table');
const strip = table && $('.strip', table);
const replay = $('#replay');
let timers = [];
const original = strip ? strip.innerHTML : '';
const at = (ms, fn) => timers.push(setTimeout(fn, ms));

function swapWord(mark, from, to) {
  const t = mark.textContent;
  const i = t.indexOf(from);
  if (i < 0) return false;
  mark.textContent = '';
  const w = document.createElement('span');
  w.className = 'swap';
  w.textContent = from;
  mark.append(t.slice(0, i), w, t.slice(i + from.length));
  w.classList.add('out');
  at(240, () => { w.textContent = to; w.classList.remove('out'); w.classList.add('in'); requestAnimationFrame(() => requestAnimationFrame(() => w.classList.remove('in'))); });
  return true;
}

function play() {
  if (!table || !strip) return;
  timers.forEach(clearTimeout);
  timers = [];
  strip.innerHTML = original;
  table.classList.remove('on');
  table.classList.add('armed');
  $$('.f-on, .m-on', table).forEach((n) => n.classList.remove('f-on', 'm-on'));
  let scan = $('.scan', table);
  if (!scan) { scan = document.createElement('div'); scan.className = 'scan'; scan.setAttribute('aria-hidden', 'true'); table.append(scan); }
  scan.classList.remove('go');
  if (replay) replay.hidden = true;
  void table.offsetWidth;
  table.classList.add('on');
  at(250, () => scan.classList.add('go'));
  let t = 650;
  const frames = $$('.frame', strip);
  for (const f of frames) {
    const marks = $$('mark.hl', $('.post-text', f));
    const flags = $$('.flag', f);
    const n = Math.max(marks.length, flags.length);
    for (let i = 0; i < n; i++) {
      const m = marks[i]; const fl = flags[i];
      at(t, () => { if (m) m.classList.add('m-on'); if (fl) fl.classList.add('f-on'); });
      t += marks.length > 3 ? 230 : 380;
    }
    const tail = $('.fix-row', f) || $('.clear-line', f);
    if (tail) at(t, () => tail.classList.add('f-on'));
    t += 260;
  }
  const result = $('.result', table);
  at(t, () => result && result.classList.add('f-on'));
  /* the one-click word fix on the first frame ("Happy Friday" on a Monday) */
  const first = frames[0];
  const btn = first && $('.hero-fix', first);
  const target = first && $$('mark.hl-high', first).find((m) => /Friday/.test(m.textContent));
  if (btn && target && /Monday/.test(btn.textContent)) {
    t += 700;
    at(t, () => btn.classList.add('pressed'));
    at(t + 260, () => {
      btn.classList.remove('pressed');
      if (swapWord(target, 'Friday', 'Monday')) {
        target.classList.add('fixed');
        const fl = $$('.flag', first).find((x) => /Happy Friday/.test(x.textContent));
        if (fl) fl.classList.add('done');
      }
    });
    t += 900;
  }
  at(t, () => { if (replay) replay.hidden = false; });
}

if (table && !still) {
  /* start once the table is on screen (it is on load; on a phone it may sit under the fold) */
  const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); play(); } }, { threshold: 0.25 });
  io.observe(table);
  if (replay) replay.addEventListener('click', play);
}

/* ---------- how it works: the step in the middle of the screen is lit ---------- */
const how = $('.how');
if (how && !still && 'IntersectionObserver' in window) {
  const steps = $$('.step', how);
  how.classList.add('live');
  const lit = new IntersectionObserver((es) => {
    for (const e of es) if (e.isIntersecting) { steps.forEach((s) => s.classList.toggle('lit', s === e.target)); }
  }, { rootMargin: '-42% 0px -42% 0px' });
  steps.forEach((s) => lit.observe(s));
}

/* ---------- contact sheet and promises: the marks draw on when the frames come into view ---------- */
if (!still && 'IntersectionObserver' in window) {
  for (const box of $$('.drawn.contact, .drawn.trust')) {
    box.classList.add('watch');
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); box.classList.add('seen'); } }, { threshold: 0.3 });
    io.observe(box);
  }
}

/* ---------- digest wires: each pulse runs the wire's own length ---------- */
function wires() { for (const w of $$('.wire')) w.style.setProperty('--run', Math.max(40, w.clientWidth + 10) + 'px'); }
wires();
window.addEventListener('resize', wires, { passive: true });

/* ---------- phones: the action bar shows once the hero has scrolled away, and leaves at the close ---------- */
const dock = $('#dock');
const hero = $('.hero-cta');
const close = $('#close');
if (dock && hero && 'IntersectionObserver' in window) {
  dock.hidden = false;
  let heroIn = true; let closeIn = false;
  const set = () => dock.classList.toggle('up', !heroIn && !closeIn);
  new IntersectionObserver((es) => { heroIn = es[0].isIntersecting; set(); }, { threshold: 0 }).observe(hero);
  if (close) new IntersectionObserver((es) => { closeIn = es[0].isIntersecting; set(); }, { threshold: 0 }).observe(close);
}
