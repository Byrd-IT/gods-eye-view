/** A /basemap/config.json as the proxy composes it (P1 terrain + P2 imagery). */
export const SERVED = Object.freeze({
  schema: 1,
  terrain: {
    available: true,
    version: 'mh0.0.13-wm20261011',
    url: '/basemap/v/mh0.0.13-wm20261011/terrain/cesium-mesh/ellipsoid',
    minzoom: 0,
    maxzoom: 14,
    waterMask: true,
  },
  imagery: {
    available: true,
    archive: 'imagery-2025',
    url: '/basemap/imagery/imagery-2025/{z}/{x}/{y}.webp',
    baseMaxzoom: 8,
    maxzoom: 14,
    year: 2025,
    regions: [
      { bounds: [-107.57812, 25.16517, -92.8125, 37.16032], maxzoom: 14 },
      { bounds: [18.28125, 67.33986, 21.79688, 68.65655], maxzoom: 13 },
    ],
  },
  switch: { auto: true, enterM: 5000, leaveM: 8000, dwellMs: 5000 },
});
