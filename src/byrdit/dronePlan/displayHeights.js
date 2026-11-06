/**
 * Where the Drone Flight Plan overlays are DRAWN on the globe, in one pure
 * module (no Cesium, no DOM) so the rules are unit-testable.
 *
 * Heights, and what each one is measured from. Never mix them:
 *
 *   groundM       terrain height under the point, ELLIPSOIDAL (WGS84), the
 *                 datum the globe draws in. Read from the terrain model
 *                 only (terrain.js), never from the Google 3D tiles.
 *   aglM          height above the ground UNDER that point (generated plans)
 *   relHeightM    height above the TAKEOFF point: what DJI flies and the KMZ
 *                 stores. NOT local AGL: on sloping ground the two differ.
 *   takeoffM      terrain height at the takeoff point, ellipsoidal.
 *
 * What is drawn where (the intent of each overlay):
 *
 *   waypoint marker, camera pyramid apex, airborne corridor, curtain top
 *                 AIRBORNE, at the aircraft position: groundM + aglM
 *                 (= takeoffM + relHeightM). Never clamped to the ground.
 *   ground track line, photo footprint, takeoff marker, pyramid base
 *                 ON THE SURFACE.
 *   obstacle column
 *                 ANCHORED to the ground at the obstruction, rising by its
 *                 own height. It is not the flight corridor.
 *
 * When the terrain could not be read (`ground.known === false`) the planner
 * plans on flat ground at height 0, so every `groundM` is 0 and `aglM` is the
 * height above the takeoff point. The globe still draws its real surface, so
 * the aircraft is drawn at `takeoff surface + that height`. The surface is
 * the globe's own terrain height at the takeoff (displayGroundM), and when
 * even that is not available nothing is invented: the offset is 0 and the
 * result is reported as unverified.
 *
 * Nothing here changes a flight height, a waypoint or a KMZ value: it only
 * decides where a drawing sits.
 */

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** The aircraft's height above the ellipsoid as the globe draws it, m. */
export function flightHeightM(w, offsetM = 0) {
  return (w.groundM ?? 0) + (w.aglM ?? 0) + (finite(offsetM) ? offsetM : 0);
}

/**
 * The vertical shift that puts a plan on the globe's real surface.
 *
 * @param {{ known?: boolean }|null|undefined} ground the plan's terrain read
 * @param {number|null|undefined} displayGroundM the globe's terrain height at
 *   the takeoff point, when it has one
 * @returns {{ offsetM: number, verified: boolean }} `verified` is false when
 *   the terrain was not read and the globe could not say either: the drawing
 *   then assumes flat ground at height 0. The plan's own `terrain-unknown`
 *   warning is what tells the user; `preview.displayVerified()` reports it.
 */
export function displayOffset(ground, displayGroundM) {
  if (ground?.known === true) return { offsetM: 0, verified: true };
  if (finite(displayGroundM))
    return { offsetM: displayGroundM, verified: true };
  return { offsetM: 0, verified: false };
}

/**
 * One waypoint placed for drawing. The aircraft keeps the position the plan
 * gives it (`groundM + aglM`, moved by `offsetM` when the terrain was not
 * read); the ground under it becomes the globe's own surface there when the
 * globe can say, so the camera pyramid base and the curtain meet the surface
 * the map draws. `aglM` is then the true height above THAT surface (signed:
 * negative means the aircraft would be under it).
 */
const placeWaypoint = (w, offsetM, groundAt) => {
  const aircraftM = (w.groundM ?? 0) + (w.aglM ?? 0) + offsetM;
  const surfaceM = groundAt ? groundAt(w.lon, w.lat) : null;
  if (!finite(surfaceM)) {
    // No surface to put it on: the whole drawing moves together.
    return { ...w, groundM: (w.groundM ?? 0) + offsetM };
  }
  return { ...w, groundM: surfaceM, aglM: aircraftM - surfaceM };
};

/**
 * A mission placed on the globe, for drawing only. `aglM` and `relHeightM` of
 * the input, and everything exported, are untouched; the input is never
 * modified. With `offsetM` 0 and no `groundAt` (the terrain was read) the
 * mission is returned as it is.
 *
 * @param {object} mission
 * @param {number} offsetM from displayOffset()
 * @param {((lon:number, lat:number) => number|null)|null} [groundAt] the
 *   globe's terrain height at a point, used only when the terrain was not read
 */
export function shiftMission(mission, offsetM, groundAt = null) {
  const off = finite(offsetM) ? offsetM : 0;
  if (!off && !groundAt) return mission;
  const place = (w) => placeWaypoint(w, off, groundAt);
  const out = { ...mission, waypoints: (mission.waypoints ?? []).map(place) };
  if (mission.legs) {
    out.legs = mission.legs.map((leg) => ({
      ...leg,
      waypoints: (leg.waypoints ?? []).map(place),
    }));
  }
  return out;
}
