/**
 * Google 3D through the scene's globe port (upstream's photoreal contract).
 *
 * Upstream's map stack switches photoreal with a port handle
 * (`{spec, globe, shown}` from the engine's `loadPhotoreal`) through
 * `showTileset` / `tilesetShown` / `tilesetReady` / `release`. The fork's
 * lazy Google session, automatic switch, buildings, NAIP and overlay code
 * read and set `tileset.show`, as on a Cesium3DTileset. A Cesium tileset
 * built beside the port (the old `loadPhotorealisticTileset` route) loads
 * its tiles but the switch then reads `handle.globe` and throws
 * "Cannot read properties of undefined (reading 'setPhotoreal')", so the
 * stack falls back to the open map.
 *
 * This loads the handle through the engine and gives it a `show` accessor
 * that switches through the same engine calls. Showing it again with the
 * same spec unparks the kept tileset: a hide and show costs no root request.
 */
import { mapEngineFor } from '../../maps/engine.js';

/**
 * @param {object} host - the scene object the renderer is bound to.
 * @param {{googleApiKey?: string, googleTokens?: {token: Function}|null}} credentials
 * @param {(host: object) => object} [engineFor]
 * @returns {Promise<{tileset: object|null, route: string, errors: Error[]}>}
 */
export async function loadGooglePortHandle(
  host,
  { googleApiKey = '', googleTokens = null } = {},
  engineFor = mapEngineFor,
) {
  const engine = engineFor(host);
  // Fork rule: only our own Google key or tokens enable Google 3D, never a
  // Cesium ion token, so no ion fallback credential is passed.
  const result = await engine.loadPhotoreal(host, {
    googleApiKey,
    googleTokens,
  });
  const handle = result?.tileset ?? null;
  if (!handle)
    return {
      tileset: null,
      route: result?.route ?? 'none',
      errors: result?.errors ?? [],
    };
  if (!('show' in handle))
    Object.defineProperty(handle, 'show', {
      configurable: true,
      enumerable: false,
      get: () => engine.tilesetShown(handle),
      set: (shown) => engine.showTileset(handle, Boolean(shown)),
    });
  return { tileset: handle, route: result.route, errors: [] };
}

/** Release a handle loaded above (hides it; never shown again). */
export function releaseGooglePortHandle(
  host,
  handle,
  engineFor = mapEngineFor,
) {
  if (!handle) return;
  engineFor(host).release(handle);
}
