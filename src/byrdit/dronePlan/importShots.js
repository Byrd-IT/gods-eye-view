/**
 * Photo stations of an imported DJI / GEV mission, for the 3D check.
 *
 * An imported file keeps only its path in the stored plan, but the parsed
 * mission (djiKmz.js) still has every action group. This turns that into the
 * places where the camera fires, so the 3D check can draw the view pyramid and
 * footprint of each photo the same way it does for a plan built in the panel:
 *
 *   - a `takePhoto` action that fires on reaching a waypoint: one station at it
 *   - a `takePhoto` group triggered every N metres (multipleDistance): stations
 *     along the legs from the group's first to its last waypoint, N m apart
 *   - a `takePhoto` group triggered every N seconds (multipleTiming): the same,
 *     spaced speed x N metres apart
 *
 * Nothing is invented: a file with no photo action gets no stations.
 * Pure: no DOM, no Cesium. Heights stay relative to the start point, as in the
 * file; importCheckMission() puts them on the globe.
 */
import { makeFrame } from './geo.js';

/** Safety cap on stations derived from one file. */
export const MAX_IMPORT_STATIONS = 20000;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const norm360 = (deg) => ((deg % 360) + 360) % 360;
const bearingXY = (dx, dy) => norm360((Math.atan2(dx, dy) * 180) / Math.PI);
const TIMING = 'multipleTiming';
const DISTANCE = 'multipleDistance';

const hasPhoto = (group) =>
  (group.actions ?? []).some((a) => a.func === 'takePhoto');

/**
 * @param {object} mission result of parseDjiKmz (waypoints with heading,
 *   gimbalPitchDeg, groups)
 * @returns {{ path: object[], stations: object[], photoActions: number }}
 *   `path` is every waypoint in order with the interval stations in between;
 *   each entry has { lon, lat, heightM, pitchDeg, headingDeg, photo }.
 *   `stations` is the entries with photo true.
 */
export function deriveImportShots(mission) {
  const wps = (mission?.waypoints ?? []).filter(
    (w) => finite(w.lon) && finite(w.lat),
  );
  if (!wps.length) return { path: [], stations: [], photoActions: 0 };
  const frame = makeFrame(wps[0].lon, wps[0].lat);
  const xy = wps.map((w) => frame.toXY(w.lon, w.lat));
  const heightOf = (w) => (finite(w.heightM) ? w.heightM : 0);

  // Direction of travel at waypoint i: along its outgoing leg, or the incoming
  // leg for the last one; further legs when a neighbour sits on the same spot.
  const travelDeg = (i) => {
    const look = (from, to) => {
      const dx = xy[to].x - xy[from].x;
      const dy = xy[to].y - xy[from].y;
      return Math.hypot(dx, dy) > 1e-6 ? bearingXY(dx, dy) : null;
    };
    for (let j = i + 1; j < wps.length; j += 1) {
      const d = look(i, j);
      if (d !== null) return d;
    }
    for (let j = i - 1; j >= 0; j -= 1) {
      const d = look(j, i);
      if (d !== null) return d;
    }
    return 0;
  };
  const travel = wps.map((_, i) => travelDeg(i));

  const headingAt = (i, x, y) => {
    const h = wps[i].heading ?? {};
    if (h.mode === 'towardPOI' && h.poi) {
      const p = frame.toXY(h.poi.lon, h.poi.lat);
      if (Math.hypot(p.x - x, p.y - y) > 1e-6)
        return bearingXY(p.x - x, p.y - y);
    }
    if (finite(h.angleDeg)) {
      if (h.mode === 'fixed' || h.mode === 'manually')
        return norm360(h.angleDeg);
      if (h.mode === 'smoothTransition' && h.angleEnabled)
        return norm360(h.angleDeg);
    }
    return travel[i];
  };

  // Gimbal pitch: the waypoint's own value, else a gimbalRotate action there,
  // else whatever was set last, else straight down.
  const pitches = [];
  let carried = -90;
  wps.forEach((w) => {
    let p = finite(w.gimbalPitchDeg) ? w.gimbalPitchDeg : null;
    if (p === null) {
      for (const g of w.groups ?? []) {
        for (const a of g.actions ?? []) {
          if (a.func !== 'gimbalRotate') continue;
          const v = Number(a.params?.gimbalPitchRotateAngle);
          if (
            a.params?.gimbalPitchRotateEnable !== '0' &&
            Number.isFinite(v) &&
            a.params?.gimbalPitchRotateAngle !== ''
          )
            p = v;
        }
      }
    }
    if (p !== null) carried = p;
    pitches.push(carried);
  });

  const fallbackSpeed =
    mission?.wayline?.autoFlightSpeedMs ??
    mission?.config?.globalTransitionalSpeed ??
    null;

  // Waypoint position of a group's index (the file's own `index` first).
  const posOf = (idx, fallback) => {
    if (!finite(idx)) return fallback;
    const byIndex = wps.findIndex((w) => w.index === idx);
    if (byIndex >= 0) return byIndex;
    return Math.min(Math.max(0, Math.trunc(idx)), wps.length - 1);
  };

  let photoActions = 0;
  const pointPhoto = new Set();
  /** @type {Map<number, object[]>} leg index -> stations along it, in order */
  const along = new Map();
  let total = 0;

  wps.forEach((w, i) => {
    for (const g of w.groups ?? []) {
      if (!hasPhoto(g)) continue;
      photoActions += g.actions.filter((a) => a.func === 'takePhoto').length;
      const start = posOf(g.start, i);
      if (g.trigger === DISTANCE || g.trigger === TIMING) {
        const end = posOf(g.end, wps.length - 1);
        const speed = finite(wps[start].speedMs)
          ? wps[start].speedMs
          : fallbackSpeed;
        const spacing =
          g.trigger === DISTANCE
            ? g.triggerParam
            : finite(speed) && finite(g.triggerParam)
              ? speed * g.triggerParam
              : null;
        if (!finite(spacing) || spacing <= 0) continue;
        let next = 0;
        let travelled = 0;
        for (let k = start; k < end && total < MAX_IMPORT_STATIONS; k += 1) {
          const dx = xy[k + 1].x - xy[k].x;
          const dy = xy[k + 1].y - xy[k].y;
          const seg = Math.hypot(dx, dy);
          if (seg <= 0) continue;
          while (
            next <= travelled + seg + 1e-9 &&
            total < MAX_IMPORT_STATIONS
          ) {
            const f = Math.min(1, Math.max(0, (next - travelled) / seg));
            const x = xy[k].x + dx * f;
            const y = xy[k].y + dy * f;
            const ll = frame.toLonLat(x, y);
            const list = along.get(k) ?? [];
            list.push({
              lon: ll.lon,
              lat: ll.lat,
              heightM:
                heightOf(wps[k]) +
                (heightOf(wps[k + 1]) - heightOf(wps[k])) * f,
              pitchDeg: pitches[k],
              headingDeg: headingAt(k, x, y),
              photo: true,
              at: next,
            });
            along.set(k, list);
            total += 1;
            next += spacing;
          }
          travelled += seg;
        }
      } else {
        // reachPoint (or an unnamed trigger): the camera fires at the waypoint.
        pointPhoto.add(start);
      }
    }
  });

  const path = [];
  wps.forEach((w, i) => {
    const isPhoto = pointPhoto.has(i);
    if (isPhoto) total += 1;
    path.push({
      lon: w.lon,
      lat: w.lat,
      heightM: heightOf(w),
      pitchDeg: pitches[i],
      headingDeg: headingAt(i, xy[i].x, xy[i].y),
      photo: isPhoto,
      // One of the file's own waypoints (the others are interval stations
      // worked out between them): the globe draws these as the aircraft.
      waypoint: true,
    });
    for (const s of along.get(i) ?? []) {
      const { at: _at, ...rest } = s;
      path.push(rest);
    }
  });
  return {
    path,
    stations: path.filter((p) => p.photo),
    photoActions,
    // What the file's heights are measured from (WPML executeHeightMode).
    heightMode: mission?.wayline?.executeHeightMode ?? 'relativeToStartPoint',
  };
}

