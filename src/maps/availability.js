import { keySetupRequirement } from '../keySetupCore.mjs';
/**
 * Why Google 3D is unavailable, phrased so the tooltip and toast recommend the
 * RIGHT fix. With no Google key the fix is a key (Cesium ion's hosted Google
 * asset is deliberately not used); with a key configured, the tileset failed for another reason —
 * restrictions, quota, an EEA-billed key, or the network — and telling the
 * user to add a key they already added is the wrong advice.
 * @param {boolean} hasCredentials
 * @returns {string}
 */
export function photorealUnavailableReason(hasCredentials) {
  if (hasCredentials)
    return "Google 3D tiles unavailable — check the key's API restrictions, quota, or network";
  return keySetupRequirement('google-maps');
}
