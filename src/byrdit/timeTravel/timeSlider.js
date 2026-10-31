/**
 * One shared time slider for every Time travel control (card t_ad584bad).
 *
 * The History panel, Esri Wayback, the NAIP aerial years, GhostMaps (through
 * the History slider) and the Sky view clock all show the SAME control: a
 * scrub bar with a thumb, edge labels, step back / forward, play / pause,
 * a speed group, an optional date (and time) picker and an optional
 * "Latest" button. Each caller keeps its own range and step meaning:
 *
 *   createTimeSlider   the DOM and the input handling only. It owns no time.
 *                      Pointer drag, keyboard (arrows step, Shift = 10,
 *                      PageUp / PageDown = 10, Home / End jump) and the
 *                      buttons call the handlers; the caller calls the
 *                      setters (setFraction, setPlaying, ...).
 *   createDiscreteSlider
 *                      the index-over-a-list model (Wayback releases, NAIP
 *                      years): fraction = index / (n - 1), step = one item,
 *                      play = one item per tick, picker = nearest item.
 *
 * Plain DOM, no stylesheet import: `ensureTimeSliderStyle` injects one
 * <style> per class prefix. History keeps its `gev-hist` class names (so its
 * CSS hooks and tests are unchanged); everyone else uses `gev-ts`.
 * "Feet are not relevant" here: the only unit is the readout text the caller
 * sets (a date, a year, a clock time).
 */

export const TS_STYLE_ID = 'gev-ts-style';
export const TS_DEFAULT_PREFIX = 'gev-ts';
export const TS_DEFAULT_RATES = Object.freeze([1, 10, 60, 600]);
/** Fine scrub resolution of aria-valuemin / max / now. */
export const TS_ARIA_MAX = 1000;
/** PageUp / PageDown and Shift: how many steps at once. */
export const TS_BIG_STEP = 10;
/** More items than this and the discrete slider draws no tick marks. */
export const TS_MAX_TICKS = 40;
/** One discrete item per tick at 1x (ms). */
export const TS_DISCRETE_BASE_MS = 1500;
const TICK_MS = 250;

/** Glyphs as constants (materialSymbolsSubset.test reads textContent literals). */
const GLYPH_BACK = '\u2190';
const GLYPH_FWD = '\u2192';
const GLYPH_PLAY = '\u25B6';
const GLYPH_PAUSE = '\u275A\u275A';

/** The look of the control, for a class prefix. */
export function timeSliderCss(prefix = TS_DEFAULT_PREFIX) {
  const p = `.${prefix}`;
  return `
${p}-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
${p}-edges { justify-content: space-between; opacity: 0.7; font-size: 10px; }
${p}-btn {
  min-width: 28px;
  height: 24px;
  padding: 0 7px;
  border: 1px solid var(--glass-border, rgba(255,255,255,0.14));
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  color: var(--text-secondary, #c8d0da);
  font: 600 11px/1 var(--font-mono, ui-monospace, monospace);
  cursor: pointer;
}
${p}-btn:hover { border-color: var(--glass-border-hover, rgba(255,255,255,0.3)); color: var(--accent, #7fd3ff); }
${p}-btn[aria-pressed='true'] { background: var(--accent-dim, rgba(127,211,255,0.18)); color: var(--accent, #7fd3ff); }
${p}-btn:disabled { opacity: 0.35; cursor: not-allowed; }
${p}-rates { display: flex; gap: 4px; }
${p}-readout { color: var(--text-primary, #eef3f8); font-weight: 700; }
${p}-scrub {
  position: relative;
  height: 18px;
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--glass-border, rgba(255,255,255,0.14));
  cursor: pointer;
  touch-action: pan-y;
}
${p}-scrub:focus-visible { outline: 2px solid var(--accent, #7fd3ff); outline-offset: 2px; }
${p}-thumb {
  position: absolute;
  top: -3px;
  width: 4px;
  height: 22px;
  margin-left: -2px;
  border-radius: 2px;
  background: #ffd27a;
  box-shadow: 0 0 6px rgba(255, 210, 122, 0.8);
  pointer-events: none;
}
${p}-tick { position: absolute; top: 3px; width: 1px; height: 10px; margin-left: -0.5px; background: rgba(255,255,255,0.28); pointer-events: none; }
${p}-ticklabels { position: relative; height: 12px; font-size: 10px; opacity: 0.75; }
${p}-ticklabel { position: absolute; transform: translateX(-50%); white-space: nowrap; }
${p}-ticklabel:first-child { transform: translateX(0); }
${p}-ticklabel:last-child { transform: translateX(-100%); }
${p}-picker {
  height: 24px;
  padding: 0 6px;
  border: 1px solid var(--glass-border, rgba(255,255,255,0.14));
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  color: var(--text-secondary, #c8d0da);
  font: 600 11px/1 var(--font-mono, ui-monospace, monospace);
  color-scheme: dark;
}
${p}-unit { opacity: 0.7; font-size: 10px; }
@media (max-width: 900px) { ${p}-btn { min-height: 32px; } }
@media (pointer: coarse) {
  ${p}-btn { min-width: 44px; min-height: 44px; }
  ${p}-scrub { height: 28px; }
  ${p}-thumb { height: 32px; }
}
`;
}

