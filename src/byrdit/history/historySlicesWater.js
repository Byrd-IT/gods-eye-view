import {
  HISTORY_INDICES as IDX,
  HistoryUnavailableError,
} from './historyEs.js';
import { FIRST_RECORD_TTL_MS, notRecorded } from './historySlicesB12c.js';

/**
 * Slice of the USGS river-gauge feed (card t_7a4c6a57):
 * /api/history/slice?feed=water&t=<ISO>&bbox=w,s,e,n.
 *
 * Two sources, one answer shape (owner decision 2A, 2026-11-01):
 *  - RECORDED (t at or after the first doc of usgs-water-levels, written by
 *    every 15 min): the newest reading of each stream gauge
 *    (parameters 00065 gage height, 00060 discharge) in [t - window, t],
 *    from our own copy. X-History-Source: recorded.
 *  - BEFORE our recording starts: a reader injected by the server
 *    (server/byrdit/historyWater.js: the H8 live-api backend over USGS NWIS
 *    instantaneous values) answers the same question for about the last 120
 *    days. X-History-Source: usgs-nwis-iv.
 * The box is required; the NWIS source refuses one over 25 square degrees.
 * Both are answered as an empty, explained slice (X-History-Empty-Reason),
 * never as an error.
 *
 * The body is a GeoJSON FeatureCollection in the schema-2 shape of the
 * exporter (scripts/export_usgs_water.py), so the water layer parses it
 * unchanged: one Point per gauge with `readings[]`.
 */

export const WATER_READINGS = Object.freeze([
  Object.freeze({
    field: 'gageHeightFt',
    parameter_code: '00065',
    parameter_name: 'Gage height',
    unit: 'ft',
  }),
  Object.freeze({
    field: 'dischargeCfs',
    parameter_code: '00060',
    parameter_name: 'Discharge',
    unit: 'ft^3/s',
  }),
]);

const isoOf = (ms) => new Date(ms).toISOString();
const fin = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** One live-api observation -> a gauge Feature, or null when unusable. */
export function gaugeFeature(row) {
  const lat = fin(row?.lat);
  const lon = fin(row?.lon);
  const at = fin(row?.t);
  const data = row?.data ?? {};
  if (lat === null || lon === null || at === null || !row?.key) return null;
  const readings = [];
  for (const spec of WATER_READINGS) {
    const value = fin(data[spec.field]);
    if (value === null) continue;
    readings.push({
      parameter_code: spec.parameter_code,
      parameter_name: spec.parameter_name,
      value,
      unit: spec.unit,
      observed_time: isoOf(at),
    });
  }
  if (!readings.length) return null;
  const site = String(row.key);
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: {
      name: typeof data.name === 'string' ? data.name : site,
      usgs_site_id: `USGS-${site}`,
      site_type_code: 'ST',
      site_type: 'Stream',
      state: null,
      observed_time: isoOf(at),
      parameter_code: readings[0].parameter_code,
      parameter_name: readings[0].parameter_name,
      value: readings[0].value,
      unit: readings[0].unit,
      readings,
    },
  };
}

/** Questions to Elasticsearch that one water slice server may have out. */
export const WATER_ES_CONCURRENCY = 4;
export const WATER_ES_MAX_QUEUED = 64;
const FIRST_FAIL_BACKOFF_MS = 60_000;
/** The exporter fills the copy about every 15 min: a newer answer may be incomplete. */
export const RECORDED_SETTLE_MS = 20 * 60_000;
const RECORDED_CODES = WATER_READINGS.map((r) => r.parameter_code);
const SPEC_BY_CODE = new Map(WATER_READINGS.map((r) => [r.parameter_code, r]));

/** The geo_point forms read from _source: object, "lat,lon" string, [lon, lat] array (not geohash or WKT). */
export function geoPoint(v) {
  let lat;
  let lon;
  if (Array.isArray(v)) [lon, lat] = v;
  else if (typeof v === 'string')
    [lat, lon] = v.split(',').map((x) => Number(x));
  else if (v && typeof v === 'object') ({ lat, lon } = v);
  lat = fin(lat);
  lon = fin(lon);
  return lat === null || lon === null ? null : { lat, lon };
}

