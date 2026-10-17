/**
 * The NAIP multi-year config.json as published on S1
 * (/srv/gev-basemap/naip/config.json, N1 schema 1, 2026-10-14), trimmed to
 * the fields that matter plus two entries that must NOT be offered (a
 * statewide year still building and a staged regional layer).
 */
export const NAIP_PUBLISH = Object.freeze({
  schema: 1,
  generated: '2026-10-14T20:26:54Z',
  kind: 'naip-texas',
  tile_url: '/{archive}/{z}/{x}/{y}.webp',
  missing_tile_status: 204,
  fallback_layer: 'sentinel2',
  credit: {
    text: 'USDA NAIP via TxGIO (CC0)',
    url: 'https://data.geographic.texas.gov/',
  },
  default_year: 2024,
  years: [
    {
      year: 2024,
      id: 'naip-2024',
      archive: '2024/naip-tx-2024',
      file: '2024/naip-tx-2024.pmtiles',
      sha256:
        '1e039a8bcaa46a39c2e2efaedff881d6855d89a1c4f75070b3132475091bfffb',
      minzoom: 12,
      maxzoom: 18,
      bounds: [-106.69922, 25.79989, -93.42773, 36.59789],
      acquired: { from: '2024-05-14', to: '2024-11-22' },
      status: 'live',
    },
    {
      year: 2022,
      id: 'naip-2022',
      archive: '2022/naip-tx-2022',
      minzoom: 12,
      maxzoom: 18,
      bounds: [-106.69922, 25.79989, -93.42773, 36.59789],
      status: 'building',
    },
  ],
  regional: [
    {
      id: 'hires-2024',
      kind: 'regional',
      year: 2024,
      name: 'Wood+Upshur 2024 15 cm',
      archive: '2024/hires-wood-upshur-2024',
      edge: {
        port: 12353,
        tile_url: '/{archive}/{z}/{x}/{y}.webp',
        origin: 'http://10.10.99.101:8480/hires',
      },
      minzoom: 14,
      maxzoom: 20,
      bounds: [-95.66551, 32.51642, -94.67228, 33.00319],
      polygon: 'hires/wood-upshur.geojson',
      acquired: { from: '2024-01-20', to: '2024-01-20' },
      credit: {
        text: 'TxGIO / ETCOG 2024',
        url: 'https://data.geographic.texas.gov/',
      },
      status: 'live',
    },
    {
      id: 'hires-2018',
      kind: 'regional',
      year: 2018,
      name: 'Wood+Upshur 2018 15 cm',
      archive: '2018/hires-wood-upshur-2018',
      edge: { port: 12353 },
      minzoom: 14,
      maxzoom: 20,
      bounds: [-95.66551, 32.51642, -94.67228, 33.00319],
      acquired: { from: '2018-01-03', to: '2018-01-30' },
      credit: { text: 'TxGIO / StratMap East Texas 2018' },
      status: 'live',
    },
    {
      id: 'hist-upshur-1939',
      kind: 'regional',
      year: 1939,
      name: 'Upshur 1939 historic aerial (B&W index mosaic)',
      archive: '1939/hires-upshur-1939',
      edge: { port: 12353 },
      minzoom: 12,
      maxzoom: 16,
      bounds: [-95.15808, 32.51439, -94.66919, 32.90726],
      credit: { text: 'TxGIO / USDA 1939' },
      grayscale: true,
      status: 'live',
    },
    {
      id: 'hist-wood-1949',
      kind: 'regional',
      year: 1949,
      name: 'Wood 1949 (raw sheets)',
      archive: '1949/hires-wood-1949',
      minzoom: 12,
      maxzoom: 16,
      bounds: [-95.66895, 32.53755, -95.14709, 33.00406],
      status: 'staged',
    },
  ],
});

/** Tyler, TX (Smith County: statewide NAIP only) and Gilmer (Upshur). */
export const TYLER = Object.freeze({ lon: -95.3011, lat: 32.3513 });
export const GILMER = Object.freeze({ lon: -94.9427, lat: 32.7287 });
