/**
 * History adapter for the USGS river-gauge layer (card t_7a4c6a57; the
 * contract is that of historyAdapters.js, the slice is historySlicesWater.js).
 *
 * The layer (src/byrdit/usgsWater.js) loads the stream gauges as 4-degree
 * tiles, /byrdit/usgs_water/stream/<x>_<y>.geojsonl (JSON Lines, one gauge
 * per line, schema 2). While history is on, each tile request is answered
 * from /api/history/slice?feed=water for that tile's box (4 x 4 degrees,
 * 16 square degrees, inside the source's 25 square degree limit): the newest
 * reading of each gauge at or before the history time, read from USGS on
 * demand (nothing is recorded for this feed). The manifest request is not
 * adapted: it only lists which tiles exist today.
 *
 * Times are NOT rebased: the card shows "as of <observed time>", which stays
 * the true time of the reading. A tile with no gauge reading at the time is
 * an empty answer (D3: never live, never another time). The rivers layer is
 * the only USGS layer with a time slider: wells, lakes and springs use other
 * parameters and are not queried by area.
 */
import { passHeaders } from './historyAdapters.js';
import {
  HISTORY_EMPTY_STATE,
  HISTORY_NOTE_STATE,
} from './historyFieldAdapters.js';

const NDJSON_TYPE = 'application/x-ndjson; charset=utf-8';
const MIN = 60_000;

/** The exporter's tile size in degrees (manifest.tile_deg). */
export const WATER_TILE_DEG = 4;
export const WATER_TILE_RE =
  /^\/byrdit\/usgs_water\/stream\/(\d{1,2})_(\d{1,2})\.geojsonl$/;
export const WATER_NOTE_CHIP =
  'Rivers are read from USGS on request (about the last 120 days)';
export const WATER_TOO_OLD_CHIP =
  'HISTORY none at this time: USGS answers for about the last 120 days only';

/** Box [west, south, east, north] of tile x_y, or null for a bad key. */
export function waterTileBox(x, y) {
  const w = -180 + WATER_TILE_DEG * Number(x);
  const s = -90 + WATER_TILE_DEG * Number(y);
  if (!Number.isInteger(w) || !Number.isInteger(s)) return null;
  const e = w + WATER_TILE_DEG;
  const n = s + WATER_TILE_DEG;
  if (w < -180 || e > 180 || s < -90 || n > 90) return null;
  return { w, s, e, n };
}

function tileOf(liveUrl) {
  const m = WATER_TILE_RE.exec(new URL(String(liveUrl), 'http://x').pathname);
  return m ? waterTileBox(m[1], m[2]) : null;
}

/** A gauge belongs to the one tile whose half-open box holds it. */
function inTile(f, box) {
  const [lon, lat] = f?.geometry?.coordinates ?? [];
  return (
    Number.isFinite(lon) &&
    Number.isFinite(lat) &&
    lon >= box.w &&
    lon < box.e &&
    lat >= box.s &&
    lat < box.n
  );
}

function adaptWater(answers, { url }) {
  const a = answers[0] ?? {};
  const box = tileOf(url);
  const source =
    a.status === 404 || !Array.isArray(a.body?.features) || !box
      ? []
      : a.body.features.filter((f) => inTile(f, box));
  const reason = a.headers?.['x-history-empty-reason'] ?? null;
  const chip =
    reason === 'before_recording_start'
      ? { state: HISTORY_EMPTY_STATE, text: WATER_TOO_OLD_CHIP, reason }
      : { state: HISTORY_NOTE_STATE, text: WATER_NOTE_CHIP, reason: null };
  const headers = passHeaders(answers);
  // a tile with no gauge is normal (sea, desert): not a recording gap
  headers['X-History-Rows'] = String(source.length);
  return {
    raw: source.length
      ? `${source.map((f) => JSON.stringify(f)).join('\n')}\n`
      : '',
    headers: { 'Content-Type': NDJSON_TYPE, ...headers },
    chip,
  };
}

export const WATER_ADAPTER = Object.freeze({
  id: 'water',
  layerId: 'local-usgs-water',
  sliceFeed: 'water',
  snapFeed: null,
  // the source reports every 15 to 60 minutes; the server snaps to 5
  quantumMs: 5 * MIN,
  rebased: false,
  // the layer keeps its tiles for a camera: reload it for every frame time
  reloadOnFrame: true,
  match: WATER_TILE_RE,
  // every tile asks another box; they belong to one frame
  paramsKey: () => 'tiles',
  // no prefetch: the last live request is one tile, and every slice spends
  // the shared USGS budget; a frame is asked for when the slider lands on it
  prefetchParams: () => [],
  accept: Object.freeze({ notRecorded: true }),
  sliceParams(liveUrl) {
    const bbox = tileOf(liveUrl);
    return bbox ? [{ bbox: `${bbox.w},${bbox.s},${bbox.e},${bbox.n}` }] : [{}];
  },
  adapt: adaptWater,
});

export const WATER_ADAPTERS = Object.freeze([WATER_ADAPTER]);
