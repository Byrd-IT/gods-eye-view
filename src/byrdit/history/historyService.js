import { HISTORY_INDICES as IDX } from './historyEs.js';
import {
  MILITARY_MAX_SNAP_AGE_MS,
  STALE_POSITION_MAX_MS,
  STALE_UNION_SPAN_MS,
  adsblolSnapAtOrBefore,
  boxesIntersect,
  mergeAircraft,
  nearestAdsblolSnaps,
  nearestSnaps,
  newestPerId,
  pickPollSnap,
  sourcesPresent,
  staleUnion,
} from './historyMerge.js';
import {
  CYCLONE_ENVELOPE,
  cycloneStorm,
  docTimeMs,
  firmsBody,
  firmsRow,
  launchResult,
  openSkyState,
  perimeterRow,
  readsbBody,
  readsbRow,
} from './historyRows.js';
import { DAY_MS } from './historyParams.js';

/**
 * /api/history query orchestration (gev-history DESIGN 4.3; card B9).
 * Every ES body here is built from parsed numbers/fixed strings only.
 */

/** ingest-log feed names per history feed. */
export const LOG_FEED = Object.freeze({
  military: 'military',
  firms: 'firms',
  'fire-perimeters': 'fire-perimeters',
  cyclones: 'cyclones',
  launches: 'launches',
  opensky: 'aircraft-opensky',
});

/** Recorder cadence per ingest-log feed (collector feed definitions). */
export const CADENCE_MS = Object.freeze({
  military: 60_000,
  firms: 1_800_000,
  'fire-perimeters': 900_000,
  cyclones: 900_000,
  launches: 900_000,
  'aircraft-opensky': null, // demand-driven (DESIGN 2.7): no expected count
});

/** OpenSky polls up to this long before t can serve a slice (2 x cadence). */
export const OPENSKY_CADENCE_FACTOR = 2;
export const OPENSKY_MAX_CADENCE_MS = 300_000;
/** Most opensky poll records read per slice (tile lookup). */
export const OPENSKY_MAX_POLLS = 200;
/** Most opensky polls read for the coverage lane's tile outlines. */
export const OPENSKY_LANE_MAX_POLLS = 2_000;
/** adsb.lol per-day histogram cache (coverage lane, snapshots). */
export const ADSBLOL_DAYS_TTL_MS = 10 * 60_000;
export const ADSBLOL_DAYS_CACHE = 32;
/** Military docs read at most for the stale union (5 polls x ~500). */
export const STALE_UNION_MAX_DOCS = 15_000;

const AIRCRAFT_SOURCE = [
  'icao24',
  'hex',
  '@timestamp',
  'snap',
  'location',
  'callsign',
  'origin_country',
  'baro_alt_m',
  'geo_alt_m',
  'on_ground',
  'velocity_ms',
  'track_deg',
  'vert_rate_ms',
  'squawk',
  'position_source',
  'category',
  'registration',
  'type',
  'db_flags',
  'source',
];

/** Range on a date field, bounds in epoch ms (inclusive; undefined = open). */
const range = (field, gte, lte) => ({
  range: { [field]: { gte, lte, format: 'epoch_millis' } },
});
/** Range on a numeric field such as `snap` (no format: ES rejects it). */
const numRange = (field, gte, lte) => ({ range: { [field]: { gte, lte } } });

function geoBox(field, bbox) {
  if (!bbox) return [];
  return [
    {
      geo_bounding_box: {
        [field]: {
          top_left: { lat: bbox.n, lon: bbox.w },
          bottom_right: { lat: bbox.s, lon: bbox.e },
        },
      },
    },
  ];
}

function geoShapeBox(field, bbox) {
  if (!bbox) return [];
  return [
    {
      geo_shape: {
        [field]: {
          shape: {
            type: 'envelope',
            coordinates: [
              [bbox.w, bbox.n],
              [bbox.e, bbox.s],
            ],
          },
          relation: 'intersects',
        },
      },
    },
  ];
}

const sourceOf = (hit) => hit?._source ?? {};

