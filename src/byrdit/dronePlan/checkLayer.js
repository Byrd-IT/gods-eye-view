/**
 * The "3D check" layer of the Drone Flight Plan on the globe. Four layers,
 * each in its own entity list so a toggle or slider rebuilds only that one:
 *
 *   zone       a see-through box corridor along every flight leg, at the real
 *              flight height, `halfWidthM` to each side, above and below
 *   curtain    a faint vertical wall from the flight path down to the ground
 *   footprints the ground area of each photo, shaded (thinned to a cap)
 *   frustums   the camera view pyramid from the drone to its footprint: ONE,
 *              stepped with an index, or a thinned set shown all at once
 *
 * VISUAL AID ONLY: nothing here detects a collision, and OpenStreetMap
 * buildings have no trees or power lines. Look at it over the Google 3D mesh.
 */
import { makeFrame } from './geo.js';
import {
  MAX_FOOTPRINTS,
  MAX_FRUSTUMS,
  MAX_PATH_POINTS,
  clampHalfWidthM,
  DEFAULT_ZONE_HALF_WIDTH_M,
  flightHeightM,
  photoFootprint,
  photoHeadingDeg,
  thinIndexes,
} from './checkGeometry.js';

/** Safety cap on photo spots sampled along interval-photo legs. */
const MAX_INTERVAL_PHOTOS = 20000;

export const CHECK_NAMES = Object.freeze({
  zone: '3D check zone',
  curtain: '3D check curtain',
  footprint: '3D check footprint',
  view: '3D check view',
});

export const DEFAULT_CHECK_OPTIONS = Object.freeze({
  enabled: true,
  zone: true,
  halfWidthM: DEFAULT_ZONE_HALF_WIDTH_M,
  curtain: true,
  footprints: true,
  frustum: 'one',
  index: 0,
  frame: null,
});

const LAYERS = ['zone', 'curtain', 'footprints', 'frustums'];

/** Drop consecutive duplicates and thin a path that is far too long. */
function pathOf(waypoints) {
  const keep = thinIndexes(waypoints.length, MAX_PATH_POINTS);
  const out = [];
  for (const i of keep) {
    const w = waypoints[i];
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.lon === w.lon &&
      prev.lat === w.lat &&
      flightHeightM(prev) === flightHeightM(w)
    ) {
      continue;
    }
    out.push(w);
  }
  return out;
}

/**
 * @param {{ dataSource: object, cesium: object, requestRender: () => void }} deps
 */
