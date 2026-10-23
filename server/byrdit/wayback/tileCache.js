import fsp from 'node:fs/promises';
import path from 'node:path';
import { safeReason, WAYBACK_USER_AGENT } from './releases.js';

/**
 * Perpetual view-through tile cache for Esri Wayback (owner decision
 * 2026-10-22: keep what we view, never expire, never evict, no bulk
 * prefetch).
 *
 * Layout under the cache dir (one file per tile, written atomically):
 *   t/<resolved>/<z>/<row>/<col>   header JSON line + "\n" + image bytes
 *   a/<release>/<z>/<row>/<col>    alias: the release that holds the image
 *   n/<release>/<z>/<row>/<col>    "no tile here" {at, status}; TTL 30 d
 *
 * Esri answers an unchanged release with a 301 to the release that holds
 * the image (sometimes through two hops). The redirect is followed here BY
 * HAND: the Location is parsed for a release number and the target URL is
 * rebuilt from our own template, so an upstream can never send us to
 * another host. The image is stored once, under the RESOLVED release; the
 * alias remembers requested -> resolved so neither a second copy nor a
 * second fetch happens.
 */

export const WAYBACK_TILE_BASE =
  'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile';
export const MAX_Z = 23;
export const MAX_TILE_BYTES = 2 * 1024 * 1024;
export const MIN_TILE_BYTES = 100;
export const NEGATIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_HOPS = 3;
const STATS_SAVE_MS = 10_000;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const LOCATION = /\/tile\/(\d{1,10})\/(\d{1,2})\/(\d{1,8})\/(\d{1,8})$/i;

/** Valid tile address? z 0..23, row/col < 2^z. */
export function validTile(release, z, row, col) {
  return (
    [release, z, row, col].every((v) => Number.isSafeInteger(v) && v >= 0) &&
    release <= 9_999_999_999 &&
    z <= MAX_Z &&
    row < 2 ** z &&
    col < 2 ** z
  );
}

/** The upstream URL for one tile (the only URL shape this module fetches). */
export const upstreamTileUrl = (release, z, row, col) =>
  `${WAYBACK_TILE_BASE}/${release}/${z}/${row}/${col}`;

