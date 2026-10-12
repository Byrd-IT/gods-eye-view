/**
 * Staleness contract shared by the collector bridge (server) and the layer
 * chips (browser, wired in B11/B12). gev-history DESIGN 2.4b + owner N5:
 *
 *  - A feed is stale when now - lastOK > max(3 x cadence, 90 s). The same rule
 *    the collector applies (gev-history src/latestStore.js staleThresholdMs).
 *  - While stale the last good body is still served, marked
 *    X-Feed-Cache: STALE with X-Feed-Stale-Since (epoch ms) and X-Feed-Reason.
 *  - The layer is drawn GREY with "No data since HH:MM <tz>" for
 *    GEV_STALE_GREY_MS (default 1 hour) measured from X-Feed-Stale-Since; after
 *    that it is CLEARED and only the chip remains. The window is judged on the
 *    server clock (X-Feed-Last-OK + X-Feed-Age-Ms), never the browser clock.
 *  - 503 only when no snapshot exists at all: chip only, nothing drawn.
 *
 * Pure and browser-safe: no Node built-ins, no DOM.
 */

/** Floor of the stale threshold (ms). */
export const STALE_FLOOR_MS = 90_000;

/** Default grey window after X-Feed-Stale-Since (owner N5: 1 hour). */
export const DEFAULT_STALE_GREY_MS = 3_600_000;

/** Stale threshold for a feed polled every `cadenceMs`. */
export function staleThresholdMs(cadenceMs) {
  return Math.max(3 * cadenceMs, STALE_FLOOR_MS);
}

/** Parse GEV_STALE_GREY_MS; anything but a positive whole number -> default. */
export function parseGreyMs(value) {
  const text = String(value ?? '').trim();
  if (!/^[0-9]+$/.test(text)) return DEFAULT_STALE_GREY_MS;
  const n = Number(text);
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_STALE_GREY_MS;
}

function headerReader(headers) {
  if (!headers) return () => null;
  if (typeof headers.get === 'function') {
    return (name) => headers.get(name);
  }
  const lower = {};
  for (const [key, value] of Object.entries(headers)) {
    lower[key.toLowerCase()] = value;
  }
  return (name) => lower[name.toLowerCase()] ?? null;
}

function epoch(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * "HH:MM <tz>" for an epoch-ms instant (24 h clock). `timeZone` defaults to
 * the runtime's zone; `locale` to en-US so the zone name is the short form.
 */
export function formatClock(epochMs, { timeZone, locale = 'en-US' } = {}) {
  const parts = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
    timeZoneName: 'short',
  }).formatToParts(new Date(epochMs));
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('hour')}:${get('minute')} ${get('timeZoneName')}`.trim();
}

/**
 * Display state of a bridged layer from one /api/<feed> response.
 *
 * @param {{status: number, headers: Headers|Record<string,string>}} response
 * @param {{greyMs?: number, timeZone?: string, locale?: string}} [options]
 * @returns {{
 *   state: 'live'|'grey'|'cleared'|'none',
 *   draw: boolean,
 *   chip: string|null,
 *   lastOkAt: number|null,
 *   staleSince: number|null,
 *   greyUntil: number|null,
 *   reason: string|null,
 * }}
 *   state live: draw normally, no chip. grey: draw desaturated + chip.
 *   cleared: draw nothing, chip only. none: no snapshot, chip only.
 */
export function feedDisplayState(
  response,
  { greyMs = DEFAULT_STALE_GREY_MS, timeZone, locale } = {},
) {
  const header = headerReader(response?.headers);
  const reason = header('x-feed-reason') || null;
  const lastOkAt = epoch(header('x-feed-last-ok'));
  const paused = /^opensky_paused_until=(\d{2}:\d{2})$/.exec(reason ?? '');
  const chipFor = () => {
    if (paused) return `OpenSky paused until ${paused[1]} UTC`;
    if (lastOkAt === null) return 'No data';
    return `No data since ${formatClock(lastOkAt, { timeZone, locale })}`;
  };
  const base = { lastOkAt, staleSince: null, greyUntil: null, reason };
  if (response?.status !== 200) {
    return { ...base, state: 'none', draw: false, chip: chipFor() };
  }
  const staleSince = epoch(header('x-feed-stale-since'));
  if (header('x-feed-cache') !== 'STALE' || staleSince === null) {
    return { ...base, state: 'live', draw: true, chip: null };
  }
  const greyUntil =
    epoch(header('x-feed-grey-until')) ?? staleSince + Math.max(0, greyMs);
  const age = epoch(header('x-feed-age-ms'));
  // Server clock at response time; without it the window has not started.
  const serverNow = lastOkAt !== null && age !== null ? lastOkAt + age : null;
  const cleared = serverNow !== null && serverNow >= greyUntil;
  return {
    ...base,
    staleSince,
    greyUntil,
    state: cleared ? 'cleared' : 'grey',
    draw: !cleared,
    chip: chipFor(),
  };
}
