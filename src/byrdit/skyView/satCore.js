/**
 * Sky view satellite engine (SKYVIEW.md 4.1, 4.2, 4.5). Pure, Cesium-free and
 * DOM-free so the same code runs inside the module worker (satWorker.js) and
 * in node tests. It reuses the existing maths, never copies it:
 *   - GP rows: parseGP from ../gpCsv.js (the satellites layer parses with the
 *     same function, so the sky and the globe hold the same catalogue);
 *   - look angles: lookAnglesAt() from src/data/satellitePass.js;
 *   - sunlit / dark sky: isSatelliteSunlit(), isObserverDark(),
 *     observerSolarElevation() from the same file;
 *   - classes: satelliteClassOf() / SATELLITE_CLASS_ORDER from
 *     src/data/satelliteClass.js.
 *
 * One tick returns a packed Float32Array, RECORD_FIELDS floats per object
 * whose elevation is above MIN_EL_DEG:
 *   [index, azDeg, elDeg, rangeKm, rangeRateKmS, flags]
 * `index` is the object's slot in the engine catalogue (stable for the life of
 * the engine; meta() maps it to name/NORAD/class), `flags` is an integer bit
 * set (see FLAG and decodeFlags). Float32 holds az/el to about 1.5e-5 deg,
 * far below a pixel even at the narrowest 5 deg field of view; the exact
 * float64 values come from describeLook(), which the tick packs.
 *
 * Per object and tick: ONE SGP4 propagation; a conservative central-angle
 * test (cullBounds) rejects objects that cannot be above MIN_EL_DEG without
 * any look-angle work; the remaining candidates get lookAnglesAt() (so az/el
 * are exactly its numbers) and range rate from the SGP4 velocity.
 *
 * Culling: an object well below the horizon cannot reach -2 deg elevation
 * before its sub-satellite point has moved the remaining central angle, and
 * that point moves no faster than the perigee angular rate plus the Earth's
 * rotation. The engine skips such an object until that much simulated time
 * has passed (forwards or backwards), so a steady 16.7k-object tick only
 * propagates the objects that could have changed state. Tested against a
 * full (uncull) run over hours of simulated time.
 */
import {
  ecfToEci,
  geodeticToEcf,
  gstime,
  json2satrec,
  sgp4,
} from 'satellite.js';
import {
  isObserverDark,
  isSatelliteSunlit,
  lookAnglesAt,
  observerSolarElevation,
} from '../../data/satellitePass.js';
import {
  SATELLITE_CLASS_ORDER,
  satelliteClassOf,
} from '../../data/satelliteClass.js';
import { parseGP } from '../gpCsv.js';

/** [index, azDeg, elDeg, rangeKm, rangeRateKmS, flags] */
export const RECORD_FIELDS = 6;
export const MIN_EL_DEG = -2;
/** Grey an object whose element set is this far from the Sky time. */
export const STALE_DAYS = 7;
/** Drop an object whose element set is this far from the Sky time. */
export const DROP_DAYS = 30;
const DAY_MS = 86_400_000;
export const ISS_NORAD = 25544;

/**
 * Core groups in dedupe-priority order: must equal CATALOG_GROUPS in
 * src/layers/satellites/policy.js (asserted by satCore.test.mjs; policy.js
 * imports Cesium, which a worker cannot load).
 */
export const SKY_CORE_GROUPS = Object.freeze([
  Object.freeze({ tag: 'stations', path: 'stations' }),
  Object.freeze({ tag: 'visual', path: 'visual' }),
  Object.freeze({ tag: 'gps-ops', path: 'gps-ops' }),
  Object.freeze({ tag: 'glonass', path: 'glo-ops' }),
  Object.freeze({ tag: 'galileo', path: 'galileo' }),
  Object.freeze({ tag: 'geo', path: 'geo' }),
]);
/** Upstream group paths the sky reads through /api/celestrak/<path>. */
export const ACTIVE_PATH = 'active';
export const STARLINK_PATH = 'starlink';

/** Data sets: core always on; active and starlink are switches. */
export const SKY_SETS = Object.freeze(['core', 'active', 'starlink']);
/** Sky classes: the satelliteClass.js classes plus "other active". */
export const SKY_CLASSES = Object.freeze([...SATELLITE_CLASS_ORDER, 'other']);

export const STATE = Object.freeze({
  NONE: 0,
  VISIBLE: 1,
  SUNLIT_BRIGHT_SKY: 2,
  SHADOW: 3,
});
export const STATE_NAMES = Object.freeze([
  'none',
  'visible',
  'sunlit-bright-sky',
  'shadow',
]);

