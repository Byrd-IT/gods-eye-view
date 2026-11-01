/**
 * Seeding "Suggested rerun" plans into a plan library, from a spec.
 *
 * A spec describes a site (centre, takeoff) and a list of native GEV plans
 * (orbit rings, partial arcs, grids). Each plan is built as the panel's state,
 * stored in the library's own plan format (planDoc.serializePlan), and planned
 * once with the real planner so its stats can be checked against a reference
 * DJI mission (a KMZ) within a tolerance.
 *
 * The spec, and any reference KMZ files, stay outside the repository: they hold
 * a real location. Run with scripts/seed-suggested-reruns.mjs.
 *
 * Pure apart from the library calls in seedLibrary(); no DOM, no Cesium.
 */
import { assembleMissions, planFlight } from './planner.js';
import { serializePlan } from './planDoc.js';
import { DEFAULT_CAMERA_PRESET_ID } from './cameraSettings.js';

export const SEED_PREFIXES = Object.freeze([
  'Suggested rerun - ',
  'Suggested test - ',
]);

/** Tolerances for matching a reference mission (card t_8e1e10f5). */
export const TOLERANCE = Object.freeze({
  radiusM: 1,
  heightM: 1,
  pitchDeg: 1,
  countFraction: 0.05,
});

export const isSeedName = (name) =>
  typeof name === 'string' && SEED_PREFIXES.some((p) => name.startsWith(p));

function metersPerDegree(latDeg) {
  const lat = (latDeg * Math.PI) / 180;
  return {
    lat: 111132.92 - 559.82 * Math.cos(2 * lat) + 1.175 * Math.cos(4 * lat),
    lon: 111412.84 * Math.cos(lat) - 93.5 * Math.cos(3 * lat),
  };
}

const boxAround = (c, halfM) => {
  const m = metersPerDegree(c.lat);
  return {
    west: c.lon - halfM / m.lon,
    east: c.lon + halfM / m.lon,
    south: c.lat - halfM / m.lat,
    north: c.lat + halfM / m.lat,
  };
};

/** The panel state (what serializePlan reads) for one spec entry. */
export function buildState(spec, entry) {
  const c = spec.center;
  const orbit = entry.options?.pattern === 'orbit';
  const options = {
    presetId: spec.presetId ?? 'dji-mini-5-pro',
    aglM: 80,
    frontOverlap: 80,
    sideOverlap: 70,
    pattern: 'grid',
    direction: 'auto',
    tiltPitchDeg: -60,
    speedMs: 5,
    photoMode: 'waypoint',
    shutterDenominator: 500,
    cameraPresetId: DEFAULT_CAMERA_PRESET_ID,
    batteryMin: 25,
    orbitRadiusM: null,
    orbitHeightsM: null,
    orbitRingMode: orbit ? 'heights' : 'angles',
    orbitAnglesDeg: null,
    orbitOutward: false,
    ...entry.options,
    orbitTargets: (entry.orbitTargets ?? []).map((t, i) => ({
      id: t.id ?? `t${i + 1}`,
      lon: c.lon,
      lat: c.lat,
      heightM: t.heightM,
      radiusM: t.radiusM,
      source: 'custom',
      ...(t.blocked ? { blocked: t.blocked } : {}),
    })),
    lookAtPaths: [],
    obstacles: [],
  };
  return {
    areas: [
      {
        id: 'area-1',
        name: entry.areaName ?? 'Area 1',
        kind: 'rect',
        box: boxAround(c, entry.areaHalfM),
      },
    ],
    nextArea: 2,
    jobGrouping: 'whole',
    takeoff: { lon: spec.takeoff.lon, lat: spec.takeoff.lat },
    options,
    orbitTargetsTouched: orbit,
    orbitsPlanned: false,
    wpml: { droneEnumValue: null, droneSubEnumValue: null },
    suite: null,
    suiteHidden: new Set(),
  };
}

/** Plan the state once, as the panel would without terrain data. */
export function planStats(spec, entry) {
  const state = buildState(spec, entry);
  const area = state.areas[0].box;
  const plan = planFlight(area, { ...state.options, takeoff: state.takeoff });
  if (plan.error) return { error: plan.error };
  const assembled = assembleMissions(plan, { known: false });
  const wps = assembled.missions.flatMap((m) => m.waypoints);
  const target = state.options.orbitTargets[0];
  const m = metersPerDegree(spec.center.lat);
  const radii = target
    ? wps.map((w) =>
        Math.hypot((w.lon - target.lon) * m.lon, (w.lat - target.lat) * m.lat),
      )
    : [];
  return {
    waypointCount: wps.length,
    photoCount: assembled.missions.reduce((s, x) => s + x.photoCount, 0),
    missionCount: assembled.missions.length,
    speedMs: plan.speedMs,
    heights: distinct(wps.map((w) => w.relHeightM)),
    pitches: distinct(wps.map((w) => w.pitchDeg)),
    meanRadiusM: radii.length
      ? radii.reduce((a, b) => a + b, 0) / radii.length
      : null,
  };
}

