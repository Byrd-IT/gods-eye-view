import { createTerrainRetryPolicy } from '../../maps/terrainRetry.js';

/**
 * Byrd-IT Open terrain (BASEMAP.md 4.2): quantized-mesh from the same-origin
 * /basemap/v/<version>/terrain/cesium-mesh/ellipsoid, with vertex normals and
 * the water mask, using the same retry policy as the hosted keyless terrain
 * (429/502/503/504 retried behind one shared cooldown).
 *
 * If layer.json cannot be read the stack still opens on `fallback()` (the
 * keyless terrain that maps/terrain.js already uses, which itself falls back
 * to the flat ellipsoid), so imagery is never blocked by terrain.
 *
 * @param {object} Cesium
 * @param {ReturnType<import('./config.js').normalizeBasemapConfig>['terrain']} terrain
 * @param {{policy?: object, fallback: () => Promise<{provider: object}>, signal?: AbortSignal, warn?: Function}} options
 */
export async function createBasemapTerrain(
  Cesium,
  terrain,
  {
    policy = createTerrainRetryPolicy(),
    fallback,
    signal,
    warn = (...args) => console.warn(...args),
  },
) {
  try {
    signal?.throwIfAborted();
    const resource = new Cesium.Resource({
      url: terrain.url,
      retryCallback: policy.retryCallback,
      retryAttempts: policy.retryAttempts,
    });
    const provider = await Cesium.CesiumTerrainProvider.fromUrl(resource, {
      requestVertexNormals: true,
      requestWaterMask: terrain.waterMask !== false,
    });
    return { provider };
  } catch (error) {
    if (signal?.aborted) throw error;
    warn(
      '[Basemap] Byrd-IT Open terrain unavailable, using the fallback terrain:',
      error,
    );
    return fallback();
  }
}
