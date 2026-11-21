/**
 * Voice adapter for the Drone Flight Plan panel.
 *
 * The rail already draws, plans and downloads. This module does not add a
 * control and does not change the panel. It calls the handle methods the
 * buttons already call, and it never puts caller text into an error.
 */
import {
  MIN_AGL_M,
  AGL_CAP_M,
  MAX_ORBIT_TARGETS,
  MAX_WAYPOINTS_PER_MISSION,
  MIN_WAYPOINTS_PER_MISSION,
  PATTERNS,
  PHOTO_MODES,
  cleanMinPhotoIntervalS,
  cleanTimedIntervalS,
} from './planner.js';
import { hasLabel } from './missionLabel.js';
import { MPH_PER_MS } from './timing.js';
import { getPreset, kmzStatus, listPresets } from './presets.js';
import { MODES, modeFor } from './recommend.js';
import { MIN_PLAN_SPEED_MS, SHUTTER_DENOMINATORS } from './speed.js';
import { listCameraPresets, isCameraPresetId } from './cameraSettings.js';
import {
  MAX_OUTWARD_PITCH_DEG,
  MAX_RING_ANGLE_DEG,
  MAX_RING_ANGLES,
  MIN_OUTWARD_PITCH_DEG,
  MIN_RING_ANGLE_DEG,
} from './orbitRings.js';
import {
  MAX_ZONE_HALF_WIDTH_M,
  MIN_ZONE_HALF_WIDTH_M,
} from './checkGeometry.js';
import { FOOTPRINT_MODES, FRUSTUM_MODES } from './checkLayer.js';
import { CLEARANCE_MAX_M } from './prefs.js';

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
  'edit',
  'obstacle',
  'target',
  'path',
  'preview',
  'library',
  'loadPlan',
  'photoCheck',
  'check',
  'units',
  'finish',
  'undo',
  'corner',
]);

const UNAVAILABLE = 'Drone Flight Plan is not available right now';
/** A .gevplan the reader refused: the document, not the panel, is the fault. */
const INVALID_PLAN = 'That is not a valid Drone Flight Plan document';
/** A two-setter request that could not be undone half-way: never claimed. */
const NOT_TOGETHER =
  'The check and surface settings could not be changed together';
const OUT_OF_RANGE = 'That option is outside the panel range';
const SPEED_MAX_MS = 15;
const ORBIT_RADIUS_MIN_M = 10;
const ORBIT_RADIUS_MAX_M = 300;
const ORBIT_HEIGHT_MAX_COUNT = 6;
/** The panel's shot triggers, flight directions and 3D-check choices. */
const CAPTURE_MODES = ['stop', 'distance', 'timed'];
const DIRECTIONS = ['auto', 'ew', 'ns'];
const RING_MODES = ['angles', 'heights'];
const ORBIT_TARGET_HEIGHT_MAX_M = 60;
const OBSTACLE_HEIGHT_MAX_M = 60;
const SURFACE_STATUS = ['idle', 'loading', 'ready', 'none', 'signin', 'error'];
/** Options that never change the plan: the export file, or a file label. */
const PLAN_FREE_OPTIONS = new Set([
  'exportCompact',
  'droneEnumValue',
  'clearDroneCode',
]);
const JOBS = ['per-area', 'whole'];
const ORBIT_TARGET_ID = /^(?:target|rec)-\d{1,3}$/;
const PATH_ID = /^path-\d{1,3}$/;
const OBSTACLE_ID = /^[A-Za-z0-9._:-]{1,60}$/;

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
  const exact = presets.filter((preset) => {
    const id = fold(preset.id);
    const name = fold(preset.name);
    const bare = (folded) =>
      folded.startsWith('dji') ? folded.slice(3) : folded;
    return id === key || name === key || bare(id) === key || bare(name) === key;
  });
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

/** A finite number, or null: the read-back never repeats NaN or a string. */
function numOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A list of finite numbers inside the bounds, or null (never a partial list). */
function numList(value, min, max, limit) {
  if (!Array.isArray(value) || value.length > limit) return null;
  const out = [];
  for (const item of value) {
    if (!finite(item, min, max)) return null;
    out.push(item);
  }
  return out;
}

