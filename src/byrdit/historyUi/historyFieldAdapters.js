/**
 * History adapters for the USGS quakes feed and the wind field (gev-history
 * DESIGN 4.5, card B12d t_215e62e1; shared decisions D1-D8 on the B12
 * umbrella t_5aa880c7). The registry fields and the adapt() contract are
 * those of historyAdapters.js (B12a); the slices are B12c's
 * (src/byrdit/history/historySlicesB12c.js).
 *
 * D2: quakes and the wind cycle are EVENT / issue times: nothing is
 * rebased. A quake keeps its real origin time; the wind manifest keeps its
 * real run and valid times ("Issued" / "Valid" in the layer row).
 *
 * D3: a slice with nothing recorded at t (before the recording start, a
 * cycle or model never recorded, a cycle past the upstream retention)
 * answers the live layer's own EMPTY shape, so the layer draws nothing, and
 * the reason goes to the chip strip (adapted.chip). Never live data, never
 * another time.
 *
 *   quakes  the browser-direct USGS all_day.geojson (an absolute URL: the
 *           adapter matches its host) -> slice feed=quakes, the USGS
 *           FeatureCollection as of t. X-History-Revised-Later (owner
 *           decision 2B: archive-only events shown with values revised
 *           after t) and a recording start inside the 24 h window are
 *           named on the chip.
 *   wind    /api/wind/manifest + /api/wind/grid/<id>.bin -> slice
 *           feed=wind part=manifest|grid, the cycle in effect at t.
 *           Review R1: the frame is ONE snapshot decided at the manifest.
 *           The router reads the grid slice (companionParams) together
 *           with the manifest slice, and serves the history manifest only
 *           when the grid's X-History-Wind-Id is the manifest's grid id.
 *           The grid answer is then OWED to the layer's grid request
 *           (owe), which is answered from it even if t moved, history
 *           failed or LIVE came in between: the layer never sends a history
 *           grid id to the live provider, and never combines halves of two
 *           reads. A grid that fails or does not match (the server re-read
 *           a degraded field in between) fails the whole manifest after
 *           one re-read (inconsistent), so the manifest request goes live
 *           and the layer gets a complete live snapshot. A 404
 *           not_recorded manifest becomes the live 'unavailable' manifest:
 *           the layer clears its field (no grid is asked).
 */
import { passHeaders } from './historyAdapters.js';

const JSON_TYPE = 'application/json; charset=utf-8';
const MIN = 60_000;

/** The live USGS feed the earthquakes layer fetches (layers/earthquakes). */
export const USGS_HOST = 'earthquake.usgs.gov';
export const USGS_ALL_DAY_RE =
  /^\/earthquakes\/feed\/v1\.0\/summary\/all_day\.geojson$/;

// ── chip texts (named constants, D8) ──────────────────────

/** A chip of a swapped layer: state + text (layerChips.js). */
export const HISTORY_EMPTY_STATE = 'history-empty';
export const HISTORY_NOTE_STATE = 'history-note';
export const HISTORY_EMPTY_PREFIX = 'HISTORY none at this time: ';
export const RECORDING_STARTS = 'recording starts ';
export const QUAKES_REVISED_LATER = ' quakes shown with later-revised values';
export const QUAKES_PARTIAL = 'Quakes recorded from ';
export const QUAKES_PARTIAL_TAIL = ' only (part of the 24 h window)';
export const WIND_GRID_CHANGED = 'history: wind grid changed; asking again';

/** Reason text per B12c X-History-Empty-Reason (D3 chip, never silent). */
export const EMPTY_REASONS = Object.freeze({
  before_recording_start: 'nothing recorded yet',
  model_not_recorded: 'this forecast model is not recorded',
  cycle_not_recorded: 'no forecast cycle recorded in the 12 h before',
  outside_upstream_retention: 'the cycle is past the upstream retention',
  upstream_missing: 'the recorded cycle is missing upstream',
  no_frames_recorded: 'no frames recorded',
});

