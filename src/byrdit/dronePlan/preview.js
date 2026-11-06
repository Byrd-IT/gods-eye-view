/**
 * The Drone Flight Plan on the globe: the survey box, each mission's flight
 * path, its waypoints and the takeoff point, in one removable data source.
 * Missions are coloured apart so the battery split is visible.
 *
 * "Plan all recommended passes" draws every pass at once (showSuite), each in
 * its own colour and line style; a pass can be hidden without replanning.
 *
 * The 3D check (checkLayer.js) rides on whatever plan is shown: a shaded
 * safety corridor, a height curtain and camera view pyramids. A visual aid
 * only; it detects nothing.
 */
import * as Cesium from 'cesium';
import { createCheckLayer } from './checkLayer.js';
import { createObstacleLayer } from './obstacleLayer.js';
import {
  displayOffset,
  flightHeightM,
  shiftMission,
} from './displayHeights.js';
import { globeHeightM } from './globeHeight.js';

export const PREVIEW_DATA_SOURCE = 'gev-drone-plan';
export const MISSION_COLORS = Object.freeze([
  '#39d0ff',
  '#ffb547',
  '#5dff9f',
  '#ff7ad9',
  '#c9a2ff',
  '#ff6b6b',
]);
/**
 * How each all-passes pass is drawn. `dash` is the Cesium dash length in
 * pixels (0 = solid). `floating` passes are drawn at their real flight height
 * instead of being clamped to the ground, so the orbit rings at different
 * heights stay distinguishable.
 */
export const PASS_STYLES = Object.freeze({
  nadir: Object.freeze({ color: '#39d0ff', dash: 0, floating: false }),
  oblique60: Object.freeze({ color: '#ffb547', dash: 18, floating: false }),
  oblique45: Object.freeze({ color: '#ff7ad9', dash: 6, floating: false }),
  orbit: Object.freeze({ color: '#5dff9f', dash: 0, floating: true }),
});
/** Style for a pass id, with a stable fallback for passes added later. */
export function passStyle(id, index = 0) {
  return (
    PASS_STYLES[id] ?? {
      color: MISSION_COLORS[index % MISSION_COLORS.length],
      dash: 0,
      floating: false,
    }
  );
}
/** Waypoint markers beyond this are thinned so the globe stays fast. */
export const MAX_MARKERS = 1500;

/**
 * @param {{ viewer: object, cesium?: object }} deps
 * @returns {{ showBox: (box: object|null) => void,
 *   showPlan: (result: object|null) => void,
 *   showSuite: (passes: object[]|null, hiddenIds?: Iterable<string>) => void,
 *   setSuiteHidden: (hiddenIds: Iterable<string>) => void,
 *   setCheck: (patch: object) => void,
 *   checkInfo: () => object,
 *   checkCounts: () => object,
 *   clear: () => void,
 *   destroy: () => Promise<void> }}
 */
