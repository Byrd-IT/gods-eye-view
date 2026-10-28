/**
 * Drone presets for the Drone Flight Plan tool. A TABLE: another aircraft is
 * one more row, not new code. Data comes from the documentation card
 * t_b9148c02 (drone_specs.json, every value with a source URL).
 *
 * Camera geometry is the *effective still-image* geometry the planner uses:
 *   sensorWidthMm  - sensor width imaged ACROSS the flight direction
 *                    (camera held landscape), mm
 *   sensorHeightMm - sensor height ALONG the flight direction, mm
 *   focalMm        - focal length, mm
 *   imageWidthPx / imageHeightPx - still size in pixels
 * Only the ratios sensor/focal and sensor/pixels reach the maths, so a frame
 * derived from DJI's published diagonal field of view (frameFromDiagFov) gives
 * exactly the footprint and GSD of the real sensor.
 *
 * Fields beyond the geometry:
 *   shutterType      - 'electronic' | 'mechanical'. Every model here shoots
 *                      stills with an ELECTRONIC shutter (rolling readout), so
 *                      the blur limit is the strict one (see speed.js).
 *   minPhotoIntervalS - shortest Timed interval at full resolution, seconds.
 *   maxSpeedMs       - fastest waypoint speed this tool will plan for.
 *   wpml             - DJI Fly mission aircraft code, or null when there is
 *                      none known.
 *   kmz              - { supported, reason }: whether DJI Fly can load a
 *                      waypoint KMZ for this aircraft at all.
 *   verified         - 'verified' | 'derived' | 'unverified' (the legend of
 *                      drone_specs.json): 'verified' = every number is in a
 *                      DJI document; 'derived' = DJI's numbers, geometry
 *                      computed by us from DJI's FOV (check with EXIF);
 *                      'unverified' = third-party or conflicting sources.
 *   sources          - URLs the numbers came from.
 *   flags            - machine-readable caveats the panel shows.
 */

const DIAG_35MM_MM = Math.hypot(36, 24);

/**
 * A frame whose diagonal is the 35 mm one, with DJI's diagonal FOV and the
 * pixel aspect of the still. For a sensor that is natively 4:3 the published
 * FOV is the 4:3 frame's, so footprint = height x width/focal is exact.
 */
export function frameFromDiagFov(fovDeg, imageWidthPx, imageHeightPx) {
  const diag = DIAG_35MM_MM;
  const norm = Math.hypot(imageWidthPx, imageHeightPx);
  return {
    sensorWidthMm: (diag * imageWidthPx) / norm,
    sensorHeightMm: (diag * imageHeightPx) / norm,
    focalMm: diag / 2 / Math.tan((fovDeg * Math.PI) / 360),
    imageWidthPx,
    imageHeightPx,
  };
}

/** DJI Fly waypoint speeds above this are not planned, whatever the aircraft. */
const WAYPOINT_SPEED_CAP_MS = 15;

const SRC = {
  mini5:
    'https://dl.djicdn.com/downloads/DJI_Mini_5_Pro/UM/DJI_Mini_5_Pro_User_Manual_en.pdf',
  mini5Grid: 'https://flythegrid.com/mini-5-pro.php',
  mini4: 'https://www.dji.com/mini-4-pro/specs',
  air3: 'https://www.dji.com/air-3/specs',
  air3s: 'https://www.dji.com/air-3s/specs',
  mavic3: 'https://www.dji.com/mavic-3/specs',
  mavic3c: 'https://www.dji.com/mavic-3-classic/specs',
  mavic3p: 'https://www.dji.com/mavic-3-pro/specs',
  phantom4: 'https://www.dji.com/phantom-4/specs',
  phantom4Manual:
    'https://dl.djicdn.com/downloads/phantom_4/20170706/Phantom_4_User_Manual_v1.6.pdf',
  wpmlCommunity: 'https://github.com/dronnix-io/FlyPath/blob/main/README.md',
};

const freezeDeep = (o) => {
  for (const v of Object.values(o)) {
    if (v && typeof v === 'object') freezeDeep(v);
  }
  return Object.freeze(o);
};

