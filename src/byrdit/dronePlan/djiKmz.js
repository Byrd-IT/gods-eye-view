/**
 * Read a DJI waypoint mission (a DJI Fly KMZ, or one this tool wrote) into
 * plain data, and check it against what DJI Fly accepts.
 *
 * Real layout (two files DJI Fly wrote for a Mini 5 Pro, 2026-10-30):
 *   wpmz/template.kml    author, createTime, updateTime, missionConfig. NO
 *                        waypoints.
 *   wpmz/waylines.wpml   missionConfig + Folder with every Placemark.
 * So waypoints are read from waylines.wpml, and only when that file is missing
 * from template.kml's Folder (the older layout this tool used to write).
 *
 * Pure: no DOM, no Cesium, no network. Never throws on a mission that is merely
 * odd: the problems come back as `warnings` so the person sees them.
 */
import {
  MAX_WAYPOINTS_PER_MISSION,
  DJI_DEFAULT_HEIGHT_LIMIT_M,
} from './planner.js';
import { readZipAsync } from './zip.js';
import { findAll, findFirst, kids, parseXml, textOf } from './xml.js';
import { WPML_NAMESPACE } from './wpml.js';

export const MAX_KMZ_BYTES = 10 * 1024 * 1024;
const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * The controller's mission id from a file name: DJI Fly names the file
 * waypoint/<UUID>/<UUID>.kmz. Browser suffixes "[1]" and " (1)" are removed.
 * @returns {string|null} the UUID in upper case, or null when it is not one
 */
export function missionIdFromFileName(fileName) {
  if (typeof fileName !== 'string') return null;
  let base = fileName
    .split(/[\\/]/)
    .pop()
    .replace(/\.kmz$/i, '');
  base = base.replace(/\s*(?:\(\d+\)|\[\d+\])\s*$/g, '').trim();
  return UUID.test(base) ? base.toUpperCase() : null;
}

function readConfig(doc) {
  const cfg = findFirst(doc, 'wpml:missionConfig');
  if (!cfg) return null;
  return {
    flyToWaylineMode: textOf(cfg, 'wpml:flyToWaylineMode'),
    finishAction: textOf(cfg, 'wpml:finishAction'),
    exitOnRCLost: textOf(cfg, 'wpml:exitOnRCLost'),
    executeRCLostAction: textOf(cfg, 'wpml:executeRCLostAction'),
    globalTransitionalSpeed: num(textOf(cfg, 'wpml:globalTransitionalSpeed')),
    droneEnumValue: num(textOf(cfg, 'wpml:droneEnumValue')),
    droneSubEnumValue: num(textOf(cfg, 'wpml:droneSubEnumValue')),
  };
}

function readPoi(text) {
  const parts = String(text ?? '')
    .split(',')
    .map((x) => Number(x.trim()));
  // DJI writes the point as LAT,LON,ALT (not the KML lon,lat order).
  if (parts.length !== 3 || !parts.every(Number.isFinite)) return null;
  const [lat, lon, altM] = parts;
  if (lat === 0 && lon === 0) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon, altM };
}

function readAction(node) {
  const param = findFirst(node, 'wpml:actionActuatorFuncParam');
  const params = {};
  for (const c of param?.children ?? []) {
    params[c.name.replace(/^wpml:/, '')] = c.text.trim();
  }
  return {
    id: num(textOf(node, 'wpml:actionId')),
    func: textOf(node, 'wpml:actionActuatorFunc'),
    params,
  };
}

function readGroup(node) {
  return {
    id: num(textOf(node, 'wpml:actionGroupId')),
    start: num(textOf(node, 'wpml:actionGroupStartIndex')),
    end: num(textOf(node, 'wpml:actionGroupEndIndex')),
    mode: textOf(node, 'wpml:actionGroupMode'),
    trigger: textOf(node, 'wpml:actionTriggerType'),
    triggerParam: num(textOf(node, 'wpml:actionTriggerParam')),
    actions: kids(node, 'wpml:action').map(readAction),
  };
}

function readWaypoint(mark) {
  const coords = (textOf(mark, 'coordinates') ?? '').split(',').map(Number);
  const [lon, lat] = coords;
  const head = findFirst(mark, 'wpml:waypointHeadingParam');
  const turn = findFirst(mark, 'wpml:waypointTurnParam');
  return {
    index: num(textOf(mark, 'wpml:index')),
    lon: Number.isFinite(lon) ? lon : null,
    lat: Number.isFinite(lat) ? lat : null,
    heightM: num(textOf(mark, 'wpml:executeHeight')),
    speedMs: num(textOf(mark, 'wpml:waypointSpeed')),
    heading: {
      mode: textOf(head, 'wpml:waypointHeadingMode'),
      angleDeg: num(textOf(head, 'wpml:waypointHeadingAngle')),
      angleEnabled: textOf(head, 'wpml:waypointHeadingAngleEnable') === '1',
      poi: readPoi(textOf(head, 'wpml:waypointPoiPoint')),
      pathMode: textOf(head, 'wpml:waypointHeadingPathMode'),
    },
    turn: {
      mode: textOf(turn, 'wpml:waypointTurnMode'),
      dampingDistM: num(textOf(turn, 'wpml:waypointTurnDampingDist')),
    },
    gimbalPitchDeg: num(textOf(mark, 'wpml:waypointGimbalPitchAngle')),
    groups: kids(mark, 'wpml:actionGroup').map(readGroup),
  };
}

