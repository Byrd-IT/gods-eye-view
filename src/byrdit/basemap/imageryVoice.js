/**
 * Voice surface of aerial imagery by year (owner decision 2026-10-26).
 * One thin adapter over the mounted NAIP slider (naip.js) and, when it is
 * already on the page, Esri Wayback. The voice tool `control_imagery`
 * (src/voice/gevActions.js) reaches it through `window.__gevImagery.voice`.
 *
 *   year      a year from the live catalog (statewide NAIP, historic county
 *             sets, and colour sets). Optional county frames that set.
 *   wayback   an Esri Wayback release, only when that basemap option is mounted
 *   off       turn the aerial overlay and/or Wayback off
 *   status    read-only state, including the valid years
 *
 * Years and counties come from the catalog the slider was given. Nothing
 * here hard-codes a year list. It adds no state of its own and never throws:
 * an unusable request answers {ok:false, error}. Errors never repeat text
 * the caller sent, unless that text was parsed into a plain year or date.
 */
import { planYear, sliderYears } from './naip.js';

export const IMAGERY_VOICE_ACTIONS = Object.freeze([
  'year',
  'wayback',
  'off',
  'status',
]);

const OPEN_STACK_ID = 'byrdit-open';

/** Switch the map to Byrd-IT Open so the aerial layers actually draw. */
export async function ensureByrditOpen(controller, openId = OPEN_STACK_ID) {
  if (typeof controller?.setStack !== 'function')
    return { ok: false, error: 'Could not switch to the Byrd-IT Open map' };
  if (controller.getActiveId?.() === openId)
    return { ok: true, switched: false };
  try {
    await controller.setStack(openId);
  } catch {
    return { ok: false, error: 'Could not switch to the Byrd-IT Open map' };
  }
  if (controller.getActiveId?.() !== openId)
    return { ok: false, error: 'Could not switch to the Byrd-IT Open map' };
  return { ok: true, switched: true };
}

/** Frame a county set. Returns false when the camera cannot move. */
export function flyToImageryBounds(viewer, Cesium, bounds) {
  if (!viewer?.camera?.flyTo || !Cesium?.Rectangle?.fromDegrees) return false;
  if (!Array.isArray(bounds) || bounds.length !== 4) return false;
  const [west, south, east, north] = bounds;
  if (![west, south, east, north].every((n) => typeof n === 'number'))
    return false;
  viewer.camera.flyTo({
    destination: Cesium.Rectangle.fromDegrees(west, south, east, north),
    duration: 1.2,
  });
  return true;
}

const STOP = new Set([
  'historic',
  'aerial',
  'index',
  'mosaic',
  'partial',
  'color',
  'colour',
  'bw',
  'cm',
  'the',
  'and',
  'via',
  'txgio',
  'usda',
  'naip',
  'ring',
  'hires',
  'hist',
  'county',
  'set',
  'imagery',
]);

