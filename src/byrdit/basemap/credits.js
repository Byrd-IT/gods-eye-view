/**
 * Byrd-IT Open attribution (BASEMAP.md 4.4). The returned markup is handed to
 * the map controller as the stack's `credit`; the controller registers it
 * only while this stack is the one on screen (src/maps/credits.js), so
 * the credits come and go with the stack.
 *
 * NAIP is not part of the stack credit: the N6 NAIP year layers register
 * "USDA NAIP <year> via TxGIO" (and each regional layer's own text)
 * themselves, only while that layer is on screen (naip.js). The buildings
 * credit is not part of the stack credit: the buildings layer registers
 * BUILDINGS_CREDIT_HTML itself, only while buildings are on screen
 * (buildings.js), because the layer comes and goes with the camera height.
 */

export const GIBS_CREDIT = 'NASA GIBS / EOSDIS';
export const TERRAIN_CREDIT_HTML =
  'Terrain: <a href="https://mapterhorn.com/attribution" target="_blank" rel="noopener">Mapterhorn</a>' +
  ' - open data from US Geological Survey (public domain), Copernicus, CC BY national mapping agencies,' +
  ' and others; heights adjusted with EGM2008 (NGA)';
export const WATER_MASK_CREDIT =
  '© OpenStreetMap contributors via Protomaps (ODbL)';
export const CREDIT_SEPARATOR = ' | ';
/** BASEMAP.md 4.4: buildings and map data (Overture buildings theme, P5). */
export const BUILDINGS_CREDIT_TEXT =
  '© OpenStreetMap contributors, Overture Maps Foundation (ODbL)';
export const BUILDINGS_CREDIT_HTML =
  'Buildings © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>,' +
  ' <a href="https://docs.overturemaps.org/attribution/" target="_blank" rel="noopener">Overture Maps Foundation</a>' +
  ' (<a href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank" rel="noopener">ODbL</a>)';

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
