// The 63 overlay layers the live S4 /basemap/config.json offered on 2026-11-03
// ([id, name]); the Map layers grouping and search are tested against them.
export const LIVE_OVERLAY_LAYERS = [
  [
    "ustopo",
    "US Topo 7.5-minute (2022)"
  ],
  [
    "hillshade",
    "Hillshade 1 m lidar"
  ],
  [
    "relief",
    "Colour relief 1 m lidar"
  ],
  [
    "terrain-rgb",
    "Terrain-RGB (Terrarium) 1 m lidar"
  ],
  [
    "contours",
    "Contours 5 ft / 25 ft major"
  ],
  [
    "lake-depth",
    "TWDB lake depth contours"
  ],
  [
    "ustopo-wu",
    "US Topo 7.5-minute 2022 (all Wood + Upshur)"
  ],
  [
    "hillshade-wu",
    "Hillshade 1 m lidar (all Wood + Upshur)"
  ],
  [
    "relief-wu",
    "Colour relief, per-area stretch (all Wood + Upshur)"
  ],
  [
    "terrain-rgb-wu",
    "Terrain-RGB (Terrarium) (all Wood + Upshur)"
  ],
  [
    "contours-wu",
    "Contours 5 ft / 25 ft major (all Wood + Upshur)"
  ],
  [
    "address-points",
    "Address points (TxGIO 2026)"
  ],
  [
    "boundaries",
    "County and city boundaries"
  ],
  [
    "flood",
    "FEMA flood hazard zones (NFHL)"
  ],
  [
    "geology",
    "Geology (Geologic Database of Texas, 1 250K)"
  ],
  [
    "high-water-marks",
    "Flood high-water marks (TxGIO)"
  ],
  [
    "hydro",
    "Rivers, streams and waterbodies (NHD 2025)"
  ],
  [
    "low-water-crossings",
    "Low-water crossings (TxGIO)"
  ],
  [
    "nlcd",
    "NLCD 2019 land cover"
  ],
  [
    "parcels",
    "Land parcels (TxGIO StratMap 2026)"
  ],
  [
    "watersheds",
    "Watersheds HUC8/10/12 (USGS WBD 2024)"
  ],
  [
    "wetlands",
    "Wetlands (USFWS NWI)"
  ],
  [
    "r1a-ustopo",
    "US Topo 7.5-minute (R1A)"
  ],
  [
    "r1a-hillshade",
    "Hillshade 1 m lidar (R1A)"
  ],
  [
    "r1a-relief",
    "Colour relief 1 m lidar (R1A)"
  ],
  [
    "r1a-terrain-rgb",
    "Terrain-RGB (Terrarium) 1 m lidar (R1A)"
  ],
  [
    "r1a-contours",
    "Contours 5 ft (R1A)"
  ],
  [
    "r1a-lake-depth",
    "TWDB lake depth contours (R1A)"
  ],
  [
    "r1b-ustopo",
    "US Topo 7.5-minute (R1B)"
  ],
  [
    "r1b-hillshade",
    "Hillshade 1 m lidar (R1B)"
  ],
  [
    "r1b-relief",
    "Colour relief 1 m lidar (R1B)"
  ],
  [
    "r1b-terrain-rgb",
    "Terrain-RGB (Terrarium) 1 m lidar (R1B)"
  ],
  [
    "r1b-contours",
    "Contours 5 ft (R1B)"
  ],
  [
    "r1b-lake-depth",
    "TWDB lake depth contours (R1B)"
  ],
  [
    "r2a-ustopo",
    "US Topo 7.5-minute (R2A)"
  ],
  [
    "r2a-hillshade",
    "Hillshade 1 m lidar (R2A)"
  ],
  [
    "r2a-relief",
    "Colour relief 1 m lidar (R2A)"
  ],
  [
    "r2a-terrain-rgb",
    "Terrain-RGB (Terrarium) 1 m lidar (R2A)"
  ],
  [
    "r2a-contours",
    "Contours 5 ft (R2A)"
  ],
  [
    "r2a-lake-depth",
    "TWDB lake depth contours (R2A)"
  ],
  [
    "r2b-ustopo",
    "US Topo 7.5-minute (R2B)"
  ],
  [
    "r2b-hillshade",
    "Hillshade 1 m lidar (R2B)"
  ],
  [
    "r2b-relief",
    "Colour relief 1 m lidar (R2B)"
  ],
  [
    "r2b-terrain-rgb",
    "Terrain-RGB (Terrarium) 1 m lidar (R2B)"
  ],
  [
    "r2b-contours",
    "Contours 5 ft (R2B)"
  ],
  [
    "r2b-lake-depth",
    "TWDB lake depth contours (R2B)"
  ],
  [
    "rm-ustopo",
    "US Topo 7.5-minute (RM)"
  ],
  [
    "rm-hillshade",
    "Hillshade 1 m lidar (RM)"
  ],
  [
    "rm-relief",
    "Colour relief 1 m lidar (RM)"
  ],
  [
    "rm-terrain-rgb",
    "Terrain-RGB (Terrarium) 1 m lidar (RM)"
  ],
  [
    "rm-contours",
    "Contours 5 ft (RM)"
  ],
  [
    "rm-lake-depth",
    "TWDB lake depth contours (RM)"
  ],
  [
    "ri-ustopo",
    "US Topo 7.5-minute (RI)"
  ],
  [
    "ri-hillshade",
    "Hillshade 1 m lidar (RI)"
  ],
  [
    "ri-relief",
    "Colour relief 1 m lidar (RI)"
  ],
  [
    "ri-terrain-rgb",
    "Terrain-RGB (Terrarium) 1 m lidar (RI)"
  ],
  [
    "ri-contours",
    "Contours 5 ft (RI)"
  ],
  [
    "gc-ustopo",
    "US Topo 7.5-minute (GC)"
  ],
  [
    "gc-hillshade",
    "Hillshade 1 m lidar (GC)"
  ],
  [
    "gc-relief",
    "Colour relief 1 m lidar (GC)"
  ],
  [
    "gc-terrain-rgb",
    "Terrain-RGB (Terrarium) 1 m lidar (GC)"
  ],
  [
    "gc-contours",
    "Contours 5 ft (GC)"
  ],
  [
    "gc-bay-depth",
    "Bay depth contours (GC)"
  ]
];
