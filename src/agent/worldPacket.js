import { findCamera } from '../render/rendererOf.js';
import {
  feedProvenanceEnvelope,
  layerSnapshot,
  layerSnapshots,
} from '../data/layerSnapshot.js';
import { contextModeWord } from '../contextModePolicy.js';
import { getPreset } from '../byrdit/dronePlan/presets.js';

export const TRACKABLE_FAMILIES = Object.freeze([
  { layerId: 'flights', kind: 'aircraft' },
  { layerId: 'military', kind: 'aircraft' },
  { layerId: 'ais-live-vessels', kind: 'vessel' },
  { layerId: 'satellites', kind: 'satellite' },
]);

const CONTEXT_MODE_RESULT_FIELDS = Object.freeze([
  { field: 'mode', emptyAs: 'off' },
  { field: 'entering', emptyAs: null },
  { field: 'priorMode', emptyAs: null },
]);

const NESTED_CONTEXT_RESULT_FIELDS = Object.freeze([
  'context',
  'contextRollback',
]);

/**
 * Translate context-mode payloads into the public tool vocabulary while
 * retaining the internal id beside each translated field.
 */
export function withContextModeVocabulary(state) {
  if (!state || typeof state !== 'object') return state;
  let out = state;
  const mutable = () => {
    if (out === state) out = { ...state };
    return out;
  };
  for (const { field, emptyAs } of CONTEXT_MODE_RESULT_FIELDS) {
    if (!(field in state)) continue;
    const internal = state[field] ?? null;
    const target = mutable();
    target[field] = contextModeWord(internal, { emptyAs });
    target[`${field}Internal`] = internal;
  }
  for (const field of NESTED_CONTEXT_RESULT_FIELDS) {
    const nested = state[field];
    if (!nested || typeof nested !== 'object') continue;
    const translated = withContextModeVocabulary(nested);
    if (translated !== nested) mutable()[field] = translated;
  }
  return out;
}

/** Read tracked entities from their canonical layer owners. */
export function collectTrackedEntities(dataManager) {
  const tracked = [];
  for (const family of TRACKABLE_FAMILIES) {
    const module = dataManager?.layers?.get(family.layerId)?.module;
    if (!module) continue;
    try {
      const info =
        family.kind === 'vessel'
          ? module.getSelectedInfo?.()
          : module.getTrackedInfo?.();
      if (info)
        tracked.push({
          kind: family.kind,
          layerId: family.layerId,
          ...info,
        });
    } catch {
      // A not-yet-ready layer contributes no tracked observation.
    }
  }
  return tracked;
}

/** Read the active Contacts window from its owning awareness layer. */
export function activeContactsWindow(dataManager) {
  try {
    const layer = dataManager?.layers?.get('military-awareness')?.module;
    return (
      layer?.contactsWindowFromSnapshot?.(layer.getContextSnapshot?.()) ?? null
    );
  } catch {
    return null;
  }
}

/**
 * The per-layer opacity the model exposes, as whole percents.
 *
 * The read-back is faithful: every entry the model reports becomes a whole
 * percent, including 100 for a layer sitting at its default. The app's own
 * opacity model (src/byrdit/layerOpacity/opacityModel.js) only stores layers
 * off their 100 % default, so a 100 does not normally reach this function;
 * a host that reports one gets it reported back as 100 rather than dropped.
 *
 * A host without an opacity model, or one whose entries are all non-finite,
 * reports nothing (null) rather than an empty map.
 * @param {object|null} model The app's opacity model, when it has one.
 * @returns {object|null} Layer id → percent, or null when there is no model.
 */
export function readLayerOpacity(model) {
  if (!model || typeof model.get !== 'function') return null;
  try {
    const out = {};
    const ids =
      typeof model.entries === 'function'
        ? model.entries().map(([id]) => id)
        : [];
    for (const id of ids) {
      if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id))
        continue;
      const value = Number(model.get(id));
      if (!Number.isFinite(value)) continue;
      out[id] = Math.round(value * 100);
    }
    return Object.keys(out).length ? out : null;
  } catch {
    // Read-back is optional; never expose an adapter's error to the model.
    return null;
  }
}

/** How many entries a compacted list may carry into the packet. */
const MAX_COMPACT_LIST = 32;

/**
 * Resolve a host handle provider to the handle itself.
 *
 * A provider is a function the application passes so a handle mounted late
 * (or a panel that was never mounted) still answers. A provider that throws,
 * or answers with nothing, contributes no state.
 * @param {object|Function|null} provider The handle, or a function returning it.
 * @returns {object|null} The handle, or null when there is none.
 */
