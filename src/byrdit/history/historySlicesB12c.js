import {
  HISTORY_INDICES as IDX,
  HistoryUnavailableError,
} from './historyEs.js';
import { COLLAPSE_PAGE, latestPerKey, mapLimit } from './historyCollapse.js';
import { DAY_MS } from './historyParams.js';

/**
 * /api/history/slice feeds gp, quakes, wind and imagery (gev-history
 * DESIGN 1.3 #8-#10 and #14, 4.3, 4.5; card B12c t_de253a39). Every answer
 * is the LIVE route's body shape so the B12d router adapters can hand it to
 * the existing parsers unchanged. Event feeds: nothing is rebased (D2).
 *
 * No fabrication (D3): a time before a feed's first record, a group, model
 * or cycle that was never recorded, or a cycle outside the upstream
 * retention answers NOTHING with a reason header (X-History-Empty-Reason),
 * never data of another time.
 *
 * What the collector records (live ES, reader key, 2026-10-14):
 *  - gev-history-gp: one doc per NEW element set (_id NORAD|EPOCH),
 *    @timestamp = epoch = EPOCH, snap = the poll that first saw it, group
 *    'active' ONLY (gev-history src/feeds/celestrak.js RECORDED_GROUP; the
 *    other groups are latest-only, 0 docs). Columns NOT recorded:
 *    EPHEMERIS_TYPE, CLASSIFICATION_TYPE, MEAN_MOTION_DOT, MEAN_MOTION_DDOT
 *    (sent empty; SGP4 in satellite.js does not use them); EPOCH is kept to
 *    the millisecond (CelesTrak sends microseconds).
 *  - gev-history-quakes (collector, all magnitudes, since 2026-10-12) +
 *    gev-history-quakes-hist-* (B13 FDSN archive, M2.5+ only, ONE version
 *    per event = the version current at import): event_id, updated,
 *    @timestamp = origin time, location, mag, mag_type, depth_km, place.
 *  - gev-history-cycles: one doc per GFS cycle seen published (f000 .idx
 *    HEAD): model, run, cycle_id. No grids (DESIGN 1.3 #10).
 *  - gev-history-imagery: nowcoast-time docs (product, layer,
 *    time_available, snap = first seen) and once-a-day gibs-latest /
 *    cmr-latest docs (latest available day per layer). No pixels.
 */

/** gev-history src/feeds/celestrak.js RECORDED_GROUP: the only group with docs. */
export const GP_RECORDED_GROUPS = Object.freeze(['active']);
/** CelesTrak GP CSV columns, in the order /api/celestrak/<group> serves them. */
export const GP_CSV_COLUMNS = Object.freeze([
  'OBJECT_NAME',
  'OBJECT_ID',
  'EPOCH',
  'MEAN_MOTION',
  'ECCENTRICITY',
  'INCLINATION',
  'RA_OF_ASC_NODE',
  'ARG_OF_PERICENTER',
  'MEAN_ANOMALY',
  'EPHEMERIS_TYPE',
  'CLASSIFICATION_TYPE',
  'NORAD_CAT_ID',
  'ELEMENT_SET_NO',
  'REV_AT_EPOCH',
  'BSTAR',
  'MEAN_MOTION_DOT',
  'MEAN_MOTION_DDOT',
]);
/** Columns the recorder does not keep: sent as empty cells, never invented. */
export const GP_UNRECORDED_COLUMNS = Object.freeze([
  'EPHEMERIS_TYPE',
  'CLASSIFICATION_TYPE',
  'MEAN_MOTION_DOT',
  'MEAN_MOTION_DDOT',
]);
const GP_SOURCE = [
  'norad_cat_id',
  'epoch',
  'snap',
  'object_name',
  'object_id',
  'mean_motion',
  'eccentricity',
  'inclination',
  'ra_of_asc_node',
  'arg_of_pericenter',
  'mean_anomaly',
  'bstar',
  'element_set_no',
  'rev_at_epoch',
];
const GP_REQUIRED = [
  'mean_motion',
  'eccentricity',
  'inclination',
  'ra_of_asc_node',
  'arg_of_pericenter',
  'mean_anomaly',
  'bstar',
];

