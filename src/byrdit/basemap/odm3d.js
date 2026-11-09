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
export const DESKTOP_SSE = 24;

const MIB = 1024 * 1024;

/**
 * Phone mode: what changes when the layer runs on a phone.
 *   - the tileset loads coarse (a slow start within the owner-approved band)
 *     and refines to the desktop SSE once it has settled (a quick usable
 *     layer, full quality afterwards);
 *   - the tileset runs on a 64 MiB cache with no overflow: under memory
 *     pressure Cesium spills, and spilled tiles reload — a phone is better
 *     off holding a smaller set steady;
 *   - tile downloading stops under any of three pressures and new requests
 *     resume only when every one of them has sunk under its hysteresis
 *     threshold (engaging above the cap, releasing below the resume line):
 *       * queued work: pending + processing requests reported by
 *         `tileset.loadProgress`,
 *       * heap: used/limit JS heap ratio from Chrome's performance.memory
 *         (or an injected `heapProbe` in tests),
 *       * loaded tiles: `tileset.statistics.numberOfTilesWithContentReady`.
 *     The stop is a `show = false` gate: with `preloadWhenHidden` false (the
 *     default) a hidden tileset requests nothing new, while requests already
 *     in flight finish draining. The frame pump keeps ticking while pressed,
 *     so a pressed tileset always wakes up again: every release path
 *     (loadProgress event, monitor tick) re-evaluates through the same
 *     `_syncPressure` — there is no await, lock or promise anywhere between
 *     the pressure signal and the show gate, so a deadlock is not reachable.
 *
 * The `cacheBytes`/`maximumCacheOverflowBytes` pair is the tile *cache*
 * budget, not a hard cap on the process: decoded GPU/upload buffers and other
 * features' use of the process are outside it. What stops runaway memory here
 * is the pressure gate (three signals above), which keeps the cache itself
 * from ever spilling.
 *
 * Global scheduler: Cesium RequestScheduler is process-global and not
 * tileset-aware; there is no per-tileset request knob (confirmed against the
 * Cesium source: `maximumSimultaneousTileLoads`-style options do not exist).
 * The only supported throttling axes are `maximumRequestsPerServer` and the
 * per-server override map `requestsByServer[<host:port>]`. Phone layers use
 * `requestsByServer[location.host]` so the cap lands exactly on the server
 * the ODM tiles arrive from (they are same-origin), and fall back to
 * `maximumRequestsPerServer` when no host can be read. Both are mutated only
 * while phone layers are active, reference-counted so several phone layers
 * stack and the last release restores the exact original state. Desktop
 * layers never touch it.
 */
export const PHONE_MEDIA_QUERY = '(max-width: 820px)';
export const PHONE_COARSE_QUERY = '(pointer: coarse)';
export const PHONE_LIMITS = {
  initialError: 80, // coarse first (owner band 64-96)
  fineError: DESKTOP_SSE,
  cacheBytes: 64 * MIB,
  cacheOverflowBytes: 0,
  inFlightCap: 24,
  resumeFraction: 0.5,
  heapPressureFraction: 0.9, // used >= 90% of the JS heap = stop new requests
  heapResumeFraction: 0.8, // ... release again < 80% (hysteresis)
  loadedTileCap: 400,
  // Same-origin fallback when no host can be read (see acquireSchedulerThrottle).
  schedulerRequestsPerServer: 12,
};

// Module-global reference count over the shared RequestScheduler: the first
// acquirer snapshots the originals and applies the phone throttle; the last
// releaser restores exactly those values. Releases are idempotent, so an
// exception during teardown cannot restore twice.
let schedulerRefs = 0;
let schedulerSaved = null;

/** The scheduler's server key for this page's origin (<host:port>), or null. */
export function schedulerServerKey() {
  const host = globalThis.location?.host;
  return typeof host === 'string' && host !== '' ? host : null;
}

/**
 * Apply the phone throttle on the shared RequestScheduler and return the
 * release function. The cap lands on `requestsByServer[serverKey]` when a
 * server key is given/read (the documented per-server override the scheduler
 * consults at request time), else on `maximumRequestsPerServer`. The save
 * records whether the key existed before; restoring deletes a key that was
 * absent instead of leaving the throttle behind. Reference-counted and
 * exception-safe; a null scheduler returns a no-op release so a caller never
 * has to branch.
 */