const KMZ_OK = { supported: true, reason: null };
const KMZ_NEEDS_CODE = { supported: true, reason: 'no-code' };

/**
 * DJI Mini 5 Pro: the geometry here is the rigorous one. A 1-inch type sensor
 * images 13.2 x 8.8 mm (3:2); the 4:3 still uses the full 8.8 mm height, so
 * 8.8 x 4/3 = 11.733 mm across, pixel pitch 8.8 / 6144 = 1.432 um, and the
 * real focal length is 24 mm / crop 2.727 = 8.8 mm. GSD = height / 6144 per
 * pixel. DJI's 84 deg diagonal FOV belongs to the 3:2 frame, so applying it to
 * the 4:3 still would overstate the footprint by about 8 %.
 * Max speed is a CONFLICT in the sources (15 vs 19 m/s): 15 is used.
 * DERIVED, not read from an EXIF dump: verify against a real photo.
 */
const MINI_5_PRO = {
  id: 'dji-mini-5-pro',
  name: 'DJI Mini 5 Pro',
  app: 'DJI Fly',
  sensorWidthMm: (8.8 * 4) / 3,
  sensorHeightMm: 8.8,
  focalMm: 8.8,
  imageWidthPx: 8192,
  imageHeightPx: 6144,
  geometryBasis: 'sensor',
  sensorText: '1-inch type, 50 MP',
  fovDeg: 84,
  shutterType: 'electronic',
  minPhotoIntervalS: 5,
  maxSpeedMs: WAYPOINT_SPEED_CAP_MS,
  defaultSpeedMs: 5,
  wpml: { droneEnumValue: 68, droneSubEnumValue: 0 },
  kmz: KMZ_OK,
  verified: 'unverified',
  sources: [SRC.mini5, SRC.mini5Grid, SRC.wpmlCommunity],
  flags: ['dji-page-geoblocked', 'max-speed-conflict', 'wpml-community'],
};

const MINI_4_PRO = {
  id: 'dji-mini-4-pro',
  name: 'DJI Mini 4 Pro',
  app: 'DJI Fly',
  ...frameFromDiagFov(82.1, 8064, 6048),
  geometryBasis: 'diag-fov-4x3',
  sensorText: '1/1.3-inch, 48 MP',
  fovDeg: 82.1,
  shutterType: 'electronic',
  // 48 MP stills: 5 s (12 MP mode: 2 s) per the DJI spec page.
  minPhotoIntervalS: 5,
  // Spec page: 12 m/s in Normal mode, 16 m/s in Sport.
  maxSpeedMs: 12,
  defaultSpeedMs: 5,
  wpml: { droneEnumValue: 68, droneSubEnumValue: 0 },
  kmz: KMZ_OK,
  verified: 'derived',
  sources: [SRC.mini4, SRC.wpmlCommunity],
  flags: ['wpml-community'],
};

const AIR_3 = {
  id: 'dji-air-3',
  name: 'DJI Air 3',
  app: 'DJI Fly',
  ...frameFromDiagFov(82, 8064, 6048),
  geometryBasis: 'diag-fov-4x3',
  sensorText: '1/1.3-inch, 48 MP (wide camera)',
  fovDeg: 82,
  shutterType: 'electronic',
  minPhotoIntervalS: 5,
  maxSpeedMs: WAYPOINT_SPEED_CAP_MS,
  defaultSpeedMs: 5,
  wpml: null,
  kmz: KMZ_NEEDS_CODE,
  verified: 'derived',
  sources: [SRC.air3],
  flags: ['wpml-unknown'],
};

// The Air 3S wide camera is the same 1-inch 50 MP unit as the Mini 5 Pro's
// (DJI Air 3S specs: 8192 x 6144, 84 deg, 24 mm equivalent).
const AIR_3S = {
  id: 'dji-air-3s',
  name: 'DJI Air 3S',
  app: 'DJI Fly',
  sensorWidthMm: (8.8 * 4) / 3,
  sensorHeightMm: 8.8,
  focalMm: 8.8,
  imageWidthPx: 8192,
  imageHeightPx: 6144,
  geometryBasis: 'sensor',
  sensorText: '1-inch type, 50 MP (wide camera)',
  fovDeg: 84,
  shutterType: 'electronic',
  minPhotoIntervalS: 5,
  maxSpeedMs: WAYPOINT_SPEED_CAP_MS,
  defaultSpeedMs: 5,
  wpml: null,
  kmz: KMZ_NEEDS_CODE,
  verified: 'derived',
  sources: [SRC.air3s],
  flags: ['wpml-unknown'],
};