/** Flag bits (integers, exact in Float32 below 2^24). */
export const FLAG = Object.freeze({
  SUNLIT: 1,
  DARK: 2,
  STATE_SHIFT: 2, // 2 bits
  CLASS_SHIFT: 4, // 3 bits
  NAKED_EYE: 128,
  STALE: 256,
  SET_SHIFT: 9, // 2 bits
});

export function packFlags({
  sunlit = false,
  dark = false,
  state = STATE.NONE,
  classId = 0,
  nakedEye = false,
  stale = false,
  setId = 0,
}) {
  return (
    (sunlit ? FLAG.SUNLIT : 0) |
    (dark ? FLAG.DARK : 0) |
    ((state & 3) << FLAG.STATE_SHIFT) |
    ((classId & 7) << FLAG.CLASS_SHIFT) |
    (nakedEye ? FLAG.NAKED_EYE : 0) |
    (stale ? FLAG.STALE : 0) |
    ((setId & 3) << FLAG.SET_SHIFT)
  );
}

export function decodeFlags(flags) {
  const f = flags | 0;
  const state = (f >> FLAG.STATE_SHIFT) & 3;
  const classId = (f >> FLAG.CLASS_SHIFT) & 7;
  const setId = (f >> FLAG.SET_SHIFT) & 3;
  return {
    sunlit: Boolean(f & FLAG.SUNLIT),
    dark: Boolean(f & FLAG.DARK),
    state,
    stateName: STATE_NAMES[state],
    classId,
    klass: SKY_CLASSES[classId],
    nakedEye: Boolean(f & FLAG.NAKED_EYE),
    stale: Boolean(f & FLAG.STALE),
    setId,
    set: SKY_SETS[setId],
  };
}

/**
 * The three drawing states (SKYVIEW.md 4.2), from the existing tests:
 * VISIBLE = sunlit AND the observer's sky is dark (Sun <= -6 deg,
 * isObserverDark's default); SUNLIT_BRIGHT_SKY = sunlit, Sun above -6;
 * SHADOW = in the Earth's (cylindrical) shadow.
 */
export function satelliteState(sunlit, dark) {
  if (!sunlit) return STATE.SHADOW;
  return dark ? STATE.VISIBLE : STATE.SUNLIT_BRIGHT_SKY;
}

/** Group path -> { tag, set, priority } (lower priority number wins). */
export function groupInfo(path, name = '') {
  const core = SKY_CORE_GROUPS.findIndex((g) => g.path === path);
  if (core >= 0)
    return { tag: SKY_CORE_GROUPS[core].tag, set: 'core', priority: core };
  if (path === STARLINK_PATH)
    return { tag: 'dense', set: 'starlink', priority: 10 };
  if (path === ACTIVE_PATH) {
    // `active` holds every Starlink too; those belong to the Starlink switch.
    if (/^STARLINK/i.test(String(name)))
      return { tag: 'dense', set: 'starlink', priority: 11 };
    return { tag: 'active', set: 'active', priority: 12 };
  }
  return null;
}

/** Sky class key for a group tag ("active" is not a satelliteClass group). */
export function skyClassOf(tag, noradId) {
  const isIss = noradId === ISS_NORAD;
  if (tag === 'active' && !isIss) return 'other';
  return satelliteClassOf(tag, { isIss }).klass;
}

// ── culling geometry ────────────────────────────────────────────────────────
const D2R = Math.PI / 180;
/** satellite.js / WGS-72 radius that satrec.a is expressed in. */
const SGP4_RADIUS_KM = 6378.135;
/** Polar radius: the smallest Earth, the widest possible horizon circle. */
const R_MIN_KM = 6356.75;
const EARTH_RATE_RAD_S = 7.2921159e-5;
/** Geodetic vs geocentric vertical (<= 0.19 deg) + osculating slack. */
const CULL_MARGIN_RAD = 1.5 * D2R;
const RATE_SAFETY = 1.25;
/** Never trust a cull window longer than this (sim time). */
export const MAX_CULL_MS = 30 * 60_000;
const MIN_CULL_MS = 1500;

/**
 * Culling bounds for one satrec: the largest central angle at which it can be
 * at elevation >= MIN_EL_DEG (at apogee) and the fastest its sub-satellite
 * point can move relative to the observer (perigee rate + Earth rotation).
 */
