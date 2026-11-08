/**
 * Our own OpenDroneMap 3D models (3D Tiles) as Map layers.
 *
 * Pure helpers plus one loader; Cesium is always passed in. Nothing here
 * touches a URL other than the same-origin /basemap/odm3d/<id>/tileset.json
 * the server composed, and nothing measures heights from Google tiles: the
 * ground height of a build comes from its own bare-earth model (ODM DTM)
 * and is published with the layer.
 *
 * Heights: an ODM tileset is georeferenced (root transform = ENU frame at
 * ellipsoid height 0), so a point's local z is its height in the model's own
 * vertical datum. `groundM` is the median DTM height in that datum.
 *   - ground alignment: the model is lifted by (terrain height - groundM) so
 *     its ground sits on the viewer's terrain (heightOffsetM is a manual
 *     correction on top, from the manifest);
 *   - canopy cut: one horizontal clipping plane at groundM + cut. It is a
 *     view setting only: the stored files never change and "Off" restores
 *     the full model.
 */

export const FT_TO_M = 0.3048;
const MAX_ALIGN_M = 300;

export const feetToMeters = (ft) => ft * FT_TO_M;

/** Median of the finite numbers, or null. */
export function median(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x));
  if (!v.length) return null;
  v.sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * Metres to lift a model so its ground meets the terrain, from sampled
 * terrain heights. Null when there is nothing usable (model stays put).
 * @param {number} groundM median bare-ground height of the model
 * @param {Array<number|null|undefined>} terrainHeights terrain under the model
 */
export function alignmentOffset(groundM, terrainHeights) {
  const valid = (terrainHeights ?? []).filter(
    (h) => typeof h === 'number' && Number.isFinite(h),
  );
  // Too few samples, or every one exactly 0: a flat ellipsoid answering for
  // missing terrain. Lifting the model by that would bury it.
  if (valid.length < 3 || valid.every((h) => h === 0)) return null;
  const terrain = median(valid);
  if (terrain === null || !Number.isFinite(groundM)) return null;
  const offset = terrain - groundM;
  return Math.abs(offset) <= MAX_ALIGN_M ? offset : null;
}

/**
 * Height of the canopy cut in the tileset's local frame (same datum as
 * groundM), or null when the cut is off.
 * @param {number} groundM
 * @param {number|null} cutFt feet above local ground; null/0 = off
 */
export function cutHeightLocal(groundM, cutFt) {
  if (!Number.isFinite(cutFt) || cutFt <= 0) return null;
  return groundM + feetToMeters(cutFt);
}

/** Opacity -> tile style colour expression; null = no style (opaque). */
export function opacityStyleColor(opacity) {
  const a = Math.min(1, Math.max(0, Number(opacity)));
  if (!Number.isFinite(a) || a >= 1) return null;
  return `color('white', ${a.toFixed(2)})`;
}

/**
 * Sample the terrain under a build: its centre and the middle of each
 * quadrant, so one tree-filled corner cannot decide the alignment.
 */
export function samplePoints(bounds) {
  const [w, s, e, n] = bounds;
  const xs = [w + (e - w) * 0.25, w + (e - w) * 0.5, w + (e - w) * 0.75];
  const ys = [s + (n - s) * 0.25, s + (n - s) * 0.5, s + (n - s) * 0.75];
  const out = [];
  for (const y of ys) for (const x of xs) out.push([x, y]);
  return out;
}

/** Handle for one displayed 3D build. */
export class Odm3dLayer {
  /**
   * @param {{Cesium: object, viewer: object, entry: object,
   *   sampleTerrain?: Function}} options
   */
  constructor({
    Cesium,
    viewer,
    entry,
    sampleTerrain = null,
    timers = globalThis,
  }) {
    this.timers = timers;
    this._pumpTimer = null;
    this._settled = 0;
    this._offs = [];
    this.Cesium = Cesium;
    this.viewer = viewer;
    this.entry = entry;
    this.sampleTerrain = sampleTerrain;
    this.tileset = null;
    this.status = 'idle'; // idle | loading | ready | failed
    this.alignedM = 0;
    this.cutFt = null;
    this.opacity = 1;
    this.destroyed = false;
    this._loading = null;
  }

  get ready() {
    return this.status === 'ready' && !!this.tileset;
  }

  async load() {
    if (this.destroyed) return;
    if (this._loading) return this._loading;
    this.status = 'loading';
    this._loading = (async () => {
      try {
        const { Cesium, viewer, entry } = this;
        const tileset = await Cesium.Cesium3DTileset.fromUrl(entry.url, {
          // Photo meshes are heavy: stay coarse until the camera is close.
          maximumScreenSpaceError: 24,
          cacheBytes: 256 * 1024 * 1024,
          maximumCacheOverflowBytes: 256 * 1024 * 1024,
          show: false,
        });
        if (this.destroyed) {
          tileset.destroy?.();
          return;
        }
        this.tileset = tileset;
        viewer.scene.primitives.add(tileset);
        // GEV draws on demand (requestRenderMode): tile decoding only moves
        // when frames are drawn, so keep frames coming while tiles are
        // pending and after every camera move, then go quiet again.
        this._offs.push(
          tileset.loadProgress?.addEventListener?.(() => this._pump()),
          viewer.camera?.moveEnd?.addEventListener?.(() => this._pump()),
        );
        this._pump();
        await this._align();
        this._applyCut();
        this._applyOpacity();
        tileset.show = true;
        this.status = 'ready';
        viewer.scene.requestRender?.();
      } catch (error) {
        this.status = this.destroyed ? 'idle' : 'failed';
        this.error = String(error?.message ?? error).slice(0, 120);
      }
    })();
    return this._loading;
  }

