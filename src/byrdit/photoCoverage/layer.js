import { cellCorners, modelHeight, modelLatLon } from './coordinates.js';
import { coverageColor } from './coverageCore.js';
import { footprintMask } from './footprintMask.js';

/** Ground coverage and camera positions; caller owns the primitive collection. */
export async function createCoverageLayer({
  Cesium,
  viewer,
  state,
  onPick = () => {},
}) {
  if (!Cesium || !viewer || !state) throw new Error('Coverage map unavailable');
  const collection = viewer.scene.primitives.add(
    new Cesium.PrimitiveCollection(),
  );
  const cameras = new Cesium.CustomDataSource('Photo coverage cameras');
  let destroyed = false,
    handler;
  try {
    await viewer.dataSources.add(cameras);
    const visible = (p) =>
      !state.visibleNames || state.visibleNames.has(p.name);
    const positions = state.photos.filter(
      (p) =>
        p.placed &&
        Number.isFinite(p.lat) &&
        Number.isFinite(p.lon) &&
        visible(p),
    );
    // GPS-only photos never took part in the reconstruction: they have no
    // solved pose, frustum, footprint or coverage, but they do have a real
    // position and height to show. Missing or malformed fields fail closed.
    const gpsOnly = state.photos.filter(
      (p) =>
        p.placed === false &&
        typeof p.name === 'string' &&
        p.name.length > 0 &&
        Number.isFinite(p.lat) &&
        Number.isFinite(p.lon) &&
        Number.isFinite(p.z) &&
        Math.abs(p.lat) <= 90 &&
        Math.abs(p.lon) <= 180 &&
        visible(p),
    );
    // The solved z coordinates share one model datum. Anchor that datum once
    // at the model origin; sampling at each camera would add terrain slope twice.
    const origin = modelLatLon(state.meta.origin, 0, 0);
    const cartographics =
      positions.length || gpsOnly.length
        ? [Cesium.Cartographic.fromDegrees(origin.lon, origin.lat)]
        : [];
    let terrain;
    try {
      terrain = cartographics.length
        ? await Cesium.sampleTerrainMostDetailed(
            viewer.terrainProvider,
            cartographics,
          )
        : [];
    } catch {
      throw new Error('Terrain height unavailable');
    }
    if (
      terrain.length !== cartographics.length ||
      terrain.some((p) => !Number.isFinite(p.height))
    )
      throw new Error('Terrain height unavailable');
    const byCell = new Map(state.cells.k.map((k, i) => [k, state.counts[i]]));
    const palette = {
      red: Cesium.Color.RED,
      orange: Cesium.Color.ORANGE,
      yellow: Cesium.Color.YELLOW,
      green: Cesium.Color.LIME,
    };
    const instances = [...state.mask].map((key) => {
      const corners = cellCorners(state.cells, state.meta.origin, key),
        a = corners[0],
        b = corners[2];
      const color =
        palette[coverageColor(byCell.get(key) ?? 0)].withAlpha(0.45);
      return new Cesium.GeometryInstance({
        id: { type: 'coverage-cell', key },
        geometry: new Cesium.RectangleGeometry({
          rectangle: Cesium.Rectangle.fromDegrees(a.lon, a.lat, b.lon, b.lat),
          vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
        }),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(color),
        },
      });
    });
    if (instances.length)
      collection.add(
        new Cesium.GroundPrimitive({
          geometryInstances: instances,
          appearance: new Cesium.PerInstanceColorAppearance({
            flat: true,
            translucent: true,
          }),
          asynchronous: true,
        }),
      );
    const footprints = [];
    for (const name of (state.footprintNames ?? []).slice(0, 50)) {
      const index = state.photos.findIndex((p) => p.name === name);
      if (index < 0) continue;
      for (const key of footprintMask(state, index)) {
        const corners = cellCorners(state.cells, state.meta.origin, key),
          a = corners[0],
          b = corners[2];
        footprints.push(
          new Cesium.GeometryInstance({
            id: { type: 'footprint', name },
            geometry: new Cesium.RectangleGeometry({
              rectangle: Cesium.Rectangle.fromDegrees(
                a.lon,
                a.lat,
                b.lon,
                b.lat,
              ),
              vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
            }),
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                Cesium.Color.CYAN.withAlpha(0.24),
              ),
            },
          }),
        );
      }
    }
    if (footprints.length)
      collection.add(
        new Cesium.GroundPrimitive({
          geometryInstances: footprints,
          appearance: new Cesium.PerInstanceColorAppearance({
            flat: true,
            translucent: true,
          }),
          asynchronous: true,
        }),
      );
    const projected = [];
    positions.forEach((p) => {
      const status = state.discarded.has(p.name)
        ? Cesium.Color.GRAY
        : p.flags?.length
          ? Cesium.Color.MAGENTA
          : Cesium.Color.CYAN;
      const position = Cesium.Cartesian3.fromDegrees(
        p.lon,
        p.lat,
        modelHeight(p.z, state.meta.ground_z, terrain[0].height),
      );
      projected.push({ name: p.name, position });
      cameras.entities.add({
        id: `photo:${p.name}`,
        position,
        point: {
          pixelSize: 7,
          color: status,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 1,
        },
        properties: { photoName: p.name },
      });
      // A short horizontal direction V at camera altitude, not a ground-coverage polygon.
      const dx = p.fwd?.[0],
        dy = p.fwd?.[1],
        length = Math.hypot(dx, dy);
      if (Number.isFinite(length) && length > 1e-6) {
        const ux = dx / length,
          uy = dy / length,
          h = modelHeight(p.z, state.meta.ground_z, terrain[0].height);
        const a = modelLatLon(
            state.meta.origin,
            p.x + ux * 10 - uy * 3,
            p.y + uy * 10 + ux * 3,
          ),
          b = modelLatLon(
            state.meta.origin,
            p.x + ux * 10 + uy * 3,
            p.y + uy * 10 - ux * 3,
          );
        cameras.entities.add({
          id: `direction:${p.name}`,
          polyline: {
            positions: [
              Cesium.Cartesian3.fromDegrees(a.lon, a.lat, h),
              position,
              Cesium.Cartesian3.fromDegrees(b.lon, b.lat, h),
            ],
            width: 2,
            material: status,
          },
          properties: { photoName: p.name },
        });
      }
    });
    // Yellow GPS-only markers are click-selectable for details, but they are
    // deliberately absent from projected/screenPoints so box and circle
    // selection can never hand an unplaced name to the server-backed keep set.
    for (const p of gpsOnly) {
      cameras.entities.add({
        id: `photo:${p.name}`,
        position: Cesium.Cartesian3.fromDegrees(
          p.lon,
          p.lat,
          modelHeight(p.z, state.meta.ground_z, terrain[0].height),
        ),
        point: {
          pixelSize: 7,
          color: Cesium.Color.YELLOW,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 1,
        },
        label: { text: 'not placed in this model' },
        properties: { photoName: p.name, placed: false },
      });
    }
    handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((event) => {
      const hit = viewer.scene.pick(event.position);
      const id = hit?.id;
      if (id?.type === 'coverage-cell') onPick({ type: 'cell', key: id.key });
      else if (id?.type === 'footprint')
        onPick({ type: 'photo', name: id.name });
      else if (typeof id?.id === 'string' && id.id.startsWith('photo:'))
        onPick({ type: 'photo', name: id.id.slice(6) });
      else if (typeof id?.id === 'string' && id.id.startsWith('direction:'))
        onPick({ type: 'photo', name: id.id.slice(10) });
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    return {
      screenPoints() {
        const occluder =
          viewer.scene.mode === Cesium.SceneMode.SCENE3D
            ? new Cesium.EllipsoidalOccluder(
                viewer.scene.globe.ellipsoid,
                viewer.camera.positionWC,
              )
            : null;
        return projected
          .filter((p) => !occluder || occluder.isPointVisible(p.position))
          .map((p) => {
            const xy = Cesium.SceneTransforms.worldToWindowCoordinates(
              viewer.scene,
              p.position,
            );
            return xy ? { name: p.name, x: xy.x, y: xy.y } : null;
          })
          .filter(Boolean);
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        handler?.destroy();
        viewer.dataSources.remove(cameras, true);
        viewer.scene.primitives.remove(collection);
      },
    };
  } catch (error) {
    handler?.destroy();
    viewer.dataSources.remove(cameras, true);
    viewer.scene.primitives.remove(collection);
    throw error;
  }
}
