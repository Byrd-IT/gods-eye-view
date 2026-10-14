/**
 * /api/history response cache (gev-history DESIGN 4.4; card B10 item 4).
 *
 * - An answer about a moment older than LIVE_EDGE_MS (5 min) cannot change
 *   except for late arrivals (spool replays, importer backfills), so it is
 *   kept in an in-process LRU capped at 64 MB of body bytes and sent with
 *   `Cache-Control: private, max-age=300` (never `immutable`) and an ETag.
 *   A matching If-None-Match gets 304 with no body.
 * - The live edge (t, or a track's `to`, within 5 min of now) is never
 *   cached and is sent `no-store` without an ETag.
 * - Keys are the canonical parsed parameters (route + feed + instants in ms
 *   + bbox numbers + caps), never the raw query, so equivalent spellings
 *   (epoch vs ISO, bbox "1.0" vs "1") share one entry. The slider snaps t
 *   to real snaps (/api/history/snapshots), so the same t recurs.
 * Pure and browser-safe (no Node built-ins): the ETag is a 64-bit pair of
 * FNV-1a / djb2 hashes over the exact body plus its length.
 */

export const CACHE_MAX_BYTES = 64 * 1024 * 1024;
export const LIVE_EDGE_MS = 5 * 60_000;
export const CACHE_MAX_AGE_S = 300;
/**
 * Server-side entry lifetime: late arrivals (spool replay, an importer
 * finishing a day) reach the in-process cache within this time.
 */
export const CACHE_TTL_MS = 15 * 60_000;
/** One entry may use at most this share of the cache. */
export const CACHE_MAX_ENTRY_BYTES = 16 * 1024 * 1024;

/** Strong ETag of a body (64-bit: FNV-1a 32 + djb2 32 + length). */
export function bodyEtag(text) {
  let a = 0x811c9dc5;
  let b = 5381;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    a ^= c;
    a = Math.imul(a, 0x01000193) >>> 0;
    b = (Math.imul(b, 33) + c) >>> 0;
  }
  return `"h${a.toString(16).padStart(8, '0')}${b
    .toString(16)
    .padStart(8, '0')}-${text.length.toString(36)}"`;
}

/** If-None-Match (list or *) matches `etag` (weak comparison, RFC 9110). */
export function etagMatches(header, etag) {
  if (typeof header !== 'string' || !header) return false;
  if (header.trim() === '*') return true;
  const strip = (v) => v.trim().replace(/^W\//, '');
  return header.split(',').some((v) => strip(v) === strip(etag));
}

/**
 * The instant a request is "about" (cacheability): slice t, track `to`,
 * coverage `to`; null = never cache. /snapshots is not cached: its "after"
 * side keeps growing while new polls arrive (and it costs ~20 ms); /health
 * is live by definition.
 */
export function aboutInstant(route, params) {
  if (route === 'slice') return params.t;
  if (route === 'track') return params.to;
  if (route === 'coverage') return params.to;
  return null;
}

/** Canonical cache key of parsed parameters (stable key order). */
export function cacheKey(route, params) {
  const keys = Object.keys(params).sort();
  return (
    route +
    '?' +
    keys
      .map((k) => {
        const v = params[k];
        if (v && typeof v === 'object')
          return `${k}=${['w', 's', 'e', 'n'].map((x) => v[x]).join(',')}`;
        return `${k}=${v}`;
      })
      .join('&')
  );
}

/** Byte-capped LRU of {text, etag, headers} with a TTL. */
export function createHistoryCache({
  maxBytes = CACHE_MAX_BYTES,
  maxEntryBytes = CACHE_MAX_ENTRY_BYTES,
  ttlMs = CACHE_TTL_MS,
  now = () => Date.now(),
} = {}) {
  const map = new Map();
  let bytes = 0;
  const sizeOf = (entry, key) => entry.text.length * 2 + key.length * 2 + 256;

  function get(key) {
    const hit = map.get(key);
    if (!hit) return null;
    map.delete(key);
    if (now() - hit.at > ttlMs) {
      bytes -= hit.size;
      return null;
    }
    map.set(key, hit);
    return hit;
  }

  function set(key, entry) {
    const size = sizeOf(entry, key);
    if (size > maxEntryBytes || size > maxBytes) return false;
    const old = map.get(key);
    if (old) {
      bytes -= old.size;
      map.delete(key);
    }
    map.set(key, { ...entry, size, at: now() });
    bytes += size;
    while (bytes > maxBytes) {
      const [k, v] = map.entries().next().value;
      map.delete(k);
      bytes -= v.size;
    }
    return true;
  }

  return {
    get,
    set,
    stats: () => ({ entries: map.size, bytes }),
  };
}
