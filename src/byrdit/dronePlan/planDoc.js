/**
 * The saved form of a Drone Flight Plan (what the library stores and what a
 * `.gevplan` file holds), and the strict reader for it.
 *
 * A saved plan is the full editable state: areas (boxes and polygons), every
 * Adjust setting, takeoff, orbit targets, obstacles, the aircraft code
 * override, and whether PLAN ALL was run (with the passes hidden on the map).
 * Opening one restores that state and plans again; the planned result is never
 * stored (it is rebuilt from the terrain). Controller mission ids and imported
 * drone files ride along.
 *
 * Pure: no DOM, no Cesium. Everything read back is re-validated here, because
 * a `.gevplan` file is untrusted input.
 */
import { normalizeOrbitTargets } from './planner.js';
import { normalizeObstacles } from './obstacles.js';
import { getPreset } from './presets.js';

export const GEVPLAN_SCHEMA = 'gevplan';
export const GEVPLAN_VERSION = 1;
export const MAX_AREAS = 20;
export const MAX_RING_POINTS = 500;
export const MAX_IMPORTS = 20;
export const MAX_IMPORT_WAYPOINTS = 2000;
export const MAX_GEVPLAN_BYTES = 25 * 1024 * 1024;

/** Setting name -> check. Unknown names are dropped. */
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const OPTION_TYPES = Object.freeze({
  presetId: (v) => typeof v === 'string' && Boolean(getPreset(v)),
  aglM: finite,
  frontOverlap: finite,
  sideOverlap: finite,
  pattern: (v) => ['grid', 'double', 'orbit'].includes(v),
  direction: (v) => v === 'auto' || finite(v) || typeof v === 'string',
  tiltPitchDeg: finite,
  speedMs: finite,
  photoMode: (v) => ['waypoint', 'interval'].includes(v),
  shutterDenominator: finite,
  batteryMin: finite,
  orbitRadiusM: (v) => v === null || finite(v),
  orbitHeightsM: (v) =>
    v === null || (Array.isArray(v) && v.length <= 20 && v.every(finite)),
  orbitTargetHeightM: finite,
  obstacleHeightM: finite,
});

const lonLat = (p) =>
  p &&
  finite(p.lon) &&
  finite(p.lat) &&
  Math.abs(p.lon) <= 180 &&
  Math.abs(p.lat) <= 90;

function cleanArea(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const id =
    typeof raw.id === 'string' && raw.id.length <= 60
      ? raw.id
      : `area-${index + 1}`;
  const name =
    typeof raw.name === 'string' && raw.name
      ? raw.name.slice(0, 120)
      : `Area ${index + 1}`;
  if (raw.kind === 'polygon') {
    if (
      !Array.isArray(raw.ring) ||
      raw.ring.length < 3 ||
      raw.ring.length > MAX_RING_POINTS
    )
      return null;
    if (!raw.ring.every(lonLat)) return null;
    const ring = raw.ring.map((p) => ({ lon: p.lon, lat: p.lat }));
    const lons = ring.map((p) => p.lon);
    const lats = ring.map((p) => p.lat);
    return {
      name,
      id,
      kind: 'polygon',
      ring,
      box: {
        west: Math.min(...lons),
        east: Math.max(...lons),
        south: Math.min(...lats),
        north: Math.max(...lats),
      },
    };
  }
  const b = raw.box;
  if (!b || ![b.west, b.east, b.south, b.north].every(finite)) return null;
  if (Math.abs(b.south) > 90 || Math.abs(b.north) > 90) return null;
  if (Math.abs(b.west) > 180 || Math.abs(b.east) > 180) return null;
  return {
    name,
    id,
    kind: 'rect',
    box: { west: b.west, east: b.east, south: b.south, north: b.north },
  };
}

/** Controller mission ids: UUIDs or null, one per flight. */
const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
export function cleanControllerIds(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 200).map((v) => {
    const id = typeof v === 'string' ? v.toUpperCase() : '';
    return UUID.test(id) ? id : null;
  });
}

