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

import { createOdmRequestGateResource } from './odmRequestGate.js';

export const FT_TO_M = 0.3048;
const MIB = 1024 * 1024;
const MAX_ALIGN_M = 300;
export const DESKTOP_SSE = 24;
// The desktop cache budget the ODM tileset shipped with before phone mode
// existed; passing `undefined` instead would silently adopt Cesium 1.138's
// own 512 MiB + 512 MiB defaults and change desktop behaviour.
export const DESKTOP_CACHE_BYTES = 256 * MIB;
export const DESKTOP_CACHE_OVERFLOW_BYTES = 256 * MIB;

/**
 * Phone mode: what changes when the layer runs on a phone.
 *   - the tileset loads coarse (a slow start within the owner-approved band)
 *     and refines to the sharpest SSE in the owner band once it has settled
 *     (a quick usable layer, band-wide quality afterwards). Phone mode never
 *     leaves 64-96; the desktop SSE is restored only when phone mode is off.
 *   - the tileset runs on a 64 MiB cache with no overflow: under memory
 *     pressure Cesium spills, and spilled tiles reload — a phone is better
 *     off holding a smaller set steady;
 *   - every request this tileset makes is gated per tileset: a concurrency
 *     cap (inFlightCap simultaneous requests, counting from hand-over into
 *     Cesium's scheduler to completion) plus a pressure pause that starts
 *     NO new loads while engaged. The mechanism is the Cesium-supported
 *     Resource-subclass hook (the same one IonResource uses, see
 *     odmRequestGate.js): only this tileset's own derived fetch chain passes
 *     through it, so the shared RequestScheduler is never written and
 *     nothing else on the page origin is affected.
 *   - pressure does NOT coarsen anything and the pause IS the gate: under
 *       * heap: used/limit JS heap ratio from Chrome's performance.memory
 *         (or an injected `heapProbe` in tests), or
 *       * loaded tiles: `tileset.statistics.numberOfTilesWithContentReady`,
 *     no new request starts; already-started requests drain, and queued
 *     requests wait (their Request objects live on, so Cesium's own
 *     out-of-view cancellation clears stale ones). Release requires every
 *     signal back under its (lower) resume threshold, then fetching
 *     resumes under the same cap. The queued-work count from
 *     `tileset.loadProgress` is monitored but is deliberately NOT a
 *     press trigger any more: with a gate, requests waiting in the gate
 *     appear in Cesium's pending count and do not drain while the pause is
 *     held, so a queue-signal press could never release — pressing on it
 *     would deadlock the release path. The cap itself already bounds the
 *     in-flight work the queue signal used to catch.
 *     Quality is never a pressure lever (no SSE coarsening on press, no
 *     restoration on release); the owner band 64-96 is only traversed by
 *     the coarse(80) -> refined(64) settle pass and the Fly-to coarsening.
 *     Never `show = false` for pressure: Cesium 1.138's updateForPass
 *     returns before the tile queue when show is false, which strands
 *     pending work, loadProgress and the gate's own release path. With show
 *     kept true the update keeps running, the queue keeps reporting, and
 *     the pump keeps ticking — every press and release path re-evaluates
 *     through the same `_syncPressure` with no await, lock or promise
 *     pause, so a deadlock is not reachable.
 *   - the process-wide RequestScheduler is never written: desktop Cesium
 *     defaults (`maximumRequestsPerServer`, `requestsByServer`) stay as
 *     Cesium ships them, for phones too; the per-tileset cache, SSE and
 *     the gate below are the whole story.
 *
 *   - the `cacheBytes`/`maximumCacheOverflowBytes` pair is the tile *cache*
 * budget, not a hard cap on the process: decoded GPU/upload buffers and other
 * features' use of the process are outside it. What stops runaway memory here
 * is the pressure gate (the two signals above), which keeps the cache itself
 * from ever spilling.
 */
