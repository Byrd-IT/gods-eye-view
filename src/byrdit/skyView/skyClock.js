/**
 * Sky time (SKYVIEW.md 7). One clock is the only time source for the sky
 * overlay and Cesium's viewer.clock (so the sun lighting and the atmosphere
 * follow it). P1 has two modes: 'live' (Date.now() on every read, no drift)
 * and 'fixed' (a picked UTC instant). Play/speeds and the History provider
 * arrive in P5 behind the same getTime()/subscribe() interface.
 */
export function createSkyClock({ now = () => Date.now() } = {}) {
  let mode = 'live';
  let fixedMs = null;
  const listeners = new Set();
  const emit = () => {
    for (const listener of [...listeners]) listener(clock);
  };
  const clock = {
    get mode() {
      return mode;
    },
    getTime() {
      return mode === 'fixed' ? fixedMs : now();
    },
    setLive() {
      if (mode === 'live') return;
      mode = 'live';
      fixedMs = null;
      emit();
    },
    setFixed(ms) {
      const value = Number(ms);
      if (!Number.isFinite(value)) return false;
      if (mode === 'fixed' && fixedMs === value) return true;
      mode = 'fixed';
      fixedMs = value;
      emit();
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return clock;
}
