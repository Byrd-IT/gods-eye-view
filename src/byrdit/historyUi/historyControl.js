/**
 * History control (gev-history DESIGN.md 4.5, card B11): a docked,
 * collapsible time slider at the bottom of the globe.
 *
 *   collapsed   LIVE badge (or HISTORY + time) and any non-live feed chip
 *   expanded    presets 1 h / 24 h / 7 d / 30 d / 90 d / all, a scrub bar
 *               over the visible window (inside now - 2 y .. now) that snaps
 *               to recorded data on release, the coverage ribbon (adsb.lol
 *               + OpenSky lanes for aircraft, a military lane; hatched =
 *               known gap), play/pause, 1x/10x/60x/600x, step <- / ->
 *               (Shift = 10), Space, LIVE, the HUD line and the feed chips
 *
 * State it owns: `ht=<ISO UTC>` in the address (its own parameter, never the
 * `l=` share field), and the 'gev:history-time' window event that Sky view
 * follows (skyView/historyTime.js). It registers no layer, no voice tool and
 * changes no live layer: when the history API fails it says "history
 * unavailable" and the globe keeps running live (quiet failure). Swapping
 * layer data to time t is card B12.
 */
import {
  createHistoryClient,
  HISTORY_UNAVAILABLE,
  HistoryUnavailableError,
} from './historyClient.js';
import {
  buildRibbon,
  gapsAt,
  hudLines,
  openskyTilesAt,
} from './coverageRibbon.js';
import { createFeedChips } from './feedChips.js';
import {
  DEFAULT_PRESET,
  HISTORY_SPAN_MS,
  PRESETS,
  RATES,
  advance,
  clampTime,
  coverageRange,
  createSnapIndex,
  fallbackStep,
  followWindow,
  formatUtc,
  fractionToTime,
  presetById,
  readHtFromUrl,
  snapTo,
  snapToleranceMs,
  timeToFraction,
  windowAround,
  writeHtToUrl,
} from './historyTimeline.js';
import { HISTORY_STYLE_ID, HISTORY_CSS } from './historyStyles.js';

export const HISTORY_EVENT = 'gev:history-time';
export const ROOT_ATTRIBUTE = 'data-gev-history';
/** Feeds whose snapshot times the slider snaps to, in order of preference. */
export const SNAP_FEEDS = Object.freeze(['aircraft', 'military']);
/** Feeds drawn in the coverage ribbon. */
export const RIBBON_FEEDS = Object.freeze(['aircraft', 'military']);

const TICK_MS = 250;
/** Outward rounds when stepping over an empty stretch (each doubles it). */
const STEP_SEARCH_ROUNDS = 12;
/** A Space tap shorter than voice push-to-talk's hold delay (500 ms). */
const SPACE_TAP_MS = 450;
const SKY_HEARTBEAT_MS = 2_000;
const CHIP_REFRESH_MS = 15_000;
const URL_WRITE_MS = 1_000;
const COVERAGE_DEBOUNCE_MS = 250;
const mounted = new WeakMap();

function el(doc, tag, { cls, text, attrs } = {}) {
  const node = doc.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  for (const [k, v] of Object.entries(attrs ?? {}))
    node.setAttribute(k, String(v));
  return node;
}

function ensureStyle(doc) {
  if (!doc?.head || doc.getElementById?.(HISTORY_STYLE_ID)) return;
  const style = el(doc, 'style', { attrs: { id: HISTORY_STYLE_ID } });
  style.textContent = HISTORY_CSS;
  doc.head.append(style);
}