/** Live all_day.geojson window: origin time in [t - 24 h, t]. */
export const QUAKE_WINDOW_MS = DAY_MS;
/**
 * Candidate events are looked up by origin time widened by this slack, so a
 * version whose origin time was revised across the window edge is still
 * found; the window itself is applied to the WINNING version only.
 */
export const QUAKE_ORIGIN_SLACK_MS = 3_600_000;
export const QUAKE_ARCHIVE_PREFIX = 'gev-history-quakes-hist-';
const QUAKE_SOURCE = [
  'event_id',
  'updated',
  '@timestamp',
  'location',
  'mag',
  'mag_type',
  'depth_km',
  'place',
];
const QUAKE_TERMS_CHUNK = 5_000;

/**
 * Wind: the cycle in effect at t is the newest RECORDED cycle with run <= t
 * (card B12c). A newest recorded run older than this (a recording gap of
 * more than one 6-hourly cycle) answers nothing (D3) rather than serving a
 * long-lead forecast as if it were the field at t.
 */
export const WIND_MAX_CYCLE_AGE_MS = 12 * 3_600_000;

/** nowCOAST weather products (server/providers/weather.js PRODUCTS). */
export const NOWCOAST_PRODUCTS = Object.freeze([
  'radar',
  'clouds',
  'clouds-regional',
  'lightning',
]);
/**
 * Pixels are NOT recorded (DESIGN 1.5 #14). A frame renders only if GEV's
 * pixel route (/api/weather/tile|image, server/providers/weather.js) accepts
 * its time NOW: the route serves only the newest 26 times of ITS OWN cached
 * GetCapabilities read that are <= 24 h old (allowedTimes), else 400
 * unknown_weather_time, and while that read is stale (up to 1 h after an
 * upstream failure) it refuses every uncached frame. nowCOAST itself lists
 * ~6-9 h, but the route's frames are ~1-2 h of radar. So availability is
 * judged per frame against the serving route instance's OWN manifest
 * (weatherTimes, injected server-side; review R1b: never a second,
 * independent capabilities read that can drift from the route's).
 */
export const PIXELS_BASIS = 'serving-route-manifest';
/** server/providers/weather.js parseWeatherCapabilities: 24 h, 26 kept, 13 sent. */
const WEATHER_MAX_AGE_MS = DAY_MS;
const WEATHER_KEEP = 26;
const WEATHER_SEND = 13;
/** Frames in 24 h: radar ~4 min = 360; read at most this many docs. */
const WEATHER_MAX_DOCS = 2_000;

/** First-record lookups (min snap per feed) are cached this long. */
export const FIRST_RECORD_TTL_MS = 10 * 60_000;

const range = (field, gte, lte) => ({
  range: { [field]: { gte, lte, format: 'epoch_millis' } },
});
const isoOf = (ms) => new Date(ms).toISOString();
const sourceOf = (hit) => hit?._source ?? {};
const fin = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const dateMs = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
};

/** A 404 'nothing recorded' answer (D3): body + reason header, never cached. */
export function notRecorded(reason, extraHeaders = {}) {
  return {
    status: 404,
    body: { error: 'not_recorded', reason },
    headers: { 'X-History-Empty-Reason': reason, ...extraHeaders },
  };
}

/**
 * Newest/oldest doc per NUMERIC key (norad_cat_id is a long: historyCollapse
 * latestPerKey cuts partitions in keyword byte order, which is wrong for
 * numbers). Same algorithm: collapse pages of <= COLLAPSE_PAGE groups; a full
 * page is split at quantiles of its own keys into contiguous numeric
 * sub-ranges [lo, b1), ..., [bk, hi), which cover the parent exactly.
 */
