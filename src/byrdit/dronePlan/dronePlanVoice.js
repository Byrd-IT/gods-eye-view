/**
 * Voice adapter for the Drone Flight Plan panel.
 *
 * The rail already draws, plans and downloads. This module does not add a
 * control and does not change the panel. It calls the handle methods the
 * buttons already call, and it never puts caller text into an error.
 */
import { MIN_AGL_M, AGL_CAP_M } from './planner.js';
import { getPreset, kmzStatus, listPresets } from './presets.js';
import { MODES, modeFor } from './recommend.js';
import { MIN_PLAN_SPEED_MS, SHUTTER_DENOMINATORS } from './speed.js';

export const DRONEPLAN_VOICE_ACTIONS = Object.freeze([
  'open',
  'close',
  'status',
  'draw',
  'box',
  'polygon',
  'recommend',
  'options',
  'takeoff',
  'remove',
  'replan',
  'suite',
  'download',
]);

const UNAVAILABLE = 'Drone Flight Plan is not available right now';
const OUT_OF_RANGE = 'That option is outside the panel range';
const SPEED_MAX_MS = 15;
const ORBIT_RADIUS_MIN_M = 10;
const ORBIT_RADIUS_MAX_M = 300;
const ORBIT_HEIGHT_MAX_COUNT = 6;

