/**
 * `sv` share state (SKYVIEW.md 7): its OWN query parameter, independent of the
 * hash-encoded camera/layer link (`l=` and friends belong to ShareLinkManager,
 * which rewrites only the hash, so a query parameter survives it).
 *
 *   sv=<lat>,<lon>,<azDeg>,<elDeg>,<fovDeg>[,<ISO UTC>]
 *   svf=<bit flags>   bit 0 = flat horizon, bit 1 = alt/az grid
 */
import { makeView } from './skyMath.js';

export const SV_PARAM = 'sv';
export const SVF_PARAM = 'svf';
export const SKY_FLAGS = Object.freeze({ flatHorizon: 1, grid: 2 });

const trim = (value, digits) => {
  const text = Number(value).toFixed(digits);
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
};

/** Compact UTC ISO with no milliseconds when they are zero. */
export function isoUtc(ms) {
  const iso = new Date(ms).toISOString();
  return iso.endsWith('.000Z') ? `${iso.slice(0, -5)}Z` : iso;
}

/** Flags object -> integer. */
export function encodeFlags(flags = {}) {
  let bits = 0;
  for (const [name, bit] of Object.entries(SKY_FLAGS))
    if (flags[name]) bits |= bit;
  return bits;
}

/** Integer -> flags object (unknown bits ignored). */
export function decodeFlags(bits) {
  const value = Number.parseInt(bits, 10);
  const safe = Number.isFinite(value) && value >= 0 ? value : 0;
  return Object.fromEntries(
    Object.entries(SKY_FLAGS).map(([name, bit]) => [name, Boolean(safe & bit)]),
  );
}

/** State -> { sv, svf } strings. timeMs null/undefined means "live". */
export function encodeSkyState({
  latDeg,
  lonDeg,
  view,
  timeMs = null,
  flags = {},
}) {
  const parts = [
    trim(latDeg, 5),
    trim(lonDeg, 5),
    trim(view.azDeg, 2),
    trim(view.elDeg, 2),
    trim(view.fovDeg, 1),
  ];
  if (Number.isFinite(timeMs)) parts.push(isoUtc(timeMs));
  return { sv: parts.join(','), svf: String(encodeFlags(flags)) };
}

/** { sv, svf } strings -> state, or null when `sv` is missing or invalid. */
export function decodeSkyState(sv, svf) {
  if (typeof sv !== 'string' || !sv) return null;
  const parts = sv.split(',');
  if (parts.length < 5 || parts.length > 6) return null;
  const nums = parts.slice(0, 5).map(Number);
  if (!nums.every(Number.isFinite)) return null;
  const [latDeg, lonDeg, azDeg, elDeg, fovDeg] = nums;
  if (Math.abs(latDeg) > 90 || Math.abs(lonDeg) > 180) return null;
  let timeMs = null;
  if (parts.length === 6) {
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?Z$/.test(parts[5]))
      return null;
    timeMs = Date.parse(parts[5]);
    if (!Number.isFinite(timeMs)) return null;
  }
  return {
    latDeg,
    lonDeg,
    view: makeView({ azDeg, elDeg, fovDeg }),
    timeMs,
    flags: decodeFlags(svf),
  };
}

/** Read sky state from a URL (string or URL). */
export function readSkyUrl(href) {
  try {
    const url = new URL(href);
    return decodeSkyState(
      url.searchParams.get(SV_PARAM),
      url.searchParams.get(SVF_PARAM),
    );
  } catch {
    return null;
  }
}

/**
 * New href with the sky parameters set (state) or removed (null). The hash
 * (ShareLinkManager's camera/layer state) and other query parameters are kept.
 */
export function writeSkyUrl(href, state) {
  const url = new URL(href);
  if (state) {
    const { sv, svf } = encodeSkyState(state);
    url.searchParams.set(SV_PARAM, sv);
    if (svf === '0') url.searchParams.delete(SVF_PARAM);
    else url.searchParams.set(SVF_PARAM, svf);
  } else {
    url.searchParams.delete(SV_PARAM);
    url.searchParams.delete(SVF_PARAM);
  }
  // Keep the link readable: ',' and ':' are legal in a query string.
  url.search = url.searchParams
    .toString()
    .replace(/%2C/gi, ',')
    .replace(/%3A/gi, ':');
  return url.href;
}