function resolveHandle(provider) {
  if (!provider) return null;
  try {
    const handle = typeof provider === 'function' ? provider() : provider;
    return handle && typeof handle === 'object' ? handle : null;
  } catch {
    return null;
  }
}

/**
 * Read an adapter's status.
 *
 * The adapters answer in their own way: some synchronously, some with a
 * promise. Both are awaited here, so the packet never carries a promise.
 * A status that fails, or an adapter that answers `ok: false` because its
 * handle is gone, contributes nothing: the packet never carries an
 * adapter's error text and never claims a state nobody reported.
 * @param {object|Function|null} provider The adapter, or a function returning it.
 * @returns {Promise<object|null>} The status, or null when there is none.
 */
async function boundedRead(fn) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), 1500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readAdapterStatus(provider) {
  const adapter = resolveHandle(provider);
  if (!adapter || typeof adapter.status !== 'function') return null;
  try {
    const status = await boundedRead(() => adapter.status());
    if (adapter.destroyed || resolveHandle(provider) !== adapter) return null;
    if (!status || typeof status !== 'object') return null;
    return status.ok === false ? null : status;
  } catch {
    return null;
  }
}

/**
 * A finite number the adapter reported, or null. A value that is absent,
 * null or blank never becomes a zero: the packet says "not reported", not
 * "zero".
 * @param {*} value The reported value.
 * @returns {number|null} The number, or null.
 */
function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * A boolean the adapter reported, or null when it reported no such field.
 * @param {object} status The adapter's status.
 * @param {string} key The field to read.
 * @returns {boolean|null} The boolean, or null.
 */
function reportedBoolean(status, key) {
  if (!status || typeof status[key] !== 'boolean') return null;
  return status[key];
}

/** The Sky state the packet carries: what is open, and what it looks at. */
function compactSkyState(status) {
  if (!status) return null;
  const out = {};
  const open = reportedBoolean(status, 'open');
  if (open !== null) out.open = open;
  const lines = reportedBoolean(status, 'lines');
  if (lines !== null) out.lines = lines;
  if (
    ['live', 'fixed', 'play', 'history', 'history-play'].includes(
      status.timeMode,
    )
  )
    out.timeMode = status.timeMode;
  if (
    typeof status.time === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(status.time)
  )
    out.time = status.time;
  const latitude = finiteNumber(status.latitude);
  const longitude = finiteNumber(status.longitude);
  if (
    latitude !== null &&
    longitude !== null &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180
  )
    out.observer = { latitude, longitude };
  return Object.keys(out).length ? out : null;
}

/** History playback: live or history, and what is playing while it does. */
function compactHistoryState(status) {
  if (!status) return null;
  const out = {};
  const playing = reportedBoolean(status, 'playing');
  if (playing !== null) out.playing = playing;
  if (status.mode === 'history' || status.mode === 'live')
    out.mode = status.mode;
  const rate = finiteNumber(status.rate);
  if (rate !== null) out.rate = rate;
  if (reportedBoolean(status, 'unavailable')) out.unavailable = true;
  if (
    typeof status.time === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(status.time)
  )
    out.time = status.time;
  const feeds = Array.isArray(status.playingFeeds)
    ? status.playingFeeds
        .filter((id) =>
          [
            'flights',
            'military',
            'ais-live-vessels',
            'earthquakes',
            'local-firms',
            'fire-perimeters',
            'weather-cyclones',
            'rocket-launches',
            'transit',
            'bikeshare',
            'wind',
            'air-quality',
            'gnss-integrity',
            'local-usgs-water',
          ].includes(id),
        )
        .slice(0, MAX_COMPACT_LIST)
    : [];
  if (feeds.length) out.playingFeeds = feeds;
  return Object.keys(out).length ? out : null;
}