const YEAR_ONLY = /^\d{4}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const COUNTY_SHAPE = /^[A-Za-z][A-Za-z .'-]{0,39}$/;

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

const fold = (text) =>
  String(text ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9+.' -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** County names in a regional entry's display name (before the year). */
export function countyLabels(entry) {
  const head = String(entry?.name || '').split(/\d/)[0] || '';
  const labels = [];
  for (const piece of head.split(/[-+]/)) {
    const label = piece.replace(/\s+/g, ' ').trim();
    const key = fold(label);
    if (!key || STOP.has(key) || /^\d+$/.test(key)) continue;
    labels.push(label);
  }
  return labels;
}

function idTokens(entry) {
  const skip = new Set(['hist', 'hires', 'color', 'colour', 'ring']);
  return String(entry?.id || '')
    .toLowerCase()
    .split('-')
    .filter((part) => part && !skip.has(part) && !/^\d+$/.test(part));
}

function countyKey(raw) {
  if (typeof raw !== 'string' || !COUNTY_SHAPE.test(raw.trim())) return null;
  const key = fold(raw)
    .replace(/^the /, '')
    .replace(/ county$/, '')
    .trim();
  if (!key || STOP.has(key)) return null;
  return key;
}

function entryScore(entry, key) {
  if (idTokens(entry).includes(key)) return 2;
  if (countyLabels(entry).some((label) => fold(label) === key)) return 1;
  return 0;
}

/** A county label from the catalog, never the caller's raw text. */
function catalogCounty(catalog, key) {
  for (const entry of catalog?.regional ?? []) {
    for (const label of countyLabels(entry)) {
      if (fold(label) === key) return label;
    }
    if (idTokens(entry).includes(key))
      return key.replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
  }
  return null;
}

function countiesForYear(catalog, year) {
  const seen = new Set();
  const labels = [];
  for (const entry of catalog?.regional ?? []) {
    if (entry.year !== year) continue;
    for (const label of countyLabels(entry)) {
      const key = fold(label);
      if (seen.has(key)) continue;
      seen.add(key);
      labels.push(label);
    }
  }
  return labels;
}

function waybackYears(rows) {
  const years = new Set();
  for (const row of rows) {
    const year = Number(String(row?.date || '').slice(0, 4));
    if (year >= 1800 && year <= 2999) years.add(year);
  }
  return [...years].sort((a, b) => a - b);
}

function parseWaybackQuery(value) {
  if (typeof value !== 'string')
    return { error: 'date must be a year or YYYY-MM-DD' };
  const text = value.trim();
  if (YEAR_ONLY.test(text)) return { year: Number(text) };
  if (ISO_DATE.test(text)) return { date: text };
  return { error: 'date must be a year or YYYY-MM-DD' };
}

/**
 * @param {object} options
 *   getNaip () => attachNaip handle, or null
 *   getCatalog () => normalized naip block, or null
 *   getWayback () => {enable, disable, setIndex, settleNow, state, catalog}, or null
 *   ensureOpen () => Promise<{ok, switched?, error?}>
 *   flyTo (bounds) => boolean
 */
export function createImageryVoice({
  getNaip,
  getCatalog,
  getWayback,
  ensureOpen,
  flyTo,
} = {}) {
  const naip = () => {
    const handle = getNaip?.();
    return typeof handle?.setYear === 'function' ? handle : null;
  };
  const catalog = () => {
    const block = getCatalog?.();
    return block && (block.years || block.regional) ? block : null;
  };
  const wayback = () => {
    const handle = getWayback?.();
    return typeof handle?.catalog === 'function' ? handle : null;
  };

  const unavailable = () => fail('Aerial imagery is not available right now');

  const snapshot = (handle, block) => {
    const st = handle?.state?.() ?? {};
    const year = st.year ?? null;
    const plan = year === null || !block ? null : planYear(block, year);
    const layers = Array.isArray(st.layers) ? st.layers : null;
    const compare = st.compare === true;
    return {
      year,
      enabled: Boolean(st.enabled),
      // compare true means this year is only the left side of the split.
      // drawn is false when Google 3D or another stack is covering the layers.
      compare,
      drawn: layers ? layers.some((layer) => layer?.show === true) : false,
      ...(compare ? { yearB: st.yearB ?? null } : {}),
      label: plan?.label ?? null,
      years: sliderYears(block),
      sets: (plan?.regional ?? []).map((entry) => ({
        id: entry.id,
        name: entry.name,
        greyscale: entry.greyscale === true,
      })),
    };
  };

  async function openStack() {
    if (typeof ensureOpen !== 'function') return { ok: true, switched: false };
    try {
      const result = await ensureOpen();
      if (result && result.ok === false)
        return {
          ok: false,
          error: 'Could not switch to the Byrd-IT Open map',
        };
      return { ok: true, switched: Boolean(result?.switched) };
    } catch {
      return { ok: false, error: 'Could not switch to the Byrd-IT Open map' };
    }
  }

  async function frame(bounds) {
    if (typeof flyTo !== 'function' || !Array.isArray(bounds)) return false;
    try {
      return (await flyTo(bounds)) !== false;
    } catch {
      return false;
    }
  }

  return {
    async year({ year, county } = {}) {
      const block = catalog();
      const handle = naip();
      if (!block || !handle) return unavailable();
      const ticks = sliderYears(block);
      if (!Number.isInteger(year) || year < 1800 || year > 2999)
        return fail('year must be a four-digit year', { years: ticks });
      if (!ticks.includes(year))
        return fail(`No aerial imagery for ${year}.`, { years: ticks });

      let framed = null;
      if (county != null && String(county).trim() !== '') {
        const key = countyKey(county);
        const known = key ? catalogCounty(block, key) : null;
        const matches = key
          ? (block.regional ?? [])
              .filter(
                (entry) => entry.year === year && entryScore(entry, key) > 0,
              )
              .sort((a, b) => entryScore(b, key) - entryScore(a, key))
          : [];
        if (!matches.length) {
          const counties = countiesForYear(block, year);
          return fail(
            known
              ? `${known} has no set for ${year}.`
              : 'No county set matched.',
            { year, counties, years: ticks },
          );
        }
        framed = matches[0];
      }

      const archive = wayback();
      const wasOn = Boolean(archive?.state?.().on);
      const opened = await openStack();
      if (!opened.ok) return fail(opened.error, { years: ticks });
      // byrdit-open covers Wayback. The stack switch turns it off; say so
      // even when that switch already ran inside openStack.
      if (wasOn) {
        try {
          await archive.disable?.();
        } catch {
          /* waybackOff reports whether it actually turned off */
        }
      }
      handle.setEnabled?.(true);
      handle.setYear(year);
      const flew = framed ? await frame(framed.bounds) : false;
      return {
        ok: true,
        ...snapshot(handle, block),
        switched: opened.switched,
        waybackOff: wasOn && archive?.state?.().on !== true,
        framed: framed ? { id: framed.id, name: framed.name, flew } : null,
      };
    },

    async wayback({ date } = {}) {
      const handle = wayback();
      if (!handle) return fail('Wayback is not available right now');
      const rows = Array.isArray(handle.catalog()) ? handle.catalog() : [];
      const years = waybackYears(rows);
      const parsed = parseWaybackQuery(date);
      if (parsed.error) return fail(parsed.error, { years });
      const match = parsed.date
        ? rows.find((row) => row.date === parsed.date)
        : [...rows]
            .filter((row) =>
              String(row.date || '').startsWith(`${parsed.year}-`),
            )
            .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
            .at(-1);
      if (!match) {
        const asked = parsed.date || String(parsed.year);
        return fail(`No Wayback release for ${asked}.`, { years });
      }
      const index = rows.findIndex(
        (row) => row.date === match.date && row.release === match.release,
      );
      if (index < 0) return fail('Wayback is not available right now');
      handle.setIndex?.(index);
      if (!handle.state?.().on) {
        let enabled = false;
        try {
          enabled = await handle.enable();
        } catch {
          enabled = false;
        }
        if (!enabled) return fail('Wayback could not be turned on', { years });
      } else {
        try {
          handle.settleNow?.();
        } catch {
          /* the slider index is already set */
        }
      }
      const state = handle.state?.() ?? {};
      return {
        ok: true,
        date: match.date,
        release: match.release,
        on: state.on !== false,
        years,
      };
    },

    async off({ target } = {}) {
      const which =
        target === 'wayback' || target === 'both' || target === 'aerial'
          ? target
          : target == null || target === ''
            ? 'aerial'
            : null;
      if (!which) return fail('target must be aerial, wayback, or both');
      const aerial = naip();
      const archive = wayback();
      // both: turn off whichever handle exists. Fail only if neither does.
      if (which === 'both') {
        if (!aerial && !archive) return unavailable();
      } else if (which === 'aerial') {
        if (!aerial) return unavailable();
      } else if (!archive) {
        return fail('Wayback is not available right now');
      }
      const out = { ok: true, target: which };
      if ((which === 'aerial' || which === 'both') && aerial) {
        aerial.setEnabled?.(false);
        out.aerial = false;
      }
      if ((which === 'wayback' || which === 'both') && archive) {
        const handle = archive;
        try {
          await handle.disable?.();
        } catch {
          return fail('Wayback could not be turned off');
        }
        out.wayback = false;
      }
      return out;
    },

    async status() {
      const block = catalog();
      const handle = naip();
      const wb = wayback();
      if (!block && !handle && !wb) return unavailable();
      const rows = wb && Array.isArray(wb.catalog()) ? wb.catalog() : [];
      const state = wb?.state?.() ?? null;
      return {
        ok: true,
        ...(handle && block
          ? snapshot(handle, block)
          : { years: sliderYears(block) }),
        counties: countiesForYear(block, handle?.state?.().year),
        wayback: wb
          ? {
              available: true,
              on: Boolean(state?.on),
              date: state?.date ?? null,
              years: waybackYears(rows),
            }
          : { available: false },
      };
    },
  };
}
