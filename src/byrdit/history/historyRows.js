/**
 * ES history docs -> the row shapes the LIVE /api/<feed> routes return, so
 * the existing layer parsers read a history answer without a new parser
 * (gev-history DESIGN 4.3; card B9 items 3-4). Pure.
 *
 * Inverse of the collector transforms (gev-history src/feeds/military.js,
 * src/opensky/parse.js, scripts/adsblol_import.py, src/feeds/{firms,
 * perimeters,cyclones,launches}.js). What the recorder did not store comes
 * back as null (never invented); every aircraft row carries `source`.
 */

export const FT_TO_M = 0.3048;
export const KN_TO_MS = 0.514444;
export const FPM_TO_MS = 0.00508;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' && v !== '' ? v : null);
const round = (v, d) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);

/** @timestamp as epoch ms (ISO string or epoch number in _source). */
export function docTimeMs(doc) {
  const raw = doc?.['@timestamp'];
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function lat(doc) {
  return num(doc?.location?.lat);
}
function lon(doc) {
  return num(doc?.location?.lon);
}

/** readsb (adsb.lol /v2/mil) row from a military or adsb.lol history doc. */
export function readsbRow(doc, snapMs) {
  const tsMs = docTimeMs(doc);
  const hex = str(doc.hex) ?? str(doc.icao24);
  const la = lat(doc),
    lo = lon(doc);
  if (!hex || la === null || lo === null || tsMs === null) return null;
  const baro = num(doc.baro_alt_m);
  const geo = num(doc.geo_alt_m);
  const vel = num(doc.velocity_ms);
  const vr = num(doc.vert_rate_ms);
  const row = {
    hex,
    flight: str(doc.callsign),
    r: str(doc.registration),
    t: str(doc.type),
    dbFlags: Number.isInteger(doc.db_flags) ? doc.db_flags : null,
    alt_baro:
      doc.on_ground === true
        ? 'ground'
        : baro === null
          ? null
          : Math.round(baro / FT_TO_M),
    alt_geom: geo === null ? null : Math.round(geo / FT_TO_M),
    gs: vel === null ? null : round(vel / KN_TO_MS, 1),
    track: num(doc.track_deg),
    baro_rate: vr === null ? null : Math.round(vr / FPM_TO_MS),
    squawk: str(doc.squawk),
    category: str(doc.category),
    lat: la,
    lon: lo,
    seen_pos: round(Math.max(0, snapMs - tsMs) / 1000, 3),
    source: str(doc.source),
  };
  return row;
}

/** readsb snapshot envelope (top-level keys = the live /api/military). */
export function readsbBody(rows, snapMs) {
  return {
    ac: rows,
    msg: 'No error',
    now: snapMs,
    total: rows.length,
    ctime: snapMs,
    ptime: 0,
  };
}

const CATEGORY_BASE = { A: 1, B: 8, C: 15 };
/**
 * readsb/ADS-B emitter category ("A3") -> OpenSky numeric category (OpenSky
 * REST doc: 2..8 = A1..A7, 9..15 = B1..B7, 16..20 = C1..C5, 1 = no ADS-B
 * category info); OpenSky docs already store the number as a string.
 */
export function openSkyCategory(value) {
  const text = str(value);
  if (text === null) return 0;
  if (/^\d{1,2}$/.test(text)) return Number(text);
  const m = /^([ABC])([0-7])$/.exec(text);
  if (!m) return 0;
  if (m[2] === '0') return 1;
  const n = CATEGORY_BASE[m[1]] + Number(m[2]);
  return m[1] === 'C' && Number(m[2]) > 5 ? 0 : n;
}

/**
 * OpenSky state vector (18 fields, /api/flights `states[i]`) + `source` as
 * element 18. GEV's normalizeOpenSkyAircraft reads indices 0..17 only.
 */
export function openSkyState(doc) {
  const tsMs = docTimeMs(doc);
  const id = str(doc.icao24);
  const la = lat(doc),
    lo = lon(doc);
  if (!id || la === null || lo === null || tsMs === null) return null;
  const t = Math.round(tsMs / 1000);
  return [
    id,
    str(doc.callsign),
    str(doc.origin_country),
    t,
    t,
    lo,
    la,
    num(doc.baro_alt_m),
    doc.on_ground === true,
    num(doc.velocity_ms),
    num(doc.track_deg),
    num(doc.vert_rate_ms),
    null,
    num(doc.geo_alt_m),
    str(doc.squawk),
    false,
    Number.isInteger(doc.position_source) ? doc.position_source : 0,
    openSkyCategory(doc.category),
    str(doc.source),
  ];
}

/** FIRMS fire row (live /api/firms `fires[i]`). */
export function firmsRow(doc) {
  const la = lat(doc),
    lo = lon(doc);
  if (la === null || lo === null) return null;
  return {
    lat: la,
    lon: lo,
    frp: num(doc.frp),
    confidence: doc.confidence ?? null,
    brightness: num(doc.brightness),
    brightnessTi5: num(doc.brightness_ti5),
    daynight: str(doc.daynight),
    acqDate: str(doc.acq_date),
    acqTime: str(doc.acq_time),
    satellite: str(doc.satellite),
    instrument: str(doc.instrument),
  };
}

export function firmsBody(rows, sourceCounts, tMs) {
  return {
    fetchedAt: tMs,
    stale: false,
    ttlMs: 1_800_000,
    sources: [...sourceCounts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([source, count]) => ({ source, count, ok: true })),
    count: rows.length,
    fires: rows,
  };
}

/** WFIGS perimeter row (live /api/fire-perimeters `rows[i]`). */
export function perimeterRow(doc) {
  const id = str(doc.fire_id);
  const g = doc.geometry;
  let polygons = null;
  if (g?.type === 'MultiPolygon' && Array.isArray(g.coordinates))
    polygons = g.coordinates;
  else if (g?.type === 'Polygon' && Array.isArray(g.coordinates))
    polygons = [g.coordinates];
  if (!id || !polygons) return null;
  const updated = num(doc.poly_date_current) ?? docTimeMs(doc);
  return {
    stableId: id,
    name: str(doc.incident_name),
    acres: num(doc.size_acres),
    containedPct: num(doc.containment_pct),
    state: str(doc.state),
    category: null,
    discoveredTime: null,
    updatedTime: updated,
    cause: null,
    behavior: null,
    personnel: null,
    county: str(doc.county),
    costToDate: null,
    complexity: null,
    complexName: null,
    polygons,
  };
}

export const CYCLONE_ENVELOPE = Object.freeze({
  schemaVersion: 1,
  source: 'NOAA NHC / CPHC',
  attribution:
    'NOAA/NWS National Hurricane Center / Central Pacific Hurricane Center',
  coverage:
    'Atlantic and eastern/central North Pacific; not worldwide cyclone coverage.',
});

const isoMs = (ms) => (ms === null ? null : new Date(ms).toISOString());
const ADVISORY = /^(?:0|[1-9]\d{0,2})[A-Z]?$/;

/**
 * Storm in the live /api/cyclones shape. The recorder stores no forecast
 * points and no separate position time, so geometryStatus is 'unavailable'
 * (the live validator requires forecastPoints for 'current'); the recorded
 * forecast track and cone travel as recordedTrack / recordedCone, and
 * positionAt = the advisory issue time (positionAtRecorded: false).
 * ATCF best-track fixes (no advisory number) are returned separately by
 * the caller, never in `storms`.
 */
export function cycloneStorm(doc) {
  const id = str(doc.storm_id)?.toLowerCase();
  const tMs = docTimeMs(doc);
  const pla = num(doc.position?.lat),
    plo = num(doc.position?.lon);
  if (!id || !/^(?:al|ep|cp)\d{6}$/.test(id) || tMs === null) return null;
  if (pla === null || plo === null) return null;
  const nhc = doc.source === 'noaa-nhc' && ADVISORY.test(doc.advisory ?? '');
  return {
    id,
    name: str(doc.name) ?? id.toUpperCase(),
    classification: str(doc.classification) ?? 'unknown',
    basin: id.slice(0, 2).toUpperCase(),
    position: { longitude: plo, latitude: pla },
    positionAt: isoMs(tMs),
    advisoryNumber: nhc ? doc.advisory : null,
    issuedAt: nhc ? isoMs(tMs) : null,
    windKt: num(doc.intensity_kt),
    pressureHpa: num(doc.pressure_mb),
    movement: {
      directionDegrees: num(doc.movement_dir_deg),
      speedKt: num(doc.movement_speed_kt),
    },
    advisoryUrl: null,
    outlookUrl: null,
    geometryStatus: 'unavailable',
    geometryAdvisoryNumber: null,
    forecastPoints: [],
    track: null,
    cone: null,
    recordedTrack: doc.forecast_track ?? null,
    recordedCone: doc.cone ?? null,
    positionAtRecorded: !nhc,
    source: str(doc.source),
  };
}

/** Launch Library 2 result subset (live /api/launches `results[i]`). */
export function launchResult(doc) {
  const id = str(doc.launch_id);
  if (!id) return null;
  const pad = {
    name: str(doc.pad_name),
    latitude: num(doc.pad_location?.lat),
    longitude: num(doc.pad_location?.lon),
  };
  return {
    id,
    name: str(doc.name),
    status: { name: str(doc.status) },
    last_updated: str(doc.last_updated),
    net: str(doc.net),
    launch_service_provider: { name: str(doc.provider) },
    mission: { name: str(doc.mission) },
    pad,
  };
}