/** An imported drone file kept with the plan (draw-only, never re-planned). */
export function cleanImport(raw, index = 0) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.waypoints))
    return null;
  const waypoints = raw.waypoints
    .slice(0, MAX_IMPORT_WAYPOINTS)
    .filter(lonLat)
    .map((w) => ({
      lon: w.lon,
      lat: w.lat,
      heightM: finite(w.heightM) ? w.heightM : null,
      speedMs: finite(w.speedMs) ? w.speedMs : null,
      headingMode:
        typeof w.headingMode === 'string' ? w.headingMode.slice(0, 40) : null,
      poi: lonLat(w.poi)
        ? {
            lon: w.poi.lon,
            lat: w.poi.lat,
            altM: finite(w.poi.altM) ? w.poi.altM : 0,
          }
        : null,
    }));
  if (!waypoints.length) return null;
  const uuid =
    typeof raw.uuid === 'string' && UUID.test(raw.uuid.toUpperCase())
      ? raw.uuid.toUpperCase()
      : null;
  return {
    id:
      typeof raw.id === 'string' && /^[\w.-]{1,60}$/.test(raw.id)
        ? raw.id
        : `import-${index + 1}`,
    name:
      typeof raw.name === 'string'
        ? raw.name.slice(0, 120)
        : `Import ${index + 1}`,
    source: raw.source === 'gev' ? 'gev' : 'dji',
    uuid,
    droneEnumValue: finite(raw.droneEnumValue) ? raw.droneEnumValue : null,
    waypoints,
  };
}

/**
 * The storable form of the panel state.
 * @param {object} state the panel's state object
 * @param {{ controllerIds?: (string|null)[], imports?: object[] }} [extra]
 */
export function serializePlan(
  state,
  { controllerIds = [], imports = [] } = {},
) {
  const options = {};
  for (const key of Object.keys(OPTION_TYPES)) {
    if (OPTION_TYPES[key](state.options[key]))
      options[key] = state.options[key];
  }
  return {
    schema: GEVPLAN_SCHEMA,
    version: GEVPLAN_VERSION,
    presetId: state.options.presetId,
    areas: state.areas.map((a) =>
      a.kind === 'polygon'
        ? {
            id: a.id,
            name: a.name,
            kind: 'polygon',
            ring: a.ring.map((p) => ({ lon: p.lon, lat: p.lat })),
          }
        : { id: a.id, name: a.name, kind: 'rect', box: { ...a.box } },
    ),
    nextArea: state.nextArea,
    jobGrouping: state.jobGrouping,
    takeoff: state.takeoff
      ? { lon: state.takeoff.lon, lat: state.takeoff.lat }
      : null,
    options,
    orbitTargets: state.options.orbitTargets ?? [],
    orbitTargetsTouched: Boolean(state.orbitTargetsTouched),
    obstacles: state.options.obstacles ?? [],
    wpml: {
      droneEnumValue: state.wpml?.droneEnumValue ?? null,
      droneSubEnumValue: state.wpml?.droneSubEnumValue ?? null,
    },
    suite: {
      planned: Boolean(state.suite || state.orbitsPlanned),
      hidden: [...(state.suiteHidden ?? [])].slice(0, 20).map(String),
    },
    controllerIds: cleanControllerIds(controllerIds),
    imports: imports.map(cleanImport).filter(Boolean),
  };
}

/**
 * Validate a saved plan. Throws an Error with a short reason on a document
 * that is not a plan this version can open; clean data otherwise.
 */
