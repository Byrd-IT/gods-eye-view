/**
 * History adapters for the air-quality (ECCC AQHI) and GNSS-integrity layers
 * (card t_7d3de14d; the contract is that of historyAdapters.js, the slices
 * are historySlicesAirGnss.js).
 *
 *   aqhi  the browser-direct ECCC observations collection
 *         (api.weather.gc.ca/collections/aqhi-observations-realtime/items,
 *         matched on host + path; the station catalog request stays live: it
 *         is static geometry, not a time series) -> slice feed=aqhi, the
 *         newest observation per station inside the layer's own 6 h window.
 *         Observation times are rebased by delta = now - t (D2): the layer
 *         drops readings older than 6 h and judges staleness on the browser
 *         clock, so relative ages must stay true.
 *   gnss  /api/gnss-integrity -> slice feed=gnss. The recorder keeps the
 *         integrity CELLS, not aircraft, so each cell is expanded to `total`
 *         anonymous rows (`bad` of them degraded) that the layer folds into
 *         exactly the cell it recorded. Nothing is invented: counts are the
 *         recorded counts. The recording is military aircraft only, which is
 *         named on the chip, and the layer's own minimum of three aircraft
 *         per cell still applies.
 *
 * D3: nothing recorded at t answers the live layer's EMPTY shape plus a chip.
 */
import {
  passHeaders,
  rebaseDelta,
  rebaseIso,
  rebaseMs,
} from './historyAdapters.js';
import { HISTORY_NOTE_STATE, emptyChip } from './historyFieldAdapters.js';

const GEO_TYPE = 'application/geo+json; charset=utf-8';
const JSON_TYPE = 'application/json; charset=utf-8';
const MIN = 60_000;

export const ECCC_HOST = 'api.weather.gc.ca';
export const AQHI_OBSERVATIONS_RE =
  /^\/collections\/aqhi-observations-realtime\/items$/;
export const GNSS_ROUTE_RE = /^\/api\/gnss-integrity$/;
export const GNSS_POPULATION_CHIP =
  'GNSS history is recorded from military aircraft only; a cell needs 3 aircraft to show';
/** Hard cap on expanded rows (a cell holds a handful of aircraft). */
export const GNSS_MAX_EXPANDED_ROWS = 60_000;

const header = (answer, name) => answer?.headers?.[name] ?? null;

function emptyChipOf(a, count) {
  const reason = header(a, 'x-history-empty-reason');
  const start = header(a, 'x-history-recording-start');
  if (reason || (!count && a?.status === 404))
    return emptyChip(reason || 'before_recording_start', start);
  return null;
}

// ── aqhi ──────────────────────────────────────────────────

function adaptAqhi(answers, { t, nowMs }) {
  const a = answers[0] ?? {};
  const delta = rebaseDelta(t, nowMs);
  const source =
    a.status === 404 || !Array.isArray(a.body?.features) ? [] : a.body.features;
  const features = source.map((f) => ({
    ...f,
    properties: {
      ...f.properties,
      observation_datetime: rebaseIso(
        f.properties?.observation_datetime,
        delta,
      ),
    },
  }));
  return {
    body: { type: 'FeatureCollection', features },
    headers: {
      'Content-Type': GEO_TYPE,
      ...passHeaders(answers),
      'X-History-Rows': String(features.length),
      ...(features.length ? {} : { 'X-History-Gap': '1' }),
    },
    chip: emptyChipOf(a, features.length),
  };
}

export const AQHI_ADAPTER = Object.freeze({
  id: 'aqhi',
  layerId: 'air-quality',
  sliceFeed: 'aqhi',
  snapFeed: null,
  // ECCC publishes hourly; the layer polls on its own interval
  quantumMs: 15 * MIN,
  rebased: true,
  host: ECCC_HOST,
  match: AQHI_OBSERVATIONS_RE,
  accept: Object.freeze({ notRecorded: true }),
  sliceParams() {
    return [{}];
  },
  adapt: adaptAqhi,
});

// ── gnss ──────────────────────────────────────────────────

/** Anonymous aircraft rows of recorded cells: `bad` degraded of `total`. */
export function expandGnssCells(cells, cap = GNSS_MAX_EXPANDED_ROWS) {
  const rows = [];
  for (const c of Array.isArray(cells) ? cells : []) {
    const total = Math.floor(Number(c?.total));
    if (!(total >= 1) || !Number.isFinite(c?.lat) || !Number.isFinite(c?.lon))
      continue;
    const bad = Math.min(total, Math.max(0, Math.floor(Number(c.bad) || 0)));
    for (let i = 0; i < total && rows.length < cap; i++)
      rows.push({
        hex: `h${String(c.cell || `${c.lat},${c.lon}`)}-${i}`,
        lat: c.lat,
        lon: c.lon,
        nic: null,
        nacp: null,
        gpsLost: false,
        degraded: i < bad,
      });
  }
  return rows;
}

function adaptGnss(answers, { t, nowMs }) {
  const a = answers[0] ?? {};
  const delta = rebaseDelta(t, nowMs);
  const ok = a.status !== 404 && a.body && Array.isArray(a.body.cells);
  const snap = ok && Number.isFinite(a.body.snap) ? a.body.snap : null;
  const rows = ok ? expandGnssCells(a.body.cells) : [];
  const expected = ok
    ? a.body.cells.reduce((n, c) => n + (Math.floor(Number(c?.total)) || 0), 0)
    : 0;
  const chip = emptyChipOf(a, rows.length) ?? {
    state: HISTORY_NOTE_STATE,
    text: GNSS_POPULATION_CHIP,
    reason: null,
  };
  return {
    body: {
      rows,
      // the age of the recorded snapshot at t; the layer dates its rows by it
      ageMs: snap === null ? 0 : Math.max(0, t - snap),
      fetchedAt: rebaseMs(snap ?? t, delta),
      classifier: null,
    },
    headers: {
      'Content-Type': JSON_TYPE,
      ...passHeaders(answers),
      'X-History-Rows': String(rows.length),
      ...(rows.length < expected ? { 'X-History-Truncated': '1' } : {}),
      ...(rows.length ? {} : { 'X-History-Gap': '1' }),
    },
    chip,
  };
}

export const GNSS_ADAPTER = Object.freeze({
  id: 'gnss',
  layerId: 'gnss-integrity',
  sliceFeed: 'gnss',
  snapFeed: null,
  // the recorder snapshots every 5 min
  quantumMs: 5 * MIN,
  rebased: true,
  match: GNSS_ROUTE_RE,
  accept: Object.freeze({ notRecorded: true }),
  sliceParams() {
    return [{}];
  },
  adapt: adaptGnss,
});

export const AIR_GNSS_ADAPTERS = Object.freeze([AQHI_ADAPTER, GNSS_ADAPTER]);