export function cullBounds(satrec) {
  const e = Math.min(Math.max(Number(satrec?.ecco) || 0, 0), 0.99);
  const aKm = (Number(satrec?.a) || 0) * SGP4_RADIUS_KM;
  const apoKm = aKm * (1 + e);
  const nRadS = (Number(satrec?.no) || 0) / 60;
  if (!(apoKm > R_MIN_KM) || !(nRadS > 0))
    return { lambdaMaxRad: Infinity, maxRateRadS: Infinity };
  const elMin = MIN_EL_DEG * D2R;
  const lambdaMaxRad =
    Math.acos(Math.min(1, (R_MIN_KM * Math.cos(elMin)) / apoKm)) -
    elMin +
    CULL_MARGIN_RAD;
  const perigeeRate = (nRadS * (1 + e) ** 2) / (1 - e * e) ** 1.5;
  return {
    lambdaMaxRad,
    maxRateRadS: RATE_SAFETY * (perigeeRate + EARTH_RATE_RAD_S),
  };
}

function unit(v) {
  const n = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / n, y: v.y / n, z: v.z / n };
}

/** Observer context (height 0, like lookAnglesAt). */
export function makeObserver(latDeg, lonDeg) {
  const lat = Number(latDeg);
  const lon = Number(lonDeg);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const ecf = geodeticToEcf({
    latitude: lat * D2R,
    longitude: lon * D2R,
    height: 0,
  });
  return { latDeg: lat, lonDeg: lon, ecf, up: unit(ecf), key: `${lat},${lon}` };
}

/** Epoch of a satrec in UTC ms. */
export function satrecEpochMs(satrec) {
  const jd = Number(satrec?.jdsatepoch) + (Number(satrec?.jdsatepochF) || 0);
  return Number.isFinite(jd) ? (jd - 2440587.5) * DAY_MS : NaN;
}

/** Element-age class of an object at Sky time: 'ok' | 'stale' | 'drop'. */
export function elementAge(epochMs, timeMs) {
  const days = Math.abs(timeMs - epochMs) / DAY_MS;
  if (!Number.isFinite(days)) return 'drop';
  if (days > DROP_DAYS) return 'drop';
  if (days > STALE_DAYS) return 'stale';
  return 'ok';
}

/**
 * SGP4 position/velocity (ECI, km, km/s) or null. Calls sgp4() with the
 * minutes since epoch directly: the same numbers as satellite.js propagate()
 * (measured identical over 16,830 objects) without its per-call Date to
 * Julian-day conversion, which was a third of the tick.
 */
export function propagateEci(satrec, timeMs) {
  let pv;
  try {
    const jd = timeMs / DAY_MS + 2440587.5;
    pv = sgp4(satrec, (jd - satrec.jdsatepoch) * 1440);
  } catch {
    return null;
  }
  const p = pv?.position;
  const v = pv?.velocity;
  if (!p || typeof p === 'boolean' || ![p.x, p.y, p.z].every(Number.isFinite))
    return null;
  return { position: p, velocity: v && typeof v !== 'boolean' ? v : null };
}

/** Observer position (ECI, km) and velocity (Earth rotation) at a GMST. */
export function observerEci(observer, gmst) {
  const r = ecfToEci(observer.ecf, gmst);
  return {
    r,
    v: { x: -EARTH_RATE_RAD_S * r.y, y: EARTH_RATE_RAD_S * r.x, z: 0 },
    up: unit(r),
  };
}

/** Range (km) and range rate (km/s, + = receding) from ECI states. */
export function rangeAndRate(pv, obs) {
  const dx = pv.position.x - obs.r.x;
  const dy = pv.position.y - obs.r.y;
  const dz = pv.position.z - obs.r.z;
  const rangeKm = Math.hypot(dx, dy, dz);
  const v = pv.velocity;
  const rangeRateKmS = v
    ? (dx * (v.x - obs.v.x) + dy * (v.y - obs.v.y) + dz * (v.z - obs.v.z)) /
      rangeKm
    : 0;
  return { rangeKm, rangeRateKmS };
}

/**
 * Full float64 description of one object at one instant (the tick packs
 * exactly these numbers). az/el are lookAnglesAt()'s own output.
 */
export function describeLook(
  entry,
  timeMs,
  observer,
  { dark, look, pv, obs } = {},
) {
  const here =
    look ||
    lookAnglesAt(entry.satrec, timeMs, observer.latDeg, observer.lonDeg);
  if (!here) return null;
  const state6 = pv || propagateEci(entry.satrec, timeMs);
  const o = obs || observerEci(observer, gstime(new Date(timeMs)));
  const { rangeKm, rangeRateKmS } = state6
    ? rangeAndRate(state6, o)
    : { rangeKm: NaN, rangeRateKmS: 0 };
  const sunlit = isSatelliteSunlit(here.satECI, timeMs);
  const isDark =
    dark ?? isObserverDark(observer.latDeg, observer.lonDeg, timeMs);
  const state = satelliteState(sunlit, isDark);
  const stale = elementAge(entry.epochMs, timeMs) === 'stale';
  return {
    index: entry.index,
    azDeg: here.azDeg,
    elDeg: here.elevDeg,
    rangeKm,
    rangeRateKmS,
    sunlit,
    dark: isDark,
    state,
    stale,
    flags: packFlags({
      sunlit,
      dark: isDark,
      state,
      classId: entry.classId,
      nakedEye: state === STATE.VISIBLE && entry.nakedEyeGroup,
      stale,
      setId: SKY_SETS.indexOf(entry.set),
    }),
  };
}