/** Inject the stylesheet of a prefix once (History injects its own copy). */
export function ensureTimeSliderStyle(doc, prefix = TS_DEFAULT_PREFIX) {
  if (!doc?.head) return;
  const id = `${TS_STYLE_ID}-${prefix}`;
  if (doc.getElementById?.(id)) return;
  const style = doc.createElement('style');
  style.setAttribute('id', id);
  style.textContent = timeSliderCss(prefix);
  doc.head.append(style);
}

// ── picker text <-> ms ────────────────────────────────────

const pad = (n, w = 2) => String(n).padStart(w, '0');

/**
 * The value string of a date / datetime-local input for an instant.
 * zone 'utc' reads the UTC fields, 'local' the browser's.
 */
export function pickerValue(
  ms,
  { kind = 'datetime-local', zone = 'utc' } = {},
) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const utc = zone === 'utc';
  const y = utc ? d.getUTCFullYear() : d.getFullYear();
  const mo = (utc ? d.getUTCMonth() : d.getMonth()) + 1;
  const da = utc ? d.getUTCDate() : d.getDate();
  const date = `${pad(y, 4)}-${pad(mo)}-${pad(da)}`;
  if (kind === 'date') return date;
  const h = utc ? d.getUTCHours() : d.getHours();
  const mi = utc ? d.getUTCMinutes() : d.getMinutes();
  return `${date}T${pad(h)}:${pad(mi)}`;
}

/** An input value -> ms (NaN when it is not a full date / datetime). */
export function parsePickerValue(
  value,
  { kind = 'datetime-local', zone = 'utc' } = {},
) {
  if (typeof value !== 'string') return NaN;
  const re =
    kind === 'date' ? /^\d{4}-\d\d-\d\d$/ : /^\d{4}-\d\d-\d\dT\d\d:\d\d/;
  if (!re.test(value)) return NaN;
  const iso = kind === 'date' ? `${value}T00:00` : value.slice(0, 16);
  return zone === 'utc' ? Date.parse(`${iso}:00Z`) : new Date(iso).getTime();
}

// ── the control ───────────────────────────────────────────

