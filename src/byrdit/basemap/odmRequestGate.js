/**
 * A real, per-ODM-tileset request gate for Cesium 1.138: a concurrency cap on
 * this tileset's content requests plus a pressure pause that stops NEW loads
 * while it is engaged. It never touches the shared RequestScheduler, so no
 * other content on the page (imagery, terrain, the buildings tileset, other
 * ODM tilesets) is throttled or starved by it.
 *
 * How this is possible in 1.138 (verified against the installed source):
 *   - Cesium3DTileset.fromUrl() runs every tile content request through the
 *     tileset's own Resource: Cesium3DTile derives its content resource via
 *     `baseResource.getDerivedResource({url})`, and getDerivedResource
 *     creates the derived resource through `this.clone()` (Cesium.js
 *     Resource.prototype.getDerivedResource / clone).
 *   - Every one of those fetches funnels through `resource._makeRequest()`
 *     (Resource.fetch -> _makeRequest -> RequestScheduler.request), which is
 *     exactly the hook Cesium's own IonResource subclass overrides to tag its
 *     requests (IonResource.prototype.clone + _makeRequest): a Resource
 *     subclass that re-clones itself stays the class of the derived resource
 *     chain, so a `_makeRequest` override sees ONLY this tileset's requests
 *     and lets everything else through untouched.
 *   - The gate is a semaphore + pause flag sitting IN FRONT of the scheduler:
 *     a gated request is not handed to RequestScheduler.request() (nor
 *     started over the network) until a slot is free and the pause is open.
 *     Cesium's own caps, priority heap and cancellations keep applying to
 *     requests once handed over. Cesium-created Request objects keep their
 *     identity across the wait, so `tile.cancelRequests()` (which is what
 *     Cesium3DTileset's cancelOutOfViewRequests calls per frame) marks them
 *     cancelled, and the gate drops a cancelled queued entry BEFORE any HTTP
 *     traffic, rejecting its promise (Cesium's processArrayBuffer treats
 *     `request.cancelled` as normal cancellation, not a tile failure).
 *   - Refusals by the underlying scheduler (its own per-server or global caps
 *     already full) are detected and the entry re-queued; the gate re-pumps
 *     on RequestScheduler.requestCompletedEvent, which fires on every
 *     completed request, so nothing is lost and nothing retries hot.
 *
 * What this is NOT: it does not touch the 64 MiB tile cache budget (which
 * stays a cache budget, not a hard memory guarantee) and it counts network
 * requests, never tile bytes.
 */

const DATA_URI_REGEX = /^data:/;
const BLOB_URI_REGEX = /^blob:/;

/** The layer can hold, pause and release this; nothing here is Cesium state. */
export class OdmRequestGate {
  /**
   * @param {{maxInFlight: number}} options
   */
  constructor({ maxInFlight = 24 } = {}) {
    this.maxInFlight = OdmRequestGate.normalizeCap(maxInFlight);
    this.inFlight = 0;
    this.paused = false;
    this.destroyed = false;
    this._queue = [];
    /** Set by the Cesium-side factory; null otherwise (tests/injection). */
    this._detachCompletedEvent = null;
  }

  static normalizeCap(cap) {
    const n =
      typeof cap === 'number' && Number.isFinite(cap) ? Math.floor(cap) : 0;
    return Math.min(Math.max(n, 1), 256);
  }

  /** Requests waiting for a slot or for the pause to lift (never started). */
  get queued() {
    return this._queue.length;
  }

  /**
   * Fetch a gated resource. Returns a promise only when this completes or is
   * refused by the underlying scheduler (which also keeps the entry queued);
   * while an entry waits it holds no bytes, sockets or scheduler slots.
   * @param {object} resource the Cesium Resource instance doing the fetch
   * @param {object} options fetch options (responseType, ...)
   * @param {Function} baseFetch un-gated fetch: (resource, options) => Promise
   * @returns {Promise}
   */
  run(resource, options, baseFetch) {
    const request = resource.request;
    if (
      this.destroyed ||
      (request !== undefined && request.cancelled === true)
    ) {
      return Promise.reject(OdmRequestGate.cancelledError());
    }
    return new Promise((resolve, reject) => {
      const entry = { resource, options, baseFetch, resolve, reject, request };
      // The fast path respects the cap AND queue order: a queued entry with
      // higher priority must never be bypassed by a fresh one.
      if (
        !this.paused &&
        this.inFlight < this.maxInFlight &&
        this._queue.length === 0
      ) {
        this._begin(entry);
        return;
      }
      this._queue.push(entry);
      this.pump();
    });
  }

  /**
   * Pressure pause: while closed, NO new request is handed over or started;
   * already-started requests are Cesium's own to finish or cancel. Reopening
   * starts queued work immediately, synchronously and under the cap (no
   * timers anywhere: completions and the reopen call pump() themselves).
   * @param {boolean} paused
   */
  setPaused(paused) {
    if (this.destroyed || this.paused === paused) return;
    this.paused = paused === true;
    if (!this.paused) this.pump();
  }

