/**
 * Esri World Imagery Wayback: the release list (GEV_BYRDIT_WAYBACK).
 *
 * Source: waybackconfig.json, a JSON object keyed by release number. Real
 * fields (verified 2026-10-22): itemID, itemTitle ("World Imagery (Wayback
 * 2026-09-24)"), itemURL, metadataLayerUrl, metadataLayerItemID,
 * layerIdentifier. The release DATE comes from itemTitle.
 *
 * One upstream fetch per 24 h at most (memory copy + a last-good copy on
 * disk that also survives restarts). A failure keeps serving the last good
 * list (stale: true) and backs off exponentially, so a broken upstream is
 * never retried in a loop (third-party API citizenship; the CelesTrak ban).
 */

export const WAYBACK_CONFIG_URL =
  'https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json';
export const RELEASE_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 15_000;
export const BACKOFF_FIRST_MS = 5 * 60 * 1000;
export const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;
const METADATA_PREFIX =
  'https://metadata.maptiles.arcgis.com/arcgis/rest/services/';
const TITLE_DATE = /\(Wayback (\d{4})-(\d{2})-(\d{2})\)\s*$/;
const MAX_RELEASES = 1000;

/** Identify ourselves to Esri. No cookies or other headers are sent. */
export const WAYBACK_USER_AGENT =
  'GodsEyeView-Byrd-IT/1.0 (+https://godseyeview.byrd-it.com; admin@byrd-it.com) wayback-viewer';

/**
 * A log-safe reason for an error: our own fixed messages as they are; for
 * anything foreign (a fetch/DNS/proxy error whose message can carry a URL,
 * userinfo or a header value) only its name and error code. Never the message.
 */
export function safeReason(error) {
  if (error instanceof WaybackConfigError) return error.message;
  const code = (value) =>
    typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(value)
      ? value
      : null;
  const name =
    typeof error?.name === 'string' && /^[A-Za-z]{1,40}$/.test(error.name)
      ? error.name
      : 'Error';
  return [name, code(error?.code) ?? code(error?.cause?.code)]
    .filter(Boolean)
    .join(' ');
}

export class WaybackConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WaybackConfigError';
  }
}

function validDate(y, m, d) {
  const t = Date.UTC(y, m - 1, d);
  const date = new Date(t);
  return (
    y >= 2010 &&
    y <= 2100 &&
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

/**
 * waybackconfig.json -> {releases, metadata}.
 *   releases: [{release, date, label}] newest first (the browser's list)
 *   metadata: Map(release -> metadata MapServer URL) (server side only)
 * Entries that do not fit are dropped; a document with no valid entry, or
 * with more than half of its entries invalid, is refused.
 * @param {unknown} raw
 */
export function normalizeReleases(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new WaybackConfigError('wayback config is not an object');
  const keys = Object.keys(raw);
  if (!keys.length || keys.length > MAX_RELEASES)
    throw new WaybackConfigError('wayback config has an unexpected size');
  const releases = [];
  const metadata = new Map();
  for (const key of keys) {
    const entry = raw[key];
    if (!/^\d{1,10}$/.test(key) || !entry || typeof entry !== 'object')
      continue;
    const match = TITLE_DATE.exec(String(entry.itemTitle ?? ''));
    if (!match) continue;
    const [y, m, d] = [match[1], match[2], match[3]].map(Number);
    if (!validDate(y, m, d)) continue;
    const release = Number(key);
    if (!Number.isSafeInteger(release)) continue;
    const date = `${match[1]}-${match[2]}-${match[3]}`;
    releases.push({ release, date, label: date });
    const meta = String(entry.metadataLayerUrl ?? '');
    if (meta.startsWith(METADATA_PREFIX) && /^[\x21-\x7e]+$/.test(meta))
      metadata.set(release, meta.replace(/\/+$/, ''));
  }
  if (!releases.length || releases.length * 2 < keys.length)
    throw new WaybackConfigError('wayback config has no usable releases');
  releases.sort((a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : b.release - a.release,
  );
  return { releases, metadata };
}

/**
 * The release store.
 * @param {{
 *   fetchImpl?: typeof fetch, now?: () => number, url?: string,
 *   readLastGood?: () => Promise<{fetchedAt: number, raw: unknown}|null>,
 *   writeLastGood?: (doc: {fetchedAt: number, raw: unknown}) => Promise<void>,
 *   log?: (...args: unknown[]) => void, ttlMs?: number,
 * }} [options]
 */
export function createReleaseStore({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  url = WAYBACK_CONFIG_URL,
  readLastGood = async () => null,
  writeLastGood = async () => {},
  log = (...args) => console.warn(...args),
  ttlMs = RELEASE_TTL_MS,
} = {}) {
  /** @type {{releases: object[], metadata: Map<number,string>, fetchedAt: number}|null} */
  let current = null;
  let diskChecked = false;
  let pending = null;
  let failures = 0;
  let retryAt = 0;
  let upstreamFetches = 0;

  async function loadDisk() {
    if (diskChecked) return;
    diskChecked = true;
    try {
      const doc = await readLastGood();
      if (!doc || !Number.isFinite(doc.fetchedAt)) return;
      const { releases, metadata } = normalizeReleases(doc.raw);
      current = { releases, metadata, fetchedAt: doc.fetchedAt };
    } catch (error) {
      log(
        '[wayback] ignoring unreadable last-good release list:',
        safeReason(error),
      );
    }
  }

  async function fetchRaw() {
    upstreamFetches += 1;
    const response = await fetchImpl(url, {
      headers: { 'user-agent': WAYBACK_USER_AGENT, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new WaybackConfigError(`HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > MAX_CONFIG_BYTES)
      throw new WaybackConfigError('wayback config too large');
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new WaybackConfigError('wayback config is not JSON');
    }
    return raw;
  }

  async function refresh() {
    try {
      const raw = await fetchRaw();
      const { releases, metadata } = normalizeReleases(raw);
      const fetchedAt = now();
      current = { releases, metadata, fetchedAt };
      failures = 0;
      retryAt = 0;
      try {
        await writeLastGood({ fetchedAt, raw });
      } catch (error) {
        log(
          '[wayback] could not save the last-good release list:',
          safeReason(error),
        );
      }
    } catch (error) {
      failures += 1;
      const wait = Math.min(
        BACKOFF_MAX_MS,
        BACKOFF_FIRST_MS * 2 ** (failures - 1),
      );
      retryAt = now() + wait;
      // One quiet line per failure (the backoff keeps these rare).
      log(
        `[wayback] release list refresh failed (${safeReason(error)}); retry in ${Math.round(wait / 60000)} min`,
      );
    }
  }

  /**
   * @returns {Promise<{releases: object[], metadata: Map<number,string>, fetchedAt: number, stale: boolean}>}
   * @throws {WaybackConfigError} nothing fresh and nothing last-good (HTTP 502)
   */
  async function get() {
    await loadDisk();
    const t = now();
    const fresh = current && t - current.fetchedAt < ttlMs;
    if (!fresh && t >= retryAt) {
      pending ??= refresh().finally(() => {
        pending = null;
      });
      await pending;
    } else if (!fresh && pending) await pending;
    if (!current)
      throw new WaybackConfigError('wayback release list unavailable');
    return { ...current, stale: now() - current.fetchedAt >= ttlMs };
  }

  return {
    get,
    /** release number -> true when it is in the cached list (no fetch). */
    has: (release) =>
      Boolean(current?.releases.some((r) => r.release === release)),
    stats: () => ({
      upstreamFetches,
      failures,
      retryAt,
      loaded: Boolean(current),
    }),
  };
}