/** The Drone Flight Plan state: the plan on the panel, in brief. */
function compactDronePlanState(status) {
  if (!status) return null;
  const out = {};
  const open = reportedBoolean(status, 'open');
  if (open !== null) out.open = open;
  const busy = reportedBoolean(status, 'busy');
  if (busy !== null) out.busy = busy;
  const areaCount = finiteNumber(status.areaCount);
  if (areaCount !== null) out.areaCount = areaCount;
  const preset =
    typeof status.presetId === 'string' ? getPreset(status.presetId) : null;
  if (preset) {
    out.aircraft = preset.name;
    out.presetId = preset.id;
  }
  if (
    [
      'mapping-grid',
      'mapping-grid-timed',
      'splat-orbit',
      'fast-survey',
    ].includes(status.mode)
  )
    out.mode = status.mode;
  if (['grid', 'double', 'orbit'].includes(status.pattern))
    out.pattern = status.pattern;
  for (const key of ['aglM', 'speedMs']) {
    const value = finiteNumber(status[key]);
    if (value !== null) out[key] = value;
  }
  const lat = finiteNumber(status.takeoff?.lat);
  const lon = finiteNumber(status.takeoff?.lon);
  if (
    lat !== null &&
    lon !== null &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
  )
    out.takeoff = { lat, lon };
  if (Array.isArray(status.suite?.passes))
    out.suite = {
      passCount: status.suite.passes.length,
      plannedCount: status.suite.passes.filter((pass) => pass?.planned === true)
        .length,
    };
  const plan = status.plan;
  if (plan && typeof plan === 'object') {
    out.plan = {
      missionCount: finiteNumber(plan.missionCount) ?? 0,
      photoCount: finiteNumber(plan.photoCount) ?? 0,
      durationS: finiteNumber(plan.durationS) ?? 0,
    };
  }
  return Object.keys(out).length ? out : null;
}

/** The aerial imagery state: the year on the map and the years offered. */
function compactImageryState(status) {
  if (!status) return null;
  const out = {};
  if ('year' in status) {
    // The adapter reports no chosen year as null: that stays null here
    // rather than becoming the year 0.
    out.year = finiteNumber(status.year);
  }
  if (Array.isArray(status.years)) {
    const years = status.years
      .map((year) => finiteNumber(year))
      .filter((year) => year !== null)
      .slice(0, MAX_COMPACT_LIST);
    if (years.length) out.years = years;
  }
  const enabled = reportedBoolean(status, 'enabled');
  if (enabled !== null) out.enabled = enabled;
  return Object.keys(out).length ? out : null;
}

/**
 * Whether the map stack is in its automatic mode.
 *
 * The controller's own state answers it: `autoMode` is 'auto' while the
 * automatic switch owns the stack, and another mode while the operator
 * pinned one. A controller that does not know about automatic switching says
 * nothing, and the packet then claims nothing either.
 * @param {object|Function|null} provider The controller, or a function returning it.
 * @returns {Promise<boolean|null>} The mode, or null when it is unknown.
 */
async function readMapStackAuto(provider) {
  const controller = resolveHandle(provider);
  if (!controller || typeof controller.getState !== 'function') return null;
  try {
    const state = await boundedRead(() => controller.getState());
    const mode = state?.autoMode;
    if (typeof mode !== 'string') return null;
    return mode === 'auto';
  } catch {
    return null;
  }
}

/**
 * The compact view state the host's own handles own: Sky, History playback,
 * the Drone Flight Plan, the aerial imagery year and the map stack's
 * automatic mode.
 *
 * Every read is a status call: nothing is switched, opened or written. A
 * handle that is absent (never mounted, or destroyed) and an adapter that
 * fails both contribute nothing at all, so the packet never claims a state
 * the application cannot back.
 * @param {object} providers The host's handles: sky, history, dronePlan,
 *   imagery and mapStack. Each is the handle itself or a function returning it.
 * @returns {Promise<object>} The compact sections, each null when unknown.
 */
export async function readHostViewState(providers = {}) {
  const {
    sky = null,
    history = null,
    dronePlan = null,
    imagery = null,
    mapStack = null,
  } = providers ?? {};
  const [skyStatus, historyStatus, droneStatus, imageryStatus, mapStackAuto] =
    await Promise.all([
      readAdapterStatus(sky),
      readAdapterStatus(history),
      readAdapterStatus(dronePlan),
      readAdapterStatus(imagery),
      readMapStackAuto(mapStack),
    ]);
  return {
    sky: compactSkyState(skyStatus),
    historyPlayback: compactHistoryState(historyStatus),
    dronePlan: compactDronePlanState(droneStatus),
    imagery: compactImageryState(imageryStatus),
    mapStackAuto,
  };
}

/**
 * The control state the packet carries: what the style manager reports, plus
 * the state only its owners can answer — the map stack's automatic mode, the
 * aerial imagery year and the per-layer opacity.
 *
 * Each addition is present only when its owner could say. A host without
 * that owner reports nothing rather than a value it would have to invent.
 * @param {object|null} styleManager The style manager, when the host has one.
 * @param {object} extras The state the owners reported.
 * @returns {object|null} The control state, or null when there is none.
 */