function build(doc) {
  const root = el(doc, 'div', {
    cls: 'gev-hist',
    attrs: {
      [ROOT_ATTRIBUTE]: '',
      'data-mode': 'live',
      'data-expanded': 'false',
      role: 'region',
      'aria-label': 'History time slider',
    },
  });
  const bar = el(doc, 'div', { cls: 'gev-hist-bar' });
  const badge = el(doc, 'button', {
    cls: 'gev-hist-badge',
    text: 'LIVE',
    attrs: {
      type: 'button',
      'aria-expanded': 'false',
      title: 'History: show the time slider',
    },
  });
  const barHud = el(doc, 'span', {
    cls: 'gev-hist-barhud',
    attrs: { role: 'status', 'aria-live': 'polite' },
  });
  const chips = el(doc, 'div', {
    cls: 'gev-hist-chips',
    attrs: { 'aria-label': 'Feed status' },
  });
  bar.append(badge, barHud, chips);

  const panel = el(doc, 'div', { cls: 'gev-hist-panel' });
  panel.hidden = true;
  const top = el(doc, 'div', { cls: 'gev-hist-row gev-hist-top' });
  const presets = el(doc, 'div', {
    cls: 'gev-hist-presets',
    attrs: { role: 'group', 'aria-label': 'Window' },
  });
  const presetButtons = new Map();
  for (const p of PRESETS) {
    const b = el(doc, 'button', {
      cls: 'gev-hist-btn',
      text: p.label,
      attrs: { type: 'button', 'data-preset': p.id, 'aria-pressed': 'false' },
    });
    presetButtons.set(p.id, b);
    presets.append(b);
  }
  const readout = el(doc, 'span', { cls: 'gev-hist-readout', text: 'LIVE' });
  const live = el(doc, 'button', {
    cls: 'gev-hist-btn gev-hist-live',
    text: 'LIVE',
    attrs: { type: 'button', title: 'Back to live' },
  });
  top.append(presets, readout, live);

  const scrub = el(doc, 'div', {
    cls: 'gev-hist-scrub',
    attrs: {
      role: 'slider',
      tabindex: '0',
      'aria-label': 'History time',
      'aria-valuemin': '0',
      'aria-valuemax': '1000',
      'aria-valuenow': '1000',
    },
  });
  const thumb = el(doc, 'div', { cls: 'gev-hist-thumb' });
  scrub.append(thumb);
  const edges = el(doc, 'div', { cls: 'gev-hist-row gev-hist-edges' });
  const edgeFrom = el(doc, 'span', { cls: 'gev-hist-edge' });
  const edgeTo = el(doc, 'span', { cls: 'gev-hist-edge' });
  edges.append(edgeFrom, edgeTo);
  const ribbon = el(doc, 'div', {
    cls: 'gev-hist-ribbon',
    attrs: { 'aria-label': 'Recording coverage' },
  });

  const controls = el(doc, 'div', { cls: 'gev-hist-row gev-hist-controls' });
  const back = el(doc, 'button', {
    cls: 'gev-hist-btn',
    text: '\u2190',
    attrs: {
      type: 'button',
      title: 'Step back (Shift = 10)',
      'aria-label': 'Step back',
    },
  });
  const play = el(doc, 'button', {
    cls: 'gev-hist-btn gev-hist-play',
    text: '\u25B6',
    attrs: { type: 'button', 'aria-label': 'Play', 'aria-pressed': 'false' },
  });
  const fwd = el(doc, 'button', {
    cls: 'gev-hist-btn',
    text: '\u2192',
    attrs: {
      type: 'button',
      title: 'Step forward (Shift = 10)',
      'aria-label': 'Step forward',
    },
  });
  const rates = el(doc, 'div', {
    cls: 'gev-hist-rates',
    attrs: { role: 'group', 'aria-label': 'Speed' },
  });
  const rateButtons = new Map();
  for (const r of RATES) {
    const b = el(doc, 'button', {
      cls: 'gev-hist-btn',
      text: `${r}x`,
      attrs: { type: 'button', 'data-rate': r, 'aria-pressed': 'false' },
    });
    rateButtons.set(r, b);
    rates.append(b);
  }
  const hud = el(doc, 'div', {
    cls: 'gev-hist-hud',
    attrs: { role: 'status', 'aria-live': 'polite' },
  });
  controls.append(back, play, fwd, rates);
  panel.append(top, scrub, edges, ribbon, controls, hud);
  root.append(bar, panel);
  return {
    root,
    badge,
    barHud,
    chips,
    panel,
    presetButtons,
    readout,
    live,
    scrub,
    thumb,
    edgeFrom,
    edgeTo,
    ribbon,
    back,
    play,
    fwd,
    rateButtons,
    hud,
  };
}

const pct = (x) => `${(Math.min(1, Math.max(0, x)) * 100).toFixed(3)}%`;

