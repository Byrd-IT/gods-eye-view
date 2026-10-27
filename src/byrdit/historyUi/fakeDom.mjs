/**
 * Minimal DOM + window + timers for the History control tests (no jsdom in
 * this repo). Only what historyControl.js uses.
 */
export class FakeElement {
  constructor(doc, tagName) {
    this.ownerDocument = doc;
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this._text = '';
    this._listeners = new Map();
  }
  get className() {
    return this.attributes.get('class') ?? '';
  }
  set className(v) {
    this.attributes.set('class', String(v));
  }
  get id() {
    return this.attributes.get('id') ?? '';
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this.children = [];
    this._text = String(v ?? '');
  }
  setAttribute(k, v) {
    this.attributes.set(k, String(v));
  }
  getAttribute(k) {
    return this.attributes.has(k) ? this.attributes.get(k) : null;
  }
  hasAttribute(k) {
    return this.attributes.has(k);
  }
  removeAttribute(k) {
    this.attributes.delete(k);
  }
  append(...nodes) {
    for (const n of nodes) {
      n.parentNode?.children.splice(n.parentNode.children.indexOf(n), 1);
      n.parentNode = this;
      this.children.push(n);
    }
  }
  prepend(...nodes) {
    for (const n of nodes) {
      n.parentNode?.children.splice(n.parentNode.children.indexOf(n), 1);
      n.parentNode = this;
    }
    this.children.unshift(...nodes);
  }
  replaceChildren(...nodes) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this._text = '';
    this.append(...nodes);
  }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this._listeners.get(type)?.delete(fn);
  }
  dispatch(type, init = {}) {
    const event = init.__fake
      ? init
      : {
          type,
          target: init.target ?? this,
          defaultPrevented: false,
          preventDefault() {
            this.defaultPrevented = true;
          },
          ...init,
          __fake: true,
        };
    for (const fn of [...(this._listeners.get(type) ?? [])]) fn(event);
    // bubble the SAME event object (preventDefault must be seen by the caller)
    if (this.parentNode) this.parentNode.dispatch(type, event);
    else if (this.ownerDocument && this !== this.ownerDocument.documentElement)
      this.ownerDocument.dispatch(type, event);
    return event;
  }
  click(init = {}) {
    if (this.disabled) return null;
    return this.dispatch('click', init);
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 1000, height: 18 };
  }
  setPointerCapture() {}
  focus() {
    this.ownerDocument.activeElement = this;
  }
  matches(selector) {
    return String(selector)
      .split(',')
      .map((s) => s.trim())
      .some((one) => matchOne(this, one));
  }
  closest(selector) {
    let node = this;
    while (node && node instanceof FakeElement) {
      if (node.matches(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }
  /** Depth-first list of descendants matching a predicate or selector. */
  findAll(test) {
    const pred = typeof test === 'function' ? test : (n) => n.matches(test);
    const out = [];
    const visit = (n) => {
      for (const c of n.children) {
        if (pred(c)) out.push(c);
        visit(c);
      }
    };
    visit(this);
    return out;
  }
  find(test) {
    return this.findAll(test)[0] ?? null;
  }
}

function matchOne(node, selector) {
  let rest = selector;
  const nots = [];
  rest = rest.replace(/:not\(([^)]+)\)/g, (_, inner) => {
    nots.push(inner);
    return '';
  });
  const parts = rest.match(/^[a-z]+|\.[\w-]+|\[[^\]]+\]/gi) ?? [];
  if (!parts.length && !nots.length) return false;
  for (const p of parts) {
    if (p.startsWith('.')) {
      if (!node.className.split(/\s+/).includes(p.slice(1))) return false;
    } else if (p.startsWith('[')) {
      const m = /^\[([\w-]+)(?:([*]?=)"?([^"\]]*)"?)?\]$/.exec(p);
      if (!m) return false;
      const value = node.getAttribute(m[1] === 'class' ? 'class' : m[1]);
      if (value === null) return false;
      if (m[2] === '=' && value !== m[3]) return false;
      if (m[2] === '*=' && !value.includes(m[3])) return false;
    } else if (node.tagName !== p.toUpperCase()) return false;
  }
  return nots.every((n) => !matchOne(node, n));
}