// Mavic 3, Mavic 3 Classic and Mavic 3 Pro share the 4/3-inch Hasselblad main
// camera: 20 MP, 84 deg, 5280 x 3956, 2 s interval. The consumer spec pages
// list an electronic shutter only (only the Enterprise 3E has a mechanical one).
const MAVIC_3 = {
  id: 'dji-mavic-3',
  name: 'DJI Mavic 3 / Classic / Pro',
  app: 'DJI Fly',
  ...frameFromDiagFov(84, 5280, 3956),
  geometryBasis: 'diag-fov-4x3',
  sensorText: '4/3-inch, 20 MP (main camera)',
  fovDeg: 84,
  shutterType: 'electronic',
  minPhotoIntervalS: 2,
  maxSpeedMs: WAYPOINT_SPEED_CAP_MS,
  defaultSpeedMs: 5,
  wpml: null,
  kmz: KMZ_NEEDS_CODE,
  verified: 'derived',
  sources: [SRC.mavic3, SRC.mavic3c, SRC.mavic3p],
  flags: ['wpml-unknown', 'shutter-unconfirmed'],
};

// Original Phantom 4 (FC330, 1/2.3-inch 12 MP), NOT the Pro, Advanced or RTK
// models (1-inch, mechanical shutter). DJI GO 4's Waypoints mode records a
// flown path and replays it (Phantom 4 User Manual v1.6, p.68): there is no
// waypoint file (KMZ/WPML) to import, so this tool plans and previews only.
const PHANTOM_4 = {
  id: 'dji-phantom-4',
  name: 'DJI Phantom 4 (original)',
  app: 'DJI GO 4',
  ...frameFromDiagFov(94, 4000, 3000),
  geometryBasis: 'diag-fov-4x3',
  sensorText: '1/2.3-inch, 12 MP',
  fovDeg: 94,
  shutterType: 'electronic',
  // Not stated in the DJI documents; 2 s is an ASSUMPTION.
  minPhotoIntervalS: 2,
  maxSpeedMs: WAYPOINT_SPEED_CAP_MS,
  defaultSpeedMs: 5,
  wpml: null,
  kmz: { supported: false, reason: 'no-fly-waypoints' },
  verified: 'unverified',
  sources: [SRC.phantom4, SRC.phantom4Manual],
  flags: ['interval-assumed', 'rolling-shutter'],
};

export const DRONE_PRESETS = Object.freeze(
  Object.fromEntries(
    [MINI_5_PRO, MINI_4_PRO, AIR_3, AIR_3S, MAVIC_3, PHANTOM_4].map((p) => [
      p.id,
      freezeDeep({ ...p }),
    ]),
  ),
);

export const DEFAULT_PRESET_ID = 'dji-mini-5-pro';

/** Look a preset up by id; undefined when unknown. */
export function getPreset(id) {
  return Object.hasOwn(DRONE_PRESETS, id) ? DRONE_PRESETS[id] : undefined;
}

/** The presets in display order. */
export function listPresets() {
  return Object.values(DRONE_PRESETS);
}

/**
 * Can a DJI Fly waypoint KMZ be written for this aircraft, given an optional
 * aircraft code the person typed in?
 * @returns {{ok:true} | {ok:false, reason:'no-fly-waypoints'|'no-code'}}
 */
export function kmzStatus(preset, overrideEnum = null) {
  if (!preset?.kmz?.supported) return { ok: false, reason: 'no-fly-waypoints' };
  const code = overrideEnum ?? preset.wpml?.droneEnumValue ?? null;
  if (!Number.isInteger(code)) return { ok: false, reason: 'no-code' };
  return { ok: true };
}