export const PHONE_MEDIA_QUERY = '(max-width: 820px)';
export const PHONE_COARSE_QUERY = '(pointer: coarse)';
export const PHONE_LIMITS = {
  initialError: 80, // coarse first (owner band 64-96)
  fineError: DESKTOP_SSE,
  // Refined phone quality: the sharpest edge of the owner band. Phone mode
  // never leaves 64-96 while it is on; `fineError` returns only when phone
  // mode is switched off.
  phoneFineError: 64,
  cacheBytes: 64 * MIB,
  cacheOverflowBytes: 0,
  inFlightCap: 24,
  resumeFraction: 0.5,
  heapPressureFraction: 0.9, // used >= 90% of the JS heap = stop new requests
  heapResumeFraction: 0.8, // ... release again < 80% (hysteresis)
  loadedTileCap: 400,
};

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
  const query =
    typeof win?.matchMedia === 'function' ? win.matchMedia.bind(win) : null;
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
    requestGateFactory = createOdmRequestGateResource, // per-tileset request cap
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
    /** Per-tileset request gate (phone only): cap + pressure pause. */
    this.requestGateFactory = requestGateFactory;
    this._gate = null;
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
        // Phones fetch through a per-tileset gate (request cap + pressure
        // pause) carried on the tileset's own Resource chain — never via
        // shared scheduler state. A fake Cesium (or one without Resource)
        // yields a null gate and the plain URL; the desktop URL is never
        // wrapped: desktop behaviour is byte-for-byte what it was.
        let tilesetUrl = entry.url;
        if (this.phoneActive) {
          try {
            const gateBundle = this.requestGateFactory(Cesium, entry.url, {
              maxInFlight: this.phoneLimits.inFlightCap,
            });
            this._gate = gateBundle?.gate ?? null;
            if (gateBundle) tilesetUrl = gateBundle.resource;
          } catch {
            this._gate = null; // a broken gate falls back to the plain URL
          }
        }
        const tileset = await Cesium.Cesium3DTileset.fromUrl(tilesetUrl, {
          // Photo meshes are heavy: stay coarse until the camera is close.
          // A phone starts even coarser and refines down after settling.
          maximumScreenSpaceError: this.phoneActive
            ? this.phoneLimits.initialError
            : DESKTOP_SSE,
          // Explicit both ways: `undefined` would silently adopt Cesium's
          // built-in 512 MiB + 512 MiB defaults and change the desktop budget.
          cacheBytes: this.phoneActive
            ? this.phoneLimits.cacheBytes
            : DESKTOP_CACHE_BYTES,
          maximumCacheOverflowBytes: this.phoneActive
            ? this.phoneLimits.cacheOverflowBytes
            : DESKTOP_CACHE_OVERFLOW_BYTES,
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
        // Nothing half-loaded may keep drawing, requesting frames or gate
        // state behind: drop the tileset/pump/listeners, the request gate
        // AND the pressure state (a failed tileset can never settle or
        // release the gate).
        this._releaseTileset();
        this._queued = 0;
        this._heapRatio = null;
        this._pressed = false;
        this._refined = false;
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
   * The phone gate, the single funnel for the pressure signals. Pressing
   * takes a signal (heap or loaded tiles) over its engage threshold;
   * releasing requires both back under their resume thresholds. The press
   * is a real per-tileset request pause: the tileset's own gate stops
   * handing over or starting any new request, started requests drain, and
   * the page origin's other users (imagery, terrain, the buildings
   * tileset) are untouched — no scheduler state is consulted or written,
   * and quality never coarsens with pressure. Synchronous
   * against the show gate — no awaits — so a deadlock is not reachable, and
   * the pump restarts on release (releases arrive via a loadProgress event
   * or the still-running monitor tick).
   */
  _syncPressure() {
    if (!this.phoneActive || this.destroyed || !this.tileset) return;
    const f = this.phoneLimits;
    const { resumeFraction } = f;
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
    const pressed = hOver || tOver;
    if (pressed === this._pressed) return;
    this._pressed = pressed;
    if (pressed) {
      // Stop NEW loads on this tileset; started requests drain, queued ones
      // wait and can be cancelled by Cesium's own out-of-view path.
      this._gate?.setPaused(true);
    } else {
      this._gate?.setPaused(false); // queued work resumes under the cap
      // Finish the coarse -> fine pass if the monitor is not already on it
      // (a release that arrived between settle ticks still gets its refine).
      this._pump();
    }
  }

  /** The single place the tileset's visibility is decided from. */
  _syncShow() {
    if (!this.tileset || this.destroyed) return;
    // show=false must never be a pressure stop: Cesium's updateForPass
    // (1.138) returns before the tile queue with show false, which strands
    // pending work and loadProgress. Pressure pauses new LOADS through the
    // tileset's own request gate instead; the tileset only hides while it
    // is not ready.
    const drawn = this.status === 'ready';
    if (this.tileset.show !== drawn) {
      this.tileset.show = drawn;
      this.viewer.scene.requestRender?.();
    }
  }

  /** Coarse -> fine: adopt the desktop screen space error. */
  _refine() {
    const tileset = this.tileset;
    if (!tileset || !this.phoneActive) return false;
    if (tileset.maximumScreenSpaceError === this.phoneLimits.phoneFineError) {
      return false;
    }
    tileset.maximumScreenSpaceError = this.phoneLimits.phoneFineError;
    this.viewer.scene.requestRender?.();
    return true;
  }

  /** Allow phone mode off (and back on): releases pressure and quality. */
  setPhoneMode(enabled) {
    const on = enabled === true;
    if (on === this.phoneActive) return;
    this.phoneActive = on;
    this._pressed = false;
    this._refined = false;
    this._queued = 0;
    this._heapRatio = null;
    this._gate?.setPaused(false); // no stranded pause across a mode switch
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
      // A phone coarsens for the flight: a jump across the map must not queue
      // the whole model fine-quality right away. The layer refines back to
      // phone quality once it has settled in the new view again (the
      // camera moveEnd pump + pressure release path both call _refine).
      if (this.phoneActive) {
        // Coarsen for the flight ...
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
    // The request gate dies with the tileset: queued (never started)
    // requests are rejected, the scheduler event subscription is detached.
    try {
      this._gate?.destroy();
    } catch {
      /* a broken gate cannot hold up teardown */
    }
    this._gate = null;
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
