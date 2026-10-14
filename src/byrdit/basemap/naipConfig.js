/**
 * Browser validation of the `naip` block of /basemap/config.json (BASEMAP
 * N6, composed server-side by naipProxy.js). Pure, no imports, so config.js
 * (which the node-side proxy also loads) can use it.
 */

export const NAIP_CREDIT_PREFIX = 'USDA NAIP';
const NAIP_PATH =
  /^\/basemap\/naip\/(?:\d{4}|regional\/[A-Za-z0-9._-]{1,64})\/\{z\}\/\{x\}\/\{y\}\.webp$/;
const DATE = /^\d{4}-\d\d-\d\d$/;
const CREDIT_TEXT = /^[A-Za-z0-9 /&+().,'-]{1,80}$/;

/** "USDA NAIP 2024 via TxGIO". */
export function naipCreditText(year) {
  return `${NAIP_CREDIT_PREFIX} ${year} via TxGIO`;
}

const int = (v, lo, hi) =>
  Number.isInteger(v) && v >= lo && v <= hi ? v : null;

function bounds(value) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  if (!value.every((v) => typeof v === 'number' && Number.isFinite(v)))
    return null;
  const [w, s, e, n] = value;
  if (w < -180 || e > 180 || s < -90 || n > 90 || w >= e || s >= n) return null;
  return [w, s, e, n];
}

function zooms(raw) {
  const minzoom = int(raw?.minzoom, 0, 22);
  const maxzoom = int(raw?.maxzoom, 0, 22);
  return minzoom === null || maxzoom === null || maxzoom < minzoom
    ? null
    : { minzoom, maxzoom };
}

function acquired(raw) {
  const from = DATE.test(raw?.from ?? '') ? raw.from : null;
  const to = DATE.test(raw?.to ?? '') ? raw.to : null;
  return from || to ? { from, to } : null;
}

const url = (value) =>
  typeof value === 'string' && NAIP_PATH.test(value) ? value : null;
const text = (value, fallback) =>
  typeof value === 'string' && CREDIT_TEXT.test(value) ? value : fallback;

/**
 * Validate the served `naip` block. Missing or broken = {available: false}
 * and the slider is simply not offered.
 */
export function normalizeNaip(raw) {
  const years = [];
  const seen = new Set();
  for (const entry of Array.isArray(raw?.years) ? raw.years : []) {
    const year = int(entry?.year, 1800, 2999);
    const z = zooms(entry);
    const b = bounds(entry?.bounds);
    const u = url(entry?.url);
    if (year === null || !z || !b || !u || seen.has(year)) continue;
    seen.add(year);
    years.push({
      kind: 'statewide',
      key: `naip-${year}`,
      year,
      url: u,
      ...z,
      bounds: b,
      acquired: acquired(entry?.acquired),
      credit: naipCreditText(year),
    });
  }
  const regional = [];
  const ids = new Set();
  for (const entry of Array.isArray(raw?.regional) ? raw.regional : []) {
    const year = int(entry?.year, 1800, 2999);
    const z = zooms(entry);
    const b = bounds(entry?.bounds);
    const u = url(entry?.url);
    const id = typeof entry?.id === 'string' ? entry.id : '';
    if (year === null || !z || !b || !u || !id || ids.has(id)) continue;
    if (!u.startsWith(`/basemap/naip/regional/${id}/`)) continue;
    ids.add(id);
    regional.push({
      kind: 'regional',
      key: `regional-${id}`,
      id,
      year,
      name: text(entry?.name, id),
      url: u,
      ...z,
      bounds: b,
      acquired: acquired(entry?.acquired),
      credit: text(entry?.credit, `TxGIO ${year}`),
      greyscale: entry?.greyscale === true,
    });
  }
  years.sort((a, b) => a.year - b.year);
  regional.sort((a, b) => a.year - b.year || (a.id < b.id ? -1 : 1));
  const available =
    raw?.available === true && (years.length > 0 || regional.length > 0);
  return {
    available,
    defaultYear: int(raw?.defaultYear, 1800, 2999),
    years: available ? years : [],
    regional: available ? regional : [],
  };
}