/** Parse a redirect Location; returns the release it points at or null. */
export function resolvedFromLocation(location, z, row, col) {
  const match = LOCATION.exec(String(location ?? '').split(/[?#]/)[0]);
  if (!match) return null;
  const [release, mz, mrow, mcol] = match.slice(1).map(Number);
  if (mz !== z || mrow !== row || mcol !== col) return null;
  return release;
}

export class TileError extends Error {
  /** @param {string} code unknown-release | bad-tile | upstream | breaker */
  constructor(code, message, { retryAfter = 0 } = {}) {
    super(message ?? code);
    this.name = 'TileError';
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** Global concurrency cap + minimum spacing between upstream requests. */
export function createLimiter({
  concurrency = 8,
  perSecond = 20,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  let active = 0;
  const waiting = [];
  let nextSlot = 0;
  const gap = perSecond > 0 ? 1000 / perSecond : 0;
  const pump = () => {
    while (active < concurrency && waiting.length) {
      active += 1;
      waiting.shift()();
    }
  };
  return {
    stats: () => ({ active, waiting: waiting.length }),
    async run(fn) {
      await new Promise((resolve) => {
        waiting.push(resolve);
        pump();
      });
      try {
        const t = now();
        const at = Math.max(t, nextSlot);
        nextSlot = at + gap;
        if (at > t) await sleep(at - t);
        return await fn();
      } finally {
        active -= 1;
        pump();
      }
    },
  };
}

/** Circuit breaker for 429 / 5xx / timeouts: open, wait, one probe. */
export function createBreaker({
  threshold = 5,
  firstOpenMs = 30_000,
  maxOpenMs = 10 * 60_000,
  now = Date.now,
} = {}) {
  let failures = 0;
  let openUntil = 0;
  let openMs = firstOpenMs;
  let probing = false;
  return {
    state: () =>
      now() < openUntil
        ? 'open'
        : failures >= threshold
          ? 'half-open'
          : 'closed',
    /** @returns {number} 0 = go; otherwise ms until the next try */
    check() {
      const t = now();
      if (t < openUntil) return openUntil - t;
      if (failures >= threshold) {
        if (probing) return 1000;
        probing = true;
      }
      return 0;
    },
    success() {
      failures = 0;
      openMs = firstOpenMs;
      openUntil = 0;
      probing = false;
    },
    failure({ retryAfterMs = 0, immediate = false } = {}) {
      probing = false;
      failures += 1;
      if (immediate || failures >= threshold) {
        const wait = Math.min(maxOpenMs, Math.max(retryAfterMs, openMs));
        openUntil = now() + wait;
        openMs = Math.min(maxOpenMs, openMs * 2);
      }
    },
  };
}

const pad = (n) => String(n);
const tilePath = (dir, kind, release, z, row, col) =>
  path.join(dir, kind, pad(release), pad(z), pad(row), pad(col));

function parseTileFile(buf) {
  const nl = buf.indexOf(0x0a);
  if (nl < 2 || nl > 2048) return null;
  try {
    const head = JSON.parse(buf.subarray(0, nl).toString('utf8'));
    if (!IMAGE_TYPES.has(head.ct)) return null;
    const body = buf.subarray(nl + 1);
    if (body.length < MIN_TILE_BYTES) return null;
    return {
      contentType: head.ct,
      etag: typeof head.etag === 'string' ? head.etag : null,
      body,
    };
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   dir: string, fetchImpl?: typeof fetch, now?: () => number,
 *   fs?: typeof fsp, maxBytes?: number, minFreePct?: number,
 *   limiter?: ReturnType<typeof createLimiter>, breaker?: ReturnType<typeof createBreaker>,
 *   guardIntervalMs?: number, timeoutMs?: number, log?: (...a: unknown[]) => void,
 * }} options
 */
export function createTileCache({
  dir,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  fs = fsp,
  maxBytes = 500 * 1024 ** 3,
  minFreePct = 15,
  limiter = createLimiter({ now }),
  breaker = createBreaker({ now }),
  guardIntervalMs = 30_000,
  timeoutMs = 15_000,
  log = (...args) => console.warn(...args),
} = {}) {
  const inflight = new Map();
  const counters = {
    hits: 0,
    misses: 0,
    negativeHits: 0,
    upstream: 0,
    written: 0,
    passthrough: 0,
    errors: 0,
    aliasHits: 0,
  };
  let tiles = 0;
  let bytes = 0;
  let statsDirty = false;
  let statsLoaded = false;
  let guard = { writing: true, reason: 'ok' };
  let guardCheckedAt = -Infinity;

  async function loadStats() {
    if (statsLoaded) return;
    statsLoaded = true;
    try {
      const doc = JSON.parse(
        await fs.readFile(path.join(dir, 'stats.json'), 'utf8'),
      );
      if (Number.isFinite(doc.tiles) && Number.isFinite(doc.bytes)) {
        tiles = doc.tiles;
        bytes = doc.bytes;
      }
    } catch {
      /* first run: counts start at zero and grow with each write */
    }
  }

  let statsSavedAt = -Infinity;
  async function saveStats({ force = false } = {}) {
    if (!statsDirty) return;
    if (!force && now() - statsSavedAt < STATS_SAVE_MS) return;
    statsSavedAt = now();
    statsDirty = false;
    try {
      const file = path.join(dir, 'stats.json');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(`${file}.tmp`, JSON.stringify({ tiles, bytes }));
      await fs.rename(`${file}.tmp`, file);
    } catch (error) {
      log('[wayback-cache] could not save stats:', safeReason(error));
    }
  }

  async function checkGuard() {
    const t = now();
    if (t - guardCheckedAt < guardIntervalMs) return guard;
    guardCheckedAt = t;
    let next = { writing: true, reason: 'ok' };
    try {
      await fs.mkdir(dir, { recursive: true });
      if (bytes >= maxBytes) next = { writing: false, reason: 'max-size' };
      else {
        const s = await fs.statfs(dir);
        const freePct =
          s.blocks > 0 ? (Number(s.bavail) / Number(s.blocks)) * 100 : 100;
        if (freePct < minFreePct)
          next = { writing: false, reason: 'low-free-space' };
      }
    } catch (error) {
      next = { writing: false, reason: `unwritable:${error?.code ?? 'error'}` };
    }
    if (next.writing !== guard.writing || next.reason !== guard.reason)
      log(
        next.writing
          ? '[wayback-cache] writes resumed'
          : `[wayback-cache] new tiles are no longer written (${next.reason}); cached tiles still serve`,
      );
    guard = next;
    return guard;
  }

  async function readTile(release, z, row, col) {
    try {
      const buf = await fs.readFile(tilePath(dir, 't', release, z, row, col));
      return parseTileFile(buf);
    } catch {
      return null;
    }
  }

  async function readSmall(kind, release, z, row, col) {
    try {
      return await fs.readFile(
        tilePath(dir, kind, release, z, row, col),
        'utf8',
      );
    } catch {
      return null;
    }
  }

  let tmpCounter = 0;
  async function atomicWrite(file, data) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${tmpCounter++}.tmp`;
    try {
      await fs.writeFile(tmp, data);
      await fs.rename(tmp, file);
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function writeTile(release, z, row, col, contentType, etag, body) {
    const head = Buffer.from(JSON.stringify({ ct: contentType, etag }) + '\n');
    const file = tilePath(dir, 't', release, z, row, col);
    let existed = false;
    try {
      await fs.access(file);
      existed = true;
    } catch {
      /* new */
    }
    await atomicWrite(file, Buffer.concat([head, body]));
    if (!existed) {
      tiles += 1;
      bytes += head.length + body.length;
      statsDirty = true;
    }
    counters.written += 1;
  }

  const writeAlias = (from, to, z, row, col) =>
    atomicWrite(tilePath(dir, 'a', from, z, row, col), String(to));
  const writeNegative = (release, z, row, col, status) =>
    atomicWrite(
      tilePath(dir, 'n', release, z, row, col),
      JSON.stringify({ at: now(), status }),
    );

  async function upstreamGet(url) {
    const response = await fetchImpl(url, {
      headers: { 'user-agent': WAYBACK_USER_AGENT, accept: 'image/*' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response;
  }

  /** Fetch one tile from Esri, following redirects by hand. */
  async function fetchFromUpstream(release, z, row, col) {
    let target = release;
    for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
      if (hop > 0) {
        // Another request may already have stored the image this hop points at.
        const have = await readTile(target, z, row, col);
        if (have) return { ...have, resolved: target, fromDisk: true };
      }
      const wait = breaker.check();
      if (wait)
        throw new TileError('breaker', 'upstream paused', {
          retryAfter: Math.ceil(wait / 1000),
        });
      counters.upstream += 1;
      let response;
      try {
        response = await limiter.run(() =>
          upstreamGet(upstreamTileUrl(target, z, row, col)),
        );
      } catch (error) {
        breaker.failure();
        throw new TileError(
          'upstream',
          `fetch failed: ${error?.name ?? 'error'}`,
        );
      }
      const status = response.status;
      if (
        status === 301 ||
        status === 302 ||
        status === 307 ||
        status === 308
      ) {
        await response.body?.cancel?.().catch(() => {});
        breaker.success();
        const next = resolvedFromLocation(
          response.headers.get('location'),
          z,
          row,
          col,
        );
        if (next === null || next === target)
          throw new TileError('upstream', 'unusable redirect');
        target = next;
        continue;
      }
      if (status === 404 || status === 400) {
        await response.body?.cancel?.().catch(() => {});
        breaker.success();
        return { none: true, status };
      }
      if (status === 429 || status >= 500) {
        await response.body?.cancel?.().catch(() => {});
        const ra = Number(response.headers.get('retry-after'));
        breaker.failure({
          retryAfterMs: Number.isFinite(ra) ? Math.min(ra, 900) * 1000 : 0,
          immediate: status === 429,
        });
        throw new TileError('upstream', `HTTP ${status}`);
      }
      if (status !== 200) {
        await response.body?.cancel?.().catch(() => {});
        throw new TileError('upstream', `HTTP ${status}`);
      }
      const contentType = String(response.headers.get('content-type') ?? '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      const declared = Number(response.headers.get('content-length'));
      if (declared > MAX_TILE_BYTES || !IMAGE_TYPES.has(contentType)) {
        await response.body?.cancel?.().catch(() => {});
        throw new TileError('upstream', 'unexpected tile response');
      }
      let body;
      try {
        body = Buffer.from(await response.arrayBuffer());
      } catch {
        breaker.failure();
        throw new TileError('upstream', 'tile body failed');
      }
      breaker.success();
      if (body.length > MAX_TILE_BYTES)
        throw new TileError('upstream', 'tile too large');
      if (body.length < MIN_TILE_BYTES) return { none: true, status: 200 };
      const etag = response.headers.get('etag');
      return {
        contentType,
        etag: etag && etag.length <= 200 && !/[\r\n]/.test(etag) ? etag : null,
        body,
        resolved: target,
      };
    }
    throw new TileError('upstream', 'too many redirects');
  }

  async function miss(release, z, row, col) {
    const result = await fetchFromUpstream(release, z, row, col);
    if (result.none) {
      if ((await checkGuard()).writing)
        await writeNegative(release, z, row, col, result.status).catch(
          () => {},
        );
      return { none: true };
    }
    const { resolved } = result;
    const canWrite = (await checkGuard()).writing;
    if (canWrite) {
      try {
        if (!result.fromDisk)
          await writeTile(
            resolved,
            z,
            row,
            col,
            result.contentType,
            result.etag,
            result.body,
          );
        if (resolved !== release)
          await writeAlias(release, resolved, z, row, col);
      } catch (error) {
        counters.errors += 1;
        log('[wayback-cache] write failed:', safeReason(error));
      }
    } else counters.passthrough += 1;
    return {
      contentType: result.contentType,
      etag: result.etag,
      body: result.body,
      resolved,
    };
  }

  /**
   * @param {number} release a release already checked against the list
   * @returns {Promise<{none?: true, contentType?: string, etag?: string|null, body?: Buffer, cache?: 'HIT'|'MISS'}>}
   */
  async function getTile(release, z, row, col) {
    if (!validTile(release, z, row, col)) throw new TileError('bad-tile');
    await loadStats();
    let resolved = release;
    const alias = await readSmall('a', release, z, row, col);
    if (alias && /^\d{1,10}$/.test(alias)) {
      resolved = Number(alias);
      counters.aliasHits += 1;
    }
    const hit = await readTile(resolved, z, row, col);
    if (hit) {
      counters.hits += 1;
      return { ...hit, cache: 'HIT' };
    }
    const neg = await readSmall('n', release, z, row, col);
    if (neg) {
      try {
        if (now() - JSON.parse(neg).at < NEGATIVE_TTL_MS) {
          counters.negativeHits += 1;
          return { none: true, cache: 'HIT' };
        }
      } catch {
        /* unreadable entry: refetch */
      }
    }
    const key = `${release}/${z}/${row}/${col}`;
    let flight = inflight.get(key);
    if (!flight) {
      counters.misses += 1;
      flight = miss(release, z, row, col).finally(() => {
        inflight.delete(key);
        saveStats();
      });
      inflight.set(key, flight);
    }
    const out = await flight;
    return { ...out, cache: 'MISS' };
  }

  return {
    getTile,
    async status() {
      await loadStats();
      const g = await checkGuard();
      return {
        tiles,
        bytes,
        ...counters,
        inflight: inflight.size,
        guard: { writing: g.writing, reason: g.reason, maxBytes, minFreePct },
        breaker: breaker.state(),
        limiter: limiter.stats(),
      };
    },
    /** For tests and shutdown: flush the stats file. */
    flush: () => saveStats({ force: true }),
  };
}