/** "2026-10-12 17:16 UTC" (explicit UTC, like the wind row). */
export function utcMinute(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms)
    ? `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
    : null;
}

/**
 * The chip of an empty answer: the reason, and the recording start when
 * the server sent it. Unknown reasons are shown as sent (never dropped).
 */
export function emptyChip(reason, start) {
  const why = EMPTY_REASONS[reason] ?? String(reason || 'nothing recorded');
  const from = utcMinute(start);
  return {
    state: HISTORY_EMPTY_STATE,
    text: `${HISTORY_EMPTY_PREFIX}${why}${from ? ` (${RECORDING_STARTS}${from})` : ''}`,
    reason: String(reason || ''),
  };
}

const header = (answer, name) => answer?.headers?.[name] ?? null;

// ── quakes ────────────────────────────────────────────────

/** The answer's chip, or null: empty reason first, then the notes. */
function quakeChip(a, count) {
  const reason = header(a, 'x-history-empty-reason');
  const start = header(a, 'x-history-recording-start');
  if (reason || (!count && a?.status === 404))
    return emptyChip(reason || 'before_recording_start', start);
  const notes = [];
  const later = Number(header(a, 'x-history-revised-later'));
  if (Number.isFinite(later) && later > 0)
    notes.push(`${later}${QUAKES_REVISED_LATER}`);
  if (header(a, 'x-history-partial-window') === '1' && utcMinute(start))
    notes.push(`${QUAKES_PARTIAL}${utcMinute(start)}${QUAKES_PARTIAL_TAIL}`);
  return notes.length
    ? { state: HISTORY_NOTE_STATE, text: notes.join(' · '), reason: null }
    : null;
}

function adaptQuakes(answers, { t }) {
  const a = answers[0] ?? {};
  const body = a.status === 404 ? {} : (a.body ?? {});
  const features = Array.isArray(body.features) ? body.features : [];
  return {
    body: {
      // the USGS summary envelope; generated = the slice time (D2: event)
      type: 'FeatureCollection',
      metadata: {
        ...(body.metadata && typeof body.metadata === 'object'
          ? body.metadata
          : {}),
        generated: Number.isFinite(body.metadata?.generated)
          ? body.metadata.generated
          : t,
        status: 200,
        count: features.length,
      },
      features,
    },
    headers: {
      'Content-Type': 'application/geo+json; charset=utf-8',
      ...passHeaders(answers),
      'X-History-Rows': String(features.length),
      ...(features.length ? {} : { 'X-History-Gap': '1' }),
    },
    chip: quakeChip(a, features.length),
  };
}

// ── wind ──────────────────────────────────────────────────

const WIND_GRID_RE = /^\/api\/wind\/grid\/([\w.-]+)\.bin$/;
const WIND_MANIFEST_RE = /^\/api\/wind\/manifest\/?$/;

/** The grid id of a live wind grid path, or null. */
export function windGridIdOf(path) {
  return WIND_GRID_RE.exec(String(path ?? ''))?.[1] ?? null;
}

/** The grid id of a manifest gridUrl ('/api/wind/grid/<id>.bin?...'). */
export function windIdOfGridUrl(gridUrl) {
  return (
    /^\/api\/wind\/grid\/([\w.-]+)\.bin(?:\?|$)/.exec(String(gridUrl))?.[1] ??
    null
  );
}

/** model / overlay of a live wind request (the source's own query). */
export function windQuery(url) {
  const q = url?.searchParams;
  const model = q?.get('model') || 'gfs';
  const overlay = q?.get('overlay') || 'none';
  return { model, overlay };
}

/**
 * The live 'unavailable' manifest (server/providers/wind.js unavailable()):
 * the wind source returns it as it is and the layer clears its field.
 */
export function windUnavailable(model, overlay, reason) {
  return {
    model,
    schemaVersion: 1,
    ...(overlay === 'none' ? {} : { overlay }),
    unavailable: true,
    stale: true,
    reason,
  };
}

/** Text of a wind reason for the layer row (manifest.reason). */
export const WIND_EMPTY_ROW = 'History: no wind field recorded at this time';

function adaptWind(answers, { url }) {
  const a = answers[0] ?? {};
  const { model, overlay } = windQuery(url);
  const gridId = windGridIdOf(url?.pathname);
  const empty = a.status === 404;
  const chip = empty
    ? emptyChip(
        header(a, 'x-history-empty-reason') || a.body?.reason,
        header(a, 'x-history-recording-start'),
      )
    : null;
  const keep = {
    ...passHeaders([a]),
    ...Object.fromEntries(
      [
        ['x-history-cycle', 'X-History-Cycle'],
        ['x-history-cycle-run', 'X-History-Cycle-Run'],
        ['x-history-valid-time', 'X-History-Valid-Time'],
        ['x-history-wind-id', 'X-History-Wind-Id'],
        ['x-history-degraded', 'X-History-Degraded'],
      ]
        .filter(([k]) => header(a, k))
        .map(([k, v]) => [v, header(a, k)]),
    ),
  };
  if (gridId) {
    // the grid half: only the bytes of the manifest the layer read (D3)
    const served = header(a, 'x-history-wind-id');
    if (empty || !(a.bytes instanceof Uint8Array) || served !== gridId)
      return {
        status: 409,
        body: { error: WIND_GRID_CHANGED },
        headers: { 'Content-Type': JSON_TYPE, ...keep },
        chip,
        refresh: true,
      };
    return {
      raw: a.bytes,
      headers: {
        'Content-Type': 'application/octet-stream',
        ...keep,
        'X-History-Rows': '1',
      },
      chip: null,
    };
  }
  if (empty)
    return {
      body: windUnavailable(model, overlay, WIND_EMPTY_ROW),
      headers: {
        'Content-Type': JSON_TYPE,
        ...keep,
        'X-History-Rows': '0',
        'X-History-Gap': '1',
      },
      chip,
    };
  const manifest = a.body ?? {};
  // R1: the manifest is served only with the grid of the same read
  const key = windIdOfGridUrl(manifest.gridUrl);
  const grid = answers[1];
  if (
    !key ||
    !grid ||
    grid.status === 404 ||
    !(grid.bytes instanceof Uint8Array) ||
    header(grid, 'x-history-wind-id') !== key
  )
    return { inconsistent: true, headers: {}, chip: null };
  return {
    body: manifest,
    headers: { 'Content-Type': JSON_TYPE, ...keep, 'X-History-Rows': '1' },
    chip: null,
    // the grid request that follows is answered from this grid answer
    owe: { key, answers: [grid] },
  };
}

/** The grid slice read with a recorded manifest (none for an empty one). */
function windCompanion(url, answers) {
  if (windGridIdOf(url?.pathname)) return null;
  if (answers[0]?.status === 404) return null;
  const { model, overlay } = windQuery(url);
  return [{ model, overlay, part: 'grid' }];
}

// ── registry entries ──────────────────────────────────────

export const QUAKES_ADAPTER = Object.freeze({
  id: 'quakes',
  layerId: 'earthquakes',
  sliceFeed: 'quakes',
  snapFeed: null,
  // the live poll cadence (layers/earthquakes updateInterval 60 s)
  quantumMs: MIN,
  rebased: false,
  // a browser-direct third-party URL: matched on host + path
  host: USGS_HOST,
  match: USGS_ALL_DAY_RE,
  accept: Object.freeze({ notRecorded: true }),
  sliceParams() {
    return [{}];
  },
  adapt: adaptQuakes,
});

export const WIND_ADAPTER = Object.freeze({
  id: 'wind',
  layerId: 'wind',
  sliceFeed: 'wind',
  snapFeed: null,
  // GFS steps are hourly; the layer polls hourly (updateInterval 1 h)
  quantumMs: 60 * MIN,
  rebased: false,
  match: /^\/api\/wind\/(?:manifest\/?|grid\/[\w.-]+\.bin)$/,
  accept: Object.freeze({ notRecorded: true, bytes: true }),
  sliceParams(url) {
    const { model, overlay } = windQuery(url);
    const part = windGridIdOf(url.pathname) ? 'grid' : 'manifest';
    return [{ model, overlay, part }];
  },
  /** Both halves of one read share the slice cache (no D6 cache drop). */
  paramsKey(url) {
    const { model, overlay } = windQuery(url);
    return `${model}|${overlay}`;
  },
  /** Prefetch both halves of a frame. */
  prefetchParams(url) {
    const { model, overlay } = windQuery(url);
    return [
      { model, overlay, part: 'manifest' },
      { model, overlay, part: 'grid' },
    ];
  },
  /** The grid slice read with the manifest (one snapshot, review R1). */
  companionParams: windCompanion,
  /** The grid id of a grid request (owed by its history manifest). */
  boundKey(url) {
    return windGridIdOf(url.pathname);
  },
  adapt: adaptWind,
});

export const FIELD_ADAPTERS = Object.freeze([QUAKES_ADAPTER, WIND_ADAPTER]);

export { WIND_MANIFEST_RE, WIND_GRID_RE };
