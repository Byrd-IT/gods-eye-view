/**
 * Byrd-IT fork: per-layer opacity state and its address-bar form.
 *
 * Pure: no DOM, no Cesium. Every data layer starts at 100 % and nothing is
 * written anywhere until a layer is moved off 100 %, so the default view is
 * byte-for-byte what it was before this control existed.
 *
 * Share state: the opacity of each layer that is NOT at 100 % travels in the
 * page address as `lop=<layer-id>:<percent>,...` (layer ids are the permanent
 * ids of the layer-state registry). Like `ht=` and `hl=` of the History menu it
 * is a query parameter of its own, so the long `#v=2&...` form, the compact
 * `/share/<code>` codec and every existing link are untouched, and a link with
 * no `lop` means every layer at 100 %.
 */

export const LOP_PARAM = 'lop';
export const OPACITY_DEFAULT = 1;
export const OPACITY_MIN = 0;
export const OPACITY_MAX = 1;
/** Slider granularity, in percent. */
export const OPACITY_STEP_PCT = 5;
/** Upper bound on entries read from an address (there are < 60 layers). */
const MAX_LOP_ENTRIES = 96;
const LOP_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A finite fraction 0..1 rounded to a whole percent; anything else is 100 %. */
export function normalizeOpacity(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return OPACITY_DEFAULT;
  return (
    Math.round(Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, n)) * 100) / 100
  );
}

/** Whole percent 0..100 of a fraction (what the slider shows). */
export function opacityPercent(value) {
  return Math.round(normalizeOpacity(value) * 100);
}

/**
 * The opacity state: a map from layer id to a fraction, defaulting to 1.
 * `set` returns whether the stored value changed, so callers skip no-ops.
 * @param {{ids?: Iterable<string>}} [options] Known ids; unknown ids are refused.
 */
export function createOpacityModel({ ids } = {}) {
  const known = ids ? new Set(ids) : null;
  /** @type {Map<string, number>} only layers off the default */
  const values = new Map();
  const listeners = new Set();
  const accepts = (id) =>
    typeof id === 'string' && id !== '' && (known ? known.has(id) : true);
  const model = {
    has: accepts,
    get(id) {
      return values.has(id) ? values.get(id) : OPACITY_DEFAULT;
    },
    set(id, value) {
      if (!accepts(id)) return false;
      const next = normalizeOpacity(value);
      const prev = model.get(id);
      if (next === prev) return false;
      if (next === OPACITY_DEFAULT) values.delete(id);
      else values.set(id, next);
      for (const listener of [...listeners]) {
        try {
          listener(id, next);
        } catch {
          /* one failing listener must not stop the others */
        }
      }
      return true;
    },
    /** Ids and fractions that differ from the default, in id order. */
    entries() {
      return [...values.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    },
    reset() {
      for (const id of [...values.keys()]) model.set(id, OPACITY_DEFAULT);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return model;
}

/** `id:pct,id:pct` for the entries off the default; '' when there are none. */
export function encodeLop(entries) {
  return [...entries]
    .filter(([id, value]) => LOP_ID.test(id) && normalizeOpacity(value) !== 1)
    .map(([id, value]) => `${id}:${opacityPercent(value)}`)
    .join(',');
}

/**
 * Parse a `lop` value. Malformed pairs, unknown ids, duplicates (the first
 * wins), and 100 % entries are dropped; the whole value is ignored when it is
 * absurdly long. Never throws.
 * @param {string|null|undefined} text
 * @param {(id: string) => boolean} [isKnown]
 * @returns {Map<string, number>}
 */
export function decodeLop(text, isKnown = () => true) {
  const out = new Map();
  if (typeof text !== 'string' || text.length === 0 || text.length > 4096)
    return out;
  const pairs = text.split(',');
  if (pairs.length > MAX_LOP_ENTRIES) return out;
  for (const pair of pairs) {
    const at = pair.lastIndexOf(':');
    if (at <= 0) continue;
    const id = pair.slice(0, at);
    const pct = pair.slice(at + 1);
    if (!LOP_ID.test(id) || !/^\d{1,3}$/.test(pct) || !isKnown(id)) continue;
    if (out.has(id)) continue;
    const value = normalizeOpacity(Number(pct) / 100);
    if (value !== OPACITY_DEFAULT) out.set(id, value);
  }
  return out;
}

/**
 * The address with `lop` set from the entries, or removed when there are none.
 * Only the `lop` pair is edited; every other parameter keeps its encoding.
 */
export function writeLopToUrl(href, entries) {
  const url = new URL(href);
  const value = encodeLop(entries);
  const kept = url.search
    .replace(/^\?/, '')
    .split('&')
    .filter((pair) => pair && pair.split('=')[0] !== LOP_PARAM);
  if (value) kept.push(`${LOP_PARAM}=${value}`);
  url.search = kept.length ? `?${kept.join('&')}` : '';
  return url.href;
}

export function readLopFromUrl(href, isKnown) {
  try {
    return decodeLop(new URL(href).searchParams.get(LOP_PARAM), isKnown);
  } catch {
    return new Map();
  }
}
