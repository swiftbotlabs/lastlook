/* A minimal browser for public/app.js in Node: fake DOM nodes, a fake clock with timers, a fake location, and a
   fetch the test controls. load() imports a fresh copy of the app (its init() runs on import).
   browser({ meta: { mode: 'try' }, hash: '#sample' }) loads it as the /try page. Reading or writing innerHTML on any
   node throws, so a render path that hands text to an HTML parser fails its test. */
export class FakeEl {
  constructor(tag) {
    this.tag = tag; this.kids = []; this.attrs = {}; this.textContent = ''; this.hidden = false; this.disabled = false; this.value = ''; this.listeners = {};
    const cl = new Set();
    this.classList = { add: (c) => cl.add(c), remove: (c) => cl.delete(c), toggle: (c, f) => { const on = f === undefined ? !cl.has(c) : f; if (on) cl.add(c); else cl.delete(c); return on; }, contains: (c) => cl.has(c) };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  append(...n) { this.kids.push(...n); }
  replaceChildren(...n) { this.kids = n; }
  focus() {} scrollIntoView() {} showModal() { this.open = true; } close() { this.open = false; }
  get innerHTML() { throw new Error('innerHTML read on <' + this.tag + '>'); }
  set innerHTML(v) { throw new Error('innerHTML written on <' + this.tag + '>: ' + String(v).slice(0, 40)); }
  click() { if (this.disabled) return; for (const f of this.listeners.click || []) f({ preventDefault() {}, target: this }); }
  fire(type) { for (const f of this.listeners[type] || []) f({ preventDefault() {}, target: this }); }
  find(id) {
    if (this.attrs.id === id) return this;
    for (const k of this.kids) { const f = k instanceof FakeEl ? k.find(id) : null; if (f) return f; }
    return null;
  }
  text() { return this.textContent + this.kids.map((k) => (k instanceof FakeEl ? k.text() : '')).join(''); }
}

const realSetImmediate = setImmediate;
export function browser(opts) {
  const o = opts || {};
  const els = new Map();
  const timers = [];
  let seq = 0;
  const b = {
    clock: Date.parse('2026-11-03T12:00:00Z'),
    requests: [],
    respond: async () => new Response('{}', { status: 500 }),
    els,
    $: (id) => els.get(id),
    count: (path) => b.requests.filter((p) => p === path).length,
    async flush() { for (let i = 0; i < 30; i++) await new Promise((r) => realSetImmediate(r)); },
    /* move the clock forward one second at a time, firing due timers in order */
    async advance(ms) {
      const end = b.clock + ms;
      while (b.clock < end) {
        b.clock = Math.min(end, b.clock + 1000);
        for (;;) {
          timers.sort((x, y) => x.at - y.at || x.id - y.id);
          const t = timers[0];
          if (!t || t.at > b.clock) break;
          if (t.every) t.at += t.every; else timers.shift();
          t.fn();
          await b.flush();
        }
        await b.flush();
      }
    }
  };
  globalThis.Node = FakeEl;
  globalThis.document = {
    /* page shell elements are made on first use; elements the app created are found in the tree, as in a browser */
    getElementById: (id) => {
      if (els.has(id)) return els.get(id);
      for (const root of els.values()) { const f = root.find(id); if (f) return f; }
      const n = new FakeEl('div'); n.attrs.id = id; els.set(id, n); return n;
    },
    querySelector: (sel) => {
      const m = /^meta\[name="([^"]+)"\]$/.exec(String(sel));
      return m && o.meta && o.meta[m[1]] != null ? { getAttribute: () => String(o.meta[m[1]]) } : null;
    },
    querySelectorAll: () => [],
    createElement: (t) => new FakeEl(t),
    createTextNode: (s) => { const n = new FakeEl('#text'); n.textContent = String(s); return n; },
    createDocumentFragment: () => new FakeEl('#frag')
  };
  globalThis.location = { hash: o.hash || '', pathname: o.path || '/', replace() {} };
  globalThis.history = { replaceState(_, __, url) { globalThis.location.hash = String(url).startsWith('#') ? String(url) : ''; } };
  Date.now = () => b.clock;
  globalThis.setInterval = (fn, ms) => { timers.push({ id: ++seq, at: b.clock + ms, every: ms, fn }); return seq; };
  globalThis.setTimeout = (fn, ms) => { timers.push({ id: ++seq, at: b.clock + (ms || 0), fn }); return seq; };
  globalThis.clearTimeout = (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); };
  globalThis.clearInterval = globalThis.clearTimeout;
  /* a runaway loop stops at 2,000 requests (the page then sees a network error), so a broken build fails instead of hanging */
  globalThis.fetch = async (path, init) => { b.requests.push(String(path)); if (b.requests.length > 2000) throw new TypeError('cap'); return b.respond(String(path), init); };
  b.load = async () => { await import('../public/app.js?run=' + (++browser.runs)); await b.flush(); };
  return b;
}
browser.runs = 0;