export async function collapseNumeric(
  es,
  index,
  {
    filter,
    field,
    sort,
    _source,
    pageSize = COLLAPSE_PAGE,
    maxQueries = 64,
    fanout = 8,
    concurrency = 4,
  },
) {
  const source = [...new Set([...(_source ?? []), field])];
  let queue = [{ lo: null, hi: null }];
  const hits = [];
  let queries = 0;
  let truncated = false;
  const run = async (part, next) => {
    queries += 1;
    const r = {};
    if (part.lo !== null) r.gte = part.lo;
    if (part.hi !== null) r.lt = part.hi;
    const json = await es.search(index, {
      size: pageSize,
      track_total_hits: false,
      _source: source,
      query: {
        bool: {
          filter: [
            ...filter,
            ...(Object.keys(r).length ? [{ range: { [field]: r } }] : []),
          ],
        },
      },
      collapse: { field },
      sort,
    });
    const page = json?.hits?.hits ?? [];
    if (page.length < pageSize) {
      hits.push(...page);
      return;
    }
    const keys = [
      ...new Set(
        page.map((h) => Number(h?._source?.[field])).filter(Number.isFinite),
      ),
    ].sort((a, b) => a - b);
    const cuts = [];
    for (let i = 1; i < fanout; i += 1) {
      const k = keys[Math.floor((i * keys.length) / fanout)];
      if (k > keys[0] && !cuts.includes(k)) cuts.push(k);
    }
    if (!cuts.length) {
      truncated = true;
      hits.push(...page);
      return;
    }
    const bounds = [part.lo, ...cuts, part.hi];
    for (let i = 0; i + 1 < bounds.length; i += 1)
      next.push({ lo: bounds[i], hi: bounds[i + 1] });
  };
  while (queue.length) {
    let wave = queue;
    queue = [];
    if (queries + wave.length > maxQueries) {
      truncated = true;
      wave = wave.slice(0, Math.max(0, maxQueries - queries));
      if (!wave.length) break;
    }
    await mapLimit(wave, concurrency, (part) => run(part, queue));
  }
  return { hits, truncated, queries };
}

// ------------------------------------------------------------------ GP

/**
 * Per NORAD id: the element set whose epoch is nearest t (DESIGN 4.5 'GP
 * epoch nearest t'). `before` = newest epoch <= t, `after` = oldest epoch
 * > t. A tie, or no `after`, keeps `before` (prefer epoch <= t).
 * @returns {{doc: object, side: 'before'|'after'}|null}
 */
export function pickNearestEpoch(t, before, after) {
  const b = before ? dateMs(before.epoch) : null;
  const a = after ? dateMs(after.epoch) : null;
  if (b === null && a === null) return null;
  if (a === null) return { doc: before, side: 'before' };
  if (b === null) return { doc: after, side: 'after' };
  return a - t < t - b
    ? { doc: after, side: 'after' }
    : { doc: before, side: 'before' };
}