  /** Request frames every 250 ms until the tileset reports loaded 3 times. */
  _pump() {
    if (this.destroyed || this._pumpTimer !== null) return;
    this._settled = 0;
    this._pumpTimer = this.timers.setInterval(() => {
      const tileset = this.tileset;
      if (this.destroyed || !tileset) return this._stopPump();
      this.viewer.scene.requestRender?.();
      this._settled = tileset.tilesLoaded === true ? this._settled + 1 : 0;
      if (this._settled >= 3) this._stopPump();
    }, 250);
    // A pending frame request must never keep a node process alive (tests).
    this._pumpTimer?.unref?.();
  }

  _stopPump() {
    if (this._pumpTimer === null) return;
    this.timers.clearInterval(this._pumpTimer);
    this._pumpTimer = null;
  }

  async _align() {
    const { Cesium, entry } = this;
    const model = entry.model;
    let lift = model.heightOffsetM ?? 0;
    try {
      if (this.sampleTerrain) {
        const heights = await this.sampleTerrain(samplePoints(entry.bounds));
        const offset = alignmentOffset(model.groundM, heights);
        if (offset !== null) lift += offset;
      }
    } catch {
      /* no terrain: keep the manifest offset only */
    }
    this.alignedM = lift;
    if (this.destroyed || !this.tileset) return;
    const [w, s, e, n] = entry.bounds;
    const centre = Cesium.Cartesian3.fromDegrees((w + e) / 2, (s + n) / 2, 0);
    const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(
      centre,
      new Cesium.Cartesian3(),
    );
    const shift = Cesium.Cartesian3.multiplyByScalar(
      up,
      lift,
      new Cesium.Cartesian3(),
    );
    this.tileset.modelMatrix = Cesium.Matrix4.fromTranslation(shift);
  }

  setCut(cutFt) {
    const next = Number.isFinite(cutFt) && cutFt > 0 ? cutFt : null;
    if (next === this.cutFt && this._cutApplied) return;
    this.cutFt = next;
    this._applyCut();
  }

  _applyCut() {
    const { Cesium, tileset, entry } = this;
    if (!tileset || this.destroyed) return;
    this._cutApplied = true;
    const height = cutHeightLocal(entry.model.groundM, this.cutFt);
    if (height === null) {
      if (tileset.clippingPlanes) tileset.clippingPlanes.enabled = false;
      this.viewer.scene.requestRender?.();
      return;
    }
    // Plane (0,0,-1,d) removes everything with z > d, in the tileset's
    // local frame (ENU at the root transform): a level cut at `height`.
    // The tileset's own lift is applied by the frame, so `height` stays in
    // the model's datum.
    const plane = new Cesium.ClippingPlane(
      new Cesium.Cartesian3(0, 0, -1),
      height,
    );
    if (!tileset.clippingPlanes) {
      tileset.clippingPlanes = new Cesium.ClippingPlaneCollection({
        planes: [plane],
        edgeWidth: 0,
      });
    } else {
      tileset.clippingPlanes.removeAll();
      tileset.clippingPlanes.add(plane);
    }
    tileset.clippingPlanes.enabled = true;
    this.viewer.scene.requestRender?.();
  }

  setOpacity(opacity) {
    if (opacity === this.opacity && this._opacityApplied) return;
    this.opacity = opacity;
    this._applyOpacity();
  }

  _applyOpacity() {
    const { Cesium, tileset } = this;
    if (!tileset || this.destroyed) return;
    this._opacityApplied = true;
    const color = opacityStyleColor(this.opacity);
    tileset.style = color ? new Cesium.Cesium3DTileStyle({ color }) : undefined;
    this.viewer.scene.requestRender?.();
  }

  /** Camera to the build (used by the panel's "Fly to"). */
  flyTo() {
    const { Cesium, viewer, entry } = this;
    const [w, s, e, n] = entry.bounds;
    viewer.camera.flyTo({
      destination: Cesium.Rectangle.fromDegrees(w, s, e, n),
      duration: 1.5,
    });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._stopPump();
    for (const off of this._offs) {
      try {
        off?.();
      } catch {
        /* listener already gone */
      }
    }
    this._offs = [];
    const { tileset, viewer } = this;
    this.tileset = null;
    if (tileset) {
      try {
        viewer.scene.primitives.remove(tileset);
      } catch {
        /* already gone */
      }
      if (!tileset.isDestroyed?.()) tileset.destroy?.();
    }
    viewer.scene.requestRender?.();
  }
}

/** Terrain sampler over the viewer's terrain provider; heights or []. */
export function terrainSampler(Cesium, viewer) {
  return async (points) => {
    const provider = viewer?.terrainProvider;
    if (!provider || !Cesium.sampleTerrainMostDetailed) return [];
    const carto = points.map(([lon, lat]) =>
      Cesium.Cartographic.fromDegrees(lon, lat),
    );
    const done = await Cesium.sampleTerrainMostDetailed(provider, carto);
    return done.map((c) => c.height);
  };
}
