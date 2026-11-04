import { msg } from '../../i18n/index.js';

/**
 * Map layers grouping and search. The overlays manifest has no group field,
 * so a layer's group is read from its id (the regional copies are the same
 * id with a region prefix: `r1a-lake-depth`, `rm-hillshade`, `hillshade-wu`).
 * Order is the order the groups are listed in; Lakes comes first because the
 * lake depth contours are what people look for.
 */
export const OVERLAY_GROUPS = Object.freeze([
  Object.freeze({
    id: 'lakes',
    title: msg('Lakes and bays (depth)'),
    test: /(^|-)(lake|bay)-depth($|-)/,
  }),
  Object.freeze({
    id: 'topo',
    title: msg('Topo maps'),
    test: /(^|-)ustopo($|-)|^htmc-/,
  }),
  Object.freeze({
    id: 'hillshade',
    title: msg('Hillshade'),
    test: /(^|-)hillshade($|-)/,
  }),
  Object.freeze({
    id: 'relief',
    title: msg('Colour relief and terrain'),
    test: /(^|-)(relief|terrain-rgb)($|-)/,
  }),
  Object.freeze({
    id: 'contours',
    title: msg('Contour lines'),
    test: /(^|-)contours($|-)/,
  }),
  Object.freeze({
    id: 'water',
    title: msg('Rivers, floods and wetlands'),
    test: /^(hydro|flood|high-water-marks|low-water-crossings|watersheds|wetlands)$/,
  }),
  Object.freeze({
    id: 'land',
    title: msg('Land, boundaries and geology'),
    test: /^(address-points|boundaries|parcels|geology|nlcd|land-surveys-rrc|rrc-oil-gas|tceq-sites|txdot-transport)$/,
  }),
]);

export const OTHER_GROUP = Object.freeze({
  id: 'other',
  title: msg('Other layers'),
});

/** The group (an OVERLAY_GROUPS entry or OTHER_GROUP) of an overlay id. */
export function groupOfOverlay(id) {
  const key = String(id ?? '').toLowerCase();
  return OVERLAY_GROUPS.find((group) => group.test.test(key)) ?? OTHER_GROUP;
}

/** Groups in display order, including OTHER_GROUP last. */
export const ALL_OVERLAY_GROUPS = Object.freeze([
  ...OVERLAY_GROUPS,
  OTHER_GROUP,
]);

/**
 * Whether a layer matches a search text: every word must appear in its name,
 * id or group title (case-insensitive). An empty text matches everything.
 * @param {{id: string, name?: string}} layer
 * @param {string} groupTitle already translated
 * @param {string} query
 */
export function overlayMatches(layer, groupTitle, query) {
  const words = String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return true;
  const haystack =
    `${layer.name ?? ''} ${layer.id ?? ''} ${groupTitle ?? ''}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}