function el(doc, tag, { cls, text, attrs } = {}) {
  const node = doc.createElement(tag);
  // minimal test DOMs have no style object
  if (!node.style) node.style = {};
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  for (const [k, v] of Object.entries(attrs ?? {}))
    node.setAttribute(k, String(v));
  return node;
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const pct = (x) => `${(clamp01(x) * 100).toFixed(3)}%`;

/**
 * @param {object} options
 *   document, parent       DOM; the root is appended to parent when given
 *   classPrefix            'gev-ts' (default) or 'gev-hist' (History)
 *   ariaLabel              name of the scrub (role=slider)
 *   rates                  speed buttons (numbers); [] = no speed group
 *   rateLabel              (rate) => button text
 *   steps                  false hides step back / forward
 *   play                   false hides play / pause
 *   playText               {play, pause}: button text (default glyphs)
 *   picker                 {kind: 'date'|'datetime-local', zone: 'utc'|'local',
 *                           label, unit} or null
 *   latestLabel            text of an extra "Latest" button, or null
 *   keys                   false: the scrub does not handle keys itself
 *   before / extra         nodes placed in the control row before the step
 *                          buttons / before the picker (Sky: Live, reverse)
 *   attrs                  {scrub, thumb, back, play, fwd, rates, picker,
 *                           latest, root: {name: value}} extra attributes
 *   labels                 {back, fwd, play, pause, rates, picker}
 *   onScrub(fraction, phase)   phase 'start' | 'move' | 'end'
 *   onStep(dir, count, event)  button / key step (event: the click / key)
 *   onJump('start' | 'end')    Home / End
 *   onPlay(wantPlaying)        play button
 *   onRate(rate)               speed button
 *   onPick(ms)                 picker change with a valid value
 *   onLatest()                 Latest button
 */
export function createTimeSlider(options = {}) {
  const {
    document: doc = globalThis.document,
    parent = null,
    classPrefix = TS_DEFAULT_PREFIX,
    ariaLabel = 'Time',
    rates = TS_DEFAULT_RATES,
    rateLabel = (r) => `${r}x`,
    steps = true,
    play: showPlay = true,
    playText = null,
    picker = null,
    latestLabel = null,
    keys = true,
    before = [],
    extra = [],
    attrs = {},
    labels = {},
    onScrub = null,
    onStep = null,
    onJump = null,
    onPlay = null,
    onRate = null,
    onPick = null,
    onLatest = null,
  } = options;
  if (!doc?.createElement) throw new TypeError('A document is required');
  const P = classPrefix;
  if (classPrefix === TS_DEFAULT_PREFIX) ensureTimeSliderStyle(doc, P);
  const L = {
    back: 'Step back (Shift = 10)',
    fwd: 'Step forward (Shift = 10)',
    play: 'Play',
    pause: 'Pause',
    rates: 'Speed',
    picker: 'Go to date',
    ...labels,
  };
  const playLabelText = {
    play: playText?.play ?? GLYPH_PLAY,
    pause: playText?.pause ?? GLYPH_PAUSE,
  };

  const root = el(doc, 'div', {
    cls: `${P}-slider`,
    attrs: { role: 'group', 'aria-label': ariaLabel, ...(attrs.root ?? {}) },
  });
  const scrub = el(doc, 'div', {
    cls: `${P}-scrub`,
    attrs: {
      role: 'slider',
      tabindex: '0',
      'aria-label': ariaLabel,
      'aria-valuemin': '0',
      'aria-valuemax': String(TS_ARIA_MAX),
      'aria-valuenow': String(TS_ARIA_MAX),
      ...(attrs.scrub ?? {}),
    },
  });
  const thumb = el(doc, 'div', {
    cls: `${P}-thumb`,
    attrs: attrs.thumb ?? {},
  });
  scrub.append(thumb);
  const tickLabels = el(doc, 'div', {
    cls: `${P}-ticklabels`,
    attrs: { 'aria-hidden': 'true' },
  });
  tickLabels.hidden = true;
  const edges = el(doc, 'div', { cls: `${P}-row ${P}-edges` });
  const edgeFrom = el(doc, 'span', { cls: `${P}-edge` });
  const edgeTo = el(doc, 'span', { cls: `${P}-edge` });
  edges.append(edgeFrom, edgeTo);

  const controls = el(doc, 'div', { cls: `${P}-row ${P}-controls` });
  const mkBtn = (name, text, extra = {}) =>
    el(doc, 'button', {
      cls: `${P}-btn${extra.cls ? ` ${extra.cls}` : ''}`,
      text,
      attrs: { type: 'button', ...(extra.attrs ?? {}), ...(attrs[name] ?? {}) },
    });
  const back = steps
    ? mkBtn('back', GLYPH_BACK, {
        attrs: { title: L.back, 'aria-label': 'Step back' },
      })
    : null;
  const play = showPlay
    ? mkBtn('play', playLabelText.play, {
        cls: `${P}-play`,
        attrs: { 'aria-label': L.play, 'aria-pressed': 'false' },
      })
    : null;
  const fwd = steps
    ? mkBtn('fwd', GLYPH_FWD, {
        attrs: { title: L.fwd, 'aria-label': 'Step forward' },
      })
    : null;
  for (const n of before) controls.append(n);
  for (const b of [back, play, fwd]) if (b) controls.append(b);
  const rateGroup = el(doc, 'div', {
    cls: `${P}-rates`,
    attrs: { role: 'group', 'aria-label': L.rates, ...(attrs.rates ?? {}) },
  });
  const rateButtons = new Map();
  for (const r of rates) {
    const b = el(doc, 'button', {
      cls: `${P}-btn`,
      text: rateLabel(r),
      attrs: {
        type: 'button',
        'data-rate': r,
        'aria-pressed': 'false',
        ...(attrs.rate?.(r) ?? {}),
      },
    });
    rateButtons.set(r, b);
    rateGroup.append(b);
  }
  if (rateButtons.size) controls.append(rateGroup);
  for (const n of extra) controls.append(n);
  let pickerInput = null;
  let pickerUnit = null;
  if (picker) {
    pickerInput = el(doc, 'input', {
      cls: `${P}-picker`,
      attrs: {
        type: picker.kind === 'date' ? 'date' : 'datetime-local',
        'aria-label': picker.label ?? L.picker,
        ...(attrs.picker ?? {}),
      },
    });
    controls.append(pickerInput);
    if (picker.unit) {
      pickerUnit = el(doc, 'span', { cls: `${P}-unit`, text: picker.unit });
      controls.append(pickerUnit);
    }
  }
  const latest = latestLabel
    ? mkBtn('latest', latestLabel, { attrs: { 'aria-label': latestLabel } })
    : null;
  if (latest) controls.append(latest);
  root.append(scrub, tickLabels, edges, controls);
  if (parent) parent.append(root);

  const removers = [];
  const listen = (target, type, fn, opts) => {
    if (!target?.addEventListener) return;
    target.addEventListener(type, fn, opts);
    removers.push(() => target.removeEventListener(type, fn, opts));
  };
  const state = { fraction: 1, playing: false, rate: rates[0] ?? null };
  let dragging = false;
  let lastFraction = 1;
  let destroyed = false;

  const fractionAt = (clientX) => {
    const r = scrub.getBoundingClientRect?.();
    if (!r || !(r.width > 0)) return null;
    return clamp01((clientX - r.left) / r.width);
  };

  listen(scrub, 'pointerdown', (e) => {
    const f = fractionAt(e.clientX);
    if (f === null) return;
    dragging = true;
    lastFraction = f;
    try {
      scrub.setPointerCapture?.(e.pointerId);
    } catch {
      /* synthetic events have no capture */
    }
    onScrub?.(f, 'start');
    e.preventDefault?.();
  });
  listen(scrub, 'pointermove', (e) => {
    if (!dragging) return;
    const f = fractionAt(e.clientX);
    if (f === null) return;
    lastFraction = f;
    onScrub?.(f, 'move');
  });
  const release = () => {
    if (!dragging) return;
    dragging = false;
    onScrub?.(lastFraction, 'end');
  };
  listen(scrub, 'pointerup', release);
  listen(scrub, 'pointercancel', release);

  if (keys)
    listen(scrub, 'keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      let dir = 0;
      let count = 1;
      switch (e.key) {
        case 'ArrowLeft':
        case 'ArrowDown':
          dir = -1;
          count = e.shiftKey ? TS_BIG_STEP : 1;
          break;
        case 'ArrowRight':
        case 'ArrowUp':
          dir = 1;
          count = e.shiftKey ? TS_BIG_STEP : 1;
          break;
        case 'PageDown':
          dir = -1;
          count = TS_BIG_STEP;
          break;
        case 'PageUp':
          dir = 1;
          count = TS_BIG_STEP;
          break;
        case 'Home':
          e.preventDefault?.();
          e.stopPropagation?.();
          onJump?.('start');
          return;
        case 'End':
          e.preventDefault?.();
          e.stopPropagation?.();
          onJump?.('end');
          return;
        default:
          return;
      }
      // keys typed on the scrub are for it alone (the globe's WASD / arrows
      // and the History document-level arrows never see them)
      e.preventDefault?.();
      e.stopPropagation?.();
      onStep?.(dir, count, e);
    });
  listen(back, 'click', (e) => onStep?.(-1, e?.shiftKey ? TS_BIG_STEP : 1, e));
  listen(fwd, 'click', (e) => onStep?.(1, e?.shiftKey ? TS_BIG_STEP : 1, e));
  listen(play, 'click', () => onPlay?.(!state.playing));
  for (const [r, b] of rateButtons) listen(b, 'click', () => onRate?.(r));
  listen(pickerInput, 'change', () => {
    const ms = parsePickerValue(pickerInput.value, picker);
    if (Number.isFinite(ms)) onPick?.(ms);
  });
  listen(latest, 'click', () => onLatest?.());

  const handle = {
    root,
    scrub,
    thumb,
    edges,
    edgeFrom,
    edgeTo,
    controls,
    back,
    play,
    fwd,
    rateButtons,
    rateGroup,
    picker: pickerInput,
    pickerUnit,
    latest,
    get destroyed() {
      return destroyed;
    },
    get dragging() {
      return dragging;
    },
    getState: () => ({ ...state }),
    /** Thumb position 0..1 and the matching aria values. */
    setFraction(f, valueText) {
      state.fraction = clamp01(Number.isFinite(f) ? f : 0);
      thumb.style.left = pct(state.fraction);
      scrub.setAttribute(
        'aria-valuenow',
        String(Math.round(state.fraction * TS_ARIA_MAX)),
      );
      if (valueText !== undefined)
        scrub.setAttribute('aria-valuetext', String(valueText));
    },
    setEdges(from, to) {
      if (from !== undefined) edgeFrom.textContent = String(from);
      if (to !== undefined) edgeTo.textContent = String(to);
    },
    /** Tick marks: [{fraction, label?}]; labels show under the bar. */
    setTicks(ticks = []) {
      const marks = [];
      const labelNodes = [];
      for (const t of ticks) {
        const m = el(doc, 'div', { cls: `${P}-tick` });
        m.style.left = pct(t.fraction);
        marks.push(m);
        if (t.label !== undefined) {
          const l = el(doc, 'span', { cls: `${P}-ticklabel`, text: t.label });
          l.style.left = pct(t.fraction);
          labelNodes.push(l);
        }
      }
      for (const old of [...scrub.children].filter((c) => c !== thumb))
        old.remove();
      if (marks.length) scrub.append(...marks);
      for (const old of [...tickLabels.children]) old.remove();
      if (labelNodes.length) tickLabels.append(...labelNodes);
      tickLabels.hidden = labelNodes.length === 0;
      // the end labels already say it: no second edges row under them
      edges.hidden = labelNodes.length > 0;
    },
    setPlaying(on) {
      state.playing = Boolean(on);
      if (!play) return;
      play.textContent = state.playing
        ? playLabelText.pause
        : playLabelText.play;
      play.setAttribute('aria-label', state.playing ? L.pause : L.play);
      play.setAttribute('aria-pressed', String(state.playing));
    },
    setRate(rate) {
      state.rate = rate;
      for (const [r, b] of rateButtons)
        b.setAttribute('aria-pressed', String(r === rate));
    },
    /** Enable / disable the transport: {back, fwd, play, latest}. */
    setEnabled(flags = {}) {
      if (back && 'back' in flags) back.disabled = !flags.back;
      if (fwd && 'fwd' in flags) fwd.disabled = !flags.fwd;
      if (play && 'play' in flags) play.disabled = !flags.play;
      if (latest && 'latest' in flags) latest.disabled = !flags.latest;
    },
    setPickerValue(ms) {
      if (!pickerInput || !picker) return;
      // never overwrite what the user is typing
      if (doc.activeElement === pickerInput) return;
      pickerInput.value = pickerValue(ms, picker);
    },
    setPickerRange(minMs, maxMs) {
      if (!pickerInput || !picker) return;
      if (Number.isFinite(minMs))
        pickerInput.setAttribute('min', pickerValue(minMs, picker));
      if (Number.isFinite(maxMs))
        pickerInput.setAttribute('max', pickerValue(maxMs, picker));
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const remove of removers.splice(0)) remove();
      root.remove?.();
    },
  };
  handle.setPlaying(false);
  if (state.rate !== null) handle.setRate(state.rate);
  handle.setFraction(1);
  return handle;
}