export function acquireSchedulerThrottle(scheduler, serverKey = null) {
  if (!scheduler) return () => {};
  if (schedulerRefs === 0) {
    schedulerSaved = {
      maximumRequestsPerServer: scheduler.maximumRequestsPerServer,
      fallback: false,
      keys: new Map(), // key -> { existed, value } snapshot per server
    };
  }
  if (serverKey != null) {
    // Per-server cap: scoped to the server the tiles arrive from.
    if (!schedulerSaved.keys.has(serverKey)) {
      const map = scheduler.requestsByServer ?? (scheduler.requestsByServer = {});
      schedulerSaved.keys.set(serverKey, {
        existed: Object.prototype.hasOwnProperty.call(map, serverKey),
        value: map[serverKey],
      });
      map[serverKey] = PHONE_LIMITS.schedulerRequestsPerServer;
    }
  } else if (schedulerRefs === 0) {
    // No host readable (unusual): throttle the global per-server default.
    schedulerSaved.fallback = true;
    scheduler.maximumRequestsPerServer = PHONE_LIMITS.schedulerRequestsPerServer;
  }
  schedulerRefs += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    schedulerRefs -= 1;
    if (schedulerRefs === 0 && schedulerSaved) {
      const saved = schedulerSaved;
      if (saved.fallback) {
        scheduler.maximumRequestsPerServer = saved.maximumRequestsPerServer;
      }
      for (const [key, snap] of saved.keys) {
        if (snap.existed) scheduler.requestsByServer[key] = snap.value;
        else delete scheduler.requestsByServer[key];
      }
      schedulerSaved = null;
    }
  };
}

/** How many phone layers currently hold the scheduler. */
export function schedulerThrottleHolders() {
  return schedulerRefs;
}

/**
 * Is this a phone-shaped viewport? Takes a `window.matchMedia`-shaped
 * function (or null): never the user agent, and a missing or throwing
 * detector means "desktop" rather than a crash.
 */
export function isPhoneView(matchMedia) {
  if (typeof matchMedia !== 'function') return false;
  try {
    return matchMedia(PHONE_MEDIA_QUERY).matches === true;
  } catch {
    return false;
  }
}

/**
 * No-argument form overlays.js picks up as `isPhoneEnvironment`: it reads
 * the browser itself, and a phone is small viewport OR coarse pointer OR
 * scarce device memory (never the user agent). Node keeps answering false.
 */
export function isPhoneEnvironment() {
  const win = globalThis.window;
  const query = typeof win?.matchMedia === 'function' ? win.matchMedia.bind(win) : null;
  const deviceMemory = globalThis.navigator?.deviceMemory;
  return matchesPhoneProfile(query, deviceMemory);
}

/**
 * The decision shared by `isPhoneEnvironment` and the layer: small width OR
 * coarse pointer OR deviceMemory <= 4. Every signal is best-effort: a
 * missing or throwing detector simply does not vote.
 */