function intOrNull(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
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

  /** The 3D check switches, as the panel keeps them (state.check). */
  function checkState() {
    const check = handle.getState().check ?? {};
    // The index the check is really showing, not the one last asked for: the
    // check layer steps over the photos that exist and clamps anything
    // higher, so the panel's own answer (checkInfo) is what is reported.
    const shown = intOrNull(
      handle.checkInfo?.()?.index,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    return {
      enabled: check.enabled === true,
      zone: check.zone === true,
      curtain: check.curtain === true,
      footprints: FOOTPRINT_MODES.includes(check.footprints)
        ? check.footprints
        : 'selected',
      frustum: FRUSTUM_MODES.includes(check.frustum) ? check.frustum : 'one',
      index: shown ?? intOrNull(check.index, 0, Number.MAX_SAFE_INTEGER) ?? 0,
      halfWidthM: finite(
        check.halfWidthM,
        MIN_ZONE_HALF_WIDTH_M,
        MAX_ZONE_HALF_WIDTH_M,
      )
        ? check.halfWidthM
        : null,
    };
  }

  /**
   * Put the check switches back after the other half of a two-setter request
   * was refused, and say whether they really are back. Only the keys this
   * request changed, and only those the panel held a value for, can be
   * restored: the setters cannot unset a key, so a switch the panel never had
   * stays as the setter left it, and the caller must not claim the request
   * changed nothing.
   */
  function restoreCheck(patch, before) {
    if (!before) return true;
    const back = {};
    for (const key of Object.keys(patch)) {
      if (Object.hasOwn(before, key)) back[key] = before[key];
    }
    if (!Object.keys(back).length) return false;
    try {
      if (handle.setCheck(back) !== true) return false;
    } catch {
      return false;
    }
    // Read back rather than trust the setter: a panel that accepted the
    // restore but clamped it has not put the switches where they were.
    const after = handle.getState().check ?? {};
    return Object.keys(back).every((key) => after[key] === back[key]);
  }

  /** The photogrammetry surface used as an obstacle surface (warn only). */
  function surfaceState() {
    const surface = handle.getState().surface ?? {};
    return {
      enabled: surface.enabled === true,
      status: SURFACE_STATUS.includes(surface.status) ? surface.status : null,
      minM: finite(surface.minM, 0, CLEARANCE_MAX_M) ? surface.minM : null,
      marginM: finite(surface.marginM, 0, CLEARANCE_MAX_M)
        ? surface.marginM
        : null,
      points: Array.isArray(surface.ids) ? surface.ids.length : 0,
    };
  }

  function summary() {
    const state = handle.getState();
    const options = state.options ?? {};
    const preset = getPreset(options.presetId);
    const result = state.result;
    const kmz = kmzStatus(preset, state.wpml?.droneEnumValue ?? null);
    // Read back only what the panel's own controls could have written: a
    // stored string is passed through none of these fields.
    const speedMs = finite(options.speedMs, MIN_PLAN_SPEED_MS, SPEED_MAX_MS)
      ? options.speedMs
      : null;
    return {
      ok: true,
      open: handle.isOpen?.() === true,
      aircraft: preset?.name ?? null,
      presetId: preset?.id ?? null,
      mode: modeFor(options),
      pattern: PATTERNS.includes(options.pattern) ? options.pattern : null,
      aglM: finite(options.aglM, MIN_AGL_M, AGL_CAP_M) ? options.aglM : null,
      frontOverlap: finite(options.frontOverlap, 50, 98)
        ? options.frontOverlap
        : null,
      sideOverlap: finite(options.sideOverlap, 40, 95)
        ? options.sideOverlap
        : null,
      speedMs,
      // The same speed in miles per hour, one decimal: the unit a pilot reads.
      speedMph:
        speedMs == null ? null : Math.round(speedMs * MPH_PER_MS * 10) / 10,
      // The trigger and, for Timed shot, the interval (seconds) the person
      // will set in DJI Fly. Null: none chosen. Not the camera minimum.
      captureMode: ['distance', 'timed'].includes(options.captureMode)
        ? options.captureMode
        : 'stop',
      timedIntervalS: cleanTimedIntervalS(options.timedIntervalS),
      photoMode: PHOTO_MODES.includes(options.photoMode)
        ? options.photoMode
        : null,
      jobs: JOBS.includes(state.jobGrouping) ? state.jobGrouping : null,
      // The settable fields the panel shows but status used to leave out, in
      // the panel's own units. Each is validated, never echoed as given.
      direction: DIRECTIONS.includes(options.direction)
        ? options.direction
        : null,
      tiltPitchDeg: numOrNull(options.tiltPitchDeg),
      orbitRadiusM: numOrNull(options.orbitRadiusM),
      orbitHeightsM: numList(
        options.orbitHeightsM,
        MIN_AGL_M,
        AGL_CAP_M,
        ORBIT_HEIGHT_MAX_COUNT,
      ),
      shutterDenominator: SHUTTER_DENOMINATORS.includes(
        options.shutterDenominator,
      )
        ? options.shutterDenominator
        : null,
      batteryMin: intOrNull(options.batteryMin, 5, 60),
      droneEnumValue: intOrNull(state.wpml?.droneEnumValue, 0, 999),
      photoSpacingM: numOrNull(options.photoSpacingM),
      continuousRoute: options.continuousRoute === true,
      maxWaypoints:
        intOrNull(
          options.maxWaypoints,
          MIN_WAYPOINTS_PER_MISSION,
          MAX_WAYPOINTS_PER_MISSION,
        ) ?? MAX_WAYPOINTS_PER_MISSION,
      usableBatteryMin: intOrNull(options.usableBatteryMin, 5, 60),
      obstacleHeightM: numOrNull(options.obstacleHeightM),
      orbitTargetHeightM: numOrNull(options.orbitTargetHeightM),
      orbitRingMode: RING_MODES.includes(options.orbitRingMode)
        ? options.orbitRingMode
        : null,
      orbitAnglesDeg: numList(
        options.orbitAnglesDeg,
        MIN_RING_ANGLE_DEG,
        MAX_RING_ANGLE_DEG,
        MAX_RING_ANGLES,
      ),
      orbitOutward: options.orbitOutward === true,
      orbitOutwardPitchDeg: numOrNull(options.orbitOutwardPitchDeg),
      cameraPresetId: listCameraPresets().some(
        (preset) => preset.id === options.cameraPresetId,
      )
        ? options.cameraPresetId
        : null,
      minPhotoIntervalS: cleanMinPhotoIntervalS(options.minPhotoIntervalS),
      exportCompact: state.exportCompact === true,
      // The orbit targets and look-at paths as ids and points, never labels:
      // a label is localized text this module does not vouch for.
      orbitTargets: (options.orbitTargets ?? [])
        .filter(
          (target) =>
            ORBIT_TARGET_ID.test(target?.id) &&
            finite(target.lat, -90, 90) &&
            finite(target.lon, -180, 180),
        )
        .map((target) => ({
          id: target.id,
          lat: round5(target.lat),
          lon: round5(target.lon),
          active: target.active !== false,
        })),
      lookAtPaths: (options.lookAtPaths ?? [])
        .filter((path) => PATH_ID.test(path?.id))
        .map((path) => ({
          id: path.id,
          points: Array.isArray(path.points) ? path.points.length : 0,
          active: path.active !== false,
        })),
      obstacles: (handle.obstacles?.list?.() ?? [])
        .filter((item) => OBSTACLE_ID.test(item?.id))
        .map((item) => ({
          id: item.id,
          kind: ['tree', 'tower', 'building', 'other'].includes(item.kind)
            ? item.kind
            : 'other',
          heightM: numOrNull(item.heightM),
        })),
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
      // The 3D check and the photogrammetry surface model: read-only here,
      // both reachable through the check action and the panel's own controls.
      check: checkState(),
      surface: surfaceState(),
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
        // The panel's drawing tool and addPolygon() have no corner ceiling;
        // only the three-corner floor is real (polygon.js).
        if (!Array.isArray(ring) || ring.length < 3)
          return fail('ring needs at least 3 points');
        const points = [];
        for (const point of ring) {
          if (!finite(point?.lon, -180, 180) || !finite(point?.lat, -90, 90))
            return fail('ring needs at least 3 points');
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
          return fail(`mode must be ${MODES.join(', ')}`);
        ensureOpen();
        handle.useRecommended(mode ?? undefined, { planNow: true });
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
        // The compact export and the drone code are not plan inputs: the
        // panel only writes them down, so a new plan would be wasted work and
        // its numbers claimed as a change nobody asked for.
        const needsPlan = Object.keys(next.patch).some(
          (key) => !PLAN_FREE_OPTIONS.has(key),
        );
        if (handle.applyOptions(next.patch, { planNow: needsPlan }) !== true) {
          // The only change the panel can refuse after readOptions accepted
          // it is a camera preset its own list does not hold (a panel built
          // from a different catalog). "No aircraft matched" was a guess.
          return fail(
            Object.hasOwn(next.patch, 'cameraPresetId')
              ? 'That camera preset is not available in this panel'
              : 'The panel did not accept those options',
          );
        }
        if (needsPlan) await handle.replan();
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
        const planned = handle.getState();
        if (planned.error)
          return fail('The plan has an error; fix it in the panel first');
        if (!planned.result) return fail('Plan the area first');
        if (typeof handle.planSuite !== 'function') return fail(UNAVAILABLE);
        await handle.planSuite();
        // A suite that did not arrive was not planned: the panel refuses one
        // while it is busy or out of date, and never claims the passes.
        if (!handle.getState().suite) return fail('Could not plan all passes');
        return summary();
      });
    },
    async download(args = {}) {
      return guard(async () => {
        const which = args.which;
        if (which !== 'mission' && which !== 'all' && which !== 'suite')
          return fail('which must be mission, all, or suite');
        // The panel may answer true now, or a promise of true while it
        // compresses a compact file or waits for a labelled picture. Awaiting
        // it is what makes "downloaded" honest: the old synchronous check
        // refused a file that was still being written.
        if (which === 'suite') {
          if (typeof handle.downloadSuite !== 'function')
            return fail(UNAVAILABLE);
          if (handle.suiteAllowed?.() !== true)
            return fail('Downloads are not available yet');
          if ((await handle.downloadSuite()) !== true)
            return fail('The file could not be saved');
          return { ok: true, downloaded: true, which };
        }
        if (which === 'all') {
          if (typeof handle.downloadAll !== 'function')
            return fail(UNAVAILABLE);
          if (handle.downloadsAllowed?.() !== true)
            return fail('Downloads are not available yet');
          if ((await handle.downloadAll()) !== true)
            return fail('The file could not be saved');
          return { ok: true, downloaded: true, which };
        }
        const missions = handle.getResult?.()?.missions ?? [];
        const index = args.index == null ? 0 : args.index;
        if (typeof handle.downloadMission !== 'function')
          return fail(UNAVAILABLE);
        if (handle.downloadsAllowed?.() !== true)
          return fail('Downloads are not available yet');
        if (!integerIn(index, 0, missions.length - 1))
          return fail('No mission at that index');
        if ((await handle.downloadMission(index)) !== true)
          return fail('The file could not be saved');
        return { ok: true, downloaded: true, which, index };
      });
    },
    /**
     * Start editing a committed area's corners. The area is named by id or by
     * its position in the list the panel shows; nothing is echoed back.
     */
    async edit(args = {}) {
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
        if (!id) return fail('No area matched.');
        if (typeof handle.editArea !== 'function') return fail(UNAVAILABLE);
        ensureOpen();
        // toggle: false — a second request must not close the editor.
        const started = handle.editArea(id, { toggle: false }) === true;
        if (!started) {
          // The panel refuses while a draw is running, or when another tool
          // holds the pointer: say which, from the panel's own tools.
          const tools = handle.drafts?.() ?? {};
          if (tools.box === true || tools.polygon === true)
            return fail('Finish drawing first');
          return fail('Another tool is using the pointer. Close it first');
        }
        return { ok: true, editing: true, areaCount: areas.length };
      });
    },
    /**
     * Obstacles. A lat/lon adds one at the panel's tree height (or at the
     * height given); a height with an index changes one; an index alone
     * removes one; nothing re-reads the heights from the open-data service
     * and answers before that read has finished.
     */
    async obstacle(args = {}) {
      return guard(async () => {
        const store = handle.obstacles;
        if (!store) return fail(UNAVAILABLE);
        const idAt = (index) => {
          const list = store.list?.() ?? [];
          if (!integerIn(index, 0, list.length - 1)) return null;
          const item = list[index];
          return OBSTACLE_ID.test(item?.id) ? item.id : null;
        };
        if (args.lat != null || args.lon != null) {
          if (!finite(args.lat, -90, 90) || !finite(args.lon, -180, 180))
            return fail('point needs lat and lon');
          // A height that is given and out of range is refused, never
          // swapped for the panel's default: 100 m is not a 15 m tree.
          if (
            args.obstacleHeightM != null &&
            !finite(args.obstacleHeightM, 0, OBSTACLE_HEIGHT_MAX_M)
          )
            return fail(OUT_OF_RANGE);
          ensureOpen();
          const made = handle.obstacles.add(
            args.obstacleHeightM == null
              ? { lat: args.lat, lon: args.lon }
              : {
                  lat: args.lat,
                  lon: args.lon,
                  heightM: args.obstacleHeightM,
                },
          );
          if (!made) return fail('That obstacle cannot be added here');
          return {
            ok: true,
            added: true,
            obstacleCount: store.list?.().length ?? 0,
          };
        }
        if (args.index != null) {
          const id = idAt(args.index);
          if (!id) return fail('No obstacle at that index');
          if (args.obstacleHeightM != null) {
            if (!finite(args.obstacleHeightM, 0, OBSTACLE_HEIGHT_MAX_M))
              return fail(OUT_OF_RANGE);
            if (store.setHeight(id, args.obstacleHeightM) === false)
              return fail('No obstacle at that index');
            return {
              ok: true,
              changed: true,
              heightM: args.obstacleHeightM,
              obstacleCount: store.list?.().length ?? 0,
            };
          }
          if (store.remove(id) === false)
            return fail('No obstacle at that index');
          return {
            ok: true,
            removed: true,
            obstacleCount: store.list?.().length ?? 0,
          };
        }
        ensureOpen();
        // The look-up is asynchronous: wait for its rows before counting, or
        // the answer is the list from before the request. `false` (or null
        // from an older panel) means nothing was looked up, and is not
        // reported as a refresh that happened.
        const looked = await store.refresh?.();
        const refreshed = looked === true;
        return {
          ok: true,
          refreshed,
          obstacleCount: store.list?.().length ?? 0,
        };
      });
    },
    /**
     * Orbit targets. A lat/lon adds one inside the survey area; an index
     * removes one. With nothing named, the list is rebuilt only when nobody
     * has edited it: the panel's rebuild drops hand-placed and hand-changed
     * targets, so a spoken request never spends that work.
     */
    async target(args = {}) {
      return guard(() => {
        const list = () => handle.getState().options?.orbitTargets ?? [];
        const idAt = (index) => {
          const items = list();
          if (!integerIn(index, 0, items.length - 1)) return null;
          const target = items[index];
          return ORBIT_TARGET_ID.test(target?.id) ? target.id : null;
        };
        if (args.lat != null || args.lon != null) {
          if (!finite(args.lat, -90, 90) || !finite(args.lon, -180, 180))
            return fail('point needs lat and lon');
          ensureOpen();
          if (typeof handle.addOrbitTarget !== 'function')
            return fail(UNAVAILABLE);
          // The panel refuses a point for three different reasons; name the
          // real one instead of blaming the point every time.
          if (!(handle.getState().areas ?? []).length)
            return fail('Draw an area first');
          if (list().length >= MAX_ORBIT_TARGETS)
            return fail(`At most ${MAX_ORBIT_TARGETS} orbit targets`);
          if (handle.addOrbitTarget({ lat: args.lat, lon: args.lon }) !== true)
            return fail('That point is not inside the survey area');
          return { ok: true, added: true, targetCount: list().length };
        }
        if (args.index != null) {
          const id = idAt(args.index);
          if (!id) return fail('No target at that index');
          if (handle.removeOrbitTarget?.(id) !== true)
            return fail('No target at that index');
          return { ok: true, removed: true, targetCount: list().length };
        }
        ensureOpen();
        if (typeof handle.recommendTargets !== 'function')
          return fail(UNAVAILABLE);
        const state = handle.getState();
        const items = list();
        const handMade =
          state.orbitTargetsTouched === true ||
          items.some((target) => target?.source === 'custom');
        if (handMade)
          return fail(
            'Orbit targets were added or changed by hand; nothing was rebuilt',
          );
        const count = handle.recommendTargets();
        return {
          ok: true,
          recommended: true,
          targetCount: Number.isFinite(count) ? count : list().length,
        };
      });
    },
    /**
     * Look-at paths. `ring` adds a path through its points; an index removes
     * one; nothing starts or stops drawing a path on the globe.
     */
    async path(args = {}) {
      return guard(() => {
        const paths = () => handle.getState().options?.lookAtPaths ?? [];
        if (args.ring != null) {
          if (!Array.isArray(args.ring) || args.ring.length < 2)
            return fail('A path needs at least two points');
          const points = [];
          for (const point of args.ring) {
            if (!finite(point?.lon, -180, 180) || !finite(point?.lat, -90, 90))
              return fail('A path needs at least two points');
            points.push({ lon: point.lon, lat: point.lat });
          }
          ensureOpen();
          if (handle.addLookAtPath?.(points) !== true)
            return fail('That path cannot be added');
          return { ok: true, added: true, pathCount: paths().length };
        }
        if (args.index != null) {
          const items = paths();
          if (!integerIn(args.index, 0, items.length - 1))
            return fail('No path at that index');
          const id = PATH_ID.test(items[args.index]?.id)
            ? items[args.index].id
            : null;
          if (!id) return fail('No path at that index');
          if (handle.removeLookAtPath?.(id) !== true)
            return fail('No path at that index');
          return { ok: true, removed: true, pathCount: paths().length };
        }
        ensureOpen();
        // The panel button toggles: a second press finishes the path. Voice
        // only starts one, and never finishes a draft the person is placing
        // (that would commit corners nobody confirmed).
        if (typeof handle.startDrawPath !== 'function')
          return fail(UNAVAILABLE);
        return {
          ok: true,
          drawing: handle.startDrawPath({ toggle: false }) === true,
        };
      });
    },
    /** The picture of one flight of the current plan (index, default 0). */
    async preview(args = {}) {
      return guard(async () => {
        // The same gate as download: with no finished plan (or a plan the
        // panel will not export) there is no picture to draw, whichever
        // flight was named.
        if (handle.downloadsAllowed?.() !== true)
          return fail('Downloads are not available yet');
        const missions = handle.getResult?.()?.missions ?? [];
        const index = args.index == null ? 0 : args.index;
        if (!integerIn(index, 0, missions.length - 1))
          return fail('No mission at that index');
        // A flight picture is named by the plan's M number, so the panel
        // refuses one for a plan that is not saved in the library. That is a
        // different refusal from "not available yet", and is named as such.
        const label = handle.library?.()?.currentLabel?.() ?? null;
        if (!hasLabel(label))
          return fail(
            'Save the plan in the plan library first, so each flight has its M number',
          );
        if (typeof handle.downloadPreview !== 'function')
          return fail(UNAVAILABLE);
        const made = await handle.downloadPreview(index);
        if (made !== true)
          return fail('The picture could not be drawn in this browser');
        return { ok: true, downloaded: true, which: 'preview', index };
      });
    },
    /**
     * The plan library as it stands. Read-only: saving, renaming and deleting
     * need a person's file dialog, and plan names are the person's own text,
     * so only counts and the mission number are reported.
     */
    async library() {
      return guard(() => {
        const panel = handle.library?.();
        if (!panel || !panel.state)
          return fail('The plan library is not available');
        const state = panel.state;
        const label = panel.currentLabel?.() ?? null;
        return {
          ok: true,
          scope: ['mine', 'shared', 'all'].includes(state.scope)
            ? state.scope
            : null,
          trash: state.trash === true,
          planCount: Array.isArray(state.plans) ? state.plans.length : 0,
          currentPlanNo: intOrNull(label?.no, 0, 1e6),
          readOnly: state.current?.readOnly === true,
          busy: state.busy === true,
        };
      });
    },
    /** Open a saved plan document the caller already validated. */
    async loadPlan(args = {}) {
      return guard(async () => {
        if (!args.plan || typeof args.plan !== 'object')
          return fail('loadPlan needs a plan document');
        if (typeof handle.loadPlan !== 'function')
          return fail('The plan library is not available');
        let loaded;
        try {
          loaded = await handle.loadPlan(args.plan);
        } catch (error) {
          // readPlan refused the document (the panel marks its own rejection):
          // that is a bad file, not a panel that is down, and the reader's
          // reason is not repeated.
          if (error?.gevPlanRejected === true) return fail(INVALID_PLAN);
          throw error;
        }
        if (loaded !== true) return fail(INVALID_PLAN);
        return summary();
      });
    },
    /** The photo check: how many shots the chosen photos cover, and gaps. */
    async photoCheck() {
      return guard(() => {
        const panel = handle.photoCheck?.();
        if (!panel) return fail('Photo check is not available');
        const analysis = panel.analysis?.() ?? null;
        const s = analysis?.summary ?? null;
        return {
          ok: true,
          checked: s != null,
          photoCount: intOrNull(s?.photoCount, 0, 1e5),
          plannedCount: intOrNull(s?.plannedCount, 0, 1e5),
          coveredCount: intOrNull(s?.coveredCount, 0, 1e5),
          missingCount: intOrNull(s?.missingCount, 0, 1e5),
          offPlanCount: intOrNull(s?.offPlanCount, 0, 1e5),
          gapCount: intOrNull(s?.gapCount, 0, 1e5),
          breakCount: intOrNull(s?.breakCount, 0, 1e5),
        };
      });
    },
    /**
     * The 3D check and the surface model. `index` picks the flight whose
     * photos are shown; the check switches and the surface settings are the
     * panel's own controls (state.check, state.surface), set through the
     * handle the checkboxes, the select and the sliders call. With no
     * setting given the answer is the panel's state.
     */
    async check(args = {}) {
      return guard(() => {
        const checkPatch = {};
        const surfacePatch = {};
        if (args.index != null) {
          if (!Number.isInteger(args.index) || args.index < 0)
            return fail('index must be zero or more');
          // The panel steps over the photos that exist; the check layer would
          // clamp a higher index and the read-back would name a flight that
          // is not on show, so it is refused here.
          const count = intOrNull(
            handle.checkInfo?.()?.count,
            0,
            Number.MAX_SAFE_INTEGER,
          );
          if (count != null && args.index > Math.max(0, count - 1))
            return fail('That flight index cannot be shown');
          checkPatch.index = args.index;
        }
        for (const [key, name] of [
          ['checkEnabled', 'enabled'],
          ['checkZone', 'zone'],
          ['checkCurtain', 'curtain'],
        ]) {
          if (args[key] == null) continue;
          if (typeof args[key] !== 'boolean') return fail(OUT_OF_RANGE);
          checkPatch[name] = args[key];
        }
        if (args.checkFootprints != null) {
          if (!FOOTPRINT_MODES.includes(args.checkFootprints))
            return fail(OUT_OF_RANGE);
          checkPatch.footprints = args.checkFootprints;
        }
        if (args.checkFrustum != null) {
          if (!FRUSTUM_MODES.includes(args.checkFrustum))
            return fail(OUT_OF_RANGE);
          checkPatch.frustum = args.checkFrustum;
        }
        if (args.zoneHalfWidthM != null) {
          if (
            !finite(
              args.zoneHalfWidthM,
              MIN_ZONE_HALF_WIDTH_M,
              MAX_ZONE_HALF_WIDTH_M,
            )
          )
            return fail(OUT_OF_RANGE);
          checkPatch.halfWidthM = args.zoneHalfWidthM;
        }
        if (args.surfaceEnabled != null) {
          if (typeof args.surfaceEnabled !== 'boolean')
            return fail(OUT_OF_RANGE);
          surfacePatch.enabled = args.surfaceEnabled;
        }
        for (const [key, name] of [
          ['surfaceMinM', 'minM'],
          ['surfaceMarginM', 'marginM'],
        ]) {
          if (args[key] == null) continue;
          if (!finite(args[key], 0, CLEARANCE_MAX_M)) return fail(OUT_OF_RANGE);
          surfacePatch[name] = args[key];
        }
        const wantsCheck = Object.keys(checkPatch).length > 0;
        const wantsSurface = Object.keys(surfacePatch).length > 0;
        // Both handles are checked before either patch is applied: a panel
        // missing one must not have the other half-applied behind a refusal.
        if (wantsCheck && typeof handle.setCheck !== 'function')
          return fail(UNAVAILABLE);
        if (wantsSurface && typeof handle.setSurface !== 'function')
          return fail(UNAVAILABLE);
        // One request can carry both halves, and the answer must be all or
        // nothing: applying one and then failing the other would leave the
        // panel half-changed behind a refusal. Each setter is atomic on its
        // own, so the order decides which refusal is free. The check goes
        // first: it is the half whose value can still be refused at apply
        // time (the flight index, against the photos that really exist), so
        // its refusal costs nothing. A surface refusal after it is undone by
        // putting the check switches back — the rollback only re-runs the
        // check, never a replan.
        const beforeCheck = wantsCheck
          ? { ...(handle.getState().check ?? {}) }
          : null;
        if (wantsCheck && handle.setCheck(checkPatch) !== true)
          return fail(
            Object.hasOwn(checkPatch, 'index')
              ? 'That flight index cannot be shown'
              : OUT_OF_RANGE,
          );
        if (wantsSurface && handle.setSurface(surfacePatch) !== true) {
          return restoreCheck(checkPatch, beforeCheck)
            ? fail(OUT_OF_RANGE)
            : fail(NOT_TOGETHER);
        }
        return { ok: true, check: checkState(), surface: surfaceState() };
      });
    },
    /** Feet or metres: the unit the panel shows and accepts lengths in. */
    async units(args = {}) {
      return guard(() => {
        const system = args.units;
        if (system !== 'ft' && system !== 'm')
          return fail('units must be ft or m');
        if (typeof handle.chooseUnits !== 'function') return fail(UNAVAILABLE);
        handle.chooseUnits(system);
        return { ok: true, units: system };
      });
    },
    /** Finish the polygon being drawn. */
    async finish() {
      return guard(() => {
        if (typeof handle.finishPolygon !== 'function')
          return fail(UNAVAILABLE);
        const tools = handle.drafts?.() ?? null;
        if (tools) {
          if (tools.polygon !== true) return fail('No polygon is being drawn');
          if (tools.corners < 3)
            return fail('A polygon needs at least three corners');
        }
        const drawn = handle.finishPolygon() === true;
        // False means the panel kept the draft: a short ring, or a shape it
        // could not plan. Never reported as finished.
        if (!drawn) return fail('The polygon could not be added');
        return {
          ok: true,
          finished: true,
          areaCount: handle.getState().areas?.length ?? 0,
        };
      });
    },
    /** Take back the last corner of the polygon being drawn. */
    async undo() {
      return guard(() => {
        if (typeof handle.undoPolygonCorner !== 'function')
          return fail(UNAVAILABLE);
        const tools = handle.drafts?.() ?? null;
        if (tools) {
          if (tools.polygon !== true) return fail('No polygon is being drawn');
          if (tools.corners < 1) return fail('No corner to take back');
        }
        if (handle.undoPolygonCorner() !== true)
          return fail('No corner to take back');
        return { ok: true, undone: true };
      });
    },
    /**
     * Remove the selected corner of a committed area. Only a corner the
     * person has clicked (or that the editor has selected) can be removed:
     * with nothing selected, nothing is removed and the answer says so.
     */
    async corner() {
      return guard(() => {
        if (typeof handle.removePolygonCorner !== 'function')
          return fail(UNAVAILABLE);
        const tools = handle.drafts?.() ?? null;
        if (tools) {
          if (!tools.editAreaId) return fail('Edit an area first');
          if (tools.editKind !== 'polygon')
            return fail('Only a polygon has corners to remove');
          if (tools.selectedCorner == null) return fail('Click a corner first');
          if (tools.canRemoveCorner !== true)
            return fail('A polygon needs at least three corners');
        }
        if (handle.removePolygonCorner() !== true)
          return fail('The corner could not be removed');
        return { ok: true, removed: true };
      });
    },
  };
}