function fold(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function finite(value, min, max) {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}

function integerIn(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function matchAircraft(raw) {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 40) return null;
  const key = fold(raw);
  // A one- or two-character fold would match several aircraft. Refuse it
  // instead of guessing, and never echo the caller's string.
  if (!key || key.length < 3) return null;
  const presets = listPresets();
  const exact = presets.filter(
    (preset) => fold(preset.id) === key || fold(preset.name) === key,
  );
  if (exact.length === 1) return exact[0];
  const partial = presets.filter(
    (preset) =>
      fold(preset.name).includes(key) || fold(preset.id).includes(key),
  );
  return partial.length === 1 ? partial[0] : null;
}

function areaRef(area) {
  const kind = area?.kind === 'polygon' ? 'polygon' : 'rect';
  if (!area || !/^area-\d{1,4}$/.test(area.id)) return { kind };
  return { id: area.id, kind };
}

function codeList(items, read) {
  const out = [];
  for (const item of items ?? []) {
    const code = read(item);
    if (typeof code === 'string' && /^[a-z0-9-]{1,40}$/.test(code))
      out.push(code);
  }
  return out;
}

function round5(value) {
  return Math.round(value * 1e5) / 1e5;
}

/**
 * @param {object|null} handle panel handle from initDronePlan
 */
export function createDronePlanVoice(handle) {
  const ready =
    handle &&
    typeof handle.open === 'function' &&
    typeof handle.getState === 'function';

  function fail(error) {
    return { ok: false, error };
  }

  async function guard(fn) {
    if (!ready) return fail(UNAVAILABLE);
    try {
      return await fn();
    } catch {
      return fail(UNAVAILABLE);
    }
  }

  function summary() {
    const state = handle.getState();
    const options = state.options ?? {};
    const preset = getPreset(options.presetId);
    const result = state.result;
    const kmz = kmzStatus(preset, state.wpml?.droneEnumValue ?? null);
    return {
      ok: true,
      open: handle.isOpen?.() === true,
      aircraft: preset?.name ?? null,
      presetId: preset?.id ?? null,
      mode: modeFor(options),
      pattern: options.pattern ?? null,
      aglM: options.aglM ?? null,
      frontOverlap: options.frontOverlap ?? null,
      sideOverlap: options.sideOverlap ?? null,
      speedMs: options.speedMs ?? null,
      photoMode: options.photoMode ?? null,
      jobs: state.jobGrouping ?? null,
      areaCount: state.areas?.length ?? 0,
      areas: (state.areas ?? []).map(areaRef),
      takeoff: state.takeoff
        ? { lat: round5(state.takeoff.lat), lon: round5(state.takeoff.lon) }
        : null,
      busy: state.busy === true,
      dirty: state.dirty === true,
      plan: result
        ? {
            missionCount: result.totals?.missionCount ?? 0,
            photoCount: result.totals?.photoCount ?? 0,
            durationS: result.totals?.durationS ?? 0,
            terrainComplete: result.terrainComplete === true,
            warningCodes: codeList(result.warnings, (item) => item.code),
          }
        : null,
      planError:
        typeof state.error === 'string' && /^[a-z0-9-]{1,40}$/.test(state.error)
          ? state.error
          : null,
      suite: state.suite
        ? {
            passes: (state.suite.passes ?? []).map((pass) => ({
              id: /^[a-z0-9]{1,20}$/.test(pass.id) ? pass.id : 'pass',
              planned: Boolean(pass.result),
              error:
                typeof pass.error === 'string' &&
                /^[a-z0-9-]{1,40}$/.test(pass.error)
                  ? pass.error
                  : null,
            })),
          }
        : null,
      downloads: handle.downloadsAllowed?.() === true,
      suiteDownloads: handle.suiteAllowed?.() === true,
      kmz: kmz.ok ? 'ok' : kmz.reason,
    };
  }

  function ensureOpen() {
    if (handle.isOpen?.() !== true) handle.open({ draw: false });
  }

  return {
    async open() {
      return guard(() => {
        handle.open({ draw: false });
        return { ok: true, open: handle.isOpen?.() === true };
      });
    },
    async close() {
      return guard(() => {
        handle.close();
        return { ok: true, open: false, cleared: true };
      });
    },
    async status() {
      return guard(() => summary());
    },
    async draw(kind) {
      return guard(() => {
        if (kind !== 'box' && kind !== 'polygon')
          return fail('kind must be box or polygon');
        ensureOpen();
        const started =
          kind === 'polygon'
            ? handle.drawPolygon({ toggle: false })
            : handle.drawBox({ toggle: false });
        return { ok: true, drawing: started === true, kind };
      });
    },
    async box(args = {}) {
      return guard(() => {
        const box = {
          west: args.west,
          south: args.south,
          east: args.east,
          north: args.north,
        };
        if (
          !finite(box.west, -180, 180) ||
          !finite(box.east, -180, 180) ||
          !finite(box.south, -90, 90) ||
          !finite(box.north, -90, 90)
        )
          return fail('box needs west, south, east and north');
        ensureOpen();
        if (handle.setBox(box) !== true)
          return fail('That box cannot be flown');
        return { ok: true, areaCount: handle.getState().areas?.length ?? 0 };
      });
    },
    async polygon(ring) {
      return guard(() => {
        if (!Array.isArray(ring) || ring.length < 3 || ring.length > 64)
          return fail('ring needs 3 to 64 points');
        const points = [];
        for (const point of ring) {
          if (!finite(point?.lon, -180, 180) || !finite(point?.lat, -90, 90))
            return fail('ring needs 3 to 64 points');
          points.push({ lon: point.lon, lat: point.lat });
        }
        ensureOpen();
        if (handle.setPolygon(points) !== true)
          return fail('That polygon cannot be flown');
        return { ok: true, points: points.length };
      });
    },
    async recommend(mode) {
      return guard(async () => {
        if (mode != null && !MODES.includes(mode))
          return fail('mode must be mapping-grid, splat-orbit, or fast-survey');
        ensureOpen();
        if (
          handle.useRecommended(mode ?? undefined, { planNow: true }) !== true
        )
          return fail('mode must be mapping-grid, splat-orbit, or fast-survey');
        await handle.replan();
        return summary();
      });
    },
    async options(patch) {
      return guard(async () => {
        const next = readOptions(patch);
        if (!next.ok) return next;
        if (!Object.keys(next.patch).length)
          return fail('options needs a panel control to set');
        ensureOpen();
        if (handle.applyOptions(next.patch, { planNow: true }) !== true)
          return fail('No aircraft matched.');
        await handle.replan();
        return summary();
      });
    },
    async takeoff(args = {}) {
      return guard(() => {
        const mode = args.takeoff;
        if (mode !== 'pick' && mode !== 'clear' && mode !== 'point')
          return fail('takeoff must be pick, clear, or point');
        ensureOpen();
        if (mode === 'clear') {
          handle.clearTakeoff();
          return { ok: true, takeoff: null };
        }
        if (mode === 'pick') {
          return {
            ok: true,
            picking: handle.startTakeoffPick({ toggle: false }) === true,
          };
        }
        if (!handle.getState().areas?.length) return fail('Draw an area first');
        if (!finite(args.lat, -90, 90) || !finite(args.lon, -180, 180))
          return fail('point needs lat and lon');
        if (handle.setTakeoff({ lat: args.lat, lon: args.lon }) !== true)
          return fail('That takeoff point is too far from the area');
        return {
          ok: true,
          takeoff: { lat: round5(args.lat), lon: round5(args.lon) },
        };
      });
    },
    async remove(args = {}) {
      return guard(() => {
        const areas = handle.getState().areas ?? [];
        let id = null;
        if (
          typeof args.areaId === 'string' &&
          /^area-\d{1,4}$/.test(args.areaId)
        ) {
          id = areas.some((area) => area.id === args.areaId)
            ? args.areaId
            : null;
        } else if (integerIn(args.index, 0, areas.length - 1)) {
          id = areas[args.index].id;
        } else if (
          areas.length === 1 &&
          args.areaId == null &&
          args.index == null
        ) {
          id = areas[0].id;
        }
        if (!id || !/^area-\d{1,4}$/.test(id)) return fail('No area matched.');
        if (handle.removeArea(id) !== true) return fail('No area matched.');
        return {
          ok: true,
          removed: id,
          areaCount: handle.getState().areas?.length ?? 0,
        };
      });
    },
    async replan() {
      return guard(async () => {
        ensureOpen();
        await handle.replan();
        return summary();
      });
    },
    async suite() {
      return guard(async () => {
        const state = handle.getState();
        if (!state.areas?.length) return fail('Draw an area first');
        if (state.busy || state.suiteBusy)
          return fail('A plan is already running');
        ensureOpen();
        if (handle.getState().dirty) await handle.replan();
        await handle.planSuite();
        return summary();
      });
    },
    async download(args = {}) {
      return guard(() => {
        const which = args.which;
        if (which !== 'mission' && which !== 'all' && which !== 'suite')
          return fail('which must be mission, all, or suite');
        if (which === 'suite') {
          if (handle.suiteAllowed?.() !== true)
            return fail('Downloads are not available yet');
          handle.downloadSuite();
          return { ok: true, downloaded: true, which };
        }
        if (handle.downloadsAllowed?.() !== true)
          return fail('Downloads are not available yet');
        if (which === 'all') {
          handle.downloadAll();
          return { ok: true, downloaded: true, which };
        }
        const missions = handle.getResult?.()?.missions ?? [];
        const index = args.index == null ? 0 : args.index;
        if (!integerIn(index, 0, missions.length - 1))
          return fail('No mission at that index');
        handle.downloadMission(index);
        return { ok: true, downloaded: true, which, index };
      });
    },
  };
}

function readOptions(patch = {}) {
  const next = {};
  if (patch.aircraft != null) {
    const preset = matchAircraft(patch.aircraft);
    if (!preset) return { ok: false, error: 'No aircraft matched.' };
    next.presetId = preset.id;
  }
  if (patch.mode != null) {
    if (!MODES.includes(patch.mode)) return { ok: false, error: OUT_OF_RANGE };
    next.mode = patch.mode;
  }
  if (patch.pattern != null) {
    if (!['grid', 'double', 'orbit'].includes(patch.pattern))
      return { ok: false, error: OUT_OF_RANGE };
    next.pattern = patch.pattern;
  }
  if (patch.direction != null) {
    if (!['auto', 'ew', 'ns'].includes(patch.direction))
      return { ok: false, error: OUT_OF_RANGE };
    next.direction = patch.direction;
  }
  if (patch.jobs != null) {
    if (!['per-area', 'whole'].includes(patch.jobs))
      return { ok: false, error: OUT_OF_RANGE };
    next.jobs = patch.jobs;
  }
  if (patch.photoMode != null) {
    if (!['waypoint', 'interval'].includes(patch.photoMode))
      return { ok: false, error: OUT_OF_RANGE };
    next.photoMode = patch.photoMode;
  }
  if (patch.aglM != null) {
    if (!finite(patch.aglM, MIN_AGL_M, AGL_CAP_M))
      return { ok: false, error: OUT_OF_RANGE };
    next.aglM = patch.aglM;
  }
  if (patch.frontOverlap != null) {
    if (!finite(patch.frontOverlap, 50, 95))
      return { ok: false, error: OUT_OF_RANGE };
    next.frontOverlap = patch.frontOverlap;
  }
  if (patch.sideOverlap != null) {
    if (!finite(patch.sideOverlap, 40, 95))
      return { ok: false, error: OUT_OF_RANGE };
    next.sideOverlap = patch.sideOverlap;
  }
  if (patch.tiltPitchDeg != null) {
    if (!finite(patch.tiltPitchDeg, -80, -45))
      return { ok: false, error: OUT_OF_RANGE };
    next.tiltPitchDeg = patch.tiltPitchDeg;
  }
  if (patch.orbitRadiusM != null) {
    if (!finite(patch.orbitRadiusM, ORBIT_RADIUS_MIN_M, ORBIT_RADIUS_MAX_M))
      return { ok: false, error: OUT_OF_RANGE };
    next.orbitRadiusM = patch.orbitRadiusM;
  }
  if (patch.orbitHeightsM != null) {
    if (
      !Array.isArray(patch.orbitHeightsM) ||
      patch.orbitHeightsM.length < 1 ||
      patch.orbitHeightsM.length > ORBIT_HEIGHT_MAX_COUNT ||
      patch.orbitHeightsM.some((n) => !finite(n, MIN_AGL_M, AGL_CAP_M))
    )
      return { ok: false, error: OUT_OF_RANGE };
    next.orbitHeightsM = patch.orbitHeightsM.slice();
  }
  if (patch.speedMs != null) {
    if (!finite(patch.speedMs, MIN_PLAN_SPEED_MS, SPEED_MAX_MS))
      return { ok: false, error: OUT_OF_RANGE };
    next.speedMs = patch.speedMs;
  }
  if (patch.shutterDenominator != null) {
    if (!SHUTTER_DENOMINATORS.includes(patch.shutterDenominator))
      return { ok: false, error: OUT_OF_RANGE };
    next.shutterDenominator = patch.shutterDenominator;
  }
  if (patch.batteryMin != null) {
    if (!integerIn(patch.batteryMin, 5, 60))
      return { ok: false, error: OUT_OF_RANGE };
    next.batteryMin = patch.batteryMin;
  }
  if (patch.clearDroneCode === true) next.clearDroneCode = true;
  if (patch.droneEnumValue != null) {
    if (!integerIn(patch.droneEnumValue, 0, 999))
      return { ok: false, error: OUT_OF_RANGE };
    next.droneEnumValue = patch.droneEnumValue;
  }
  return { ok: true, patch: next };
}
