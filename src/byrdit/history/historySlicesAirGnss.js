import { HISTORY_INDICES as IDX } from './historyEs.js';
import { latestPerKey } from './historyCollapse.js';
import { GNSS_SNAPSHOT_LOOKBACK_MS } from './historyParams.js';
import { FIRST_RECORD_TTL_MS, notRecorded } from './historySlicesB12c.js';

/**
 * Slices of two collector-recorded feeds (card t_7d3de14d):
 *
 *  aqhi  ECCC AQHI observations. The recorder keeps CHANGES only (a station
 *        whose reading did not change has no new doc), so the slice is the
 *        newest observation per station inside [t - window, t] (default 6 h,
 *        the age at which the live layer drops a reading). Observation time
 *        is `@timestamp`; `snap` is the recording time and is not used.
 *  gnss  The integrity cells of the newest recorded snapshot in
 *        [t - 15 min, t]. One doc per cell per snapshot (cadence 5 min). The
 *        recorder classifies military aircraft only (source adsb.lol-mil), so
 *        a cell holds a handful of aircraft at most; that is reported to the
 *        client in X-History-Gnss-Population, never hidden.
 */

const range = (field, gte, lte) => ({
  range: { [field]: { gte, lte, format: 'epoch_millis' } },
});
const sourceOf = (hit) => hit?._source ?? {};
const fin = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const isoOf = (ms) => new Date(ms).toISOString();

function geoBox(bbox) {
  if (!bbox) return [];
  return [
    {
      geo_bounding_box: {
        location: {
          top_left: { lat: bbox.n, lon: bbox.w },
          bottom_right: { lat: bbox.s, lon: bbox.e },
        },
      },
    },
  ];
}

export function createAirGnssSlices({ es, now = () => Date.now() }) {
  const firstCache = new Map();

  /** Oldest `field` value in `index` (cached, FIRST_RECORD_TTL_MS). */
  async function firstRecord(key, index, field) {
    const hit = firstCache.get(key);
    if (hit && now() - hit.at < FIRST_RECORD_TTL_MS) return hit.value;
    const json = await es.search(index, {
      size: 0,
      aggs: { first: { min: { field } } },
    });
    const value = fin(json?.aggregations?.first?.value);
    firstCache.set(key, { at: now(), value });
    return value;
  }

  const startHeader = (first) =>
    first !== null ? { 'X-History-Recording-Start': isoOf(first) } : {};

  async function sliceAqhi({ t, bbox, maxRows, windowMs }) {
    const first = await firstRecord('aqhi', IDX.aqhi, '@timestamp');
    if (first === null || t < first)
      return notRecorded('before_recording_start', startHeader(first));
    const latest = await latestPerKey(es, IDX.aqhi, {
      filter: [range('@timestamp', t - windowMs, t), ...geoBox(bbox)],
      field: 'location_id',
      _source: [
        'location_id',
        'station',
        'aqhi',
        'aqhi_value',
        'band',
        'location',
        'notes',
        'observation_type',
        '@timestamp',
      ],
    });
    const features = [];
    for (const hit of latest.hits) {
      const d = sourceOf(hit);
      const lat = fin(d.location?.lat);
      const lon = fin(d.location?.lon);
      const at = Date.parse(d['@timestamp']);
      if (
        lat === null ||
        lon === null ||
        !Number.isFinite(at) ||
        !d.location_id
      )
        continue;
      features.push({
        type: 'Feature',
        id: String(d.location_id),
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: {
          location_id: String(d.location_id),
          location_name_en: d.station ?? null,
          aqhi: fin(d.aqhi),
          observation_datetime: isoOf(at),
          special_notes_en: d.notes ?? null,
        },
      });
    }
    features.sort((a, b) => a.id.localeCompare(b.id));
    const truncated = latest.truncated || features.length > maxRows;
    const kept = features.slice(0, maxRows);
    return {
      body: { type: 'FeatureCollection', features: kept },
      headers: {
        'X-History-Rows': String(kept.length),
        'X-History-Window-Ms': String(windowMs),
        ...startHeader(first),
        ...(truncated ? { 'X-History-Truncated': '1' } : {}),
        ...(kept.length ? {} : { 'X-History-Gap': '1' }),
      },
    };
  }

  async function sliceGnss({ t, bbox, maxRows }) {
    const first = await firstRecord('gnss', IDX.gnss, 'snap');
    if (first === null || t < first)
      return notRecorded('before_recording_start', startHeader(first));
    const newest = await es.search(IDX.gnss, {
      size: 1,
      query: {
        bool: {
          filter: [range('snap', t - GNSS_SNAPSHOT_LOOKBACK_MS, t)],
        },
      },
      sort: [{ snap: 'desc' }],
      _source: ['snap'],
    });
    const snap = fin(sourceOf(newest?.hits?.hits?.[0]).snap);
    const base = { 'X-History-Gnss-Population': 'military-aircraft' };
    if (snap === null)
      return {
        body: { snap: null, cells: [] },
        headers: {
          ...base,
          'X-History-Rows': '0',
          'X-History-Gap': '1',
          ...startHeader(first),
        },
      };
    const all = await es.searchAll(IDX.gnss, {
      query: { bool: { filter: [{ term: { snap } }, ...geoBox(bbox)] } },
      _source: [
        'cell',
        'location',
        'total',
        'bad',
        'gps_lost',
        'min_nic',
        'min_nacp',
        'classifier',
      ],
      maxRows,
    });
    const cells = [];
    for (const hit of all.hits) {
      const d = sourceOf(hit);
      const lat = fin(d.location?.lat);
      const lon = fin(d.location?.lon);
      const total = fin(d.total);
      if (lat === null || lon === null || total === null || total < 1) continue;
      cells.push({
        cell: String(d.cell ?? ''),
        lat,
        lon,
        total,
        bad: Math.min(total, Math.max(0, fin(d.bad) ?? 0)),
      });
    }
    cells.sort((a, b) => a.cell.localeCompare(b.cell));
    return {
      body: { snap, cells },
      headers: {
        ...base,
        'X-History-Snap': String(snap),
        'X-History-Rows': String(cells.length),
        ...startHeader(first),
        ...(all.truncated ? { 'X-History-Truncated': '1' } : {}),
      },
    };
  }

  return { sliceAqhi, sliceGnss };
}
