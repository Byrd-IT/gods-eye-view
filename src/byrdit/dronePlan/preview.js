/**
 * The Drone Flight Plan on the globe: the survey box, each mission's flight
 * path, its waypoints and the takeoff point, in one removable data source.
 * Missions are coloured apart so the battery split is visible.
 */
import * as Cesium from 'cesium';

export const PREVIEW_DATA_SOURCE = 'gev-drone-plan';
export const MISSION_COLORS = Object.freeze([
  '#39d0ff',
  '#ffb547',
  '#5dff9f',
  '#ff7ad9',
  '#c9a2ff',
  '#ff6b6b',
]);
/** Waypoint markers beyond this are thinned so the globe stays fast. */
export const MAX_MARKERS = 1500;

/**
 * @param {{ viewer: object, cesium?: object }} deps
 * @returns {{ showBox: (box: object|null) => void,
 *   showPlan: (result: object|null) => void, clear: () => void,
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
  const drop = (list) => {
    for (const entity of list) dataSource.entities.remove(entity);
    return [];
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
    clear() {
      boxEntities = drop(boxEntities);
      areaEntities = drop(areaEntities);
      planEntities = drop(planEntities);
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