const decodeText = (bytes) => new TextDecoder('utf-8').decode(bytes);

/**
 * @param {Uint8Array} bytes the KMZ
 * @param {{ fileName?: string }} [opts]
 * @returns {Promise<object>} the mission; `.error` (a code) when it cannot be read at all
 */
export async function parseDjiKmz(bytes, { fileName = '' } = {}) {
  const base = {
    source: 'dji',
    fileName,
    uuid: missionIdFromFileName(fileName),
  };
  if (!(bytes instanceof Uint8Array) || !bytes.length) {
    return { ...base, error: 'empty' };
  }
  if (bytes.length > MAX_KMZ_BYTES) return { ...base, error: 'too-large' };
  let files;
  try {
    // Only the two mission files are inflated; the rest of the archive is skipped.
    files = await readZipAsync(bytes, {
      only: (n) => /(^|\/)wpmz\/(waylines\.wpml|template\.kml)$/i.test(n),
    });
  } catch {
    return { ...base, error: 'not-a-kmz' };
  }
  const find = (suffix) =>
    [...files.keys()].find((n) => n.toLowerCase().endsWith(suffix));
  const wayName = find('wpmz/waylines.wpml');
  const tplName = find('wpmz/template.kml');
  if (!wayName && !tplName) return { ...base, error: 'no-wpmz' };
  let way = null;
  let tpl = null;
  try {
    way = wayName ? parseXml(decodeText(files.get(wayName))) : null;
    tpl = tplName ? parseXml(decodeText(files.get(tplName))) : null;
  } catch {
    return { ...base, error: 'bad-xml' };
  }
  const root = (doc) => kids(doc, 'kml')[0] ?? doc;
  const namespace =
    (way && root(way).attrs['xmlns:wpml']) ||
    (tpl && root(tpl).attrs['xmlns:wpml']) ||
    null;

  let source = way;
  let usedTemplateFallback = false;
  if (!way || !findAll(way, 'Placemark').length) {
    if (tpl && findAll(tpl, 'Placemark').length) {
      source = tpl;
      usedTemplateFallback = true;
    }
  }
  const marks = source ? findAll(source, 'Placemark') : [];
  const waypoints = marks.map(readWaypoint);
  const folder = source ? findFirst(source, 'Folder') : null;
  const config = (way && readConfig(way)) || (tpl && readConfig(tpl)) || null;
  const tplDoc = tpl ? findFirst(tpl, 'Document') : null;
  return {
    ...base,
    namespace,
    config,
    meta: tpl
      ? {
          author: textOf(tpl, 'wpml:author'),
          createTime: num(textOf(tpl, 'wpml:createTime')),
          updateTime: num(textOf(tpl, 'wpml:updateTime')),
        }
      : null,
    templateChildren: tplDoc ? tplDoc.children.map((c) => c.name) : null,
    hasWaylines: Boolean(way),
    usedTemplateFallback,
    wayline: {
      executeHeightMode: folder
        ? textOf(folder, 'wpml:executeHeightMode')
        : null,
      distanceM: folder ? num(textOf(folder, 'wpml:distance')) : null,
      durationS: folder ? num(textOf(folder, 'wpml:duration')) : null,
      autoFlightSpeedMs: folder
        ? num(textOf(folder, 'wpml:autoFlightSpeed'))
        : null,
    },
    waypoints,
  };
}

