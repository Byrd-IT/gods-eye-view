/**
 * Byrd-IT Open base-map health (P9 follow-up, card t_27a7db75).
 *
 * The edge hosts publish a health report (gb-refresh.py, P9). The /basemap
 * proxy serves a credential-free copy at /basemap/health.json (proxy.js
 * composeHealth). This module reads it in the browser and turns it into the
 * one thing the UI shows: a "degraded" reason for the Byrd-IT Open chip.
 *
 * Health is advice, never a gate. Availability still comes only from
 * /basemap/config.json, and nothing here is awaited by the stack. A health
 * fetch that fails, times out, or returns junk counts as "unknown", and
 * unknown means no badge: it never greys out, hides or blocks the chip.
 * Note what that does to a badge already shown: a failed poll after a
 * degraded one moves degraded -> unknown, so the "(degraded)" badge and its
 * tooltip are cleared (no stale warning is kept). A failed poll while
 * healthy or unknown changes nothing.
 */

export const BASEMAP_HEALTH_URL = '/basemap/health.json';
export const HEALTH_STATES = Object.freeze(['ok', 'degraded', 'down']);
/** The P9 health timer writes every 5 min; poll at the same rate. */
export const HEALTH_POLL_MS = 5 * 60 * 1000;
export const HEALTH_TIMEOUT_MS = 4_000;
const MAX_HINT = 200;
const DEFAULT_DEGRADED = 'Byrd-IT Open map service is degraded';

export const UNKNOWN_HEALTH = Object.freeze({
  state: 'unknown',
  chip: null,
  warning: null,
});

const text = (value) =>
  typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .trim()
        .slice(0, MAX_HINT)
    : '';

/**
 * Validate the proxy's health answer. Only the state, the chip text and the
 * first warning survive; anything else is ignored.
 * @param {unknown} raw
 * @returns {{state: 'ok'|'degraded'|'down'|'unknown', chip: string|null, warning: string|null}}
 */
export function normalizeBasemapHealth(raw) {
  const state = raw?.state;
  if (raw?.available === false || !HEALTH_STATES.includes(state))
    return UNKNOWN_HEALTH;
  const warnings = Array.isArray(raw?.warnings) ? raw.warnings : [];
  const warning = warnings.map(text).find(Boolean) ?? null;
  return { state, chip: text(raw?.chip) || null, warning };
}

/**
 * The degraded reason the chip shows as its tooltip, or null when healthy or
 * unknown. "down" is shown as degraded too: the config said the stack is
 * available, so the map still works (from the standby edge, or Esri on tile
 * failures), and health never greys a working chip out.
 */
export function basemapDegradedReason(health) {
  if (health?.state !== 'degraded' && health?.state !== 'down') return null;
  return health.warning || health.chip || DEFAULT_DEGRADED;
}

/**
 * GET /basemap/health.json. Never throws (an abort included): any failure is
 * UNKNOWN_HEALTH.
 */
export async function loadBasemapHealth({
  fetchImpl = globalThis.fetch,
  signal,
  timeoutMs = HEALTH_TIMEOUT_MS,
} = {}) {
  try {
    const timeout = AbortSignal.timeout?.(timeoutMs);
    const combined =
      signal && timeout && AbortSignal.any
        ? AbortSignal.any([signal, timeout])
        : (signal ?? timeout);
    const response = await fetchImpl(BASEMAP_HEALTH_URL, {
      signal: combined,
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    });
    if (!response.ok) {
      await response.body?.cancel?.();
      return UNKNOWN_HEALTH;
    }
    return normalizeBasemapHealth(await response.json());
  } catch {
    return UNKNOWN_HEALTH;
  }
}

/**
 * Holds the latest health and polls it. `onChange` fires only when the
 * degraded reason the UI shows actually changes.
 * @param {{load?: () => Promise<object>, intervalMs?: number, timers?: {setTimeout: Function, clearTimeout: Function}, onChange?: (reason: string|null) => void}} [options]
 */
export function createBasemapHealthMonitor({
  load = () => loadBasemapHealth(),
  intervalMs = HEALTH_POLL_MS,
  timers = globalThis,
  onChange = () => {},
} = {}) {
  let health = UNKNOWN_HEALTH;
  let reason = null;
  let timer = null;
  let stopped = false;
  let started = false;
  let listener = onChange;

  async function poll() {
    timer = null;
    let next;
    try {
      next = await load();
    } catch {
      next = UNKNOWN_HEALTH;
    }
    if (stopped) return;
    health = next ?? UNKNOWN_HEALTH;
    const nextReason = basemapDegradedReason(health);
    if (nextReason !== reason) {
      reason = nextReason;
      try {
        listener(reason);
      } catch {
        /* presentation never breaks the map */
      }
    }
    timer = timers.setTimeout(poll, intervalMs);
    // Node (tests, SSR): a background poll never keeps the process alive.
    timer?.unref?.();
  }

  return {
    start() {
      if (stopped || started) return;
      started = true;
      void poll();
    },
    stop() {
      stopped = true;
      if (timer) timers.clearTimeout(timer);
      timer = null;
    },
    get health() {
      return health;
    },
    get degradedReason() {
      return reason;
    },
    set onChange(fn) {
      listener = typeof fn === 'function' ? fn : () => {};
    },
  };
}
