/**
 * Satellites at a history time (card t_73beacfb, History menu).
 *
 * While a time is set, the layer propagates every satellite at that time with
 * the recorded element set nearest it (GET /api/history/slice?feed=gp, the
 * `active` group of gev-history-gp, CelesTrak GP CSV) instead of the live
 * catalog at Date.now(). A satellite the recorder had no element set for at
 * that time is hidden (it was not tracked yet), never drawn from a newer
 * element set. Element sets dated after "now" (the recorder has seen epochs a
 * day ahead) are clamped out by the server; a row whose epoch is still after
 * the asked time is only used when it is within ELSET_MAX_AHEAD_MS of it.
 *
 * Elsets are fetched once per ELSET_REUSE_MS window; between fetches the same
 * elsets are re-propagated at the new time (SGP4 holds within a day or two).
 */
import { json2satrec } from 'satellite.js';
import { parseGP } from '../../byrdit/gpCsv.js';
import { noradIdFromSatnum } from '../../sources/tle.js';

export const ELSET_REUSE_MS = 12 * 3_600_000;
export const ELSET_MAX_AHEAD_MS = 3 * 86_400_000;
const MAX_ROWS = 15_000; // the API maximum

export function createHistory({ state: layerState, parts = null }) {
  /** NORAD -> satrec the live catalog had, while a history time is set. */
  const liveSatrecs = new Map();
  let fetchedAt = NaN;
  let token = 0;

  const noradOf = (satrec) => noradIdFromSatnum(satrec.satnum);

  /** The tracked satellite's dot is drawn by its entity (tracking.js). */
  const drawnByPoint = (id) => id !== layerState._trackedNorad;

  /** ids with no recorded element set at the history time (never drawn) */
  const hidden = () => (layerState._historyHidden ??= new Set());

  /** A satellite that is tracked cannot stay tracked once it is not drawn. */
  function untrackIfHidden() {
    const id = layerState._trackedNorad;
    if (id && hidden().has(id))
      parts?.tracking?._clearTracking?.(false, { origin: 'programmatic' });
  }

  // Orbit paths are built from the live element sets: a satellite that is not
  // drawn at the history time must not keep its path on screen.
  const pathsHidden = new Set();
  function syncPaths() {
    for (const [id, path] of layerState._orbitPaths ?? []) {
      if (!path.primitive) continue;
      if (hidden().has(id) && path.primitive.show !== false) {
        path.primitive.show = false;
        pathsHidden.add(id);
      }
    }
  }
  function showPaths() {
    for (const id of pathsHidden) {
      const path = layerState._orbitPaths?.get(id);
      if (path?.primitive) path.primitive.show = true;
    }
    pathsHidden.clear();
  }

  function restore() {
    showPaths();
    hidden().clear();
    for (const [id, satrec] of liveSatrecs) {
      const sat = layerState._catalog.get(id);
      if (sat) sat.satrec = satrec;
    }
    liveSatrecs.clear();
    for (const [id, point] of layerState._points) point.show = drawnByPoint(id);
    fetchedAt = NaN;
  }

  /** No element sets known for the time: draw nothing, never a wrong place. */
  function hideAll({ untrack = true } = {}) {
    for (const [id, point] of layerState._points) {
      point.show = false;
      hidden().add(id);
    }
    syncPaths();
    // while sets are still loading we do not know yet who has none: the
    // satellite being followed stays followed until the answer says otherwise
    if (untrack) untrackIfHidden();
    fetchedAt = NaN;
  }

  function apply(rows, tMs) {
    const byId = new Map();
    for (const row of rows) {
      const satrec = json2satrec(row.gp);
      if (!satrec || satrec.error !== 0) continue;
      const epoch = Date.parse(`${row.gp.EPOCH}Z`);
      if (Number.isFinite(epoch) && epoch - tMs > ELSET_MAX_AHEAD_MS) continue;
      byId.set(noradOf(satrec), satrec);
    }
    for (const [id, sat] of layerState._catalog) {
      const point = layerState._points.get(id);
      const next = byId.get(id);
      if (!liveSatrecs.has(id)) liveSatrecs.set(id, sat.satrec);
      if (next) {
        sat.satrec = next;
        hidden().delete(id);
        if (point) point.show = drawnByPoint(id);
      } else {
        hidden().add(id);
        if (point) point.show = false;
      }
    }
    showPaths();
    syncPaths();
    untrackIfHidden();
    return byId.size;
  }

  async function load(tMs, mine) {
    const url = `/api/history/slice?feed=gp&group=active&maxRows=${MAX_ROWS}&t=${encodeURIComponent(
      new Date(tMs).toISOString(),
    )}`;
    const res = await globalThis.fetch(url);
    const text = res.ok ? await res.text() : '';
    const truncated = res.headers?.get?.('x-history-truncated') === '1';
    if (mine !== token) return { status: 'superseded' };
    const rows = parseGP(text);
    if (!rows.length) {
      hideAll();
      return { status: res.ok ? 'empty' : 'unavailable' };
    }
    fetchedAt = tMs;
    return { status: truncated ? 'truncated' : 'ok', count: apply(rows, tMs) };
  }

  /**
   * The live catalog was rebuilt (ingestion.js): its satellites carry live
   * element sets again, so the saved ones are void. While a history time is
   * set, hide them and apply the recorded sets again.
   */
  function onCatalogReloaded() {
    liveSatrecs.clear();
    fetchedAt = NaN;
    const ms = layerState._historyMs;
    if (!Number.isFinite(ms)) return;
    hideAll();
    const mine = ++token;
    load(ms, mine).catch(() => {
      if (mine === token) hideAll();
    });
  }

  return {
    onCatalogReloaded,
    methods: {
      /** ms = show the layer as of that time, null = back to live. */
      async setHistoryTime(ms) {
        const mine = ++token;
        if (!Number.isFinite(ms)) {
          layerState._historyMs = null;
          restore();
          layerState._lastPropagation = 0;
          return { status: 'live' };
        }
        layerState._historyMs = ms;
        layerState._lastPropagation = 0;
        if (
          Number.isFinite(fetchedAt) &&
          Math.abs(ms - fetchedAt) < ELSET_REUSE_MS
        )
          return { status: 'ok', reused: true };
        // the sets for this time are not here yet: draw nothing until they are,
        // never the live (or an older recorded) position at this time
        hideAll({ untrack: false });
        try {
          return await load(ms, mine);
        } catch {
          if (mine === token) hideAll();
          return { status: 'unavailable' };
        }
      },
      getHistoryState: () => ({
        timeMs: layerState._historyMs ?? null,
        elsetAtMs: Number.isFinite(fetchedAt) ? fetchedAt : null,
      }),
    },
  };
}