function readOptions(patch = {}) {
  const next = {};
  // intervalTriggerProven is a trusted static setting. Voice cannot copy it.
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
    if (!finite(patch.frontOverlap, 50, 98))
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
  // The same rule as the panel field: any positive number up to the maximum.
  // A null is ignored here (the tool schema takes a number only), so the
  // interval is cleared from the panel, not by voice.
  if (patch.timedIntervalS != null) {
    if (
      typeof patch.timedIntervalS !== 'number' ||
      cleanTimedIntervalS(patch.timedIntervalS) == null
    )
      return { ok: false, error: OUT_OF_RANGE };
    next.timedIntervalS = patch.timedIntervalS;
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
  if (patch.captureMode != null) {
    if (!CAPTURE_MODES.includes(patch.captureMode))
      return { ok: false, error: OUT_OF_RANGE };
    next.captureMode = patch.captureMode;
  }
  // cleanPhotoSpacingM keeps any positive number; zero and below are refused
  // here rather than passed on as a silent reset.
  if (patch.photoSpacingM != null) {
    if (
      typeof patch.photoSpacingM !== 'number' ||
      !Number.isFinite(patch.photoSpacingM) ||
      !(patch.photoSpacingM > 0)
    )
      return { ok: false, error: OUT_OF_RANGE };
    next.photoSpacingM = patch.photoSpacingM;
  }
  if (patch.orbitAnglesDeg != null) {
    if (
      !Array.isArray(patch.orbitAnglesDeg) ||
      patch.orbitAnglesDeg.length < 1 ||
      patch.orbitAnglesDeg.length > MAX_RING_ANGLES ||
      patch.orbitAnglesDeg.some(
        (n) => !finite(n, MIN_RING_ANGLE_DEG, MAX_RING_ANGLE_DEG),
      )
    )
      return { ok: false, error: OUT_OF_RANGE };
    next.orbitAnglesDeg = patch.orbitAnglesDeg.slice();
  }
  if (patch.orbitOutward != null) {
    if (typeof patch.orbitOutward !== 'boolean')
      return { ok: false, error: OUT_OF_RANGE };
    next.orbitOutward = patch.orbitOutward;
  }
  if (patch.orbitOutwardPitchDeg != null) {
    if (
      !finite(
        patch.orbitOutwardPitchDeg,
        MIN_OUTWARD_PITCH_DEG,
        MAX_OUTWARD_PITCH_DEG,
      )
    )
      return { ok: false, error: OUT_OF_RANGE };
    next.orbitOutwardPitchDeg = patch.orbitOutwardPitchDeg;
  }
  if (patch.orbitTargetHeightM != null) {
    if (!finite(patch.orbitTargetHeightM, 0, ORBIT_TARGET_HEIGHT_MAX_M))
      return { ok: false, error: OUT_OF_RANGE };
    next.orbitTargetHeightM = patch.orbitTargetHeightM;
  }
  if (patch.obstacleHeightM != null) {
    if (!finite(patch.obstacleHeightM, 0, OBSTACLE_HEIGHT_MAX_M))
      return { ok: false, error: OUT_OF_RANGE };
    next.obstacleHeightM = patch.obstacleHeightM;
  }
  if (patch.maxWaypoints != null) {
    if (
      !integerIn(
        patch.maxWaypoints,
        MIN_WAYPOINTS_PER_MISSION,
        MAX_WAYPOINTS_PER_MISSION,
      )
    )
      return { ok: false, error: OUT_OF_RANGE };
    next.maxWaypoints = patch.maxWaypoints;
  }
  if (patch.usableBatteryMin != null) {
    if (!integerIn(patch.usableBatteryMin, 5, 60))
      return { ok: false, error: OUT_OF_RANGE };
    next.usableBatteryMin = patch.usableBatteryMin;
  }
  if (patch.continuousRoute != null) {
    if (typeof patch.continuousRoute !== 'boolean')
      return { ok: false, error: OUT_OF_RANGE };
    next.continuousRoute = patch.continuousRoute;
  }
  // A stored camera preset id only: the list the panel's select is built from.
  if (patch.cameraPresetId != null) {
    if (!isCameraPresetId(patch.cameraPresetId))
      return { ok: false, error: OUT_OF_RANGE };
    next.cameraPresetId = patch.cameraPresetId;
  }
  // The camera's minimum interval, the same 0.1-60 s window as the field.
  if (patch.minPhotoIntervalS != null) {
    if (cleanMinPhotoIntervalS(patch.minPhotoIntervalS) == null)
      return { ok: false, error: OUT_OF_RANGE };
    next.minPhotoIntervalS = patch.minPhotoIntervalS;
  }
  if (patch.exportCompact != null) {
    if (typeof patch.exportCompact !== 'boolean')
      return { ok: false, error: OUT_OF_RANGE };
    next.exportCompact = patch.exportCompact;
  }
  return { ok: true, patch: next };
}