const cell = (v) => (v === null || v === undefined ? '' : String(v));
const textCell = (v) =>
  typeof v === 'string' ? v.replace(/[,\r\n"]/g, ' ').trim() : '';

/** One recorded elset -> one CelesTrak GP CSV row, or null if incomplete. */
export function gpCsvRow(doc) {
  const norad = fin(doc?.norad_cat_id);
  const epochMs = dateMs(doc?.epoch);
  const name = textCell(doc?.object_name);
  if (norad === null || norad <= 0 || epochMs === null || !name) return null;
  if (GP_REQUIRED.some((k) => fin(doc[k]) === null)) return null;
  const epoch = isoOf(epochMs).replace(/Z$/, '');
  return [
    name,
    textCell(doc.object_id),
    epoch,
    cell(doc.mean_motion),
    cell(doc.eccentricity),
    cell(doc.inclination),
    cell(doc.ra_of_asc_node),
    cell(doc.arg_of_pericenter),
    cell(doc.mean_anomaly),
    '',
    '',
    cell(norad),
    cell(fin(doc.element_set_no)),
    cell(fin(doc.rev_at_epoch)),
    cell(doc.bstar),
    '',
    '',
  ].join(',');
}

/** CRLF CSV with the CelesTrak header (the header alone when no rows). */
export function gpCsv(docs) {
  const lines = [GP_CSV_COLUMNS.join(',')];
  for (const d of docs) {
    const row = gpCsvRow(d);
    if (row) lines.push(row);
  }
  return lines.join('\r\n') + '\r\n';
}

/**
 * @param {object} options
 * @param {{search: Function}} options.es
 * @param {() => number} [options.now]
 * @param {null|{retention: Function, read: Function}} [options.windReader]
 *   server-injected byte-range reader (server/byrdit/historyWind.js); src/
 *   may not import server/
 */
export function createB12cSlices({
  es,
  now = () => Date.now(),
  windReader,
  weatherTimes = null,
}) {
  const firstCache = new Map();

  /** Smallest value of `field` among docs matching `filter` (cached). */
  async function firstRecord(key, index, filter, field) {
    const hit = firstCache.get(key);
    if (hit && now() - hit.at < FIRST_RECORD_TTL_MS) return hit.value;
    const json = await es.search(index, {
      size: 0,
      query: { bool: { filter } },
      aggs: { first: { min: { field } } },
    });
    const value = fin(json?.aggregations?.first?.value);
    firstCache.set(key, { at: now(), value });
    return value;
  }

  async function sliceGp({ t, group, maxRows }) {
    if (!GP_RECORDED_GROUPS.includes(group))
      return notRecorded('group_not_recorded', {
        'X-History-Recorded-Groups': GP_RECORDED_GROUPS.join(','),
      });
    const groupFilter = { term: { group } };
    const first = await firstRecord(
      `gp:${group}`,
      IDX.gp,
      [groupFilter],
      'snap',
    );
    const base = {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-History-Gp-Rule': 'nearest-epoch-prefer-at-or-before',
      'X-History-Gp-Unrecorded-Columns': GP_UNRECORDED_COLUMNS.join(','),
      ...(first !== null ? { 'X-History-Recording-Start': isoOf(first) } : {}),
    };
    if (first === null || t < first)
      return {
        text: gpCsv([]),
        headers: {
          ...base,
          'X-History-Rows': '0',
          'X-History-Empty-Reason': 'before_recording_start',
        },
      };
    const field = 'norad_cat_id';
    // membership as of t: objects the recorder had seen in the group by t;
    // elsets: newest epoch <= t and oldest epoch > t of ANY recording time
    const [members, before, after] = await Promise.all([
      collapseNumeric(es, IDX.gp, {
        filter: [groupFilter, { range: { snap: { lte: t } } }],
        field,
        sort: [{ snap: 'desc' }],
        _source: [field],
      }),
      collapseNumeric(es, IDX.gp, {
        filter: [groupFilter, range('epoch', undefined, t)],
        field,
        sort: [{ epoch: 'desc' }],
        _source: GP_SOURCE,
      }),
      collapseNumeric(es, IDX.gp, {
        filter: [
          groupFilter,
          { range: { epoch: { gt: t, format: 'epoch_millis' } } },
        ],
        field,
        sort: [{ epoch: 'asc' }],
        _source: GP_SOURCE,
      }),
    ]);
    const byId = (r) =>
      new Map(r.hits.map((h) => [sourceOf(h)[field], sourceOf(h)]));
    const b = byId(before);
    const a = byId(after);
    const ids = [...new Set(members.hits.map((h) => sourceOf(h)[field]))]
      .filter((id) => Number.isFinite(id))
      .sort((x, y) => x - y);
    let nBefore = 0;
    let nAfter = 0;
    const chosen = [];
    for (const id of ids) {
      const pick = pickNearestEpoch(t, b.get(id) ?? null, a.get(id) ?? null);
      if (!pick || !gpCsvRow(pick.doc)) continue;
      chosen.push(pick);
    }
    const kept = chosen.slice(0, maxRows);
    for (const p of kept) p.side === 'before' ? (nBefore += 1) : (nAfter += 1);
    const truncated =
      members.truncated ||
      before.truncated ||
      after.truncated ||
      chosen.length > maxRows;
    return {
      text: gpCsv(kept.map((p) => p.doc)),
      headers: {
        ...base,
        'X-History-Rows': String(kept.length),
        'X-History-Gp-Epoch-Before': String(nBefore),
        'X-History-Gp-Epoch-After': String(nAfter),
        ...(truncated ? { 'X-History-Truncated': '1' } : {}),
      },
    };
  }

  // ---------------------------------------------------------------- quakes

  /**
   * USGS GeoJSON as of t: per event the newest version with updated <= t;
   * that version's origin time must be in [t - 24 h, t] (the live
   * all_day.geojson window). The window and bbox are applied to the
   * WINNING version only (never before choosing it, which would resurrect a
   * superseded version).
   */
  async function sliceQuakes({ t, bbox, maxRows }) {
    const first = await firstRecord(
      'quakes',
      IDX.quakes,
      [{ match_all: {} }],
      '@timestamp',
    );
    const base =
      first !== null ? { 'X-History-Recording-Start': isoOf(first) } : {};
    const empty = (reason) => ({
      body: featureCollection([], t),
      headers: {
        ...base,
        'X-History-Rows': '0',
        'X-History-Empty-Reason': reason,
      },
    });
    if (first === null || t < first) return empty('before_recording_start');
    const candidates = await latestPerKey(es, IDX.quakes, {
      filter: [
        range('updated', undefined, t),
        range(
          '@timestamp',
          t - QUAKE_WINDOW_MS - QUAKE_ORIGIN_SLACK_MS,
          t + QUAKE_ORIGIN_SLACK_MS,
        ),
      ],
      field: 'event_id',
      timeField: 'updated',
      _source: ['event_id'],
    });
    const ids = [
      ...new Set(candidates.hits.map((h) => sourceOf(h).event_id)),
    ].filter((id) => typeof id === 'string' && id);
    const chunks = [];
    for (let i = 0; i < ids.length; i += QUAKE_TERMS_CHUNK)
      chunks.push(ids.slice(i, i + QUAKE_TERMS_CHUNK));
    const parts = await mapLimit(chunks, 2, (chunk) =>
      latestPerKey(es, IDX.quakes, {
        filter: [
          { terms: { event_id: chunk } },
          range('updated', undefined, t),
        ],
        field: 'event_id',
        timeField: 'updated',
        _source: QUAKE_SOURCE,
      }),
    );
    const sources = new Set();
    let features = [];
    for (const part of parts)
      for (const hit of part.hits) {
        const f = quakeFeature(sourceOf(hit));
        if (!f) continue;
        const origin = f.properties.time;
        if (origin < t - QUAKE_WINDOW_MS || origin > t) continue;
        const [lon, lat] = f.geometry.coordinates;
        if (
          bbox &&
          !(lon >= bbox.w && lon <= bbox.e && lat >= bbox.s && lat <= bbox.n)
        )
          continue;
        sources.add(
          String(hit._index ?? '').includes(QUAKE_ARCHIVE_PREFIX)
            ? 'usgs-archive'
            : 'usgs-fdsn',
        );
        features.push(f);
      }
    // USGS order: newest origin first; ties by id (deterministic)
    features.sort(
      (x, y) =>
        y.properties.time - x.properties.time ||
        (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
    );
    const truncated =
      candidates.truncated ||
      parts.some((p) => p.truncated) ||
      features.length > maxRows;
    features = features.slice(0, maxRows);
    const partial = t - QUAKE_WINDOW_MS < first;
    return {
      body: featureCollection(features, t),
      headers: {
        ...base,
        'X-History-Rows': String(features.length),
        'X-History-Sources': [...sources].sort().join(',') || 'none',
        ...(partial ? { 'X-History-Partial-Window': '1' } : {}),
        ...(truncated ? { 'X-History-Truncated': '1' } : {}),
      },
    };
  }

  // ------------------------------------------------------------------ wind

  async function sliceWind({ t, model, overlay, part }) {
    if (!windReader) throw new HistoryUnavailableError('wind_reader_missing');
    const modelFilter = { term: { model } };
    const [first, newest] = await Promise.all([
      firstRecord(`cycles:${model}`, IDX.cycles, [modelFilter], 'run'),
      es.search(IDX.cycles, {
        size: 1,
        _source: ['model', 'run', 'cycle_id', 'snap'],
        query: { bool: { filter: [modelFilter, range('run', undefined, t)] } },
        sort: [{ run: 'desc' }],
      }),
    ]);
    if (first === null) return notRecorded('model_not_recorded');
    const doc = sourceOf(newest?.hits?.hits?.[0]);
    const runMs = dateMs(doc.run);
    const start = { 'X-History-Recording-Start': isoOf(first) };
    if (runMs === null) return notRecorded('before_recording_start', start);
    const cycleHeaders = {
      ...start,
      'X-History-Cycle': String(doc.cycle_id ?? ''),
      'X-History-Cycle-Run': isoOf(runMs),
    };
    if (t - runMs > WIND_MAX_CYCLE_AGE_MS)
      return notRecorded('cycle_not_recorded', cycleHeaders);
    const retention = windReader.retention(model, now());
    if (runMs < retention.fromMs)
      return notRecorded('outside_upstream_retention', {
        ...cycleHeaders,
        'X-History-Upstream-Retention-From': isoOf(retention.fromMs),
      });
    const value = await windReader.read({ model, overlay, runMs, validMs: t });
    if (value.status !== 'ok') return notRecorded(value.status, cycleHeaders);
    // A wind-only answer (the overlay's scalar read failed) is degraded: the
    // reader retries it after a short hold and it is never put in the API
    // cache. X-History-Wind-Id = the grid id of THIS answer (manifest
    // gridUrl /api/wind/grid/<id>.bin), sent on both parts so the router
    // can tell a grid from a different (recovered) read than its manifest.
    const degraded = value.manifest.scalarError !== undefined;
    const headers = {
      ...cycleHeaders,
      'X-History-Valid-Time': value.manifest.cycle.validIso,
      'X-History-Forecast-Hour': String(value.manifest.cycle.forecastHour),
      'X-History-Grid': gridSliceUrl(t, model, overlay),
      'X-History-Wind-Id': windGridId(value.manifest.gridUrl),
      ...(degraded ? { 'X-History-Degraded': 'scalar_unavailable' } : {}),
    };
    if (part === 'grid')
      return {
        bytes: value.bytes,
        headers: { ...headers, 'Content-Type': 'application/octet-stream' },
      };
    return {
      body: value.manifest,
      headers,
      ...(degraded ? { noStore: true } : {}),
    };
  }

  // --------------------------------------------------------------- imagery

  async function sliceImagery({ t, product }) {
    if (product === 'daily') return imageryDaily(t);
    const first = await firstRecord(
      `nowcoast:${product}`,
      IDX.imagery,
      [{ term: { kind: 'nowcoast-time' } }, { term: { product } }],
      'snap',
    );
    const base =
      first !== null ? { 'X-History-Recording-Start': isoOf(first) } : {};
    // the pixel headers depend on now(): never cached (noStore), so a cache
    // hit or a 304 cannot keep an expired 'available'
    if (first === null || t < first)
      return {
        noStore: true,
        body: weatherTimeList(product, [], null),
        headers: {
          ...base,
          'X-History-Rows': '0',
          'X-History-Empty-Reason': 'before_recording_start',
          ...pixelHeaders(pixelAvailability([], null, now())),
        },
      };
    const json = await es.search(IDX.imagery, {
      size: WEATHER_MAX_DOCS,
      _source: ['time_available', 'snap'],
      query: {
        bool: {
          filter: [
            { term: { kind: 'nowcoast-time' } },
            { term: { product } },
            range('time_available', t - WEATHER_MAX_AGE_MS, t),
            { range: { snap: { lte: t } } },
          ],
        },
      },
      sort: [{ time_available: 'desc' }],
    });
    const hits = json?.hits?.hits ?? [];
    let recordedAt = null;
    const times = new Set();
    for (const h of hits) {
      const ms = dateMs(sourceOf(h).time_available);
      if (ms === null) continue;
      times.add(isoOf(ms));
      const snap = fin(sourceOf(h).snap);
      if (snap !== null && (recordedAt === null || snap > recordedAt))
        recordedAt = snap;
    }
    const kept = [...times].sort().slice(-WEATHER_KEEP).slice(-WEATHER_SEND);
    let serving = null;
    if (kept.length) {
      try {
        if (!weatherTimes) throw new Error('serving_route_unreachable');
        serving = await weatherTimes.read(product);
      } catch (error) {
        // unknown: never claimed renderable
        serving = { error: error?.reason ?? 'serving_route_unreachable' };
      }
    }
    return {
      noStore: true,
      body: weatherTimeList(product, kept, recordedAt),
      headers: {
        ...base,
        'X-History-Rows': String(kept.length),
        ...pixelHeaders(pixelAvailability(kept, serving, now())),
        ...(kept.length
          ? {}
          : { 'X-History-Empty-Reason': 'no_frames_recorded' }),
        ...(hits.length >= WEATHER_MAX_DOCS
          ? { 'X-History-Truncated': '1' }
          : {}),
      },
    };
  }

  /** GIBS / CMR newest available day per layer as recorded by t. */
  async function imageryDaily(t) {
    const r = await latestPerKey(es, IDX.imagery, {
      filter: [
        { terms: { kind: ['gibs-latest', 'cmr-latest'] } },
        { range: { snap: { lte: t } } },
      ],
      field: 'layer',
      timeField: 'snap',
      _source: ['kind', 'source', 'product', 'layer', 'time_available', 'snap'],
    });
    const layers = r.hits
      .map((h) => sourceOf(h))
      .map((d) => ({
        kind: d.kind,
        source: d.source,
        product: d.product,
        layer: d.layer,
        latest:
          dateMs(d.time_available) === null
            ? null
            : isoOf(dateMs(d.time_available)),
        recordedAt: fin(d.snap) === null ? null : isoOf(d.snap),
      }))
      .filter((d) => d.latest)
      .sort((x, y) =>
        `${x.kind}|${x.product}|${x.layer}` <
        `${y.kind}|${y.product}|${y.layer}`
          ? -1
          : 1,
      );
    return {
      body: { schemaVersion: 1, t: isoOf(t), layers },
      headers: {
        'X-History-Rows': String(layers.length),
        ...(layers.length
          ? {}
          : { 'X-History-Empty-Reason': 'before_recording_start' }),
        ...(r.truncated ? { 'X-History-Truncated': '1' } : {}),
      },
    };
  }

  return { sliceGp, sliceQuakes, sliceWind, sliceImagery };
}

/** The grid half of a wind slice (same t/model/overlay as its manifest). */
export function gridSliceUrl(t, model, overlay) {
  return `/api/history/slice?feed=wind&t=${encodeURIComponent(isoOf(t))}&model=${model}&overlay=${overlay}&part=grid`;
}

/** `<id>` of a wind manifest gridUrl `/api/wind/grid/<id>.bin?...`. */
export function windGridId(gridUrl) {
  return (
    /^\/api\/wind\/grid\/([\w.-]+)\.bin(?:\?|$)/.exec(String(gridUrl))?.[1] ??
    ''
  );
}

/** One recorded quake version -> a USGS GeoJSON Feature (recorded fields only). */
export function quakeFeature(doc) {
  const id = doc?.event_id;
  const time = dateMs(doc?.['@timestamp']);
  const lat = fin(doc?.location?.lat);
  const lon = fin(doc?.location?.lon);
  if (
    typeof id !== 'string' ||
    !id ||
    time === null ||
    lat === null ||
    lon === null
  )
    return null;
  const properties = {
    mag: fin(doc.mag),
    place: typeof doc.place === 'string' ? doc.place : null,
    time,
    updated: dateMs(doc.updated),
    magType: typeof doc.mag_type === 'string' ? doc.mag_type : null,
  };
  return {
    type: 'Feature',
    properties,
    geometry: { type: 'Point', coordinates: [lon, lat, fin(doc.depth_km)] },
    id,
  };
}

/** USGS summary FeatureCollection envelope (metadata.generated = t). */
export function featureCollection(features, t) {
  return {
    type: 'FeatureCollection',
    metadata: {
      generated: t,
      title: 'USGS earthquakes recorded in the 24 hours before t (GEV history)',
      status: 200,
      count: features.length,
    },
    features,
  };
}

/**
 * Which recorded frames GEV's pixel route renders NOW (see PIXELS_BASIS).
 * `serving` = the serving route instance's own state { times (the newest
 * 13 of its allowedTimes, ascending), fetchedAt, stale, unavailable,
 * checkedAt, marginMs } (server/byrdit/historyImageryTimes.js), or
 * { error } / null when it could not be established.
 *  - not established, route unavailable, or route metadata STALE (it then
 *    refuses every uncached frame) -> 'unknown', nothing claimed;
 *  - a frame the route lists (and not within marginMs of the 24 h limit)
 *    renders: claimed in `renderable`;
 *  - a frame not listed but not older than the oldest listed one, or older
 *    than 24 h, does NOT render (the list is the newest end of allowedTimes);
 *  - a frame older than the oldest listed one when the route lists a full
 *    13 may still be in its allowedTimes (up to 26, not published), or is
 *    within marginMs of 24 h: UNDETERMINED, never called unavailable.
 * State: all claimed 'available'; some claimed 'partial'; none claimed and
 * some undetermined 'unknown' (reason frames_older_than_route_list); else
 * 'unavailable'.
 */
export function pixelAvailability(frames, serving, nowMs) {
  if (!frames.length)
    return { state: 'unavailable', renderable: [], undetermined: [], serving };
  const reason = !serving
    ? 'serving_route_unreachable'
    : serving.error
      ? serving.error
      : !Array.isArray(serving.times)
        ? 'serving_route_bad_answer'
        : serving.unavailable
          ? 'serving_metadata_unavailable'
          : serving.stale
            ? 'serving_metadata_stale'
            : null;
  if (reason)
    return {
      state: 'unknown',
      renderable: [],
      undetermined: [...frames],
      serving,
      reason,
    };
  const listed = new Set(serving.times);
  const oldest = serving.times.length ? Date.parse(serving.times[0]) : null;
  const full = serving.times.length >= WEATHER_SEND;
  const margin = serving.marginMs ?? 0;
  const renderable = [];
  const undetermined = [];
  for (const x of frames) {
    const age = nowMs - Date.parse(x);
    if (age > WEATHER_MAX_AGE_MS) continue; // the route refuses > 24 h
    if (age > WEATHER_MAX_AGE_MS - margin) undetermined.push(x);
    else if (listed.has(x)) renderable.push(x);
    else if (full && Date.parse(x) < oldest) undetermined.push(x);
  }
  return {
    state:
      renderable.length === frames.length
        ? 'available'
        : renderable.length
          ? 'partial'
          : undetermined.length
            ? 'unknown'
            : 'unavailable',
    renderable,
    undetermined,
    serving,
    ...(!renderable.length && undetermined.length
      ? { reason: 'frames_older_than_route_list' }
      : {}),
  };
}

/** Response headers for pixelAvailability(); the frame list says which. */
export function pixelHeaders({
  state,
  renderable,
  undetermined = [],
  serving,
  reason,
}) {
  const known =
    serving && !serving.error && Array.isArray(serving.times) && !serving.stale
      ? !serving.unavailable
      : false;
  return {
    'X-History-Pixels': state,
    'X-History-Pixels-Basis': known ? PIXELS_BASIS : 'unknown',
    ...(reason ? { 'X-History-Pixels-Reason': reason } : {}),
    ...(known && undetermined.length
      ? { 'X-History-Pixels-Undetermined': String(undetermined.length) }
      : {}),
    ...(serving && Number.isFinite(serving.checkedAt)
      ? { 'X-History-Pixels-Checked-At': isoOf(serving.checkedAt) }
      : {}),
    ...(serving && Number.isFinite(serving.fetchedAt)
      ? { 'X-History-Pixels-Route-Read-At': isoOf(serving.fetchedAt) }
      : {}),
    ...(renderable.length
      ? { 'X-History-Pixels-Frames': renderable.join(',') }
      : {}),
  };
}

/**
 * The time-list part of GEV /api/weather/manifest (server/providers/
 * weather.js describe()) at t: times, latest/time/observedAt and the frame
 * URLs. Static product metadata (title, bounds from GetCapabilities, sizes)
 * is NOT recorded; the B12d router merges it from the live manifest.
 */
export function weatherTimeList(product, times, recordedAt) {
  const time = times.at(-1) ?? null;
  return {
    schemaVersion: 1,
    product,
    times,
    latest: time,
    time,
    observedAt: time,
    fetchedAt: recordedAt,
    stale: !time,
    unavailable: !time,
    reason: time ? null : 'No recorded imagery at this time',
    tileTemplate: time
      ? `/api/weather/tile?product=${product}&time=${encodeURIComponent(time)}&z={z}&x={x}&y={y}`
      : null,
    imageUrl: time
      ? `/api/weather/image?product=${product}&time=${encodeURIComponent(time)}`
      : null,
  };
}