/** Recorded docs of one gauge -> a gauge Feature (schema 2), or null. */
export function recordedGaugeFeature(siteId, perCode) {
  let first = null;
  const readings = [];
  for (const code of RECORDED_CODES) {
    const d = perCode.get(code);
    const value = fin(d?.value);
    const at = Date.parse(d?.observed_time);
    if (value === null || !Number.isFinite(at)) continue;
    const spec = SPEC_BY_CODE.get(code);
    readings.push({
      parameter_code: code,
      parameter_name: spec.parameter_name,
      value,
      unit: typeof d.unit === 'string' ? d.unit : spec.unit,
      observed_time: isoOf(at),
    });
    first ??= d;
  }
  const at = geoPoint(first?.location);
  if (!readings.length || !at) return null;
  const { lat, lon } = at;
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: {
      name: typeof first.site_name === 'string' ? first.site_name : siteId,
      usgs_site_id: String(siteId),
      site_type_code: 'ST',
      site_type: 'Stream',
      state: null,
      observed_time: readings[0].observed_time,
      parameter_code: readings[0].parameter_code,
      parameter_name: readings[0].parameter_name,
      value: readings[0].value,
      unit: readings[0].unit,
      readings,
    },
  };
}

export function createWaterSlices({
  reader,
  es = null,
  now = () => Date.now(),
}) {
  let running = 0;
  const waiting = [];
  async function esTurn() {
    if (running < WATER_ES_CONCURRENCY) {
      running += 1;
      return;
    }
    if (waiting.length >= WATER_ES_MAX_QUEUED)
      throw new HistoryUnavailableError('water history: too many questions');
    await new Promise((resolve) => waiting.push(resolve));
  }
  function esRelease() {
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  }
  // one shared lookup of the first recorded reading: concurrent tiles of a
  // view wait for the same promise, it runs behind the limiter, and a failure
  // is remembered for FIRST_FAIL_BACKOFF_MS so an outage or a missing
  // privilege costs one query a minute, not one per tile
  let firstAt = null;
  let firstValue = null;
  let firstPending = null;
  async function lookupFirst() {
    let took = false;
    try {
      await esTurn();
      took = true;
      const json = await es.search(IDX.water, {
        size: 0,
        aggs: { first: { min: { field: 'observed_time' } } },
      });
      firstValue = fin(json?.aggregations?.first?.value);
      firstAt = now();
    } catch {
      // keep the start time we already knew; only the next try is pushed out
      firstAt = now() - FIRST_RECORD_TTL_MS + FIRST_FAIL_BACKOFF_MS;
    } finally {
      if (took) esRelease();
    }
    return firstValue;
  }
  function firstRecorded() {
    if (firstAt !== null && now() - firstAt < FIRST_RECORD_TTL_MS)
      return Promise.resolve(firstValue);
    firstPending ??= lookupFirst().finally(() => {
      firstPending = null;
    });
    return firstPending;
  }

  // no NWIS reader (GEV_ES_LIVE_WATER=1): the adapter must not tell users that
  // USGS is asked on request
  const recordedOnly = reader ? {} : { 'X-History-Recorded-Only': '1' };

  async function sliceRecorded({ t, bbox, maxRows, windowMs }, first) {
    await esTurn();
    let json;
    try {
      json = await es.search(IDX.water, {
        size: 0,
        track_total_hits: false,
        query: {
          bool: {
            filter: [
              {
                range: {
                  observed_time: {
                    gte: t - windowMs,
                    lte: t,
                    format: 'epoch_millis',
                  },
                },
              },
              { term: { site_type_code: 'ST' } },
              { terms: { parameter_code: RECORDED_CODES } },
              {
                geo_bounding_box: {
                  location: {
                    top_left: { lat: bbox.n, lon: bbox.w },
                    bottom_right: { lat: bbox.s, lon: bbox.e },
                  },
                },
              },
            ],
          },
        },
        aggs: {
          sites: {
            terms: {
              field: 'site_id',
              size: maxRows + 1,
              order: { _key: 'asc' },
            },
            aggs: {
              p: {
                terms: { field: 'parameter_code', size: RECORDED_CODES.length },
                aggs: {
                  n: {
                    top_hits: {
                      size: 1,
                      sort: [{ observed_time: 'desc' }],
                      _source: [
                        'site_name',
                        'value',
                        'unit',
                        'observed_time',
                        'location',
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      });
    } finally {
      esRelease();
    }
    const buckets = json?.aggregations?.sites?.buckets ?? [];
    const features = [];
    for (const site of buckets) {
      const perCode = new Map();
      for (const b of site?.p?.buckets ?? [])
        perCode.set(b.key, b?.n?.hits?.hits?.[0]?._source);
      const f = recordedGaugeFeature(site.key, perCode);
      if (f) features.push(f);
    }
    const truncated = buckets.length > maxRows;
    const kept = features.slice(0, maxRows);
    return {
      // a time inside the copy's fill interval is not cached: a later reading may complete it
      ...(t > now() - RECORDED_SETTLE_MS ? { noStore: true } : {}),
      body: { type: 'FeatureCollection', features: kept },
      headers: {
        'X-History-Rows': String(kept.length),
        'X-History-Window-Ms': String(windowMs),
        'X-History-Source': 'recorded',
        ...recordedOnly,
        'X-History-Recording-Start': isoOf(first),
        ...(truncated ? { 'X-History-Truncated': '1' } : {}),
        ...(kept.length ? {} : { 'X-History-Gap': '1' }),
      },
    };
  }

  async function sliceWater(q) {
    const { t, bbox, maxRows, windowMs } = q;
    if (!bbox) return notRecorded('area_required');
    // an unreadable copy of ours degrades to the NWIS reader (still true data; the lookup remembers a failure for a minute)
    const first = es ? await firstRecorded() : null;
    let fellBack = false;
    if (first !== null && t >= first) {
      try {
        return await sliceRecorded(q, first);
      } catch (error) {
        // our copy failed after answering before: NWIS can still answer for
        // about the last 120 days; further back the error stands
        if (!reader || t < reader.earliestMs(now())) throw error;
        fellBack = true;
      }
    }
    if (!reader) {
      if (first !== null)
        return notRecorded('before_recording_start', {
          'X-History-Recording-Start': isoOf(first),
          ...recordedOnly,
        });
      throw new Error('no water reader');
    }
    const earliest = reader.earliestMs(now());
    const start = {
      'X-History-Recording-Start': isoOf(first ?? earliest),
    };
    if (t < earliest) return notRecorded('before_recording_start', start);
    let answer;
    try {
      answer = await reader.read({
        t,
        windowMs,
        limit: maxRows,
        bbox: { west: bbox.w, south: bbox.s, east: bbox.e, north: bbox.n },
      });
    } catch (error) {
      // a refused question (box over 25 square degrees) is an explained
      // empty slice; a source failure stays an error (the router falls back)
      if (error?.code === 'INVALID_ARGUMENT')
        return notRecorded('area_too_large');
      throw error;
    }
    const features = answer.observations.map(gaugeFeature).filter(Boolean);
    features.sort((a, b) =>
      a.properties.usgs_site_id.localeCompare(b.properties.usgs_site_id),
    );
    const kept = features.slice(0, maxRows);
    return {
      // a stand-in for our own copy must not outlive its outage in the cache
      ...(fellBack ? { noStore: true } : {}),
      body: { type: 'FeatureCollection', features: kept },
      headers: {
        'X-History-Rows': String(kept.length),
        'X-History-Window-Ms': String(windowMs),
        'X-History-Source': 'usgs-nwis-iv',
        ...start,
        ...(answer.truncated || features.length > maxRows
          ? { 'X-History-Truncated': '1' }
          : {}),
        ...(kept.length ? {} : { 'X-History-Gap': '1' }),
      },
    };
  }
  return { sliceWater };
}