function parseMessage(text) {
  if (typeof text !== 'string' || text.length > 8192) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

function tileOf(bboxArray) {
  if (!Array.isArray(bboxArray) || bboxArray.length !== 4) return null;
  const [w, s, e, n] = bboxArray.map(Number);
  if (![w, s, e, n].every(Number.isFinite)) return null;
  return { w, s, e, n };
}

/**
 * @param {object} options
 * @param {ReturnType<import('./historyEs.js').createHistoryEsClient>} options.es
 * @param {() => number} [options.now]
 */
export function createHistoryService({ es, now = () => Date.now() }) {
  /** day range key -> { at, days: Map(dayStartMs -> docs), latestMs } */
  const adsblolDays = new Map();
  let adsblolLast = null;

  /** ok poll snaps of an ingest-log feed in [from, to], newest first. */
  async function pollSnaps(logFeed, from, to, size, order = 'desc') {
    const json = await es.search(IDX.ingestLog, {
      size,
      _source: ['snap', 'message', '@timestamp'],
      sort: [{ snap: order }],
      query: {
        bool: {
          filter: [
            { term: { feed: logFeed } },
            { term: { kind: 'poll' } },
            { term: { ok: true } },
            numRange('snap', from, to),
          ],
        },
      },
    });
    return (json?.hits?.hits ?? []).map(sourceOf);
  }

  /**
   * Per-UTC-day adsb.lol doc counts in [fromDay, toDay) (both streams) and
   * the newest imported bucket, cached ADSBLOL_DAYS_TTL_MS per day range
   * (at most ADSBLOL_DAYS_CACHE ranges): an import only ever adds days.
   */
  async function adsblolDayCounts(fromMs, toMs) {
    const fromDay = Math.floor(fromMs / DAY_MS) * DAY_MS;
    const toDay = Math.ceil(toMs / DAY_MS) * DAY_MS;
    const key = `${fromDay}:${toDay}`;
    const t = now();
    const hit = adsblolDays.get(key);
    if (hit && t - hit.at < ADSBLOL_DAYS_TTL_MS) return hit;
    const json = await es.search(IDX.adsblol, {
      size: 0,
      query: {
        bool: { filter: [range('@timestamp', fromDay, toDay - 1)] },
      },
      aggs: {
        d: {
          date_histogram: {
            field: '@timestamp',
            calendar_interval: '1d',
            min_doc_count: 1,
          },
        },
      },
    });
    const days = new Map();
    for (const b of json?.aggregations?.d?.buckets ?? [])
      days.set(b.key, b.doc_count);
    const latestMs = await adsblolLatest();
    const entry = { at: t, days, latestMs };
    adsblolDays.delete(key);
    adsblolDays.set(key, entry);
    while (adsblolDays.size > ADSBLOL_DAYS_CACHE)
      adsblolDays.delete(adsblolDays.keys().next().value);
    return entry;
  }

  /** Newest imported adsb.lol bucket end (ms), cached with the day counts. */
  async function adsblolLatest() {
    const t = now();
    if (adsblolLast && t - adsblolLast.at < ADSBLOL_DAYS_TTL_MS)
      return adsblolLast.value;
    const json = await es.search(IDX.adsblol, {
      size: 0,
      aggs: { last: { max: { field: 'snap' } } },
    });
    const s = json?.aggregations?.last?.value;
    adsblolLast = { at: t, value: Number.isFinite(s) ? s * 1000 : null };
    return adsblolLast.value;
  }

  /** adsb.lol rows of the 60 s bucket ending at or before t. */
  async function adsblolBucket(tMs, bbox, maxRows, extraFilter = []) {
    const snapS = adsblolSnapAtOrBefore(tMs);
    const snapMs = snapS * 1000;
    const res = await es.searchAll(IDX.adsblol, {
      query: {
        bool: {
          filter: [
            { term: { snap: snapS } },
            range('@timestamp', snapMs - 60_000, snapMs),
            ...geoBox('location', bbox),
            ...extraFilter,
          ],
        },
      },
      _source: AIRCRAFT_SOURCE,
      maxRows,
    });
    return { snapMs, ...res };
  }

  /** OpenSky polls whose tile intersects bbox within 2 x cadence before t. */
  async function openskyPolls(tMs, bbox) {
    const polls = await pollSnaps(
      LOG_FEED.opensky,
      tMs - OPENSKY_CADENCE_FACTOR * OPENSKY_MAX_CADENCE_MS,
      tMs,
      OPENSKY_MAX_POLLS,
    );
    const world = { w: -180, s: -90, e: 180, n: 90 };
    const out = [];
    for (const p of polls) {
      const msg = parseMessage(p.message);
      const tile = tileOf(msg?.tile_bbox);
      const cadence = Number(msg?.cadence_ms);
      if (!tile || !Number.isFinite(p.snap)) continue;
      const maxAge =
        OPENSKY_CADENCE_FACTOR *
        (Number.isFinite(cadence) && cadence > 0
          ? Math.min(cadence, OPENSKY_MAX_CADENCE_MS)
          : OPENSKY_MAX_CADENCE_MS);
      if (p.snap < tMs - maxAge || p.snap > tMs) continue;
      if (!boxesIntersect(tile, bbox ?? world)) continue;
      out.push({ snap: p.snap, tile, cadenceMs: cadence });
    }
    // newest poll per tile only
    const perTile = newestPerId(
      out,
      (p) => p.tile.w + ',' + p.tile.s + ',' + p.tile.e + ',' + p.tile.n,
      (p) => p.snap,
    );
    return [...perTile.values()];
  }

  async function openskyRows(tMs, bbox, maxRows) {
    const polls = await openskyPolls(tMs, bbox);
    if (!polls.length) return { samples: [], polls, truncated: false };
    const snaps = polls.map((p) => p.snap);
    const oldest = Math.min(...snaps);
    const primary = await es.searchAll(IDX.opensky, {
      query: {
        bool: {
          filter: [{ terms: { snap: snaps } }, ...geoBox('location', bbox)],
        },
      },
      _source: AIRCRAFT_SOURCE,
      maxRows,
    });
    // TSDS duplicate rule: an unchanged aircraft was not re-written; take
    // its last sample in [t - 2 x cadence, t] (DESIGN 4.3 second query).
    const cadence = Math.max(
      ...polls.map((p) =>
        Number.isFinite(p.cadenceMs) && p.cadenceMs > 0
          ? Math.min(p.cadenceMs, OPENSKY_MAX_CADENCE_MS)
          : OPENSKY_MAX_CADENCE_MS,
      ),
    );
    const span = OPENSKY_CADENCE_FACTOR * cadence;
    const prior = await es.searchAll(IDX.opensky, {
      query: {
        bool: {
          filter: [
            numRange('snap', oldest - span, tMs),
            range('@timestamp', tMs - span, tMs),
            ...geoBox('location', bbox),
          ],
          must_not: [{ terms: { snap: snaps } }],
        },
      },
      _source: AIRCRAFT_SOURCE,
      maxRows,
    });
    const toSample = (hit) => {
      const doc = sourceOf(hit);
      return { id: doc.icao24, tsMs: docTimeMs(doc), source: 'opensky', doc };
    };
    const samples = staleUnion(
      primary.hits.map(toSample),
      prior.hits.map(toSample),
      tMs,
      span,
    );
    return {
      samples,
      polls,
      truncated: primary.truncated || prior.truncated,
    };
  }

  /** feed=aircraft: adsb.lol + OpenSky merge (DESIGN 1.3 #1c). */
  async function sliceAircraft({ t, bbox, maxRows }) {
    const [a, o] = await Promise.all([
      adsblolBucket(t, bbox, maxRows),
      openskyRows(t, bbox, maxRows),
    ]);
    const adsSamples = a.hits.map((hit) => {
      const doc = sourceOf(hit);
      return { id: doc.icao24, tsMs: docTimeMs(doc), source: 'adsblol', doc };
    });
    let merged = mergeAircraft(adsSamples, o.samples, t);
    const truncated = a.truncated || o.truncated || merged.length > maxRows;
    merged = merged.slice(0, maxRows);
    const states = merged
      .map((s) => openSkyState({ ...s.doc, source: s.source }))
      .filter(Boolean);
    return {
      body: { time: Math.round(t / 1000), states },
      headers: {
        'X-History-Source': sourcesPresent(merged) || 'none',
        'X-History-Snap': String(a.snapMs),
        'X-History-OpenSky-Tiles': String(o.polls.length),
        'X-History-Rows': String(states.length),
        ...(truncated ? { 'X-History-Truncated': '1' } : {}),
        ...(states.length ? {} : { 'X-History-Gap': '1' }),
      },
    };
  }

  /** feed=military: recorder poll at t (+ stale union), else archive. */
  async function sliceMilitary({ t, bbox, maxRows }) {
    const candidates = await pollSnaps(
      LOG_FEED.military,
      t - MILITARY_MAX_SNAP_AGE_MS,
      t,
      10,
    );
    const snap = pickPollSnap(
      candidates.map((p) => p.snap),
      t,
    );
    if (snap !== null) {
      const [primary, prior] = await Promise.all([
        es.searchAll(IDX.military, {
          query: {
            bool: {
              filter: [{ term: { snap } }, ...geoBox('location', bbox)],
            },
          },
          _source: AIRCRAFT_SOURCE,
          maxRows,
        }),
        es.searchAll(IDX.military, {
          query: {
            bool: {
              filter: [
                numRange('snap', snap - STALE_UNION_SPAN_MS, snap - 1),
                range('@timestamp', snap - STALE_POSITION_MAX_MS, snap),
                ...geoBox('location', bbox),
              ],
            },
          },
          _source: AIRCRAFT_SOURCE,
          maxRows: STALE_UNION_MAX_DOCS,
        }),
      ]);
      const toSample = (hit) => {
        const doc = sourceOf(hit);
        return { id: doc.hex, tsMs: docTimeMs(doc), doc };
      };
      let rows = staleUnion(
        primary.hits.map(toSample),
        prior.hits.map(toSample),
        snap,
      );
      const truncated = primary.truncated || rows.length > maxRows;
      rows = rows.slice(0, maxRows);
      const ac = rows.map((s) => readsbRow(s.doc, snap)).filter(Boolean);
      return {
        body: readsbBody(ac, snap),
        headers: {
          'X-History-Source': 'adsb.lol',
          'X-History-Snap': String(snap),
          'X-History-Rows': String(ac.length),
          ...(truncated ? { 'X-History-Truncated': '1' } : {}),
        },
      };
    }
    // Recording gap / before the recorder: adsb.lol archive, dbFlags & 1.
    const military = { terms: { db_flags: [1, 3, 5, 7, 9, 11, 13, 15] } };
    const a = await adsblolBucket(t, bbox, maxRows, [military]);
    const ac = a.hits
      .map((hit) =>
        readsbRow({ ...sourceOf(hit), source: 'adsblol' }, a.snapMs),
      )
      .filter(Boolean);
    return {
      body: readsbBody(ac, a.snapMs),
      headers: {
        'X-History-Source': ac.length ? 'adsblol' : 'none',
        'X-History-Snap': String(a.snapMs),
        'X-History-Rows': String(ac.length),
        'X-History-Fallback': 'adsblol-dbflags',
        ...(a.truncated ? { 'X-History-Truncated': '1' } : {}),
        ...(ac.length ? {} : { 'X-History-Gap': '1' }),
      },
    };
  }

  /** feed=firms: detections acquired in [t - 24 h, t]. */
  async function sliceFirms({ t, bbox, maxRows }) {
    const res = await es.searchAll(IDX.fires, {
      query: {
        bool: {
          filter: [
            range('@timestamp', t - DAY_MS, t),
            ...geoBox('location', bbox),
          ],
        },
      },
      sort: [{ '@timestamp': 'desc' }],
      _source: [
        'location',
        'frp',
        'confidence',
        'brightness',
        'brightness_ti5',
        'daynight',
        'acq_date',
        'acq_time',
        'satellite',
        'instrument',
        'firms_source',
      ],
      maxRows,
    });
    // live and archive share the deterministic _id: count each once
    const seen = new Set();
    const counts = new Map();
    const rows = [];
    for (const hit of res.hits) {
      if (seen.has(hit._id)) continue;
      seen.add(hit._id);
      const row = firmsRow(sourceOf(hit));
      if (!row) continue;
      rows.push(row);
      const src = sourceOf(hit).firms_source ?? 'unknown';
      counts.set(src, (counts.get(src) ?? 0) + 1);
    }
    return {
      body: firmsBody(rows, counts, t),
      headers: {
        'X-History-Rows': String(rows.length),
        ...(res.truncated ? { 'X-History-Truncated': '1' } : {}),
        ...(rows.length ? {} : { 'X-History-Gap': '1' }),
      },
    };
  }

  /** Latest version per id as of t (event feeds). */
  async function latestVersions(index, { t, windowMs, timeField, filter }) {
    const res = await es.searchAll(index, {
      query: {
        bool: {
          filter: [range(timeField, t - windowMs, t), ...filter],
        },
      },
      maxRows: 20_000,
    });
    return res;
  }

  async function slicePerimeters({ t, bbox, maxRows, windowMs }) {
    const res = await latestVersions(IDX.perimeters, {
      t,
      windowMs,
      timeField: '@timestamp',
      filter: geoShapeBox('geometry', bbox),
    });
    const newest = newestPerId(
      res.hits.map(sourceOf),
      (d) => d.fire_id,
      (d) => docTimeMs(d) ?? 0,
    );
    let rows = [...newest.values()].map(perimeterRow).filter(Boolean);
    rows.sort((a, b) => a.stableId.localeCompare(b.stableId));
    const truncated = res.truncated || rows.length > maxRows;
    rows = rows.slice(0, maxRows);
    return {
      body: { fetchedAt: t, rows },
      headers: {
        'X-History-Rows': String(rows.length),
        'X-History-Window-Ms': String(windowMs),
        ...(truncated ? { 'X-History-Truncated': '1' } : {}),
      },
    };
  }

  async function sliceCyclones({ t, bbox, maxRows, windowMs }) {
    const res = await latestVersions(IDX.cyclones, {
      t,
      windowMs,
      timeField: '@timestamp',
      filter: geoBox('position', bbox),
    });
    const docs = res.hits.map(sourceOf);
    const advisories = newestPerId(
      docs.filter((d) => d.source === 'noaa-nhc'),
      (d) => String(d.storm_id ?? '').toLowerCase(),
      (d) => docTimeMs(d) ?? 0,
    );
    const fixes = newestPerId(
      docs.filter(
        (d) =>
          d.source !== 'noaa-nhc' &&
          !advisories.has(String(d.storm_id ?? '').toLowerCase()),
      ),
      (d) => String(d.storm_id ?? '').toLowerCase(),
      (d) => docTimeMs(d) ?? 0,
    );
    const order = (a, b) => a.id.localeCompare(b.id);
    const storms = [...advisories.values()]
      .map(cycloneStorm)
      .filter((s) => s && s.advisoryNumber !== null)
      .sort(order)
      .slice(0, maxRows);
    const bestTrackStorms = [...fixes.values()]
      .map(cycloneStorm)
      .filter(Boolean)
      .sort(order)
      .slice(0, maxRows);
    return {
      body: {
        ...CYCLONE_ENVELOPE,
        fetchedAt: t,
        stale: false,
        unavailable: false,
        reason: null,
        storms,
        bestTrackStorms,
      },
      headers: {
        'X-History-Rows': String(storms.length + bestTrackStorms.length),
        'X-History-Window-Ms': String(windowMs),
      },
    };
  }

  async function sliceLaunches({ t, bbox, maxRows, windowMs }) {
    const res = await latestVersions(IDX.launches, {
      t,
      windowMs,
      timeField: 'net',
      filter: [range('last_updated', 0, t), ...geoBox('pad_location', bbox)],
    });
    const newest = newestPerId(
      res.hits.map(sourceOf),
      (d) => d.launch_id,
      (d) => Date.parse(d.last_updated ?? '') || 0,
    );
    let results = [...newest.values()]
      .map(launchResult)
      .filter(Boolean)
      .sort((a, b) => Date.parse(a.net) - Date.parse(b.net));
    const truncated = res.truncated || results.length > maxRows;
    results = results.slice(-maxRows);
    return {
      body: { count: results.length, next: null, previous: null, results },
      headers: {
        'X-History-Rows': String(results.length),
        'X-History-Window-Ms': String(windowMs),
        ...(truncated ? { 'X-History-Truncated': '1' } : {}),
      },
    };
  }

  const SLICES = {
    aircraft: sliceAircraft,
    military: sliceMilitary,
    firms: sliceFirms,
    'fire-perimeters': slicePerimeters,
    cyclones: sliceCyclones,
    launches: sliceLaunches,
  };

  async function slice(params) {
    return SLICES[params.feed](params);
  }

  /** Coverage lane from the ingest-log (polls_ok / expected / docs). */
  async function logLane(logFeed, { from, to, bucketMs }) {
    const json = await es.search(IDX.ingestLog, {
      size: 0,
      query: {
        bool: {
          filter: [
            { term: { feed: logFeed } },
            { term: { kind: 'poll' } },
            range('@timestamp', from, to),
          ],
        },
      },
      aggs: {
        b: {
          date_histogram: {
            field: '@timestamp',
            fixed_interval: `${bucketMs / 1000}s`,
            min_doc_count: 0,
            extended_bounds: { min: from, max: to - 1 },
            hard_bounds: { min: from, max: to - 1 },
          },
          aggs: {
            ok: { filter: { term: { ok: true } } },
            docs: { sum: { field: 'docs_written' } },
          },
        },
      },
    });
    const cadence = CADENCE_MS[logFeed];
    return (json?.aggregations?.b?.buckets ?? []).map((b) => ({
      t: new Date(b.key).toISOString(),
      polls_ok: b.ok?.doc_count ?? 0,
      polls_expected: cadence ? Math.floor(bucketMs / cadence) : null,
      docs: Math.round(b.docs?.value ?? 0),
    }));
  }

  /** Recorded gaps (type=gap docs written by the gap detector). */
  async function gaps(logFeed, { from, to }) {
    const json = await es.search(IDX.ingestLog, {
      size: 500,
      _source: ['gap_from', 'gap_to', 'message'],
      sort: [{ gap_from: 'asc' }],
      query: {
        bool: {
          filter: [
            { term: { feed: logFeed } },
            { term: { kind: 'gap' } },
            range('gap_to', from, undefined),
            range('gap_from', undefined, to),
          ],
        },
      },
    });
    return (json?.hits?.hits ?? []).map((h) => ({
      from: sourceOf(h).gap_from ?? null,
      to: sourceOf(h).gap_to ?? null,
    }));
  }

  /**
   * OpenSky lane: polls/docs per bucket, plus the tile bboxes polled in each
   * bucket (DESIGN 4.5 tile outlines) when the range is <= 7 days and holds
   * <= OPENSKY_LANE_MAX_POLLS polls; otherwise `tiles` is omitted
   * (tilesOmitted: true) so the answer stays bounded.
   */
  async function openskyLane({ from, to, bucketMs }) {
    const lane = await logLane(LOG_FEED.opensky, { from, to, bucketMs });
    const total = lane.reduce((n, b) => n + b.polls_ok, 0);
    if (to - from > 7 * DAY_MS || total > OPENSKY_LANE_MAX_POLLS)
      return { buckets: lane, tilesOmitted: total > 0 };
    const polls = total
      ? await pollSnaps(LOG_FEED.opensky, from, to, OPENSKY_LANE_MAX_POLLS)
      : [];
    const byBucket = new Map();
    for (const p of polls) {
      const tile = tileOf(parseMessage(p.message)?.tile_bbox);
      if (!tile || !Number.isFinite(p.snap)) continue;
      const key = Math.floor(p.snap / bucketMs) * bucketMs;
      const set = byBucket.get(key) ?? new Map();
      set.set(`${tile.w},${tile.s},${tile.e},${tile.n}`, tile);
      byBucket.set(key, set);
    }
    for (const b of lane) {
      const tiles = byBucket.get(Date.parse(b.t));
      if (tiles) b.tiles = [...tiles.values()].map((x) => [x.w, x.s, x.e, x.n]);
    }
    return { buckets: lane, tilesOmitted: false };
  }

  async function coverage({ feed, from, to, bucket, bucketMs }) {
    if (feed === 'aircraft') {
      const [days, opensky] = await Promise.all([
        adsblolDayCounts(from, to),
        openskyLane({ from, to, bucketMs }),
      ]);
      const dayLane = [];
      const first = Math.floor(from / DAY_MS) * DAY_MS;
      for (let d = first; d < to; d += DAY_MS)
        dayLane.push({
          t: new Date(d).toISOString(),
          docs: days.days.get(d) ?? 0,
          complete: (days.days.get(d) ?? 0) > 0,
        });
      return {
        feed,
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        bucket,
        lanes: [
          {
            source: 'adsblol',
            bucket: '1d',
            latest:
              days.latestMs === null
                ? null
                : new Date(days.latestMs).toISOString(),
            buckets: dayLane,
          },
          { source: 'opensky', bucket, ...opensky },
        ],
        gaps: [],
      };
    }
    const logFeed = LOG_FEED[feed];
    const [lane, gapList] = await Promise.all([
      logLane(logFeed, { from, to, bucketMs }),
      gaps(logFeed, { from, to }),
    ]);
    return {
      feed,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      bucket,
      lanes: [{ source: 'collector', bucket, buckets: lane }],
      gaps: gapList,
    };
  }

  async function snapshots({ feed, around, n }) {
    const iso = (ms, source) => ({
      t: new Date(ms).toISOString(),
      epochMs: ms,
      source,
    });
    if (feed === 'aircraft') {
      const days = await adsblolDayCounts(around - DAY_MS, around + DAY_MS);
      const ads =
        days.latestMs === null
          ? []
          : nearestAdsblolSnaps(around, n, days.latestMs).filter((ms) =>
              days.days.has(Math.floor((ms - 1) / DAY_MS) * DAY_MS),
            );
      const [before, after] = await Promise.all([
        pollSnaps(LOG_FEED.opensky, 0, around, n, 'desc'),
        pollSnaps(
          LOG_FEED.opensky,
          around + 1,
          Number.MAX_SAFE_INTEGER,
          n,
          'asc',
        ),
      ]);
      const os = nearestSnaps(
        before.map((p) => p.snap),
        after.map((p) => p.snap),
        around,
        n,
      );
      const all = [
        ...ads.map((ms) => iso(ms, 'adsblol')),
        ...os.map((ms) => iso(ms, 'opensky')),
      ]
        .sort(
          (a, b) =>
            Math.abs(a.epochMs - around) - Math.abs(b.epochMs - around) ||
            a.epochMs - b.epochMs,
        )
        .slice(0, n)
        .sort((a, b) => a.epochMs - b.epochMs);
      return { feed, around: new Date(around).toISOString(), snaps: all };
    }
    const logFeed = LOG_FEED[feed];
    const [before, after] = await Promise.all([
      pollSnaps(logFeed, 0, around, n, 'desc'),
      pollSnaps(logFeed, around + 1, Number.MAX_SAFE_INTEGER, n, 'asc'),
    ]);
    const snaps = nearestSnaps(
      before.map((p) => p.snap),
      after.map((p) => p.snap),
      around,
      n,
    );
    return {
      feed,
      around: new Date(around).toISOString(),
      snaps: snaps.map((ms) => iso(ms, 'collector')),
    };
  }

  return { slice, coverage, snapshots };
}