function readControlState(
  styleManager,
  { mapStackAuto, imagery, layerOpacity },
) {
  const base =
    typeof styleManager?.getControlState === 'function'
      ? styleManager.getControlState()
      : null;
  const hasBase = Boolean(base && typeof base === 'object');
  const out = hasBase ? { ...base } : {};
  if (typeof mapStackAuto === 'boolean' && !('mapStackAuto' in out))
    out.mapStackAuto = mapStackAuto;
  if (imagery) {
    if (imagery.year !== undefined && !('imageryYear' in out))
      out.imageryYear = imagery.year;
    if (Array.isArray(imagery.years) && !('imageryYears' in out))
      out.imageryYears = imagery.years;
  }
  if (layerOpacity && !('layerOpacity' in out)) out.layerOpacity = layerOpacity;
  return hasBase || Object.keys(out).length ? out : null;
}

/**
 * Build the model-free fast World Packet from existing application owners.
 *
 * This performs no network requests and intentionally mirrors the historical
 * get_current_view_state payload so voice can delegate without behavior drift.
 */
export function getWorldPacket(options = {}) {
  const {
    viewer,
    styleManager,
    dataManager,
    sceneDirector = null,
    layerOpacity = null,
    sky = null,
    historyPlayback = null,
    dronePlan = null,
    imagery = null,
    mapStackAuto = null,
    now: requestedNow,
  } = options ?? {};
  // A default parameter only covers undefined; null or NaN would age every
  // feed against the epoch and report stale data as "just now".
  const now = Number.isFinite(requestedNow) ? requestedNow : Date.now();
  const pose = findCamera(viewer)?.pose();
  if (!pose) throw new TypeError('World Packet requires a viewer camera');
  if (!dataManager || typeof dataManager.getAll !== 'function')
    throw new TypeError('World Packet requires a data manager');

  const eye = { lon: pose.lon, lat: pose.lat, height: pose.height };
  // Read the roster once. Voice must not rewalk disabled layers: preserving the
  // current enabled-only view keeps the model's context budget bounded.
  const rows = dataManager.getAll();
  const enabledRows = rows.filter((layer) => layer.enabled);
  const contactsWindow = activeContactsWindow(dataManager);
  const contextState =
    typeof styleManager?.getContextModeState === 'function'
      ? withContextModeVocabulary(styleManager.getContextModeState())
      : null;
  const opacity = readLayerOpacity(layerOpacity);
  const controls = readControlState(styleManager, {
    mapStackAuto,
    imagery,
    layerOpacity: opacity,
  });

  return {
    ok: true,
    action: 'get_current_view_state',
    camera: {
      latitude: eye.lat,
      longitude: eye.lon,
      heightM: eye.height,
      ...(Number.isFinite(pose.heading)
        ? { headingDeg: ((((pose.heading * 180) / Math.PI) % 360) + 360) % 360 }
        : {}),
      ...(Number.isFinite(pose.pitch)
        ? { pitchDeg: (pose.pitch * 180) / Math.PI }
        : {}),
    },
    style: styleManager?.activeStyle || 'normal',
    context: contextState
      ? {
          ...contextState,
          ...(contactsWindow ? { contactsWindow } : {}),
        }
      : null,
    cockpit:
      typeof styleManager?.getCockpitState === 'function'
        ? styleManager.getCockpitState()
        : null,
    controls,
    scenePlayback: sceneDirector?.getPlaybackStatus?.() || null,
    tracked: collectTrackedEntities(dataManager),
    disabledLayerCount: rows.length - enabledRows.length,
    // Preserve get_current_view_state's existing compact enabled-only shape.
    layers: enabledRows.map((layer) => {
      const snapshot = layerSnapshot(layer, { now });
      return {
        id: layer.id,
        name: layer.name,
        enabled: layer.enabled,
        count: layer.stats?.count || 0,
        error: layer.stats?.error || null,
        feedState: snapshot.feedState,
        source: snapshot.source,
        lastUpdate: snapshot.lastUpdate,
      };
    }),
    feedProvenance: feedProvenanceEnvelope(
      layerSnapshots(rows, { now }).filter((layer) => layer.enabled),
      { now },
    ),
    // Only a host that owns an opacity model reports layer opacity, and only
    // the layers it actually exposes: the packet stays compact.
    ...(opacity ? { layerOpacity: opacity } : {}),
    // The host's own view state, each section present only when the handle
    // that owns it could answer. A handle that is absent (never mounted, or
    // destroyed) contributes nothing rather than a guess.
    ...(sky ? { sky } : {}),
    ...(historyPlayback ? { historyPlayback } : {}),
    ...(dronePlan ? { dronePlan } : {}),
  };
}