/**
 * The mission the 3D check draws: the path with ground heights. Heights in the
 * file are above the start point (the first waypoint is taken as it), so a
 * station's height above the ground under it is
 * `ground at start + height - ground under it`. The aircraft is therefore
 * drawn at `ground at start + height` above the ellipsoid (groundM + aglM),
 * never at the file's height measured from the ellipsoid itself.
 *
 * Without terrain heights the planner-style flat-ground assumption applies:
 * the ground is taken as flat at `displayGroundM`, the globe's own terrain
 * height at the start point (terrain model only, never the 3D tiles), or at
 * height 0 when the globe cannot say either. Nothing is invented: that case
 * is `verified: false`.
 *
 * @param {{ path: object[] }} shots deriveImportShots()
 * @param {{ known?: boolean, takeoffM?: number, wpM?: (number|null)[] }} [ground]
 *   as sampleGround returns it for the points `shots.path`
 * @param {{ displayGroundM?: number|null,
 *   groundAt?: (lon:number, lat:number) => number|null }} [display] the
 *   globe's terrain height at the start point, and a lookup for the surface
 *   under each point: used only when `ground` is not known
 */
export function importCheckMission(shots, ground = null, display = {}) {
  const known = ground?.known === true;
  const flat = finite(display?.displayGroundM) ? display.displayGroundM : null;
  const takeoffM = known ? ground.takeoffM : (flat ?? 0);
  const mode = shots.heightMode ?? 'relativeToStartPoint';
  // What each height in the file is measured from. Only the modes whose datum
  // GEV can place are drawn: an EGM96 (sea level) height needs a geoid model
  // the app does not have, and is not guessed.
  const placeable = ['relativeToStartPoint', 'WGS84', 'realTimeFollowSurface'];
  if (!placeable.includes(mode)) {
    return { waypoints: [], verified: false, unsupportedHeightMode: mode };
  }
  const waypoints = shots.path.map((p, i) => {
    // The surface under this point: the terrain read, else (terrain not read)
    // the globe's own surface there, else flat at the start.
    const globeUnder = known ? null : display?.groundAt?.(p.lon, p.lat);
    const under =
      known && finite(ground.wpM?.[i])
        ? ground.wpM[i]
        : finite(globeUnder)
          ? globeUnder
          : takeoffM;
    // Height above the ellipsoid the aircraft is drawn at, m.
    const aircraftM =
      mode === 'WGS84'
        ? p.heightM
        : mode === 'realTimeFollowSurface'
          ? under + p.heightM
          : takeoffM + p.heightM;
    return {
      lon: p.lon,
      lat: p.lat,
      groundM: under,
      // Signed on purpose: a file that flies BELOW the terrain under it is
      // drawn there, not lifted onto the ground.
      aglM: aircraftM - under,
      pitchDeg: p.pitchDeg,
      headingDeg: p.headingDeg,
      photo: p.photo,
      waypoint: p.waypoint === true,
    };
  });
  return { waypoints, verified: known || flat !== null };
}
