/**
 * History-bound Sky time provider (SKYVIEW.md 7, DESIGN.md 4.5, B11/B12).
 *
 * When the History time slider is active it owns the time for the whole
 * app, and Sky view follows it: Sky hides its own scrubber, shows a
 * "Time: History" chip and keeps only its presets (which ask the History
 * control to seek when it offers that).
 *
 * The History control needs no import of Sky code. Two ways to connect,
 * both carrying the same state:
 *   1. an object  { getState() -> state, subscribe(fn) -> unsubscribe,
 *                   getTime?() -> ms }               (tests, direct wiring)
 *   2. a DOM event on window:  new CustomEvent('gev:history-time',
 *                   { detail: state })                (the B11 hook)
 * state = {
 *   active:   boolean   History mode on (false = Sky uses its own clock)
 *   timeMs:   number    the History time `ht` (UTC ms)
 *   playing:  boolean   History play state
 *   rate:     number    sky seconds per wall second while playing
 *   seek?:    (ms) => void       optional: Sky presets move the History time
 *   satelliteSource?: (timeMs) => { key, fetchText(path) } | null
 *             optional (B12 item 2): GP elements with the epoch nearest t;
 *             `key` changes when another element set applies
 *   error?:   string    History unavailable (Sky falls back to its clock)
 * }
 */
export const HISTORY_EVENT = 'gev:history-time';

function readState(raw, receivedAt) {
  const timeMs = Number(raw?.timeMs);
  const rate = Number(raw?.rate);
  return {
    active: Boolean(raw?.active) && Number.isFinite(timeMs) && !raw?.error,
    timeMs: Number.isFinite(timeMs) ? timeMs : null,
    playing: Boolean(raw?.playing),
    rate: Number.isFinite(rate) && rate !== 0 ? rate : 1,
    seek: typeof raw?.seek === 'function' ? raw.seek : null,
    satelliteSource:
      typeof raw?.satelliteSource === 'function' ? raw.satelliteSource : null,
    error: raw?.error ? String(raw.error) : null,
    receivedAt,
  };
}

/**
 * @param {object} options
 *   control?  object form (1)
 *   target?   event target for form (2), default window
 *   now?      wall clock (ms)
 */
export function createHistoryProvider({
  control = null,
  target = globalThis.window ?? null,
  now = () => Date.now(),
} = {}) {
  const listeners = new Set();
  const removers = [];
  let state = readState(null, now());
  const emit = () => {
    for (const listener of [...listeners]) {
      try {
        listener(provider);
      } catch {
        /* keep going */
      }
    }
  };
  const accept = (raw) => {
    state = readState(raw, now());
    emit();
  };

  if (control && typeof control.getState === 'function') {
    state = readState(control.getState(), now());
    const off = control.subscribe?.(() => accept(control.getState()));
    if (typeof off === 'function') removers.push(off);
  } else if (target?.addEventListener) {
    const onEvent = (event) => accept(event?.detail);
    target.addEventListener(HISTORY_EVENT, onEvent);
    removers.push(() => target.removeEventListener(HISTORY_EVENT, onEvent));
  }

  const provider = {
    get active() {
      return state.active;
    },
    get playing() {
      return state.active && state.playing;
    },
    get rate() {
      return state.rate;
    },
    get error() {
      return state.error;
    },
    get canSeek() {
      return Boolean(state.seek);
    },
    /** History time `ht`; while playing it advances between events. */
    getTime() {
      if (!state.active) return null;
      if (typeof control?.getTime === 'function') {
        const t = Number(control.getTime());
        if (Number.isFinite(t)) return t;
      }
      if (!state.playing) return state.timeMs;
      return state.timeMs + (now() - state.receivedAt) * state.rate;
    },
    /** Ask the History control to move to `ms` (false when it cannot). */
    seek(ms) {
      if (!state.active || !state.seek || !Number.isFinite(ms)) return false;
      state.seek(ms);
      return true;
    },
    /** GP element source with the epoch nearest `timeMs`, or null. */
    satelliteSourceAt(timeMs) {
      if (!state.active || !state.satelliteSource) return null;
      try {
        const source = state.satelliteSource(timeMs);
        return source && typeof source.fetchText === 'function'
          ? { key: String(source.key ?? ''), fetchText: source.fetchText }
          : null;
      } catch {
        return null;
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      for (const remove of removers.splice(0)) remove();
      listeners.clear();
    },
  };
  return provider;
}