/**
 * Mount the control.
 * @param {object} options
 *   document, window      DOM (window: fetch, events, location, history)
 *   parent                container, default document.body
 *   client                history client (default: /api/history over fetch)
 *   chips                 feed chips (default: createFeedChips on window)
 *   tileOutlines          optional {show(tiles), clear(), destroy()}
 *   now                   wall clock ms;  monotonic  performance.now
 *   timers                {setTimeout, clearTimeout, setInterval, clearInterval}
 */
export function mountHistoryControl({
  document: doc = globalThis.document,
  window: win = globalThis.window,
  parent,
  client,
  chips,
  tileOutlines = null,
  now = () => Date.now(),
  monotonic = () => globalThis.performance?.now?.() ?? Date.now(),
  timers = globalThis,
} = {}) {
  const host = parent || doc?.body;
  if (!doc || !host)
    throw new TypeError('A document and a parent are required');
  const existing = mounted.get(host);
  if (existing && !existing.destroyed) return existing;

  ensureStyle(doc);
  const dom = build(doc);
  host.append(dom.root);
  const api =
    client ??
    createHistoryClient({ fetchImpl: (...a) => win.fetch(...a), now });
  const feedChips = chips ?? createFeedChips({ target: win, monotonic });
  feedChips.install?.();

  const removers = [];
  const listeners = new Set();
  const listen = (target, type, fn, opts) => {
    if (!target?.addEventListener) return;
    target.addEventListener(type, fn, opts);
    removers.push(() => target.removeEventListener(type, fn, opts));
  };

  const snapIndex = createSnapIndex();
  const s = {
    mode: 'live',
    expanded: false,
    timeMs: null,
    playing: false,
    rate: RATES[0],
    preset: DEFAULT_PRESET,
    win: null,
    ribbon: null,
    unavailable: false,
    loading: false,
    reachedNow: false,
    note: '',
    chips: [],
  };
  let destroyed = false;
  let dragging = false;
  let coverageGen = 0;
  let seekGen = 0;
  let coverageTimer = null;
  let tickTimer = null;
  let lastTick = 0;
  let urlTimer = null;
  let urlDue = 0;
  let tilesKey = '';
  let pendingSteps = 0;
  let stepping = null;

  const spanOf = () =>
    presetById(s.preset)?.spanMs ?? presetById(DEFAULT_PRESET).spanMs;

  // ── outputs ─────────────────────────────────────────────

  function detail() {
    return {
      active: s.mode === 'history',
      timeMs: s.mode === 'history' ? s.timeMs : null,
      playing: s.mode === 'history' && s.playing,
      rate: s.rate,
      seek: (ms) => seek(ms, { snap: true }),
      ...(s.unavailable ? { error: HISTORY_UNAVAILABLE } : {}),
    };
  }

  function emit() {
    if (destroyed) return;
    const d = detail();
    for (const fn of [...listeners]) {
      try {
        fn(d);
      } catch {
        /* keep going */
      }
    }
    if (
      typeof win?.dispatchEvent === 'function' &&
      typeof globalThis.CustomEvent === 'function'
    ) {
      try {
        win.dispatchEvent(
          new globalThis.CustomEvent(HISTORY_EVENT, { detail: d }),
        );
      } catch {
        /* keep going */
      }
    }
  }

  function writeUrl({ immediate = false } = {}) {
    if (!win?.history?.replaceState || !win?.location?.href) return;
    const apply = () => {
      urlTimer = null;
      urlDue = monotonic() + URL_WRITE_MS;
      try {
        const next = writeHtToUrl(
          win.location.href,
          s.mode === 'history' ? s.timeMs : null,
        );
        if (next !== win.location.href)
          win.history.replaceState(win.history.state, '', next);
      } catch {
        /* an address we cannot write is not worth breaking the control */
      }
    };
    if (immediate || monotonic() >= urlDue) {
      if (urlTimer) timers.clearTimeout(urlTimer);
      apply();
    } else if (!urlTimer)
      urlTimer = timers.setTimeout(apply, Math.max(0, urlDue - monotonic()));
  }

  // ── rendering ───────────────────────────────────────────

  function renderRibbon() {
    const lanes = s.ribbon?.lanes ?? [];
    const rows = [];
    for (const lane of lanes) {
      const row = el(doc, 'div', {
        cls: 'gev-hist-lane',
        attrs: { 'data-lane': lane.id },
      });
      const label = el(doc, 'span', {
        cls: 'gev-hist-lane-label',
        text: lane.label,
      });
      const track = el(doc, 'div', { cls: 'gev-hist-lane-track' });
      const span = s.win.to - s.win.from;
      for (const seg of lane.segments) {
        if (seg.kind === 'none') continue;
        const node = el(doc, 'div', {
          cls: `gev-hist-seg gev-hist-seg-${seg.kind}`,
          attrs: {
            'data-kind': seg.kind,
            'data-from': new Date(seg.from).toISOString(),
            'data-to': new Date(seg.to).toISOString(),
            title: `${lane.label}: ${seg.kind}${seg.kind === 'unverified' ? ' (not verified)' : ''} ${formatUtc(seg.from, { seconds: false })} - ${formatUtc(seg.to, { seconds: false })}`,
          },
        });
        node.style.left = pct((seg.from - s.win.from) / span);
        node.style.width = pct((seg.to - seg.from) / span);
        track.append(node);
      }
      row.append(label, track);
      rows.push(row);
    }
    if (!lanes.length) {
      rows.push(
        el(doc, 'div', {
          cls: 'gev-hist-lane-empty',
          text: s.unavailable
            ? HISTORY_UNAVAILABLE
            : s.loading
              ? 'loading coverage\u2026'
              : '',
        }),
      );
    }
    dom.ribbon.replaceChildren(...rows);
  }

  function hudText() {
    if (s.unavailable) return HISTORY_UNAVAILABLE;
    if (s.mode !== 'history')
      return s.expanded
        ? 'Live. Drag the bar or step back to look at a past time.'
        : '';
    const lines = hudLines(s.timeMs, s.ribbon, now());
    if (s.reachedNow) lines.push('Reached now: press LIVE to return to live');
    if (s.note) lines.push(s.note);
    return lines.join(' \u00b7 ');
  }

  function renderChips() {
    const nodes = [];
    for (const c of s.chips) {
      if (c.state === 'live' && !s.expanded) continue;
      const text =
        c.state === 'live'
          ? `${c.label} LIVE`
          : `${c.label}: ${c.chip}${c.age ? ` (${c.age} ago)` : ''}${c.state === 'cleared' ? ', cleared' : ''}`;
      nodes.push(
        el(doc, 'span', {
          cls: `gev-hist-chip gev-hist-chip-${c.state}`,
          text,
          attrs: { 'data-feed': c.feed, 'data-state': c.state },
        }),
      );
    }
    dom.chips.replaceChildren(...nodes);
  }

  function render() {
    if (destroyed) return;
    const history = s.mode === 'history';
    const t = now();
    dom.root.setAttribute('data-mode', s.mode);
    dom.root.setAttribute('data-expanded', String(s.expanded));
    dom.root.setAttribute('data-playing', String(history && s.playing));
    dom.root.setAttribute('data-rate', String(s.rate));
    dom.root.setAttribute('data-unavailable', String(s.unavailable));
    if (history)
      dom.root.setAttribute('data-time', new Date(s.timeMs).toISOString());
    else dom.root.removeAttribute?.('data-time');
    dom.panel.hidden = !s.expanded;
    dom.badge.setAttribute('aria-expanded', String(s.expanded));
    dom.badge.textContent = history
      ? `HISTORY ${formatUtc(s.timeMs, { seconds: false })}`
      : 'LIVE';
    const hud = hudText();
    dom.barHud.textContent = s.expanded ? '' : hud;
    dom.hud.textContent = hud;
    const local = history
      ? (() => {
          try {
            return new Date(s.timeMs).toLocaleTimeString('en-US', {
              hour: '2-digit',
              minute: '2-digit',
              hourCycle: 'h23',
              timeZoneName: 'short',
            });
          } catch {
            return '';
          }
        })()
      : '';
    dom.readout.textContent = history
      ? `${formatUtc(s.timeMs)}${local ? ` \u00b7 ${local}` : ''}`
      : 'LIVE';
    for (const [id, b] of dom.presetButtons)
      b.setAttribute('aria-pressed', String(id === s.preset));
    for (const [r, b] of dom.rateButtons)
      b.setAttribute('aria-pressed', String(r === s.rate));
    dom.play.textContent = history && s.playing ? '\u275A\u275A' : '\u25B6';
    dom.play.setAttribute(
      'aria-label',
      history && s.playing ? 'Pause' : 'Play',
    );
    dom.play.setAttribute('aria-pressed', String(history && s.playing));
    dom.play.disabled = !history;
    dom.fwd.disabled = !history;
    dom.live.disabled = !history;
    if (s.win) {
      const at = history ? s.timeMs : t;
      const f = timeToFraction(at, s.win);
      dom.thumb.style.left = pct(f);
      dom.scrub.setAttribute('aria-valuenow', String(Math.round(f * 1000)));
      dom.scrub.setAttribute(
        'aria-valuetext',
        history ? formatUtc(s.timeMs) : 'Live',
      );
      dom.edgeFrom.textContent = formatUtc(s.win.from, { seconds: false });
      dom.edgeTo.textContent =
        s.win.to >= t - 60_000
          ? 'now'
          : formatUtc(s.win.to, { seconds: false });
    }
    renderChips();
    if (tileOutlines) {
      const tiles = history ? openskyTilesAt(s.timeMs, s.ribbon) : [];
      const key = JSON.stringify(tiles);
      if (key !== tilesKey) {
        tilesKey = key;
        try {
          if (tiles.length) tileOutlines.show(tiles);
          else tileOutlines.clear();
        } catch {
          /* outlines are a hint, never a failure */
        }
      }
    }
  }

  // ── coverage ────────────────────────────────────────────

  function updateWindow({ force = false } = {}) {
    const t = now();
    const at = s.mode === 'history' ? s.timeMs : t;
    const next =
      s.mode === 'history'
        ? followWindow(force ? null : s.win, at, spanOf(), t, {
            playing: s.playing,
          })
        : windowAround(t, spanOf(), t, 1);
    const moved = !s.win || next.from !== s.win.from || next.to !== s.win.to;
    s.win = next;
    if (moved || force) scheduleCoverage();
  }

  function scheduleCoverage() {
    if (!(s.expanded || s.mode === 'history')) return;
    if (coverageTimer) timers.clearTimeout(coverageTimer);
    coverageTimer = timers.setTimeout(loadCoverage, COVERAGE_DEBOUNCE_MS);
  }

  async function loadCoverage() {
    coverageTimer = null;
    if (destroyed || !s.win) return;
    const gen = ++coverageGen;
    const t = now();
    const win0 = s.win;
    const range = coverageRange(win0, t);
    s.loading = true;
    renderRibbon();
    const answers = await Promise.allSettled(
      RIBBON_FEEDS.map((feed) =>
        api.coverage({
          feed,
          from: range.from,
          to: range.to,
          bucket: range.bucket,
        }),
      ),
    );
    if (destroyed || gen !== coverageGen) return;
    s.loading = false;
    const ok = answers.map((a) => (a.status === 'fulfilled' ? a.value : null));
    s.unavailable = ok.every((a) => a === null);
    s.ribbon = s.unavailable
      ? null
      : buildRibbon({ win: win0, now: t, aircraft: ok[0], military: ok[1] });
    renderRibbon();
    render();
    emit();
  }

  // ── time ────────────────────────────────────────────────

  function setTime(ms) {
    s.timeMs = clampTime(ms, now());
    s.reachedNow = false;
    s.note = '';
    // the window holds still under a dragging pointer (no jump mid-drag)
    if (!dragging) updateWindow();
  }

  function enter(ms = now()) {
    const wasLive = s.mode !== 'history';
    s.mode = 'history';
    setTime(ms);
    if (wasLive && !s.ribbon) scheduleCoverage();
    render();
    writeUrl({ immediate: wasLive });
    emit();
  }

  function leave() {
    s.mode = 'live';
    s.playing = false;
    s.reachedNow = false;
    s.note = '';
    stopTicker();
    seekGen++;
    pendingSteps = 0;
    s.timeMs = null;
    updateWindow({ force: true });
    render();
    writeUrl({ immediate: true });
    emit();
  }

  /** Move the history time; with snap, settle on the nearest recorded snap. */
  function seek(ms, { snap = false } = {}) {
    if (!Number.isFinite(ms) || destroyed) return;
    if (s.mode !== 'history') enter(ms);
    else {
      setTime(ms);
      render();
      writeUrl();
      emit();
    }
    if (snap) snapNow();
  }

  async function snapNow() {
    const gen = ++seekGen;
    const t = s.timeMs;
    // inside a known gap the time stays put: the HUD names the gap
    if (gapsAt(t, s.ribbon).length) return;
    const tolerance = snapToleranceMs(spanOf());
    for (const feed of SNAP_FEEDS) {
      let snaps;
      try {
        snaps = await api.snapshots({ feed, around: t, n: 10 });
      } catch (error) {
        if (error instanceof HistoryUnavailableError) markUnavailable();
        return;
      }
      if (destroyed || gen !== seekGen || s.mode !== 'history') return;
      if (feed === SNAP_FEEDS[0]) snapIndex.add(t, snaps);
      const hit = snapTo(t, snaps, tolerance);
      if (hit !== null) {
        if (hit !== s.timeMs) {
          setTime(hit);
          render();
          writeUrl();
          emit();
        }
        return;
      }
    }
  }

  function markUnavailable() {
    if (s.unavailable) return;
    s.unavailable = true;
    render();
    renderRibbon();
    emit();
  }

  /** Step to the next/previous recorded snapshot (count of them). */
  function step(dir, count = 1) {
    if (destroyed) return;
    if (s.mode !== 'history') {
      if (dir > 0) return; // nothing after live
      enter(now());
    }
    pendingSteps += Math.sign(dir) * count;
    if (!stepping) stepping = runSteps().finally(() => (stepping = null));
  }

  async function runSteps() {
    while (pendingSteps !== 0 && !destroyed && s.mode === 'history') {
      const dir = Math.sign(pendingSteps);
      const count = Math.abs(pendingSteps);
      pendingSteps = 0;
      const gen = ++seekGen;
      const t = s.timeMs;
      let target = snapIndex.step(t, dir, count);
      if (target === null) {
        try {
          target = await findStep(t, dir, count);
        } catch (error) {
          if (error instanceof HistoryUnavailableError) markUnavailable();
          target = null;
        }
      }
      if (destroyed || gen !== seekGen || s.mode !== 'history') return;
      setTime(target ?? fallbackStep(t, dir, count, now()));
      render();
      writeUrl();
      emit();
    }
  }

  /**
   * The count-th recorded snapshot from t in dir. /snapshots answers the n
   * nearest on BOTH sides, so a gap on the dir side can leave that side
   * empty. Then search outward exactly: nothing lies in (t, t + known]; ask
   * around a = t + known + 1 s. If the answer holds any snapshot beyond t,
   * its nearest one is the true next snapshot (anything closer to t would be
   * closer to a too); else everything within its radius is empty as well,
   * so `known` at least doubles each round (bounded rounds, rate limit).
   */
  async function findStep(t, dir, count) {
    const feed = SNAP_FEEDS[0];
    const n = Math.min(50, count * 2 + 4);
    const beyond = (list, from) =>
      list
        .filter((x) => (dir > 0 ? x > from + 500 : x < from - 500))
        .sort((a, b) => (dir > 0 ? a - b : b - a));
    let cur = t;
    let remaining = count;
    let rounds = 0;
    while (remaining > 0 && rounds < STEP_SEARCH_ROUNDS) {
      rounds++;
      // nearest n around cur: every snapshot within its radius is in it, so
      // the ones beyond cur are the next consecutive snapshots
      const snaps = await api.snapshots({ feed, around: cur, n });
      snapIndex.add(cur, snaps);
      const next = beyond(snaps, cur);
      if (next.length) {
        const k = Math.min(remaining, next.length);
        cur = next[k - 1];
        remaining -= k;
        continue;
      }
      if (!snaps.length) break; // nothing stored at all
      // empty on the dir side: nothing lies in (cur, cur + known]
      let known = snaps.reduce((m, x) => Math.max(m, Math.abs(x - cur)), 0);
      let found = null;
      while (found === null && rounds < STEP_SEARCH_ROUNDS) {
        rounds++;
        const around = cur + dir * (known + 1000);
        if (around < now() - HISTORY_SPAN_MS || around > now()) break;
        const more = await api.snapshots({ feed, around, n });
        snapIndex.add(around, more);
        // anything nearer to cur than the nearest found would be nearer to
        // `around` too, so the nearest beyond cur is the true next snapshot
        const ahead = beyond(more, cur);
        if (ahead.length) found = ahead[0];
        else if (!more.length) break;
        else
          known +=
            1000 + more.reduce((m, x) => Math.max(m, Math.abs(x - around)), 0);
      }
      if (found === null) break;
      cur = found;
      remaining -= 1;
    }
    return cur === t ? null : cur;
  }

  function play() {
    if (s.mode !== 'history') return;
    if (s.timeMs >= now() - 1000) {
      s.reachedNow = true;
      render();
      return;
    }
    s.playing = true;
    s.reachedNow = false;
    startTicker();
    render();
    emit();
  }

  function pause() {
    if (!s.playing) return;
    s.playing = false;
    stopTicker();
    render();
    writeUrl({ immediate: true });
    emit();
  }

  function toggle() {
    if (s.playing) pause();
    else play();
  }

  function setRate(rate) {
    if (!RATES.includes(rate)) return;
    s.rate = rate;
    lastTick = monotonic();
    render();
    emit();
  }

  function setPreset(id) {
    if (!presetById(id)) return;
    s.preset = id;
    updateWindow({ force: true });
    render();
  }

  function startTicker() {
    stopTicker();
    lastTick = monotonic();
    tickTimer = timers.setInterval(tick, TICK_MS);
  }

  function stopTicker() {
    if (tickTimer) timers.clearInterval(tickTimer);
    tickTimer = null;
  }

  function tick() {
    if (!s.playing || s.mode !== 'history' || dragging) {
      lastTick = monotonic();
      return;
    }
    const m = monotonic();
    const { timeMs, reachedNow } = advance(
      s.timeMs,
      m - lastTick,
      s.rate,
      now(),
    );
    lastTick = m;
    s.timeMs = timeMs;
    updateWindow();
    if (reachedNow) {
      s.playing = false;
      s.reachedNow = true;
      stopTicker();
      emit();
    }
    render();
    writeUrl();
  }

  function expand(open = !s.expanded) {
    s.expanded = Boolean(open);
    if (s.expanded) updateWindow({ force: !s.ribbon });
    render();
    if (s.expanded && !s.ribbon) scheduleCoverage();
  }

  // ── input ───────────────────────────────────────────────

  function fractionAt(clientX) {
    const r = dom.scrub.getBoundingClientRect?.();
    if (!r || !(r.width > 0)) return null;
    return (clientX - r.left) / r.width;
  }

  listen(dom.badge, 'click', () => expand());
  listen(dom.live, 'click', () => leave());
  listen(dom.play, 'click', () => toggle());
  listen(dom.back, 'click', (e) => step(-1, e?.shiftKey ? 10 : 1));
  listen(dom.fwd, 'click', (e) => step(1, e?.shiftKey ? 10 : 1));
  for (const [id, b] of dom.presetButtons)
    listen(b, 'click', () => setPreset(id));
  for (const [r, b] of dom.rateButtons) listen(b, 'click', () => setRate(r));

  listen(dom.scrub, 'pointerdown', (e) => {
    const f = fractionAt(e.clientX);
    if (f === null || !s.win) return;
    dragging = true;
    try {
      dom.scrub.setPointerCapture?.(e.pointerId);
    } catch {
      /* synthetic events have no capture */
    }
    seekGen++;
    seek(fractionToTime(f, s.win));
    e.preventDefault?.();
  });
  listen(dom.scrub, 'pointermove', (e) => {
    if (!dragging || !s.win) return;
    const f = fractionAt(e.clientX);
    if (f === null) return;
    // the window stays put while dragging; no request until release
    s.timeMs = clampTime(fractionToTime(f, s.win), now());
    s.reachedNow = false;
    render();
    emit();
  });
  const release = () => {
    if (!dragging) return;
    dragging = false;
    lastTick = monotonic();
    updateWindow();
    writeUrl();
    snapNow();
  };
  listen(dom.scrub, 'pointerup', release);
  listen(dom.scrub, 'pointercancel', release);

  const isEditable = (t) =>
    Boolean(
      t?.matches?.(
        'input, textarea, select, [contenteditable], [contenteditable] *',
      ),
    );
  const inSky = (t) => Boolean(t?.closest?.('[class*="gev-sky"]'));
  // Space = play/pause on a short TAP (keyup within the push-to-talk hold
  // delay). The app's voice input owns a HELD Space and preventDefaults
  // every background Space (src/voice/realtimeInput.js), so the History
  // control neither checks defaultPrevented for Space nor prevents it: a hold
  // still talks, a tap toggles playback.
  let spaceDownAt = null;
  const spaceEligible = (e) =>
    s.mode === 'history' &&
    !e.altKey &&
    !e.ctrlKey &&
    !e.metaKey &&
    !isEditable(e.target) &&
    !inSky(e.target) &&
    // a focused button keeps its own Space (no double toggle)
    !e.target?.matches?.('button, [role="button"], a[href]');
  const isSpace = (e) => e.key === ' ' || e.code === 'Space';
  listen(doc, 'keydown', (e) => {
    if (isSpace(e)) {
      if (!e.repeat) spaceDownAt = spaceEligible(e) ? monotonic() : null;
      return;
    }
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if (!(s.mode === 'history' || s.expanded)) return;
    const target = e.target;
    if (isEditable(target) || inSky(target)) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (
        target?.matches?.(
          '[role="slider"]:not(.gev-hist-scrub), [role="radio"]',
        )
      )
        return;
      e.preventDefault();
      step(e.key === 'ArrowRight' ? 1 : -1, e.shiftKey ? 10 : 1);
    }
  });
  listen(doc, 'keyup', (e) => {
    if (!isSpace(e) || spaceDownAt === null) return;
    const held = monotonic() - spaceDownAt;
    spaceDownAt = null;
    if (held < SPACE_TAP_MS && spaceEligible(e)) toggle();
  });

  // ── timers ──────────────────────────────────────────────

  const heartbeat = timers.setInterval(() => {
    // Sky may mount after the first event: repeat the state while active
    if (s.mode === 'history') emit();
  }, SKY_HEARTBEAT_MS);
  removers.push(() => timers.clearInterval(heartbeat));
  const chipTimer = timers.setInterval(() => {
    feedChips.refresh?.();
    if (s.mode !== 'history' && s.expanded) updateWindow();
    render();
  }, CHIP_REFRESH_MS);
  removers.push(() => timers.clearInterval(chipTimer));
  const offChips = feedChips.subscribe?.((list) => {
    s.chips = list;
    renderChips();
  });
  if (typeof offChips === 'function') removers.push(offChips);
  s.chips = feedChips.states?.() ?? [];

  // ── start: `ht` in the address opens history at that time ─
  const initial = win?.location?.href
    ? readHtFromUrl(win.location.href, now())
    : null;
  updateWindow();
  if (initial !== null) {
    s.expanded = true;
    enter(initial);
  } else {
    render();
    emit();
  }

  const handle = {
    get destroyed() {
      return destroyed;
    },
    root: dom.root,
    getState: () => ({
      ...detail(),
      mode: s.mode,
      expanded: s.expanded,
      preset: s.preset,
      window: s.win,
      unavailable: s.unavailable,
      ribbon: s.ribbon,
      chips: s.chips,
      hud: hudText(),
    }),
    getTime: () => (s.mode === 'history' ? s.timeMs : null),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    expand,
    enter,
    leave,
    seek,
    step,
    play,
    pause,
    toggle,
    setRate,
    setPreset,
    /** Settle pending work (tests / QA): steps and coverage. */
    async settle() {
      if (coverageTimer) {
        timers.clearTimeout(coverageTimer);
        await loadCoverage();
      }
      while (stepping) await stepping;
    },
    destroy() {
      if (destroyed) return;
      const wasHistory = s.mode === 'history';
      destroyed = true;
      stopTicker();
      if (coverageTimer) timers.clearTimeout(coverageTimer);
      if (urlTimer) timers.clearTimeout(urlTimer);
      for (const remove of removers.splice(0)) remove();
      listeners.clear();
      feedChips.destroy?.();
      try {
        tileOutlines?.destroy?.();
      } catch {
        /* ignore */
      }
      dom.root.remove?.();
      mounted.delete(host);
      if (
        wasHistory &&
        typeof win?.dispatchEvent === 'function' &&
        typeof globalThis.CustomEvent === 'function'
      ) {
        try {
          win.dispatchEvent(
            new globalThis.CustomEvent(HISTORY_EVENT, {
              detail: { active: false },
            }),
          );
        } catch {
          /* ignore */
        }
      }
    },
  };
  mounted.set(host, handle);
  return handle;
}