export function createCheckLayer({ dataSource, cesium, requestRender }) {
  // Off until the panel hands its options over: a bare preview draws nothing
  // extra.
  let options = { ...DEFAULT_CHECK_OPTIONS, enabled: false };
  let passes = null;
  let version = 0;
  let items = [];
  let itemsVersion = -1;
  const lists = { zone: [], curtain: [], footprints: [], frustums: [] };
  const keys = {};

  const color = (css, alpha) =>
    cesium.Color.fromCssColorString(css).withAlpha(alpha);
  const add = (list, entity) => list.push(dataSource.entities.add(entity));
  const drop = (name) => {
    for (const entity of lists[name]) dataSource.entities.remove(entity);
    lists[name] = [];
  };

  /**
   * Where the camera fires along an interval-photo leg: its waypoints are not
   * photo spots (the shutter runs on a timer), so walk the leg and drop a
   * photo every photoSpacingM, facing along the leg unless it fixes a heading.
   */
  function intervalPhotos(leg) {
    const wps = leg.waypoints ?? [];
    const out = [];
    if (wps.length < 2) return wps.map((wp) => ({ wp }));
    const spacing = Math.max(1, Number(leg.photoSpacingM) || 1);
    const frame = makeFrame(wps[0].lon, wps[0].lat);
    const xy = wps.map((w) => frame.toXY(w.lon, w.lat));
    // A leg continued from a cut starts at the point the last mission ended on.
    let next = leg.continued === true ? spacing : 0;
    let travelled = 0;
    for (let k = 1; k < wps.length; k += 1) {
      const seg = Math.hypot(xy[k].x - xy[k - 1].x, xy[k].y - xy[k - 1].y);
      if (seg <= 0) continue;
      while (
        next <= travelled + seg + 1e-9 &&
        out.length < MAX_INTERVAL_PHOTOS
      ) {
        const f = Math.min(1, Math.max(0, (next - travelled) / seg));
        const a = wps[k - 1];
        const b = wps[k];
        const ll = frame.toLonLat(
          xy[k - 1].x + (xy[k].x - xy[k - 1].x) * f,
          xy[k - 1].y + (xy[k].y - xy[k - 1].y) * f,
        );
        const mix = (p, q) =>
          (Number(p) || 0) + ((Number(q) || 0) - (Number(p) || 0)) * f;
        out.push({
          wp: {
            ...a,
            lon: ll.lon,
            lat: ll.lat,
            aglM: mix(a.aglM, b.aglM),
            groundM: mix(a.groundM, b.groundM),
            pitchDeg: Number.isFinite(a.pitchDeg) ? a.pitchDeg : leg.pitchDeg,
          },
          headingDeg: Number.isFinite(a.headingDeg)
            ? a.headingDeg
            : (Math.atan2(xy[k].x - xy[k - 1].x, xy[k].y - xy[k - 1].y) * 180) /
                Math.PI +
              360,
        });
        next += spacing;
      }
      travelled += seg;
    }
    return out;
  }

  /** Every photo of every shown pass, in flight order. */
  function photoItems() {
    if (itemsVersion === version) return items;
    items = [];
    for (const pass of passes ?? []) {
      pass.missions.forEach((mission, mi) => {
        const legs = mission.legs;
        if (legs?.some((leg) => leg.photoMode === 'interval')) {
          for (const leg of legs) {
            if (leg.photoMode === 'interval' && leg.kind === 'grid') {
              for (const p of intervalPhotos(leg)) {
                items.push({
                  pass,
                  mission,
                  mi,
                  wp: p.wp,
                  i: 0,
                  headingDeg: p.headingDeg,
                });
              }
            } else {
              leg.waypoints.forEach((wp) => {
                if (wp.photo !== false)
                  items.push({ pass, mission, mi, wp, i: wp.index ?? 0 });
              });
            }
          }
          return;
        }
        mission.waypoints.forEach((wp, i) => {
          if (wp.photo === false) return;
          items.push({ pass, mission, mi, wp, i });
        });
      });
    }
    itemsVersion = version;
    return items;
  }

  const clampIndex = () => {
    const n = photoItems().length;
    return Math.min(Math.max(0, Math.trunc(options.index) || 0), n - 1);
  };

  function buildZone() {
    const w = clampHalfWidthM(options.halfWidthM);
    const shape = [
      new cesium.Cartesian2(-w, -w),
      new cesium.Cartesian2(w, -w),
      new cesium.Cartesian2(w, w),
      new cesium.Cartesian2(-w, w),
    ];
    for (const pass of passes ?? []) {
      pass.missions.forEach((mission, mi) => {
        const wps = pathOf(mission.waypoints);
        if (wps.length < 2) return;
        add(lists.zone, {
          name: `${CHECK_NAMES.zone}: ${pass.id} ${mi + 1}`,
          polylineVolume: {
            positions: cesium.Cartesian3.fromDegreesArrayHeights(
              wps.flatMap((p) => [p.lon, p.lat, flightHeightM(p)]),
            ),
            shape,
            cornerType: cesium.CornerType?.BEVELED,
            material: color(pass.color, 0.16),
            outline: false,
          },
        });
      });
    }
  }

  function buildCurtain() {
    for (const pass of passes ?? []) {
      pass.missions.forEach((mission, mi) => {
        const wps = pathOf(mission.waypoints);
        if (wps.length < 2) return;
        add(lists.curtain, {
          name: `${CHECK_NAMES.curtain}: ${pass.id} ${mi + 1}`,
          wall: {
            positions: cesium.Cartesian3.fromDegreesArrayHeights(
              wps.flatMap((p) => [p.lon, p.lat, flightHeightM(p)]),
            ),
            minimumHeights: wps.map((p) => p.groundM ?? 0),
            material: color(pass.color, 0.1),
            outline: false,
          },
        });
      });
    }
  }

  const cornersOf = (item) => {
    const wps = item.mission.waypoints;
    const heading = Number.isFinite(item.headingDeg)
      ? item.headingDeg % 360
      : photoHeadingDeg(wps, item.i);
    return photoFootprint(item.wp, heading, options.frame);
  };

  function buildFootprints() {
    const all = photoItems();
    for (const k of thinIndexes(all.length, MAX_FOOTPRINTS)) {
      const item = all[k];
      const fp = cornersOf(item);
      add(lists.footprints, {
        name: `${CHECK_NAMES.footprint}: ${item.pass.id}`,
        polygon: {
          hierarchy: cesium.Cartesian3.fromDegreesArray(
            fp.corners.flatMap((c) => [c.lon, c.lat]),
          ),
          // Faint: an 80/70 % overlap stacks about six of these on every spot.
          material: color(item.pass.color, 0.05),
          classificationType: cesium.ClassificationType.BOTH,
        },
      });
    }
  }

  function buildPyramid(item) {
    const fp = cornersOf(item);
    const apex = [item.wp.lon, item.wp.lat, fp.heightM];
    const base = fp.corners.map((c) => [c.lon, c.lat, fp.groundM]);
    const pos = (p) => cesium.Cartesian3.fromDegrees(p[0], p[1], p[2]);
    const material = color(item.pass.color, 0.2);
    for (let k = 0; k < 4; k += 1) {
      const a = base[k];
      const b = base[(k + 1) % 4];
      add(lists.frustums, {
        name: `${CHECK_NAMES.view}: ${item.pass.id}`,
        polygon: {
          hierarchy: cesium.Cartesian3.fromDegreesArrayHeights(
            [apex, a, b].flat(),
          ),
          perPositionHeight: true,
          material,
          outline: false,
        },
      });
    }
    add(lists.frustums, {
      name: `${CHECK_NAMES.view}: ${item.pass.id} edges`,
      polyline: {
        positions: [
          base[0],
          base[1],
          base[2],
          base[3],
          base[0],
          apex,
          base[1],
          apex,
          base[2],
          apex,
          base[3],
        ].map(pos),
        width: 2,
        material: color(item.pass.color, 0.9),
      },
    });
  }

  function buildFrustums() {
    const all = photoItems();
    if (!all.length) return;
    if (options.frustum === 'one') {
      buildPyramid(all[clampIndex()]);
    } else if (options.frustum === 'thinned') {
      for (const k of thinIndexes(all.length, MAX_FRUSTUMS)) {
        buildPyramid(all[k]);
      }
    }
  }

  const frameKey = () =>
    options.frame
      ? [
          options.frame.sensorWidthMm,
          options.frame.sensorHeightMm,
          options.frame.focalMm,
        ].join(',')
      : 'none';

  /** What each layer depends on; a layer is rebuilt only when its key moves. */
  function wantedKeys() {
    const on = options.enabled && passes;
    const wantFrame = on && options.frame;
    return {
      zone: on && options.zone ? `${version}|${options.halfWidthM}` : '',
      curtain: on && options.curtain ? `${version}` : '',
      footprints:
        wantFrame && options.footprints ? `${version}|${frameKey()}` : '',
      frustums:
        wantFrame && options.frustum !== 'off'
          ? `${version}|${frameKey()}|${options.frustum}|${
              options.frustum === 'one' ? clampIndex() : ''
            }`
          : '',
    };
  }

  const builders = {
    zone: buildZone,
    curtain: buildCurtain,
    footprints: buildFootprints,
    frustums: buildFrustums,
  };

  function sync() {
    const wanted = wantedKeys();
    let changed = false;
    for (const name of LAYERS) {
      if (keys[name] === wanted[name]) continue;
      keys[name] = wanted[name];
      drop(name);
      if (wanted[name]) builders[name]();
      changed = true;
    }
    if (changed) requestRender();
  }

  return {
    /** The visible passes: [{ id, color, missions: [{ waypoints }] }]. */
    setData(next) {
      passes = next?.length ? next : null;
      version += 1;
      sync();
    },
    setOptions(patch = {}) {
      options = { ...options, ...patch };
      sync();
    },
    options: () => ({ ...options }),
    /** How many photos can be stepped through, and the one in view. */
    info() {
      const all = photoItems();
      if (!all.length) return { count: 0, index: 0, current: null };
      const index = clampIndex();
      const item = all[index];
      const fp = options.frame ? cornersOf(item) : null;
      return {
        count: all.length,
        index,
        current: {
          passId: item.pass.id,
          pitchDeg: item.wp.pitchDeg ?? null,
          headingDeg: Number.isFinite(item.headingDeg)
            ? item.headingDeg % 360
            : photoHeadingDeg(item.mission.waypoints, item.i),
          aglM: item.wp.aglM ?? null,
          heightM: flightHeightM(item.wp),
          footprint: fp
            ? {
                widthM: (fp.widthNearM + fp.widthFarM) / 2,
                depthM: fp.depthM,
                clipped: fp.clipped,
              }
            : null,
        },
      };
    },
    counts: () => ({
      zone: lists.zone.length,
      curtain: lists.curtain.length,
      footprints: lists.footprints.length,
      frustums: lists.frustums.length,
    }),
    /** Remove every 3D check entity; the options stay. */
    clear() {
      passes = null;
      version += 1;
      sync();
    },
  };
}