export function createDronePlanPreview({
  viewer,
  cesium = Cesium,
  overlay = null,
  onObstacleHeight,
  kindText,
}) {
  const dataSource = new cesium.CustomDataSource(PREVIEW_DATA_SOURCE);
  let attaching = Promise.resolve(viewer.dataSources.add(dataSource)).catch(
    () => null,
  );
  let destroyed = false;
  const requestRender = () => viewer.scene.requestRender?.();
  const color = (css, alpha = 1) =>
    cesium.Color.fromCssColorString(css).withAlpha(alpha);
  const ground = {
    clampToGround: true,
    classificationType: cesium.ClassificationType.BOTH,
  };

  let boxEntities = [];
  let areaEntities = [];
  let planEntities = [];
  let suiteEntities = [];
  let importEntities = [];
  let photoEntities = [];
  let photoBounds = null;
  let clearanceEntities = [];
  let suitePasses = null;
  const drop = (list) => {
    for (const entity of list) dataSource.entities.remove(entity);
    return [];
  };
  const check = createCheckLayer({ dataSource, cesium, requestRender });
  const obstacles = createObstacleLayer({
    dataSource,
    cesium,
    viewer,
    requestRender,
    overlay,
    onHeight: onObstacleHeight,
    kindText,
  });
  // What the 3D check is drawn from: the all-passes plan when there is one,
  // otherwise the single plan. It is rebuilt only when that source changes,
  // so the show/clear pairs of a re-sync do not redraw it twice.
  let planCheck = null;
  let planSource = null;
  let suiteCheck = null;
  let suiteSource = null;
  let checkSource = null;
  // Imported files (setImportCheck): shown only when no panel plan is.
  let importCheck = null;
  let importSource = null;
  // The last imported items drawn, so the airborne waypoint markers can be
  // redrawn when the terrain heights for them arrive (setImportCheck).
  let lastImports = null;
  // False when the terrain could not be read for the plan on show and the
  // globe could not say either: the aircraft is then drawn on assumed flat
  // ground at height 0 and the panel says so.
  let displayVerified = true;
  /**
   * The vertical shift that puts a plan's drawings on the globe's real
   * surface (displayHeights.js). 0 whenever the terrain was read.
   */
  const offsetFor = (result) => {
    const takeoff = result?.plan?.takeoff;
    const d = displayOffset(
      result?.ground,
      result?.ground?.known === true || !takeoff
        ? null
        : globeHeightM(viewer, cesium, takeoff.lon, takeoff.lat),
    );
    if (!d.verified) displayVerified = false;
    return d;
  };
  // Where the globe's own surface is, for a plan whose terrain was not read.
  const surfaceAt = (lon, lat) => globeHeightM(viewer, cesium, lon, lat);
  // The globe is asked for the surface only when the terrain was NOT read: a
  // read plan already carries the ground under every waypoint.
  const placed = (mission, d, result) =>
    shiftMission(
      mission,
      d.offsetM,
      result?.ground?.known !== true && d.verified ? surfaceAt : null,
    );
  const refreshCheck = () => {
    const next = suiteCheck ? suiteSource : (planSource ?? importSource);
    if (next === checkSource) return;
    checkSource = next;
    // Imported files with no photo action are on the globe (their aircraft
    // markers) but give the 3D check nothing to draw: `checkable` is false.
    check.setData(
      suiteCheck ??
        planCheck ??
        importCheck?.filter((p) => p.checkable !== false),
    );
  };

  function drawImports(items, hiddenIds = []) {
    importEntities = drop(importEntities);
    if (destroyed) return;
    const hidden = new Set(hiddenIds);
    const total = (items ?? []).reduce(
      (n, i) => n + (i.lines ?? []).reduce((k, l) => k + l.length, 0),
      0,
    );
    const step = Math.max(1, Math.ceil(total / MAX_MARKERS));
    for (const item of items ?? []) {
      if (hidden.has(item.id)) continue;
      const flight = importCheck?.find((p) => p.id === item.id);
      const airborne = (flight?.missions?.[0]?.waypoints ?? []).filter(
        (w) => w.waypoint === true,
      );
      for (const line of item.lines ?? []) {
        if (line.length >= 2) {
          importEntities.push(
            dataSource.entities.add({
              name: item.id,
              polyline: {
                positions: cesium.Cartesian3.fromDegreesArray(
                  line.flatMap((w) => [w.lon, w.lat]),
                ),
                width: 3,
                ...ground,
                material: color(item.color, 0.95),
              },
            }),
          );
        }
        // With terrain heights for the file the waypoints are drawn in the
        // air at the aircraft position (below); otherwise they stay on the
        // ground track, the only place the file itself gives.
        if (!airborne.length) {
          line.forEach((w, i) => {
            if (i % step && i !== line.length - 1) return;
            importEntities.push(
              dataSource.entities.add({
                position: cesium.Cartesian3.fromDegrees(w.lon, w.lat),
                point: {
                  pixelSize: 5,
                  color: color(item.color),
                  outlineColor: color('#000000', 0.6),
                  outlineWidth: 1,
                  heightReference: cesium.HeightReference.CLAMP_TO_GROUND,
                  disableDepthTestDistance: 1500,
                },
              }),
            );
          });
        }
      }
      const airStep = Math.max(1, Math.ceil(airborne.length / MAX_MARKERS));
      airborne.forEach((w, i) => {
        if (i % airStep && i !== airborne.length - 1) return;
        importEntities.push(
          dataSource.entities.add({
            name: `${item.id} waypoint`,
            position: cesium.Cartesian3.fromDegrees(
              w.lon,
              w.lat,
              flightHeightM(w),
            ),
            point: {
              pixelSize: 5,
              color: color(item.color),
              outlineColor: color('#000000', 0.6),
              outlineWidth: 1,
              disableDepthTestDistance: 1500,
            },
          }),
        );
      });
      for (const ring of item.rings ?? []) {
        if (ring.length < 3) continue;
        importEntities.push(
          dataSource.entities.add({
            name: item.id,
            polyline: {
              positions: cesium.Cartesian3.fromDegreesArray(
                [...ring, ring[0]].flatMap((p) => [p.lon, p.lat]),
              ),
              width: 2,
              ...ground,
              material: new cesium.PolylineDashMaterialProperty({
                color: color(item.color, 0.95),
                dashLength: 10,
              }),
            },
          }),
        );
      }
      for (const p of item.poi ?? []) {
        importEntities.push(
          dataSource.entities.add({
            position: cesium.Cartesian3.fromDegrees(p.lon, p.lat),
            point: {
              pixelSize: 9,
              color: color('#ffffff'),
              outlineColor: color(item.color),
              outlineWidth: 3,
              heightReference: cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: 1500,
            },
          }),
        );
      }
    }
    requestRender();
  }

  return {
    showBox(box) {
      boxEntities = drop(boxEntities);
      if (box && !destroyed) {
        const ring = cesium.Cartesian3.fromDegreesArray([
          box.west,
          box.south,
          box.east,
          box.south,
          box.east,
          box.north,
          box.west,
          box.north,
          box.west,
          box.south,
        ]);
        boxEntities.push(
          dataSource.entities.add({
            polyline: {
              positions: ring,
              width: 2,
              ...ground,
              material: new cesium.PolylineDashMaterialProperty({
                color: color('#8be9ff', 0.95),
                dashLength: 12,
              }),
            },
          }),
        );
      }
      requestRender();
    },
    showAreas(areas) {
      areaEntities = drop(areaEntities);
      if (!destroyed && areas?.length) {
        for (const area of areas) {
          const ring =
            area.kind === 'polygon' && area.ring?.length
              ? area.ring
              : [
                  { lon: area.box.west, lat: area.box.south },
                  { lon: area.box.east, lat: area.box.south },
                  { lon: area.box.east, lat: area.box.north },
                  { lon: area.box.west, lat: area.box.north },
                ];
          const closed = ring.flatMap((p) => [p.lon, p.lat]);
          closed.push(ring[0].lon, ring[0].lat);
          areaEntities.push(
            dataSource.entities.add({
              name: area.name || 'Area',
              polyline: {
                positions: cesium.Cartesian3.fromDegreesArray(closed),
                width: 2,
                ...ground,
                material: new cesium.PolylineDashMaterialProperty({
                  color: color('#ffb547', 0.95),
                  dashLength: 12,
                }),
              },
            }),
          );
        }
      }
      requestRender();
    },
    showPlan(result) {
      planEntities = drop(planEntities);
      planSource = result && !destroyed ? result : null;
      displayVerified = true;
      const planOff = planSource
        ? offsetFor(result)
        : { offsetM: 0, verified: true };
      planCheck = planSource
        ? result.missions.map((mission, mi) => ({
            id: `mission-${mi + 1}`,
            color: MISSION_COLORS[mi % MISSION_COLORS.length],
            missions: [placed(mission, planOff, result)],
          }))
        : null;
      refreshCheck();
      if (result && !destroyed) {
        const total = result.missions.reduce(
          (n, m) => n + m.waypoints.length,
          0,
        );
        const step = Math.max(1, Math.ceil(total / MAX_MARKERS));
        result.missions.forEach((mission, mi) => {
          const css = MISSION_COLORS[mi % MISSION_COLORS.length];
          const flat = mission.waypoints.flatMap((w) => [w.lon, w.lat]);
          if (flat.length >= 4) {
            planEntities.push(
              dataSource.entities.add({
                name: `Mission ${mi + 1}`,
                polyline: {
                  positions: cesium.Cartesian3.fromDegreesArray(flat),
                  width: 3,
                  ...ground,
                  material: color(css, 0.9),
                },
              }),
            );
          }
          // Stretches the height cap cannot lift over an obstacle: red. Each
          // stretch is drawn on its own, so a blocked turn between two grid
          // lines or a blocked way out from takeoff shows where it is.
          const wps = mission.waypoints;
          const stretches = [];
          for (let i = 1; i < wps.length; i += 1) {
            if (wps[i - 1].obstacleBlocked || wps[i].obstacleBlocked) {
              stretches.push([wps[i - 1], wps[i]]);
            }
          }
          const takeoffAt = result.plan?.takeoff;
          if (takeoffAt && wps.length) {
            if (wps[0].obstacleBlocked) stretches.push([takeoffAt, wps[0]]);
            const end = wps[wps.length - 1];
            if (end.obstacleBlocked) stretches.push([end, takeoffAt]);
          }
          for (const [a, b] of stretches) {
            planEntities.push(
              dataSource.entities.add({
                name: 'Blocked by obstacle',
                polyline: {
                  positions: cesium.Cartesian3.fromDegreesArray([
                    a.lon,
                    a.lat,
                    b.lon,
                    b.lat,
                  ]),
                  width: 6,
                  ...ground,
                  material: color('#ff2d2d', 0.95),
                },
              }),
            );
          }
          // A waypoint marker is the AIRCRAFT position: drawn at the ground
          // height under it plus its height above ground, never clamped to
          // the surface. The ground track above stays on the ground.
          mission.waypoints.forEach((w, i) => {
            if (i % step && i !== mission.waypoints.length - 1) return;
            planEntities.push(
              dataSource.entities.add({
                position: cesium.Cartesian3.fromDegrees(
                  w.lon,
                  w.lat,
                  flightHeightM(w, planOff.offsetM),
                ),
                point: {
                  pixelSize: 4,
                  color: color(css),
                  outlineColor: color('#000000', 0.6),
                  outlineWidth: 1,
                  disableDepthTestDistance: 1500,
                },
              }),
            );
          });
        });
        const home = result.plan.takeoff;
        planEntities.push(
          dataSource.entities.add({
            // Marked by its own look and name: the world-overlay host, not a
            // Cesium label, owns on-globe text in this app.
            name: 'Takeoff',
            position: cesium.Cartesian3.fromDegrees(home.lon, home.lat),
            point: {
              pixelSize: 13,
              color: color('#ffffff'),
              outlineColor: color('#18d27a'),
              outlineWidth: 4,
              heightReference: cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          }),
        );
      }
      requestRender();
    },
    /**
     * Draw every pass of the all-passes plan. Passes in `hiddenIds` (and
     * passes with no result) are not drawn. Marker thinning counts the
     * waypoints of ALL planned passes, so toggling a pass never changes how
     * the others are thinned. Flight height of a floating pass is the ground
     * height under the waypoint plus its height above ground
     * (`groundM + aglM`), the same datum the terrain sampler returned.
     */
    showSuite(passes, hiddenIds = []) {
      suiteEntities = drop(suiteEntities);
      suitePasses = passes?.length ? passes : null;
      const hidden = new Set(hiddenIds);
      const shown = suitePasses
        ? suitePasses.filter((p) => p.result && !hidden.has(p.id))
        : [];
      // A new array each call, so identity cannot stand in for "same":
      // compare the passes and which are hidden.
      const sourceKey = shown.map((p) => p.id).join('|');
      if (!suitePasses || destroyed || !shown.length) {
        suiteCheck = null;
        suiteSource = null;
      } else if (
        !suiteSource ||
        suiteSource.key !== sourceKey ||
        suiteSource.passes !== suitePasses
      ) {
        suiteSource = { key: sourceKey, passes: suitePasses };
        displayVerified = true;
        suiteCheck = shown.map((p) => {
          const d = offsetFor(p.result);
          return {
            id: p.id,
            color: passStyle(p.id, suitePasses.indexOf(p)).color,
            missions: p.result.missions.map((m) => placed(m, d, p.result)),
          };
        });
      }
      refreshCheck();
      if (suitePasses && !destroyed) {
        const planned = suitePasses.filter((p) => p.result);
        const total = planned.reduce(
          (n, p) =>
            n + p.result.missions.reduce((k, m) => k + m.waypoints.length, 0),
          0,
        );
        const step = Math.max(1, Math.ceil(total / MAX_MARKERS));
        suitePasses.forEach((pass, pi) => {
          if (!pass.result || hidden.has(pass.id)) return;
          const style = passStyle(pass.id, pi);
          const suiteOff = offsetFor(pass.result);
          const heightOf = (w) => flightHeightM(w, suiteOff.offsetM);
          pass.result.missions.forEach((mission, mi) => {
            const wps = mission.waypoints;
            if (wps.length >= 2) {
              const positions = style.floating
                ? cesium.Cartesian3.fromDegreesArrayHeights(
                    wps.flatMap((w) => [w.lon, w.lat, heightOf(w)]),
                  )
                : cesium.Cartesian3.fromDegreesArray(
                    wps.flatMap((w) => [w.lon, w.lat]),
                  );
              suiteEntities.push(
                dataSource.entities.add({
                  name: `${pass.id} mission ${mi + 1}`,
                  polyline: {
                    positions,
                    width: 3,
                    ...(style.floating ? {} : ground),
                    material: style.dash
                      ? new cesium.PolylineDashMaterialProperty({
                          color: color(style.color, 0.95),
                          dashLength: style.dash,
                        })
                      : color(style.color, 0.9),
                  },
                }),
              );
            }
            wps.forEach((w, i) => {
              if (i % step && i !== wps.length - 1) return;
              suiteEntities.push(
                dataSource.entities.add({
                  // The aircraft position for every pass, floating or not.
                  position: cesium.Cartesian3.fromDegrees(
                    w.lon,
                    w.lat,
                    heightOf(w),
                  ),
                  point: {
                    pixelSize: 4,
                    color: color(style.color),
                    outlineColor: color('#000000', 0.6),
                    outlineWidth: 1,
                    disableDepthTestDistance: 1500,
                  },
                }),
              );
            });
          });
        });
        const home = planned[0]?.result.plan.takeoff;
        if (home) {
          suiteEntities.push(
            dataSource.entities.add({
              name: 'Takeoff',
              position: cesium.Cartesian3.fromDegrees(home.lon, home.lat),
              point: {
                pixelSize: 13,
                color: color('#ffffff'),
                outlineColor: color('#18d27a'),
                outlineWidth: 4,
                heightReference: cesium.HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              },
            }),
          );
        }
      }
      requestRender();
    },
    /**
     * Draw library plans and imported drone files, each in its own colour:
     * items are { id, color, lines: [[{lon,lat}]], rings: [[{lon,lat}]],
     * poi: [{lon,lat}] }. `hiddenIds` are left out. Separate from the plan
     * being edited, so it never disturbs it.
     */
    showImports(items, hiddenIds = []) {
      lastImports = { items, hiddenIds };
      drawImports(items, hiddenIds);
    },
    /**
     * Photo check: planned photo points (green when a photo is near, red when
     * not), the photos (cyan on the plan, orange away from it) and the spacing
     * gaps (red lines). `data` is { planned: [{lon,lat,covered}], photos:
     * [{lon,lat,onPlan}], gaps: [[{lon,lat},{lon,lat}]] }; null clears it.
     * Problems are always drawn; only the fine ones are thinned past
     * MAX_MARKERS. Returns how many markers were drawn.
     */
    showPhotoCheck(data) {
      photoEntities = drop(photoEntities);
      photoBounds = null;
      if (!data || destroyed) {
        requestRender();
        return 0;
      }
      const lons = [];
      const lats = [];
      const dot = (p, size, fill, outline) => {
        lons.push(p.lon);
        lats.push(p.lat);
        photoEntities.push(
          dataSource.entities.add({
            position: cesium.Cartesian3.fromDegrees(p.lon, p.lat),
            point: {
              pixelSize: size,
              color: fill,
              outlineColor: outline,
              outlineWidth: 1,
              heightReference: cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: 1500,
            },
          }),
        );
      };
      const planned = data.planned ?? [];
      const photos = data.photos ?? [];
      const step = Math.max(
        1,
        Math.ceil((planned.length + photos.length) / MAX_MARKERS),
      );
      const keep = (problem, i) => problem || i % step === 0;
      const dark = color('#000000', 0.6);
      planned.forEach((p, i) => {
        if (!keep(!p.covered, i)) return;
        dot(
          p,
          p.covered ? 9 : 12,
          p.covered ? color('#2ecc71', 0.55) : color('#ff3b30'),
          dark,
        );
      });
      photos.forEach((p, i) => {
        if (!keep(p.onPlan === false, i)) return;
        dot(
          p,
          5,
          p.onPlan === false ? color('#ff9f1c') : color('#00d1ff'),
          dark,
        );
      });
      for (const [a, b] of (data.gaps ?? []).slice(0, 500)) {
        lons.push(a.lon, b.lon);
        lats.push(a.lat, b.lat);
        photoEntities.push(
          dataSource.entities.add({
            name: 'Photo spacing gap',
            polyline: {
              positions: cesium.Cartesian3.fromDegreesArray([
                a.lon,
                a.lat,
                b.lon,
                b.lat,
              ]),
              width: 4,
              ...ground,
              material: color('#ff3b30', 0.95),
            },
          }),
        );
      }
      if (lons.length) {
        // A loop, not Math.min(...array): up to ~17k points would risk the
        // engine's argument limit.
        const b = {
          west: Infinity,
          east: -Infinity,
          south: Infinity,
          north: -Infinity,
        };
        for (const v of lons) {
          if (v < b.west) b.west = v;
          if (v > b.east) b.east = v;
        }
        for (const v of lats) {
          if (v < b.south) b.south = v;
          if (v > b.north) b.north = v;
        }
        photoBounds = b;
      }
      requestRender();
      return photoEntities.length;
    },
    /** Fly the camera over what showPhotoCheck drew. */
    flyToPhotoCheck() {
      const b = photoBounds;
      if (
        !b ||
        destroyed ||
        !viewer.camera?.flyTo ||
        !cesium.Rectangle?.fromDegrees
      )
        return false;
      const pad = Math.max(
        0.0005,
        (b.east - b.west + (b.north - b.south)) * 0.15,
      );
      viewer.camera.flyTo({
        destination: cesium.Rectangle.fromDegrees(
          b.west - pad,
          b.south - pad,
          b.east + pad,
          b.north + pad,
        ),
        duration: 1.2,
      });
      return true;
    },
    /** Redraw the current suite with only `hiddenIds` left out. */
    setSuiteHidden(hiddenIds = []) {
      if (suitePasses) this.showSuite(suitePasses, hiddenIds);
    },
    /** 3D check options: enabled, zone, halfWidthM, curtain, footprints,
     * frustum ('off' | 'one' | 'thinned'), index, frame (the camera preset). */
    /**
     * Feed imported drone files to the 3D check: passes [{ id, color,
     * missions: [{ waypoints }] }] as importCheckMission() builds them; null
     * clears. A plan built in the panel (or the all-passes plan) wins over it.
     */
    setImportCheck(passes) {
      importCheck = passes?.length && !destroyed ? passes : null;
      importSource = importCheck ? { passes: importCheck } : null;
      refreshCheck();
      // The aircraft markers come from the same heights: redraw them.
      if (lastImports && !destroyed) {
        drawImports(lastImports.items, lastImports.hiddenIds);
        requestRender();
      }
    },
    /**
     * False when the plan on show had no terrain read and the globe could
     * not give the takeoff surface either: the aircraft is then drawn on
     * assumed flat ground at height 0 (unverified, not an invented height).
     */
    displayVerified() {
      return displayVerified;
    },
    setCheck(patch) {
      check.setOptions(patch);
    },
    /** Draw the obstacle columns (and their labels) from a list. */
    setObstacles(list) {
      obstacles.set(list);
    },
    setObstacleGround(m) {
      obstacles.setGroundHint(m);
    },
    /** Terrain height under each obstacle, { id: m }, from the plan's read. */
    setObstacleGrounds(map) {
      obstacles.setSampledGrounds(map);
    },
    /**
     * Flag the stretches that come too close to the surface model: a red line
     * on the ground under each stretch and a red marker at its closest point.
     * `spans` come from checkClearance(); an empty list clears the flags.
     */
    setClearance(spans) {
      clearanceEntities = drop(clearanceEntities);
      for (const s of Array.isArray(spans) ? spans.slice(0, 200) : []) {
        const a = s.start;
        const b = s.end;
        if (!a || !b) continue;
        if (a.lon !== b.lon || a.lat !== b.lat) {
          clearanceEntities.push(
            dataSource.entities.add({
              name: 'Too close to the surface model',
              polyline: {
                positions: cesium.Cartesian3.fromDegreesArray([
                  a.lon,
                  a.lat,
                  b.lon,
                  b.lat,
                ]),
                width: 8,
                ...ground,
                material: color('#ff2d2d', 0.9),
              },
            }),
          );
        }
        const m = s.minAt ?? a;
        clearanceEntities.push(
          dataSource.entities.add({
            name: 'Closest point to the surface model',
            position: cesium.Cartesian3.fromDegrees(m.lon, m.lat),
            point: {
              pixelSize: 11,
              color: color('#ff2d2d'),
              outlineColor: color('#ffffff', 0.9),
              outlineWidth: 2,
              heightReference: cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: 1500,
            },
          }),
        );
      }
      requestRender();
    },
    clearanceCount() {
      return clearanceEntities.length;
    },
    obstacleCount() {
      return obstacles.count();
    },
    /** { count, index, current } for the photo in view. */
    checkInfo() {
      return check.info();
    },
    /** Entities per 3D check layer. */
    checkCounts() {
      return check.counts();
    },
    clear() {
      obstacles.clear();
      planCheck = null;
      planSource = null;
      suiteCheck = null;
      suiteSource = null;
      importCheck = null;
      importSource = null;
      lastImports = null;
      refreshCheck();
      boxEntities = drop(boxEntities);
      areaEntities = drop(areaEntities);
      planEntities = drop(planEntities);
      suiteEntities = drop(suiteEntities);
      importEntities = drop(importEntities);
      clearanceEntities = drop(clearanceEntities);
      suitePasses = null;
      requestRender();
    },
    destroy() {
      if (destroyed) return attaching;
      destroyed = true;
      obstacles.destroy();
      dataSource.entities.removeAll();
      attaching = attaching.then(() => {
        try {
          viewer.dataSources.remove(dataSource, true);
        } catch {
          /* viewer already disposed */
        }
      });
      return attaching;
    },
  };
}