/**
 * Tick policy (SKYVIEW.md 4.1): core + active every tick (1 Hz), Starlink
 * every other tick (0.5 Hz, the main thread extrapolates in between), but
 * every tick after a time jump or when the Sky clock runs fast enough that
 * two ticks are more than `maxGapMs` of sky time apart.
 */
export const STARLINK_MAX_GAP_MS = 10_000;
export function planTick({
  tickNo = 0,
  timeMs,
  activeOn = true,
  starlinkOn = false,
  lastStarlinkMs = null,
  force = false,
  maxGapMs = STARLINK_MAX_GAP_MS,
}) {
  const sets = ['core'];
  if (activeOn) sets.push('active');
  if (
    starlinkOn &&
    (force ||
      lastStarlinkMs == null ||
      tickNo % 2 === 0 ||
      Math.abs(timeMs - lastStarlinkMs) > maxGapMs)
  )
    sets.push('starlink');
  return sets;
}

/** The engine the worker wraps. */
export function createSatEngine({
  now = () => globalThis.performance?.now?.() ?? Date.now(),
} = {}) {
  const entries = [];
  const byNorad = new Map();
  let cullT = new Float64Array(0);
  let cullSlack = new Float64Array(0);
  let scratch = new Float32Array(0);
  let observer = null;
  let version = 0;

  const resetCull = (i) => {
    if (i === undefined) cullSlack.fill(0);
    else cullSlack[i] = 0;
  };
  const growCull = () => {
    if (cullT.length >= entries.length) return;
    const size = Math.max(entries.length, cullT.length * 2, 64);
    const t = new Float64Array(size);
    const s = new Float64Array(size);
    t.set(cullT);
    s.set(cullSlack);
    cullT = t;
    cullSlack = s;
  };

  /** Load one group's CSV text. Returns counts. */
  function loadGroup(path, text) {
    const rows = parseGP(text);
    let added = 0;
    let updated = 0;
    let rejected = 0;
    for (const row of rows) {
      const info = groupInfo(path, row.name);
      if (!info) {
        rejected += 1;
        continue;
      }
      let satrec;
      try {
        satrec = json2satrec(row.gp);
      } catch {
        satrec = null;
      }
      if (!satrec || satrec.error !== 0) {
        rejected += 1;
        continue;
      }
      const noradId = Number(satrec.satnum);
      const existing = byNorad.get(noradId);
      if (existing && existing.priority <= info.priority) continue;
      const klass = skyClassOf(info.tag, noradId);
      const fields = {
        noradId,
        name: row.name,
        objectId: row.gp.OBJECT_ID || '',
        group: info.tag,
        set: info.set,
        priority: info.priority,
        satrec,
        epochMs: satrecEpochMs(satrec),
        klass,
        classId: SKY_CLASSES.indexOf(klass),
        nakedEyeGroup:
          info.tag === 'stations' ||
          info.tag === 'visual' ||
          noradId === ISS_NORAD,
        ...cullBounds(satrec),
      };
      if (existing) {
        Object.assign(existing, fields);
        resetCull(existing.index);
        updated += 1;
      } else {
        const entry = { index: entries.length, ...fields };
        entries.push(entry);
        byNorad.set(noradId, entry);
        added += 1;
      }
    }
    growCull();
    if (added || updated) version += 1;
    return { path, parsed: rows.length, added, updated, rejected };
  }

  function setObserver(latDeg, lonDeg) {
    const next = makeObserver(latDeg, lonDeg);
    if (!next) return false;
    if (observer?.key !== next.key) resetCull();
    observer = next;
    return true;
  }

  /**
   * One tick at Sky time `timeMs` for the given sets.
   * @returns {{timeMs:number, records:Float32Array, count:number, sets:string[],
   *   sunAltDeg:number, dark:boolean, computed:number, culled:number,
   *   dropped:number, failed:number, durationMs:number}}
   */
  function tick({ timeMs, sets = ['core', 'active'], cull = true } = {}) {
    const started = now();
    const t = Number(timeMs);
    const empty = {
      timeMs: t,
      records: new Float32Array(0),
      count: 0,
      sets: [...sets],
      sunAltDeg: NaN,
      dark: false,
      computed: 0,
      culled: 0,
      dropped: 0,
      failed: 0,
      durationMs: 0,
    };
    if (!observer || !Number.isFinite(t)) return empty;
    const want = new Set(sets);
    const { latDeg, lonDeg } = observer;
    const sunAltDeg = observerSolarElevation(latDeg, lonDeg, t);
    const dark = isObserverDark(latDeg, lonDeg, t);
    const gmst = gstime(new Date(t));
    const obs = observerEci(observer, gmst);
    const up = obs.up;
    if (scratch.length < entries.length * RECORD_FIELDS)
      scratch = new Float32Array(entries.length * RECORD_FIELDS);
    let n = 0;
    let computed = 0;
    let culled = 0;
    let dropped = 0;
    let failed = 0;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!want.has(entry.set)) continue;
      if (Math.abs(t - entry.epochMs) > DROP_DAYS * DAY_MS) {
        dropped += 1;
        continue;
      }
      if (cull && cullSlack[i] > 0 && Math.abs(t - cullT[i]) < cullSlack[i]) {
        culled += 1;
        continue;
      }
      computed += 1;
      const pv = propagateEci(entry.satrec, t);
      if (!pv) {
        failed += 1;
        cullSlack[i] = 0;
        continue;
      }
      cullSlack[i] = 0;
      // Central angle observer -> sub-satellite point (same in ECI and ECF).
      const p = pv.position;
      const cos =
        (p.x * up.x + p.y * up.y + p.z * up.z) / Math.hypot(p.x, p.y, p.z);
      const lambda = Math.acos(Math.max(-1, Math.min(1, cos)));
      if (lambda > entry.lambdaMaxRad) {
        // Certainly below MIN_EL_DEG now; skip it until it could be back.
        if (cull) {
          const slackMs =
            ((lambda - entry.lambdaMaxRad) / entry.maxRateRadS) * 1000;
          if (slackMs > MIN_CULL_MS) {
            cullT[i] = t;
            cullSlack[i] = Math.min(slackMs, MAX_CULL_MS);
          }
        }
        continue;
      }
      const look = lookAnglesAt(entry.satrec, t, latDeg, lonDeg);
      if (!look) {
        failed += 1;
        continue;
      }
      if (look.elevDeg <= MIN_EL_DEG) continue;
      const d = describeLook(entry, t, observer, { dark, look, pv, obs });
      const o = n * RECORD_FIELDS;
      scratch[o] = entry.index;
      scratch[o + 1] = d.azDeg;
      scratch[o + 2] = d.elDeg;
      scratch[o + 3] = d.rangeKm;
      scratch[o + 4] = d.rangeRateKmS;
      scratch[o + 5] = d.flags;
      n += 1;
    }
    return {
      ...empty,
      records: scratch.slice(0, n * RECORD_FIELDS),
      count: n,
      sunAltDeg,
      dark,
      computed,
      culled,
      dropped,
      failed,
      durationMs: now() - started,
    };
  }

  /** Per-object metadata for the main thread (index order). */
  function meta() {
    return entries.map((e) => ({
      index: e.index,
      noradId: e.noradId,
      name: e.name,
      objectId: e.objectId,
      group: e.group,
      set: e.set,
      klass: e.klass,
      epochMs: e.epochMs,
    }));
  }

  /** Element-age summary for the banner (SKYVIEW.md 4.5). */
  function ageSummary(timeMs, sets = SKY_SETS) {
    const want = new Set(sets);
    let newest = -Infinity;
    let total = 0;
    let stale = 0;
    let dropped = 0;
    for (const e of entries) {
      if (!want.has(e.set)) continue;
      total += 1;
      if (e.epochMs > newest) newest = e.epochMs;
      const age = elementAge(e.epochMs, timeMs);
      if (age === 'stale') stale += 1;
      else if (age === 'drop') dropped += 1;
    }
    return {
      total,
      stale,
      dropped,
      newestEpochMs: Number.isFinite(newest) ? newest : null,
    };
  }

  return {
    get size() {
      return entries.length;
    },
    get version() {
      return version;
    },
    get observer() {
      return observer;
    },
    entries,
    entry: (index) => entries[index],
    byNorad: (id) => byNorad.get(Number(id)),
    loadGroup,
    setObserver,
    tick,
    meta,
    ageSummary,
    resetCull: () => resetCull(),
  };
}
