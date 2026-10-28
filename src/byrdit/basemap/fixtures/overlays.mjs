const edge = (ext) => ({
  port: 12353,
  tile_url: `/{archive}/{z}/{x}/{y}.${ext}`,
  origin: 'http://10.10.99.101:8480/hires',
});
const raster = (id, name, archive, opacity, credit, extra = {}) => ({
  id,
  name,
  kind: 'overlay-raster',
  format: 'webp',
  tile_size: 256,
  archive,
  file: `hires/${archive}.pmtiles`,
  edge: edge('webp'),
  sha256: 'ab'.repeat(32),
  minzoom: 11,
  maxzoom: 17,
  bounds: [-96.1853, 32.50976, -94.43573, 33.2295],
  default_opacity: opacity,
  status: 'live-data',
  credit,
  ...extra,
});

/** overlays.json as published on S1 (M2, 2026-10-27), trimmed; plus bad entries. */
export const OVERLAYS_PUBLISH = Object.freeze({
  schema: 1,
  kind: 'gev-overlays-east-texas',
  layers: [
    raster(
      'ustopo',
      'US Topo 7.5-minute (2022)',
      'm2/ustopo-2022',
      1,
      'USGS US Topo',
    ),
    raster(
      'hillshade',
      'Hillshade 1 m lidar',
      'm2/hillshade-3dep1m',
      0.5,
      'USGS 3DEP',
    ),
    raster(
      'relief',
      'Colour relief 1 m lidar',
      'm2/relief-3dep1m',
      0.6,
      'USGS 3DEP',
    ),
    raster(
      'terrain-rgb',
      'Terrain-RGB (Terrarium) 1 m lidar',
      'm2/terrain-rgb-3dep1m',
      1,
      'USGS 3DEP',
    ),
    {
      id: 'contours',
      name: 'Contours 5 ft / 25 ft major',
      kind: 'overlay-vector',
      format: 'mvt',
      archive: 'm2/contours-3dep1m',
      edge: edge('mvt'),
      minzoom: 11,
      maxzoom: 16,
      bounds: [-96.18391, 32.51026, -94.43711, 33.22765],
      vector_layers: [
        { id: 'contours_major', minzoom: 11, maxzoom: 16, fields: ['elev_ft'] },
        { id: 'contours_minor', minzoom: 14, maxzoom: 16, fields: ['elev_ft'] },
      ],
      credit: 'USGS 3DEP',
      status: 'live-data',
    },
    {
      id: 'lake-depth',
      name: 'TWDB lake depth contours',
      kind: 'overlay-vector',
      format: 'mvt',
      archive: 'm2/lake-depth-twdb',
      edge: edge('mvt'),
      minzoom: 9,
      maxzoom: 16,
      bounds: [-96.13287, 32.55506, -94.48982, 33.10746],
      vector_layers: [
        { id: 'lake_pool', minzoom: 9, maxzoom: 16 },
        { id: 'bathy_major', minzoom: 10, maxzoom: 16 },
        { id: 'bathy_contours', minzoom: 14, maxzoom: 16 },
      ],
      credit: 'Texas Water Development Board',
      status: 'live-data',
    },
    // must NOT be offered:
    raster('staged', 'Staged layer', 'm2/staged', 1, 'x', {
      status: 'building',
    }),
  ],
});