export function matchesPhoneProfile(matchMedia, deviceMemory) {
  if (typeof deviceMemory === 'number' && deviceMemory <= 4) return true;
  if (isPhoneView(matchMedia)) return true;
  if (typeof matchMedia !== 'function') return false;
  try {
    return matchMedia(PHONE_COARSE_QUERY)?.matches === true;
  } catch {
    return false;
  }
}

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
   *   sampleTerrain?: Function, heapProbe?: Function|null,
   *   deviceMemory?: number}} options
   */
  constructor({
    Cesium,
    viewer,
    entry,
    sampleTerrain = null,
    timers = globalThis,
    phoneMode = null, // true = on, false = off, null = detect (see below)
    matchMedia = globalThis?.matchMedia ?? null,
    deviceMemory = globalThis.navigator?.deviceMemory,
    heapProbe = null, // () => ({ used, limit }); default: performance.memory
    phoneLimits = PHONE_LIMITS,
  }) {
    this.timers = timers;
    this._pumpTimer = null;
    this._settled = 0;
    this._offs = [];
    this.Cesium = Cesium;
    this.viewer = viewer;
    this.entry = entry;
    this.sampleTerrain = sampleTerrain;
    this.phoneLimits = phoneLimits;
    this._matchMedia = matchMedia;
    this.deviceMemory = deviceMemory;
    this.heapProbe = heapProbe;
    this.phoneActive =
      phoneMode === null
        ? matchesPhoneProfile(matchMedia, deviceMemory)
        : phoneMode === true;
    this.tileset = null;
    this.status = 'idle'; // idle | loading | ready | failed
    this.alignedM = 0;
    this.cutFt = null;
    this.opacity = 1;
    this.destroyed = false;
    this._loading = null;
    /** Phone pressure: queued work, heap ratio, loaded tiles + the gate. */
    this._queued = 0;
    this._heapRatio = null;
    this._pressed = false;
    this._refined = false;
    this._throttleRelease = null;
  }

  get ready() {
    return this.status === 'ready' && !!this.tileset;
  }

  /** Hold the global scheduler while this phone layer is active. */
  _acquireThrottle() {
    if (!this.phoneActive || this._throttleRelease) return;
    this._throttleRelease = acquireSchedulerThrottle(
      this.Cesium.RequestScheduler,
      schedulerServerKey(),
    );
  }

  _releaseThrottle() {
    try {
      this._throttleRelease?.();
    } catch {
      /* a release is idempotent; this cannot fail, be defensive anyway */
    }
    this._throttleRelease = null;
  }

  async load() {
    if (this.destroyed) return;
    if (this._loading) return this._loading;
    this.status = 'loading';
    // Throttle the shared scheduler before the tileset issues anything.
    this._acquireThrottle();
    this._loading = (async () => {
      try {
        const { Cesium, viewer, entry } = this;
        const tileset = await Cesium.Cesium3DTileset.fromUrl(entry.url, {
          // Photo meshes are heavy: stay coarse until the camera is close.
          // A phone starts even coarser and refines down after settling.
          maximumScreenSpaceError: this.phoneActive
            ? this.phoneLimits.initialError
            : DESKTOP_SSE,
          cacheBytes: this.phoneActive
            ? this.phoneLimits.cacheBytes
            : undefined,
          maximumCacheOverflowBytes: this.phoneActive
            ? this.phoneLimits.cacheOverflowBytes
            : undefined,
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
          tileset.loadProgress?.addEventListener?.((pending, processing) =>
            this._onLoadProgress(pending, processing),
          ),
          viewer.camera?.moveEnd?.addEventListener?.(() => this._pump()),
          // The terrain can come back (or change) after the model was placed:
          // place it again on the terrain that is there now.
          viewer.scene?.terrainProviderChanged?.addEventListener?.(() =>
            this._realign(),
          ),
        );
        this._pump();
        await this._align();
        if (this.destroyed) return;
        this._applyCut();
        this._applyOpacity();
        this.status = 'ready';
        this._syncShow(); // respects an already-engaged pressure stop
        viewer.scene.requestRender?.();
      } catch (error) {
        // Nothing half-loaded may keep drawing or requesting frames.
        this._releaseTileset();
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
      if (this.phoneActive) this._probePressure();
      this._settled = tileset.tilesLoaded === true ? this._settled + 1 : 0;
      if (this._settled >= 3 && !this._pressed) {
        // Coarse first on a phone; refine once everything has settled. A
        // settled-but-pressed tileset stays coarse: it refines on the
        // pressure release instead (the release restarts the pump).
        if (this.phoneActive && !this._refined) {
          this._refined = this._refine();
        }
        this._stopPump();
      }
    }, 250);
    // A pending frame request must never keep a node process alive (tests).
    this._pumpTimer?.unref?.();
  }

  _stopPump() {
    if (this._pumpTimer === null) return;
    this.timers.clearInterval(this._pumpTimer);
    this._pumpTimer = null;
  }

  /**
   * Read the two pressure signals the tileset does not push to us (JS heap
   * and loaded-tile count). Runs on the monitor tick only; failures leave
   * the old reading, never press or release by themselves.
   */
  _probePressure() {
    if (!this.phoneActive || !this.tileset) return;
    const ratio = this._heapUsage();
    if (ratio !== null) this._heapRatio = ratio;
    this._syncPressure();
  }

  /** Fraction of the JS heap in use, or null when unknowable here. */
  _heapUsage() {
    try {
      if (this.heapProbe) {
        const h = this.heapProbe();
        if (h?.limit > 0 && typeof h?.used === 'number' && h.limit > 0) {
          return h.used / h.limit;
        }
        return null;
      }
      const m = globalThis.performance?.memory;
      if (m?.jsHeapSizeLimit > 0 && typeof m.usedJSHeapSize === 'number') {
        return m.usedJSHeapSize / m.jsHeapSizeLimit;
      }
    } catch {
      /* no memory readings on this platform */
    }
    return null;
  }

  /** Tile work queued by this tileset: pending + processing (1.138 event). */
  _onLoadProgress(pending, processing) {
    if (!this.phoneActive) return;
    this._queued =
      (typeof pending === 'number' && Number.isFinite(pending) ? pending : 0) +
      (typeof processing === 'number' && Number.isFinite(processing)
        ? processing
        : 0);
    this._syncPressure();
  }

  /**
   * The phone gate, the single funnel for all pressure signals. Pressing
   * takes any one signal over its engage threshold; releasing requires the
   * queue AND heap AND loaded tiles all back under their resume thresholds.
   * Synchronous against the show gate — no awaits — so a deadlock is not
   * reachable, and the pump restarts on release (releases never come from a
   * stopped pump's void: they arrive via a loadProgress event or the
   * still-running monitor tick).
   */
  _syncPressure() {
    if (!this.phoneActive || this.destroyed || !this.tileset) return;
    const f = this.phoneLimits;
    const { inFlightCap, resumeFraction } = f;
    const qOver =
      this._queued >
      (this._pressed ? Math.round(inFlightCap * resumeFraction) : inFlightCap);
    const hOver =
      this._heapRatio !== null &&
      (this._pressed
        ? this._heapRatio >= f.heapResumeFraction
        : this._heapRatio >= f.heapPressureFraction);
    const loaded = this.tileset.statistics?.numberOfTilesWithContentReady;
    const tOver =
      typeof loaded === 'number' &&
      Number.isFinite(loaded) &&
      loaded >
        (this._pressed
          ? Math.round(f.loadedTileCap * resumeFraction)
          : f.loadedTileCap);
    const pressed = qOver || hOver || tOver;
    if (pressed === this._pressed) return;
    this._pressed = pressed;
    this._syncShow();
    if (!pressed) {
      if (!this._refined && this.status === 'ready') this._refine();
      this._pump(); // finish the coarse -> fine pass
    }
  }

  /** The single place the tileset's visibility is decided from. */
  _syncShow() {
    if (!this.tileset || this.destroyed) return;
    const drawn = this.status === 'ready' && !this._pressed;
    if (this.tileset.show !== drawn) {
      this.tileset.show = drawn;
      this.viewer.scene.requestRender?.();
    }
  }

  /** Coarse -> fine: adopt the desktop screen space error. */
  _refine() {
    const tileset = this.tileset;
    if (!tileset || !this.phoneActive) return false;
    if (tileset.maximumScreenSpaceError === this.phoneLimits.fineError) {
      return false;
    }
    tileset.maximumScreenSpaceError = this.phoneLimits.fineError;
    this.viewer.scene.requestRender?.();
    return true;
  }

  /** Allow phone mode off (and back on): releases pressure, quality, throttle. */
  setPhoneMode(enabled) {
    const on = enabled === true;
    if (on === this.phoneActive) return;
    this.phoneActive = on;
    this._pressed = false;
    this._refined = false;
    if (!on) this._queued = 0;
    if (!on) {
      this._heapRatio = null;
      this._releaseThrottle();
    } else {
      this._acquireThrottle();
    }
    if (this.tileset && !this.destroyed) {
      this.tileset.maximumScreenSpaceError = on
        ? this.phoneLimits.initialError
        : this.phoneLimits.fineError;
      if (on && this.status === 'ready') this._pump();
      this._syncShow();
    }
  }

  /** Align again; one at a time, and once more if asked while running. */
  async _realign() {
    if (this.destroyed || !this.tileset) return;
    if (this._aligning) {
      this._alignAgain = true;
      return;
    }
    this._aligning = true;
    try {
      do {
        this._alignAgain = false;
        await this._align();
      } while (this._alignAgain && !this.destroyed && this.tileset);
    } finally {
      this._aligning = false;
    }
    this.viewer.scene.requestRender?.();
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
    const { Cesium, viewer, entry, tileset } = this;
    // The drawn model knows its real place and size (terrain lift included);
    // a lat/lon rectangle would ignore the ground height.
    if (
      tileset?.boundingSphere &&
      Cesium.HeadingPitchRange &&
      viewer.camera.flyToBoundingSphere
    ) {
      viewer.camera.flyToBoundingSphere(tileset.boundingSphere, {
        duration: 1.5,
        offset: new Cesium.HeadingPitchRange(
          0,
          Cesium.Math.toRadians(-40),
          tileset.boundingSphere.radius * 2.2,
        ),
      });
      // A phone keeps the scheduler throttled while flying coarse: the user
      // is moving toward tiles that still have to load.
      if (this.phoneActive) {
        this._acquireThrottle();
        // Coarsen for the flight: a jump across the map must not queue the
        // whole model fine-quality right away. The layer refines back to
        // desktop quality once it has settled in the new view again (the
        // camera moveEnd pump + pressure release path both call _refine).
        if (this.status === 'ready') {
          this._refined = false;
          if (!this._pressed) {
            tileset.maximumScreenSpaceError = this.phoneLimits.initialError;
            this._pump();
          }
        }
      }
      return;
    }
    const [w, s, e, n] = entry.bounds;
    viewer.camera.flyTo({
      destination: Cesium.Rectangle.fromDegrees(w, s, e, n),
      duration: 1.5,
    });
  }

  /** Stop the frame pump, drop the listeners, take the tileset out of the scene. */
  _releaseTileset() {
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

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._releaseTileset();
    this._releaseThrottle();
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
