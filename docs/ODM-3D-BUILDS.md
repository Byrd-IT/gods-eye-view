# Byrd Ranch 3D builds (OpenDroneMap) in the Map layers card

Our own drone maps, built with OpenDroneMap (ODM), show up as 3D layers next
to the flat orthophoto layers. Every layer whose id starts with `odm-` (flat
`odm-preview-*` and 3D `odm-3d-*`) is listed in the **Byrd Ranch builds**
section of the Map layers card (`src/byrdit/basemap/overlayGroups.js`).

Each 3D layer has a toggle, an opacity slider, its version name (the layer
name), a canopy cut (Full model / Cut above 90 ft / Cut above 120 ft) and a
**Fly to** button. The model is placed on the terrain automatically and is
drawn only while Byrd-IT Open is the map shown (Google 3D carries its own
buildings; the layer is removed while it is drawn and comes back after).

## Publish a build: one command

Run on any host with ssh to the source host and to S1 (the map store). The
tileset is streamed to S1, every file is SHA256-checked against the source,
and the layer is added to `hires/m2/overlays.json` last (atomic write, backup
`overlays.json.bak-odm3d-<stamp>`). No restart: GEV reads the manifest on its
own.

    python3 scripts/publish_odm_3d.py \
        --source S4:/srv/odm/data/<build-uuid> \
        --id odm-3d-<first 8 of uuid> \
        --name "Byrd Ranch shop area 3D (2026-10-31, 574 photos)" \
        --canopy-default-ft 90          # small shop-area builds; none for big ones

`--dry-run` prints the manifest entry and copies nothing. A model above
`--max-gb` (default 3) is refused until the owner has approved it
(`--allow-large`). Ids are never reused; a new build gets a new id. Logs go
to stdout and to syslog (tag `gev-publish-odm3d`), which Fleet ships to
Elasticsearch (`logs-journald.generic`: host.name, appname, priority,
message).

What the script fixes on the way: ODM writes the tile meshes with x east, y
north, z up but declares the bounding boxes as if they were Y-up. Cesium then
culls by boxes that do not enclose the mesh. The published `tileset.json` has
the boxes mapped to Z-up and `asset.gltfUpAxis: "Z"`; the original is kept as
`tileset.original.json` and no tile file is touched. The footprint and the
ground height come from the corrected boxes and the ODM DTM
(`odm_dem/dtm.tif`, median, 5% and 95% recorded).

## How the canopy cut works

A level clipping plane in the tileset frame at `ground_m + cut` (90 ft =
27.43 m, 120 ft = 36.58 m). It is a view setting only: stored files never
change and "Full model" restores everything. One plane at the median ground
height cannot follow slopes: on the first two builds the ground varies by
13-20 m (5%-95%), so on a slope the true height above ground differs by about
that much.

## Server side

`/basemap/odm3d/<id>/<file>` is relayed from the S1 origin
(`GEV_BASEMAP_ODM3D_URLS`, default: the folder `GEV_BASEMAP_OVERLAYS_CONFIG`
is read from). Only plain files with a tile extension inside an offered build
are served; unknown ids and any other path are 404 without an upstream
request. Tile files are cached for 30 days, `tileset.json` for 60 s.

## Checks

    node --test src/byrdit/basemap/odm3d.test.mjs
    QA_BASE_URL=http://127.0.0.1:4191 node scripts/qa-odm3d.mjs     # rendered proof
    QA_BASE_URL=http://127.0.0.1:4191 node scripts/qa-basemap-auto.mjs
