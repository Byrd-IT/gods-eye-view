/**
 * Drone presets for the Drone Flight Plan tool. A TABLE, so another aircraft
 * (for example the Phantom 4 FC330, which has no DJI Fly waypoint-KMZ path and
 * would need its own exporter) is one more row, not new code.
 *
 * Camera geometry is the *effective still-image* geometry the planner uses:
 *   sensorWidthMm  - sensor width actually imaged ACROSS the flight direction
 *                    (camera held landscape), mm
 *   sensorHeightMm - sensor height ALONG the flight direction, mm
 *   focalMm        - real (not 35 mm-equivalent) focal length, mm
 *   imageWidthPx / imageHeightPx - still size in pixels
 *
 * DJI Mini 5 Pro sources (checked 2026-10-28):
 *  - DJI Mini 5 Pro specs page (dji.com/mini-5-pro/specs): "1-inch CMOS, 50MP
 *    effective pixels"; lens FOV 84 deg, 24 mm format equivalent, f/1.8.
 *  - Max still 8192 x 6144 (4:3), SkyeBrowse / Dr. Drone spec sheets.
 *  - A 1-inch-type sensor images 13.2 x 8.8 mm (3:2). The 4:3 still uses the
 *    full 8.8 mm height, so 8.8 x 4/3 = 11.733 mm across, a pixel pitch of
 *    8.8 / 6144 = 1.432 um. Real focal length = 24 mm / crop 2.727 = 8.8 mm,
 *    the same value the community FlyPath planner uses for this aircraft.
 *  - The result is exact and easy to check by hand: GSD = height / 6144 per
 *    pixel (120 m -> 1.953 cm/px), footprint across = 4/3 x height, along =
 *    1 x height. Using the narrower 11.733 mm rather than 13.2 mm makes the
 *    planned overlap slightly conservative if the true crop is wider.
 *  - DERIVED, not read from an EXIF dump: verify against a real photo.
 *  - minPhotoIntervalS 5 s is the community-verified shoot interval for the
 *    50 MP stills (flypath_engine drones.json); it caps flight speed.
 *  - droneEnumValue 68 / sub 0: community-verified from a DJI Fly mission on
 *    the RC 2 (flypath_engine); NOT confirmed on this aircraft yet.
 */
export const DRONE_PRESETS = Object.freeze({
  'dji-mini-5-pro': Object.freeze({
    id: 'dji-mini-5-pro',
    name: 'DJI Mini 5 Pro',
    app: 'DJI Fly',
    sensorWidthMm: (8.8 * 4) / 3,
    sensorHeightMm: 8.8,
    focalMm: 8.8,
    imageWidthPx: 8192,
    imageHeightPx: 6144,
    minPhotoIntervalS: 5,
    maxSpeedMs: 15,
    defaultSpeedMs: 5,
    wpml: Object.freeze({ droneEnumValue: 68, droneSubEnumValue: 0 }),
    verified: 'derived-community',
  }),
});

export const DEFAULT_PRESET_ID = 'dji-mini-5-pro';

/** Look a preset up by id; undefined when unknown. */
export function getPreset(id) {
  return DRONE_PRESETS[id];
}

/** The presets in display order. */
export function listPresets() {
  return Object.values(DRONE_PRESETS);
}
