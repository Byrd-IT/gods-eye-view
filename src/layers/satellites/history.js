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

export function createHistory({ state: layerState }) {
  /** NORAD -> satrec the live catalog had, while a history time is set. */
  const liveSatrecs = new Map();
  let fetchedAt = NaN;
  let token = 0;

  const noradOf = (satrec) => noradIdFromSatnum(satrec.satnum);

  function restore() {
    for (const [id, satrec] of liveSatrecs) {
      const sat = layerState._catalog.get(id);
      if (sat) sat.satrec = satrec;
    }
    liveSatrecs.clear();
    for (const point of layerState._points.values()) point.show = true;
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
        if (point) point.show = true;
      } else if (point) {
        point.show = false;
      }
    }
    return byId.size;
  }

  async function load(tMs, mine) {
    const url = `/api/history/slice?feed=gp&group=active&maxRows=${MAX_ROWS}&t=${encodeURIComponent(
      new Date(tMs).toISOString(),
    )}`;
    const res = await globalThis.fetch(url);
    const text = res.ok ? await res.text() : '';
    if (mine !== token) return { status: 'superseded' };
    const rows = parseGP(text);
    if (!rows.length) return { status: 'empty' };
    fetchedAt = tMs;
    return { status: 'ok', count: apply(rows, tMs) };
  }

  return {
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
        if (Number.isFinite(fetchedAt) && Math.abs(ms - fetchedAt) < ELSET_REUSE_MS)
          return { status: 'ok', reused: true };
        try {
          return await load(ms, mine);
        } catch {
          return { status: 'unavailable' };
        }
      },
      getHistoryState: () => ({
        timeMs: layerState._historyMs ?? null,
        elsetAtMs: Number.isFinite(fetchedAt) ? fetchedAt : null,
      }),
    },
    /** The date the layer propagates at: the history time, else now. */
    nowDate: () => new Date(layerState._historyMs ?? Date.now()),
  };
}
