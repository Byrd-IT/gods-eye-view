/**
 * Lazy Google 3D root session (BASEMAP.md 4.3 items 2, 4, 5, 6).
 *
 * - No root request until ensure() is called. Nothing calls it for a page
 *   that loads at global view and is never zoomed in, so that page costs 0
 *   root sessions (before this change it cost 1).
 * - One Cesium3DTileset per page load. After that, switching only flips
 *   `show`, so a switch costs 0 root requests. The tileset is never destroyed
 *   on LEAVE.
 * - Re-root only when the session is older than reRootAgeMs (2.5 h; Google
 *   guarantees at least 3 h per root) and only when Google is about to be
 *   shown again (ensure() is called on ENTER only).
 * - Failures: exponential backoff and at most `rootAttemptsPerHour` root
 *   attempts per rolling hour. ensure() then fails fast without a request.
 *
 * getGoogleRootCount() counts every root request this page made. Tests and
 * the debug HUD read it.
 */

let rootCount = 0;

/** Root requests (attempts) issued by this page load. */
export function getGoogleRootCount() {
  return rootCount;
}

/** Test hook. */
export function resetGoogleRootCount() {
  rootCount = 0;
}

const HOUR_MS = 60 * 60 * 1000;

export class GoogleUnavailableError extends Error {
  constructor(message, { cause, retryAt = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'GoogleUnavailableError';
    this.retryAt = retryAt;
  }
}

/**
 * @param {object} options
 * @param {boolean} options.hasCredentials - a Google key or token source exists.
 * @param {() => Promise<{tileset: object|null, errors?: Error[]}>} options.load - one root request.
 * @param {(tileset: object) => void} [options.attach] - add to the scene, hidden.
 * @param {(tileset: object) => void} [options.detach] - remove + destroy a replaced tileset.
 * @param {() => number} [options.now]
 * @param {number} [options.reRootAgeMs]
 * @param {number} [options.rootAttemptsPerHour]
 * @param {number} [options.backoffBaseMs]
 * @param {number} [options.backoffMaxMs]
 */
export function createGoogleSession({
  hasCredentials,
  load,
  attach = () => {},
  detach = () => {},
  now = Date.now,
  reRootAgeMs = 2.5 * HOUR_MS,
  rootAttemptsPerHour = 3,
  backoffBaseMs = 30_000,
  backoffMaxMs = 20 * 60_000,
}) {
  let tileset = null;
  let createdAt = 0;
  let inflight = null;
  let failures = 0;
  let retryAt = 0;
  let destroyed = false;
  const attempts = [];

  function blockedUntil(t) {
    while (attempts.length && attempts[0] <= t - HOUR_MS) attempts.shift();
    let until = retryAt > t ? retryAt : 0;
    if (attempts.length >= rootAttemptsPerHour)
      until = Math.max(until, attempts[0] + HOUR_MS);
    return until;
  }

  async function root() {
    const t = now();
    rootCount += 1;
    attempts.push(t);
    let result;
    try {
      result = await load();
    } catch (error) {
      result = { tileset: null, errors: [error] };
    }
    if (destroyed) {
      if (result?.tileset) detach(result.tileset);
      throw new GoogleUnavailableError('Google 3D session closed');
    }
    if (!result?.tileset) {
      failures += 1;
      retryAt =
        now() + Math.min(backoffMaxMs, backoffBaseMs * 2 ** (failures - 1));
      const cause = result?.errors?.at?.(-1);
      throw new GoogleUnavailableError(
        `Google 3D unavailable${cause?.message ? ` (${cause.message})` : ''}`,
        { cause, retryAt },
      );
    }
    const previous = tileset;
    tileset = result.tileset;
    createdAt = t;
    failures = 0;
    retryAt = 0;
    attach(tileset);
    if (previous && previous !== tileset) detach(previous);
    return tileset;
  }

  return {
    get hasCredentials() {
      return Boolean(hasCredentials);
    },
    /** The current tileset, or null before the first successful root. */
    get tileset() {
      return tileset;
    },
    /** Age of the current root session in ms (Infinity before the first). */
    age() {
      return tileset ? now() - createdAt : Infinity;
    },
    /** True while failures keep Google off (backoff or hourly cap). */
    isBackingOff() {
      return blockedUntil(now()) > now();
    },
    /**
     * Return a tileset fit to show now, making a root request only when
     * there is none yet or the current one is older than reRootAgeMs.
     */
    ensure() {
      if (destroyed)
        return Promise.reject(
          new GoogleUnavailableError('Google 3D session closed'),
        );
      if (!hasCredentials)
        return Promise.reject(
          new GoogleUnavailableError('Google 3D needs a Google key'),
        );
      const t = now();
      if (tileset && t - createdAt < reRootAgeMs)
        return Promise.resolve(tileset);
      if (inflight) return inflight;
      const until = blockedUntil(t);
      if (until > t) {
        // A stale-but-working tileset beats none while root attempts back off.
        if (tileset) return Promise.resolve(tileset);
        return Promise.reject(
          new GoogleUnavailableError('Google 3D unavailable (backing off)', {
            retryAt: until,
          }),
        );
      }
      inflight = root().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (tileset) detach(tileset);
      tileset = null;
    },
  };
}