  /**
   * Start as many queued requests as the cap and the pause allow, highest
   * priority first (Cesium sets `priorityFunction` on tile requests; the
   * scheduler sorts exactly this ascending).
   */
  pump() {
    if (this.destroyed || this.paused) return;
    if (this._queue.length === 0 || this.inFlight >= this.maxInFlight) return;
    this._queue.sort(
      (a, b) => OdmRequestGate.priorityOf(a) - OdmRequestGate.priorityOf(b),
    );
    while (this._queue.length > 0 && this.inFlight < this.maxInFlight) {
      const entry = this._queue.shift();
      if (entry.request !== undefined && entry.request.cancelled === true) {
        entry.reject(OdmRequestGate.cancelledError());
        continue;
      }
      // A scheduler refusal re-queues the entry IN FRONT of the rest: the
      // while loop must NOT immediately retry it (the scheduler has not
      // changed inside this synchronous call, so retrying is the same
      // refusal again — pre-fix that refilled entry went straight back
      // through _begin, an unbounded synchronous hot loop). Break out and
      // let the retry happen on requestCompletedEvent's pump, exactly the
      // signal the refusal is waiting for.
      if (this._begin(entry) === false) break;
    }
  }

  /**
   * Hand one request to Cesium (which may start or refuse it) and book a slot
   * from hand-over until it settles.
   * @returns {boolean} false only when the underlying scheduler refused the
   *   request and the entry went back into the queue (pump() ends its pass);
   *   true when the entry found any terminal path or was handed over.
   * @private
   */
  _begin(entry) {
    this.inFlight++;
    let promise;
    try {
      promise = entry.baseFetch(entry.resource, entry.options);
    } catch (error) {
      this.inFlight--;
      this.pump();
      entry.reject(error);
      return true;
    }
    if (promise === undefined) {
      // The underlying scheduler had a full cap of its own: return the slot
      // and keep the entry queued. pump() runs again on every completed
      // request through the requestCompletedEvent subscription, so the entry
      // retries when the scheduler has room, never hot-looping.
      this.inFlight--;
      this._queue.unshift(entry);
      return false;
    }
    Promise.resolve(promise).then(
      (value) => {
        this.inFlight--;
        this.pump();
        entry.resolve(value);
      },
      (error) => {
        this.inFlight--;
        this.pump();
        entry.reject(error);
      },
    );
    return true;
  }

  /** Teardown: nothing queued may start; in-flight requests settle alone. */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.paused = true;
    const queued = this._queue;
    this._queue = [];
    for (const entry of queued) {
      // Cesium identifies cancellation from the Request, not this error.
      if (entry.request) entry.request.cancelled = true;
      entry.reject(OdmRequestGate.cancelledError());
    }
    this._detachCompletedEvent?.();
  }

  static priorityOf(entry) {
    try {
      const p = entry.request?.priorityFunction?.();
      return typeof p === 'number' && Number.isFinite(p) ? p : 0;
    } catch {
      return 0;
    }
  }

  static cancelledError() {
    const e = new Error(
      'Request cancelled while waiting in the ODM request gate',
    );
    e.isCancelledRequest = true;
    return e;
  }
}

/**
 * Build the Cesium 1.138 Resource subclass that drives this gate, returning
 * `{ resource, gate }`. Returns null when the Cesium passed in has no real
 * Resource class (a fake in unit tests): the layer then proceeds with a plain
 * URL, and the test injects its own gate factory.
 *
 * @param {{Resource: Function, RequestScheduler?: object}} Cesium
 * @param {string} url the tileset.json url
 * @param {{maxInFlight: number}} options
 */
export function createOdmRequestGateResource(Cesium, url, options = {}) {
  const ResourceClass = Cesium?.Resource;
  if (typeof ResourceClass !== 'function') return null;
  // The deployed GEV tileset url is same-origin relative:
  // /basemap/odm3d/<id>/tileset.json. A root-relative url (single leading
  // slash, never '//', never any other scheme) can only resolve to THIS
  // page's origin (browsers resolve it against document.baseURI), so it is
  // exactly as safe as the absolute http(s) form and must be gated too —
  // turning it away silently disabled the phone gate on the real page.
  const text = String(url);
  const httpish = /^https?:/i.test(text);
  const rootRelative = /^\/(?!\/)/.test(text) && !text.includes('\\');
  if (!httpish && !rootRelative) return null;

  const gate = new OdmRequestGate({ maxInFlight: options.maxInFlight });

  // The un-gated fetch: exactly what an ordinary Resource fetch does.
  const baseFetch = (resource, opts) =>
    ResourceClass.prototype._makeRequest.call(resource, opts);

  const isFreeUri = (u) => DATA_URI_REGEX.test(u) || BLOB_URI_REGEX.test(u);

  class OdmGatedResource extends ResourceClass {
    _makeRequest(opts) {
      // data:/blob: uris never hit the network: run them ungated so a pause
      // cannot stall a local decode either.
      if (isFreeUri(this.url)) {
        return baseFetch(this, opts);
      }
      return gate.run(this, opts, baseFetch);
    }

    clone(result) {
      if (result === undefined || result === null) {
        // getDerivedResource() calls this without a result; IonResource's own
        // clone() is the precedent: preserve the subclass down every
        // derivation so every derived fetch stays gated.
        result = new OdmGatedResource({ url: '/', parseUrl: false });
      }
      if (!(result instanceof OdmGatedResource)) {
        result = new OdmGatedResource({ url: '/', parseUrl: false });
      }
      ResourceClass.prototype.clone.call(this, result);
      return result;
    }
  }

  const resource = new OdmGatedResource(url);

  // Re-pump when the underlying scheduler frees capacity for its refused
  // requests; attached once, detached on destroy.
  const scheduler = Cesium.RequestScheduler;
  if (scheduler?.requestCompletedEvent?.addEventListener) {
    const onCompleted = () => gate.pump();
    scheduler.requestCompletedEvent.addEventListener(onCompleted);
    gate._detachCompletedEvent = () => {
      try {
        scheduler.requestCompletedEvent.removeEventListener(onCompleted);
      } catch {
        /* the event outlived the gate */
      }
    };
  }

  return { resource, gate };
}