export function readPlan(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('not-a-plan');
  if (raw.schema !== GEVPLAN_SCHEMA) throw new Error('not-a-plan');
  if (!Number.isInteger(raw.version) || raw.version < 1)
    throw new Error('not-a-plan');
  if (raw.version > GEVPLAN_VERSION) throw new Error('newer-version');
  if (!Array.isArray(raw.areas) || raw.areas.length > MAX_AREAS)
    throw new Error('bad-areas');
  const areas = raw.areas.map(cleanArea);
  if (areas.some((a) => !a)) throw new Error('bad-areas');
  const options = {};
  for (const [key, ok] of Object.entries(OPTION_TYPES)) {
    if (raw.options && ok(raw.options[key])) options[key] = raw.options[key];
  }
  const takeoff = lonLat(raw.takeoff)
    ? { lon: raw.takeoff.lon, lat: raw.takeoff.lat }
    : null;
  const enumValue = raw.wpml?.droneEnumValue;
  const subValue = raw.wpml?.droneSubEnumValue;
  return {
    areas,
    nextArea:
      Number.isInteger(raw.nextArea) &&
      raw.nextArea >= 1 &&
      raw.nextArea < 10_000
        ? Math.max(raw.nextArea, areas.length + 1)
        : areas.length + 1,
    jobGrouping: raw.jobGrouping === 'whole' ? 'whole' : 'per-area',
    takeoff,
    options,
    orbitTargets: normalizeOrbitTargets(raw.orbitTargets) ?? [],
    orbitTargetsTouched: raw.orbitTargetsTouched === true,
    obstacles: normalizeObstacles(raw.obstacles),
    wpml: {
      droneEnumValue:
        Number.isInteger(enumValue) && enumValue >= 0 && enumValue <= 999
          ? enumValue
          : null,
      droneSubEnumValue:
        Number.isInteger(subValue) && subValue >= 0 && subValue <= 999
          ? subValue
          : null,
    },
    suite: {
      planned: raw.suite?.planned === true,
      hidden: Array.isArray(raw.suite?.hidden)
        ? raw.suite.hidden.filter((x) => typeof x === 'string').slice(0, 20)
        : [],
    },
    controllerIds: cleanControllerIds(raw.controllerIds),
    imports: (Array.isArray(raw.imports)
      ? raw.imports.slice(0, MAX_IMPORTS)
      : []
    )
      .map(cleanImport)
      .filter(Boolean),
  };
}

/** The `.gevplan` file: JSON with the plan's details around the plan. */
export function buildGevPlanFile(details, plan) {
  return JSON.stringify(
    {
      schema: GEVPLAN_SCHEMA,
      version: GEVPLAN_VERSION,
      kind: 'file',
      details: {
        name: details?.name ?? '',
        site: details?.site ?? '',
        customer: details?.customer ?? '',
        notes: details?.notes ?? '',
        status: details?.status ?? 'planned',
      },
      plan,
    },
    null,
    1,
  );
}

/**
 * Read a `.gevplan` file's text. Returns { details, plan } with the plan
 * already validated, or throws like readPlan.
 */
export function parseGevPlanFile(text) {
  if (typeof text !== 'string' || text.length > MAX_GEVPLAN_BYTES)
    throw new Error('too-large');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('not-a-plan');
  }
  if (
    !raw ||
    raw.schema !== GEVPLAN_SCHEMA ||
    raw.kind !== 'file' ||
    !raw.plan
  ) {
    throw new Error('not-a-plan');
  }
  if (Number.isInteger(raw.version) && raw.version > GEVPLAN_VERSION)
    throw new Error('newer-version');
  const d = raw.details ?? {};
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  return {
    details: {
      name: str(d.name, 120),
      site: str(d.site, 200),
      customer: str(d.customer, 200),
      notes: str(d.notes, 5000),
      status: ['planned', 'flown', 'processed'].includes(d.status)
        ? d.status
        : 'planned',
    },
    plan: readPlan(raw.plan),
  };
}

/** A draw-only import from a parsed DJI mission (see djiKmz.js). */
export function importFromMission(
  mission,
  { id, name, source = 'dji', droneEnumValue = null } = {},
) {
  return cleanImport({
    id,
    name,
    source,
    uuid: mission.uuid,
    droneEnumValue: mission.config?.droneEnumValue ?? droneEnumValue,
    waypoints: mission.waypoints.map((w) => ({
      lon: w.lon,
      lat: w.lat,
      heightM: w.heightM,
      speedMs: w.speedMs,
      headingMode: w.heading?.mode,
      poi: w.heading?.poi
        ? {
            lon: w.heading.poi.lon,
            lat: w.heading.poi.lat,
            altM: w.heading.poi.altM,
          }
        : null,
    })),
  });
}
