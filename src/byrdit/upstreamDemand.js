/**
 * Byrd-IT fork: server-side upstream feeds only while someone is watching
 * (t_75fc43e5, 2026-10-09). Pure, no DOM; used by
 * server/providers/vessels/ais-live.js.
 */

/** Server-side upstream subscriptions (AISStream websocket) are released
 * after this long with no viewer request. Override with
 * GEV_UPSTREAM_IDLE_RELEASE_MS (0 = never release, upstream behavior). */
export const UPSTREAM_IDLE_RELEASE_MS = 30 * 60_000;

/** Reads the idle-release window from the environment. */
export function upstreamIdleReleaseMs(env = globalThis.process?.env || {}) {
  const raw = env.GEV_UPSTREAM_IDLE_RELEASE_MS;
  if (raw === undefined || raw === '') return UPSTREAM_IDLE_RELEASE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : UPSTREAM_IDLE_RELEASE_MS;
}

/**
 * True while some viewer asked for the feed within the idle window. A server
 * that has never been asked has no demand (no connect at startup).
 */
export function upstreamDemandActive(lastDemandAt, nowMs, idleMs) {
  if (!(idleMs > 0)) return true;
  return lastDemandAt > 0 && nowMs - lastDemandAt <= idleMs;
}