const distinct = (list) =>
  [...new Set(list.filter(Number.isFinite).map((v) => Math.round(v * 10) / 10))]
    .sort((a, b) => a - b);

/** Stats of a parsed reference mission (parseDjiKmz) around the centre. */
export function referenceStats(mission, center) {
  const m = metersPerDegree(center.lat);
  const wps = mission.waypoints.filter((w) => w.lon !== null);
  const radii = wps.map((w) =>
    Math.hypot((w.lon - center.lon) * m.lon, (w.lat - center.lat) * m.lat),
  );
  return {
    waypointCount: wps.length,
    heights: distinct(wps.map((w) => w.heightM)),
    pitches: distinct(wps.map((w) => w.gimbalPitchDeg)),
    meanRadiusM: radii.reduce((a, b) => a + b, 0) / (radii.length || 1),
  };
}

const closeSets = (a, b, tol) =>
  a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);

/** Differences between a native plan and its reference; [] when it matches. */
export function compareToReference(native, reference, tol = TOLERANCE) {
  const problems = [];
  const relCount =
    Math.abs(native.waypointCount - reference.waypointCount) /
    reference.waypointCount;
  if (relCount > tol.countFraction)
    problems.push(
      `waypoints ${native.waypointCount} vs ${reference.waypointCount}`,
    );
  if (!closeSets(native.heights, reference.heights, tol.heightM))
    problems.push(
      `heights ${native.heights} vs ${reference.heights}`,
    );
  if (!closeSets(native.pitches, reference.pitches, tol.pitchDeg))
    problems.push(`pitches ${native.pitches} vs ${reference.pitches}`);
  if (Math.abs(native.meanRadiusM - reference.meanRadiusM) > tol.radiusM)
    problems.push(
      `radius ${native.meanRadiusM?.toFixed(1)} vs ${reference.meanRadiusM.toFixed(1)}`,
    );
  return problems;
}

/** One library item: details plus the storable plan document. */
export function buildItem(spec, entry) {
  if (!isSeedName(entry.name))
    throw new Error(`seed plans must be named "${SEED_PREFIXES.join('" or "')}"`);
  const stats = planStats(spec, entry);
  if (stats.error) throw new Error(`${entry.name}: ${stats.error}`);
  const planned =
    `Planned by GEV: ${stats.waypointCount} waypoints, ${stats.photoCount} photos, ` +
    `${stats.missionCount} mission${stats.missionCount === 1 ? '' : 's'}, ` +
    `speed ${stats.speedMs.toFixed(2)} m/s.`;
  return {
    details: {
      name: entry.name,
      site: spec.site ?? '',
      notes: `${entry.notes ?? ''}\n${planned}`.trim(),
      status: 'planned',
    },
    plan: serializePlan(buildState(spec, entry)),
  };
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Write the items to a store. Idempotent: an existing plan of the same name
 * whose document is unchanged is left alone; a changed one gets a new version;
 * nothing else in the library is read for writing or touched.
 * @returns {{name: string, action: 'created'|'updated'|'unchanged', id?: string}[]}
 */
export function seedLibrary(store, user, items, { dryRun = false } = {}) {
  const existing = store.list(user, { purgeOld: false });
  return items.map(({ details, plan }) => {
    if (!isSeedName(details.name)) throw new Error('refusing a non-seed name');
    const found = existing.find((p) => p.name === details.name);
    if (!found) {
      if (dryRun) return { name: details.name, action: 'created' };
      const made = store.create(user, details, plan);
      return { name: details.name, action: 'created', id: made.id };
    }
    const current = store.get(user, found.id);
    const same =
      sameJson(current.plan, plan) &&
      found.site === details.site &&
      found.notes === details.notes;
    if (same) return { name: details.name, action: 'unchanged', id: found.id };
    if (!dryRun) store.save(user, found.id, plan, details);
    return { name: details.name, action: 'updated', id: found.id };
  });
}
