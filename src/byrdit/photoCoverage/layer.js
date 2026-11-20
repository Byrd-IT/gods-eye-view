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
    const positions = state.photos.filter(
      (p) =>
        p.placed &&
        Number.isFinite(p.lat) &&
        Number.isFinite(p.lon) &&
        (!state.visibleNames || state.visibleNames.has(p.name)),
    );
    const cartographics = positions.map((p) =>
      Cesium.Cartographic.fromDegrees(p.lon, p.lat),
    );
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
      terrain.length !== positions.length ||
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
    positions.forEach((p, i) => {
      const status = state.discarded.has(p.name)
        ? Cesium.Color.GRAY
        : p.flags?.length
          ? Cesium.Color.MAGENTA
          : Cesium.Color.CYAN;
      const position = Cesium.Cartesian3.fromDegrees(
        p.lon,
        p.lat,
        modelHeight(p.z, state.meta.ground_z, terrain[i].height),
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
          h = modelHeight(p.z, state.meta.ground_z, terrain[i].height);
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
        return projected
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
