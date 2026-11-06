/**
 * Height numbers for the Drone Flight Plan tool, in one leaf module (no
 * imports) so the planner, the orbit rings and the tests share them.
 *
 * Three different things live here and must not be mixed up:
 *
 *  - PLANNING_MAX: the most height above ground GEV will plan. It is a limit
 *    of this planner only. It is not permission to fly there and it does not
 *    change anything in the aircraft: DJI firmware height limits, airspace
 *    authorizations and the pilot's own legal duties all still apply.
 *  - ADVISORY: 400 ft, the usual reference height above ground for small
 *    drones. A plan above it still plans; it gets a plain notice.
 *  - DJI_DEFAULT_HEIGHT_LIMIT_M (planner.js): the height above the takeoff
 *    point DJI Fly starts with. A separate fact about the aircraft app.
 *
 * Everything inside the planner and the KMZ is in METRES. A foot is exactly
 * 0.3048 m, so 1500 ft is exactly 457.2 m (written as a literal, because
 * 1500 * 0.3048 comes out as 457.20000000000005 in floating point).
 */
export const FT_TO_M = 0.3048;

/** The planning maximum, feet (what the person reads in feet mode). */
export const PLANNING_MAX_AGL_FT = 1500;
/** The planning maximum, metres: exactly 1500 ft. */
export const PLANNING_MAX_AGL_M = 457.2;

/** 400 ft in feet and metres (exactly 121.92 m): where the notice starts. */
export const ADVISORY_AGL_FT = 400;
export const ADVISORY_AGL_M = 121.92;
