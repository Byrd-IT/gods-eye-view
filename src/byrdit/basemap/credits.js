/**
 * Byrd-IT Open attribution (BASEMAP.md 4.4). The returned markup is handed to
 * the map controller as the stack's `credit`; the controller registers it
 * only while this stack is the one on screen (src/maps/credits.js), so
 * the credits come and go with the stack.
 *
 * NAIP was dropped (owner decision O2) and the buildings layer is not part of
 * this phase, so neither credit appears here.
 */

export const GIBS_CREDIT = 'NASA GIBS / EOSDIS';
export const TERRAIN_CREDIT_HTML =
  'Terrain: <a href="https://mapterhorn.com/attribution" target="_blank" rel="noopener">Mapterhorn</a>' +
  ' - open data from US Geological Survey (public domain), Copernicus, CC BY national mapping agencies,' +
  ' and others; heights adjusted with EGM2008 (NGA)';
export const WATER_MASK_CREDIT =
  '© OpenStreetMap contributors via Protomaps (ODbL)';
export const CREDIT_SEPARATOR = ' | ';

/** "Contains modified Copernicus Sentinel data <year>". */
export function sentinelCredit(year) {
  return Number.isInteger(year)
    ? `Contains modified Copernicus Sentinel data ${year}`
    : 'Contains modified Copernicus Sentinel data';
}

/**
 * The credit strings for the parts of the stack that are in use.
 * @param {ReturnType<import('./config.js').normalizeBasemapConfig>} config
 * @returns {string[]}
 */
export function basemapCredits(config) {
  const credits = [];
  if (config?.imagery?.available) {
    if (config.imagery.regions.length)
      credits.push(sentinelCredit(config.imagery.year));
    credits.push(GIBS_CREDIT);
  }
  if (config?.terrain?.available) {
    credits.push(TERRAIN_CREDIT_HTML);
    if (config.terrain.waterMask) credits.push(WATER_MASK_CREDIT);
  }
  return credits;
}

/** One credit markup string for the map controller (null when nothing is used). */
export function basemapCreditHtml(config) {
  const credits = basemapCredits(config);
  return credits.length ? credits.join(CREDIT_SEPARATOR) : null;
}