const R = 6371008.8;
export function distanceM(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Two waypoints further apart than this are not one flyable mission. */
export const FAR_LEG_M = 5000;

/**
 * Check a parsed mission. Warnings only: nothing is changed.
 * @param {object} mission result of parseDjiKmz
 * @param {{ preset?: object, droneEnumValue?: number|null }} [ctx] the selected aircraft
 * @returns {{ level: 'warn'|'info', code: string, args?: object }[]}
 */
export function checkMission(
  mission,
  { preset = null, droneEnumValue = null } = {},
) {
  const out = [];
  const add = (level, code, args) =>
    out.push({ level, code, ...(args ? { args } : {}) });
  if (mission.error) {
    add('warn', `read-${mission.error}`);
    return out;
  }
  if (mission.namespace !== WPML_NAMESPACE) {
    add('warn', 'namespace', {
      found: mission.namespace ?? '(none)',
      expected: WPML_NAMESPACE,
    });
  }
  if (!mission.hasWaylines) add('warn', 'no-waylines');
  else if (mission.usedTemplateFallback) add('info', 'template-fallback');
  if (mission.templateChildren) {
    const want = [
      'wpml:author',
      'wpml:createTime',
      'wpml:updateTime',
      'wpml:missionConfig',
    ];
    const same =
      mission.templateChildren.length === want.length &&
      want.every((n, i) => mission.templateChildren[i] === n);
    if (!same) add('warn', 'template-shape');
  } else if (mission.hasWaylines) {
    add('warn', 'no-template');
  }
  const cfg = mission.config;
  if (!cfg) {
    add('warn', 'no-config');
  } else {
    const expected = droneEnumValue ?? preset?.wpml?.droneEnumValue ?? null;
    const sub = preset?.wpml?.droneSubEnumValue ?? 0;
    if (cfg.droneEnumValue === null) add('warn', 'no-drone');
    else if (
      expected !== null &&
      (cfg.droneEnumValue !== expected ||
        (droneEnumValue === null && (cfg.droneSubEnumValue ?? 0) !== sub))
    ) {
      add('warn', 'drone-mismatch', {
        found: `${cfg.droneEnumValue}/${cfg.droneSubEnumValue ?? 0}`,
        expected: `${expected}/${droneEnumValue === null ? sub : '*'}`,
        model: preset?.name ?? '',
      });
    }
  }
  const wps = mission.waypoints;
  if (!wps.length) {
    add('warn', 'no-waypoints');
    return out;
  }
  if (wps.length > MAX_WAYPOINTS_PER_MISSION) {
    add('warn', 'too-many', {
      count: wps.length,
      max: MAX_WAYPOINTS_PER_MISSION,
    });
  }
  if (wps.some((w, i) => w.index !== i)) add('warn', 'index-gap');
  if (
    wps.some(
      (w) =>
        w.lon === null ||
        w.lat === null ||
        Math.abs(w.lat) > 90 ||
        Math.abs(w.lon) > 180,
    )
  ) {
    add('warn', 'bad-coordinates');
  }
  if (mission.wayline.executeHeightMode !== 'relativeToStartPoint') {
    add('warn', 'height-mode', {
      found: mission.wayline.executeHeightMode ?? '(none)',
    });
  }
  const heights = wps.map((w) => w.heightM);
  if (heights.some((h) => h === null)) add('warn', 'no-height');
  const known = heights.filter((h) => h !== null);
  if (known.some((h) => h < 0 || h > DJI_DEFAULT_HEIGHT_LIMIT_M)) {
    add('warn', 'height-range', {
      min: Math.min(...known),
      max: Math.max(...known),
      limit: DJI_DEFAULT_HEIGHT_LIMIT_M,
    });
  }
  const maxSpeed = preset?.maxSpeedMs ?? 15;
  if (
    wps.some(
      (w) => w.speedMs === null || w.speedMs <= 0 || w.speedMs > maxSpeed,
    )
  ) {
    add('warn', 'speed-range', { max: maxSpeed });
  }
  for (const w of wps) {
    if (w.heading.mode === 'towardPOI' && !w.heading.poi) {
      add('warn', 'poi-missing', { index: w.index });
      break;
    }
  }
  // Action groups: parallel, ids from 1 (never going down), action ids unique
  // over the whole mission.
  const groups = wps.flatMap((w) => w.groups);
  if (groups.some((g) => g.mode !== 'parallel')) add('warn', 'group-mode');
  // DJI Fly itself repeats a group id when one gimbalEvenlyRotate group runs on
  // from one waypoint to the next, so ids only have to start at 1 and never go
  // back down.
  const gids = groups.map((g) => g.id);
  if (
    gids.length &&
    (gids.some((g) => g === null) ||
      Math.min(...gids) !== 1 ||
      gids.some((g, i) => i > 0 && g < gids[i - 1]))
  ) {
    add('warn', 'group-ids');
  }
  const aids = groups.flatMap((g) => g.actions.map((a) => a.id));
  if (
    aids.length &&
    (aids.some((a) => a === null) || new Set(aids).size !== aids.length)
  ) {
    add('warn', 'action-ids');
  }
  const located = wps.filter((w) => w.lon !== null && w.lat !== null);
  for (let i = 1; i < located.length; i += 1) {
    if (distanceM(located[i - 1], located[i]) > FAR_LEG_M) {
      add('warn', 'far-apart', {
        km: Math.round(distanceM(located[i - 1], located[i]) / 1000),
      });
      break;
    }
  }
  return out;
}