export function fakeDocument() {
  const doc = {
    activeElement: null,
    _listeners: new Map(),
    createElement: (tag) => new FakeElement(doc, tag),
    getElementById(id) {
      return (
        [doc.head, doc.body].flatMap((r) => r.findAll((n) => n.id === id))[0] ??
        null
      );
    },
    addEventListener(type, fn) {
      if (!doc._listeners.has(type)) doc._listeners.set(type, new Set());
      doc._listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      doc._listeners.get(type)?.delete(fn);
    },
    dispatch(type, event) {
      for (const fn of [...(doc._listeners.get(type) ?? [])]) fn(event);
      return event;
    },
    /** keydown at `target` (default: body) */
    key(key, { target, shiftKey = false, code } = {}) {
      return (target ?? doc.body).dispatch('keydown', {
        key,
        code: code ?? (key === ' ' ? 'Space' : key),
        shiftKey,
      });
    },
    /** keyup at `target` (default: body) */
    keyup(key, { target, shiftKey = false, code } = {}) {
      return (target ?? doc.body).dispatch('keyup', {
        key,
        code: code ?? (key === ' ' ? 'Space' : key),
        shiftKey,
      });
    },
    /** a short tap: keydown, `holdMs` on the clock, keyup */
    async tap(key, clock, { holdMs = 80, ...opts } = {}) {
      const down = doc.key(key, opts);
      await clock.run(holdMs);
      const up = doc.keyup(key, opts);
      return { down, up };
    },
  };
  doc.documentElement = new FakeElement(doc, 'html');
  doc.head = new FakeElement(doc, 'head');
  doc.body = new FakeElement(doc, 'body');
  return doc;
}

/** Virtual clock: wall `now`, monotonic and timers all move together. */
export function fakeClock(startMs) {
  let wall = startMs;
  let mono = 1_000;
  let seq = 0;
  const jobs = new Map();
  const timers = {
    setTimeout(fn, ms = 0) {
      const id = ++seq;
      jobs.set(id, { fn, at: mono + Math.max(0, ms), every: null });
      return id;
    },
    clearTimeout(id) {
      jobs.delete(id);
    },
    setInterval(fn, ms) {
      const id = ++seq;
      jobs.set(id, { fn, at: mono + ms, every: ms });
      return id;
    },
    clearInterval(id) {
      jobs.delete(id);
    },
  };
  return {
    now: () => wall,
    monotonic: () => mono,
    timers,
    /** Advance by ms, running due jobs in time order. */
    async run(ms) {
      const end = mono + ms;
      for (;;) {
        let next = null;
        for (const [id, job] of jobs)
          if (job.at <= end && (!next || job.at < next[1].at)) next = [id, job];
        if (!next) break;
        const [id, job] = next;
        wall += job.at - mono;
        mono = job.at;
        if (job.every) job.at += job.every;
        else jobs.delete(id);
        job.fn();
        await flush();
      }
      wall += end - mono;
      mono = end;
      await flush();
    },
  };
}

export async function flush() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

export function fakeWindow(href, fetchImpl) {
  const events = [];
  const listeners = new Map();
  const win = {
    location: { href, origin: new URL(href).origin },
    history: {
      state: null,
      replaceState(state, _title, url) {
        win.history.state = state;
        win.location.href = new URL(url, win.location.href).href;
        win.writes.push(win.location.href);
      },
    },
    writes: [],
    events,
    fetch: fetchImpl,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent(event) {
      events.push(event);
      for (const fn of [...(listeners.get(event.type) ?? [])]) fn(event);
      return true;
    },
  };
  return win;
}

/** A fetch Response-like answer. */
export function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const h = new Headers({
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  });
  return new Response(JSON.stringify(body), { status, headers: h });
}
