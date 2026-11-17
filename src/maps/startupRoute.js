/**
 * @module maps/startupRoute
 * @description Which route the photoreal base starts on, from the
 * credentials configured; Cesium-free.
 */
const clean = (value) => String(value || '').trim();

/**
 * Decide which map provider can deliver the best startup experience.
 * Byrd-IT: Google 3D is only ever reached with OUR Google key (or server
 * tokens); a Cesium ion token never selects Google 3D (the ion-hosted Google
 * asset runs on Cesium's account and quota, which the owner does not want to
 * depend on).
 * @param {{googleApiKey?: string}} credentials
 * @returns {'google-direct'|'osm'}
 */
export function selectMapStartupRoute({ googleApiKey = '' } = {}) {
  return clean(googleApiKey) ? 'google-direct' : 'osm';
}
