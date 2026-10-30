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
export function createDronePlanPreview({ viewer, cesium = Cesium }) {
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
  let suitePasses = null;
  const drop = (list) => {
    for (const entity of list) dataSource.entities.remove(entity);
    return [];
  };
  const check = createCheckLayer({ dataSource, cesium, requestRender });
  // What the 3D check is drawn from: the all-passes plan when there is one,
  // otherwise the single plan. It is rebuilt only when that source changes,
  // so the show/clear pairs of a re-sync do not redraw it twice.
  let planCheck = null;
  let planSource = null;
  let suiteCheck = null;
  let suiteSource = null;
  let checkSource = null;
  const refreshCheck = () => {
    const next = suiteCheck ? suiteSource : planSource;
    if (next === checkSource) return;
    checkSource = next;
    check.setData(suiteCheck ?? planCheck);
  };

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
      planCheck = planSource
        ? result.missions.map((mission, mi) => ({
            id: `mission-${mi + 1}`,
            color: MISSION_COLORS[mi % MISSION_COLORS.length],
            missions: [mission],
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
          mission.waypoints.forEach((w, i) => {
            if (i % step && i !== mission.waypoints.length - 1) return;
            planEntities.push(
              dataSource.entities.add({
                position: cesium.Cartesian3.fromDegrees(w.lon, w.lat),
                point: {
                  pixelSize: 4,
                  color: color(css),
                  outlineColor: color('#000000', 0.6),
                  outlineWidth: 1,
                  heightReference: cesium.HeightReference.CLAMP_TO_GROUND,
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
        suiteCheck = shown.map((p) => ({
          id: p.id,
          color: passStyle(p.id, suitePasses.indexOf(p)).color,
          missions: p.result.missions,
        }));
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
          const heightOf = (w) => (w.groundM ?? 0) + (w.aglM ?? 0);
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
                  position: style.floating
                    ? cesium.Cartesian3.fromDegrees(w.lon, w.lat, heightOf(w))
                    : cesium.Cartesian3.fromDegrees(w.lon, w.lat),
                  point: {
                    pixelSize: 4,
                    color: color(style.color),
                    outlineColor: color('#000000', 0.6),
                    outlineWidth: 1,
                    ...(style.floating
                      ? {}
                      : {
                          heightReference:
                            cesium.HeightReference.CLAMP_TO_GROUND,
                        }),
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
    /** Redraw the current suite with only `hiddenIds` left out. */
    setSuiteHidden(hiddenIds = []) {
      if (suitePasses) this.showSuite(suitePasses, hiddenIds);
    },
    /** 3D check options: enabled, zone, halfWidthM, curtain, footprints,
     * frustum ('off' | 'one' | 'thinned'), index, frame (the camera preset). */
    setCheck(patch) {
      check.setOptions(patch);
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
      planCheck = null;
      planSource = null;
      suiteCheck = null;
      suiteSource = null;
      refreshCheck();
      boxEntities = drop(boxEntities);
      areaEntities = drop(areaEntities);
      planEntities = drop(planEntities);
      suiteEntities = drop(suiteEntities);
      suitePasses = null;
      requestRender();
    },
    destroy() {
      if (destroyed) return attaching;
      destroyed = true;
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
