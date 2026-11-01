import { notRecorded } from './historySlicesB12c.js';

/**
 * Slice of the USGS river-gauge feed (card t_7a4c6a57):
 * /api/history/slice?feed=water&t=<ISO>&bbox=w,s,e,n.
 *
 * Nothing is recorded for this feed. A reader injected by the server
 * (server/byrdit/historyWater.js: the H8 live-api backend over USGS NWIS
 * instantaneous values) answers "the newest reading of each gauge at or
 * before t, inside the box". The box is required and the source refuses one
 * over 25 square degrees; both are answered as an empty, explained slice
 * (X-History-Empty-Reason), never as an error.
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

export function createWaterSlices({ reader, now = () => Date.now() }) {
  async function sliceWater({ t, bbox, maxRows, windowMs }) {
    if (!reader) throw new Error('no water reader');
    const earliest = reader.earliestMs(now());
    const start = { 'X-History-Recording-Start': isoOf(earliest) };
    if (!bbox) return notRecorded('area_required');
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
