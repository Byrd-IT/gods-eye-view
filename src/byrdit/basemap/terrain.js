import { createTerrainRetryPolicy } from '../../maps/terrainRetry.js';

/**
 * Byrd-IT Open terrain (BASEMAP.md 4.2): quantized-mesh from the same-origin
 * /basemap/v/<version>/terrain/cesium-mesh/ellipsoid, with vertex normals and
 * the water mask, as the globe port's `quantizedMesh` spec (the renderer asks
 * for its tiles with the same retry policy as the hosted keyless terrain:
 * 429/502/503/504 retried behind one shared cooldown).
 *
 * If layer.json cannot be read the stack still opens on `fallback()` (the
 * keyless terrain that maps/terrain.js already uses, which itself falls back
 * to the flat ellipsoid), so imagery is never blocked by terrain.
 *
 * @param {ReturnType<import('./config.js').normalizeBasemapConfig>['terrain']} terrain
 * @param {{fetchImpl?: typeof fetch, fallback: (request: {signal?: AbortSignal}) => Promise<{provider: object|null, spec?: object}>, signal?: AbortSignal, warn?: Function}} options
 */
export async function createBasemapTerrain(
  terrain,
  {
    fetchImpl = (...args) => globalThis.fetch(...args),
    fallback,
    signal,
    warn = (...args) => console.warn(...args),
  },
) {
  try {
    signal?.throwIfAborted();
    const response = await fetchImpl(
      `${terrain.url.replace(/\/+$/, '')}/layer.json`,
      { signal },
    );
    if (!response.ok)
      throw new Error(`Terrain layer.json answered ${response.status}`);
    return {
      provider: null,
      spec: {
        kind: 'quantizedMesh',
        url: terrain.url,
        requestVertexNormals: true,
        requestWaterMask: terrain.waterMask !== false,
      },
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    warn(
      '[Basemap] Byrd-IT Open terrain unavailable, using the fallback terrain:',
      error,
    );
    return fallback({ signal });
  }
}