// ── the index-over-a-list model ───────────────────────────

/**
 * A slider over a list of items (Wayback releases, NAIP years): the thumb
 * stands on an item, a step is one item, play moves forward one item per
 * tick (TS_DISCRETE_BASE_MS / rate), the picker takes the nearest item.
 *
 * @param {object} options  createTimeSlider options, plus
 *   items            [{value, label?, ms?}] ascending (oldest first)
 *   index            starting index (default: the last)
 *   tickLabels       true: a label under the bar for every item
 *   onChange(index, {source})  an index change the user made
 *   timers, baseIntervalMs
 */
export function createDiscreteSlider(options = {}) {
  const {
    items: initialItems = [],
    index: initialIndex,
    tickLabels = false,
    onChange = null,
    timers = globalThis,
    baseIntervalMs = TS_DISCRETE_BASE_MS,
    rates = [1, 2, 4],
    ...rest
  } = options;
  let items = [...initialItems];
  let index = Number.isInteger(initialIndex)
    ? initialIndex
    : Math.max(0, items.length - 1);
  let timer = null;
  let rate = rates[0] ?? 1;

  const fractionOf = (i) => (items.length > 1 ? i / (items.length - 1) : 1);
  const clampIndex = (i) => Math.max(0, Math.min(items.length - 1, i));

  const ui = createTimeSlider({
    ...rest,
    rates,
    onScrub(f, phase) {
      if (!items.length) return;
      // a drag takes over from playback
      if (phase === 'start') stop();
      const i = clampIndex(Math.round(f * (items.length - 1)));
      // the thumb follows the pointer; the item changes on a new stop
      if (i !== index) move(i, 'scrub');
      else if (phase === 'end') ui.setFraction(fractionOf(index));
    },
    onStep(dir, count) {
      stop();
      move(clampIndex(index + dir * count), 'step');
    },
    onJump(which) {
      stop();
      move(which === 'start' ? 0 : items.length - 1, 'jump');
    },
    onPlay(want) {
      if (want) start();
      else stop();
    },
    onRate(r) {
      rate = r;
      ui.setRate(r);
      if (timer) restartTimer();
    },
    onPick(ms) {
      const i = nearestIndex(ms);
      if (i < 0) return;
      stop();
      move(i, 'pick');
    },
    onLatest() {
      stop();
      move(items.length - 1, 'latest');
    },
  });

  function nearestIndex(ms) {
    let best = -1;
    let bestD = Infinity;
    items.forEach((it, i) => {
      if (!Number.isFinite(it.ms)) return;
      const d = Math.abs(it.ms - ms);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  function sync() {
    ui.setFraction(fractionOf(index), items[index]?.label ?? '');
    ui.setEdges(items[0]?.label ?? '', items[items.length - 1]?.label ?? '');
    ui.setEnabled({
      back: index > 0,
      fwd: index < items.length - 1,
      play: items.length > 1,
      latest: index < items.length - 1,
    });
    const ms = items[index]?.ms;
    if (Number.isFinite(ms)) ui.setPickerValue(ms);
  }

  function move(i, source) {
    if (!items.length) return;
    const next = clampIndex(i);
    if (next === index) {
      sync();
      return;
    }
    index = next;
    sync();
    onChange?.(index, { source });
  }

  function stop() {
    if (timer) timers.clearInterval(timer);
    timer = null;
    ui.setPlaying(false);
  }

  function restartTimer() {
    if (timer) timers.clearInterval(timer);
    timer = timers.setInterval(
      tick,
      Math.max(TICK_MS, baseIntervalMs / Math.max(1, rate)),
    );
  }

  function tick() {
    if (index >= items.length - 1) {
      stop();
      return;
    }
    move(index + 1, 'play');
    if (index >= items.length - 1) stop();
  }

  function start() {
    if (items.length < 2) return;
    // at the newest: play again from the oldest
    if (index >= items.length - 1) move(0, 'play');
    ui.setPlaying(true);
    restartTimer();
  }

  if (tickLabels || items.length) refreshTicks();
  function refreshTicks() {
    ui.setTicks(
      items.length > TS_MAX_TICKS
        ? []
        : items.map((it, i) => ({
            fraction: fractionOf(i),
            ...(tickLabels
              ? { label: String(it.label ?? it.value ?? '') }
              : {}),
          })),
    );
  }
  if (ui.rateButtons.size) ui.setRate(rate);
  sync();

  const handle = {
    ...ui,
    ui,
    getIndex: () => index,
    getItems: () => [...items],
    isPlaying: () => Boolean(timer),
    /** The caller moved (no onChange): follow it. */
    setIndex(i) {
      index = clampIndex(i);
      sync();
    },
    setItems(next, i) {
      stop();
      items = [...next];
      index = clampIndex(Number.isInteger(i) ? i : index);
      refreshTicks();
      sync();
    },
    /** Readout text of the current item (aria-valuetext). */
    setValueText(text) {
      ui.setFraction(fractionOf(index), text);
    },
    stop,
    destroy() {
      stop();
      ui.destroy();
    },
  };
  // the spread above would freeze these getters at their creation values
  Object.defineProperties(handle, {
    destroyed: { get: () => ui.destroyed, enumerable: true },
    dragging: { get: () => ui.dragging, enumerable: true },
  });
  return handle;
}
