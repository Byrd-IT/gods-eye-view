/**
 * Text for the Drone Flight Plan panel: number formatting and the warning
 * sentences. Every sentence is a literal t() call so the i18n scanner sees it.
 */
import { formatNumber, t } from '../../i18n/index.js';
import { OBSTACLE_MARGIN_M } from './planner.js';
import { lengthFromM, lengthUnit, speedFromMs, speedUnit } from './units.js';

const fixed = (value, digits = 0) =>
  formatNumber(value, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

/** `262 ft` or `80 m`, in the unit the person chose. */
export function lengthText(metres, digits = 0) {
  return `${fixed(lengthFromM(metres), digits)} ${lengthUnit()}`;
}

/** Same as lengthText: a height, radius or width. */
export function heightText(metres) {
  return lengthText(metres);
}

/** `16.4 ft/s` or `5.0 m/s`. */
export function speedText(ms, digits = 1) {
  return `${fixed(speedFromMs(ms), digits)} ${speedUnit()}`;
}

/** `1.2 km` or `640 m`; in feet `2100 ft` or `1.2 mi`. */
export function distanceText(metres) {
  if (lengthUnit() === 'ft') {
    const feet = lengthFromM(metres);
    return feet >= 5280 ? `${fixed(feet / 5280, 2)} mi` : `${fixed(feet)} ft`;
  }
  return metres >= 1000
    ? `${fixed(metres / 1000, 2)} km`
    : `${fixed(metres)} m`;
}

/** `14 min` or `1 h 05 min` */
export function durationText(seconds) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${fixed(minutes)} min`;
  const h = Math.floor(minutes / 60);
  return `${fixed(h)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/** The sentence for one warning object `{ code, params }`. */
export function warningText(warning) {
  const p = warning.params ?? {};
  switch (warning.code) {
    case 'agl-capped':
      return t(
        'Height capped at {cap} above ground; you asked for {requested}',
        {
          cap: lengthText(p.cap),
          requested: lengthText(p.requested),
        },
      );
    case 'speed-camera-limited':
      return t(
        'Speed lowered from {requested} to {limited} so the camera can keep up with the photo spacing',
        { requested: speedText(p.requested), limited: speedText(p.limited) },
      );
    case 'speed-blur-limited':
      return t(
        'Speed lowered from {requested} to {limited} so photos stay sharp at a 1/{shutter} s shutter',
        {
          requested: speedText(p.requested),
          limited: speedText(p.limited),
          shutter: fixed(p.shutter),
        },
      );
    case 'speed-below-minimum':
      return t(
        'This camera cannot keep up even at {min} with these settings (limit {limit}): lower the overlap or fly higher',
        { min: speedText(p.minMs), limit: speedText(p.limitMs, 2) },
      );
    case 'vlos':
      return t(
        'The furthest waypoint is {distance} from takeoff: keep the aircraft in sight',
        { distance: lengthText(p.distanceM) },
      );
    case 'terrain-unknown':
      return t(
        'Terrain heights unavailable, so flat ground is assumed and heights are NOT terrain-aware',
      );
    case 'rel-height-over-limit':
      return t(
        'The ground varies by {range}: this plan reaches {max} above the takeoff point, over the {limit} height limit DJI Fly starts with. Lower the height, take off from higher ground, or raise the limit in DJI Fly',
        {
          range: lengthText(p.terrainRangeM),
          max: lengthText(p.maxRelM),
          limit: lengthText(p.limitM),
        },
      );
    case 'terrain-partial':
      return t(
        'Heights could not be read for {count} waypoints; their ground height is guessed from the nearest read point, so those heights may be wrong',
        { count: fixed(p.count) },
      );
    case 'below-takeoff':
      return t(
        'Part of the route is only {min} above the takeoff point. Take off from lower ground or raise the height',
        { min: lengthText(p.minRelM, 1) },
      );
    case 'steep-segment':
      return t(
        '{count} stretches cross steep ground; DJI Fly curves between waypoints, so height above ground can drift there',
        { count: fixed(p.count) },
      );
    case 'mission-over-budget':
      return t(
        'A mission is longer than the battery time even after splitting',
      );
    case 'too-many-missions':
      return t(
        'This needs more than {count} missions: shrink the box, lower the overlap or take off closer',
        { count: fixed(p.count) },
      );
    case 'takeoff-too-far':
      return t(
        'That takeoff point is {distance} from the box; keep it within {limit}. The box centre is used instead',
        { distance: lengthText(p.distanceM), limit: lengthText(p.limitM) },
      );
    case 'areas-spread':
      return t(
        'Some areas are more than {limit} from the takeoff point, so those flights are a longer transit',
        { limit: lengthText(p.limitM) },
      );
    case 'orbit-raised-for-obstacles':
      return t(
        'Orbit heights were raised to {min}: the trees are {obstacle} tall and the drone keeps a margin above them',
        { min: lengthText(p.minAglM), obstacle: lengthText(p.obstacleHeightM) },
      );
    case 'orbit-ring-widened':
      return t(
        '{count} orbit rings were made wider so the viewing angle holds above the obstacle or roof',
        { count: fixed(p.count) },
      );
    case 'orbit-surface-fallback':
      return t(
        '{count} orbit rings are outside the surface model (or only partly inside), so the tree / obstacle height setting of {min} is used for them',
        { count: fixed(p.count), min: lengthText(p.minAglM) },
      );
    case 'orbit-angle-changed':
      return t(
        '{count} orbit rings could not keep their viewing angle under the {cap} height limit',
        { count: fixed(p.count), cap: lengthText(p.capM) },
      );
    case 'orbit-blocked-all':
      return t('The blocked sector of {label} leaves no open arc to fly', {
        label: p.label,
      });
    case 'lookat-no-target':
      return t('The look-at path {label} has no orbit target to look at', {
        label: p.label,
      });
    case 'obstacle-raised':
      return t(
        '{count} waypoints were raised to clear an obstacle column (its height plus {margin})',
        { count: fixed(p.count), margin: lengthText(OBSTACLE_MARGIN_M) },
      );
    case 'obstacle-blocked':
      return t(
        '{count} waypoints cannot clear an obstacle: they would need {need} but the limit is {cap} above ground. Those legs are red on the globe. Lower the column, move the route or skip the area',
        {
          count: fixed(p.count),
          need: lengthText(p.needM),
          cap: lengthText(p.capM),
        },
      );
    case 'obstacle-list-cut':
      return t(
        '{count} more obstacles were found than the plan can use, so they are not planned. Draw a smaller area, or check those places by eye',
        { count: fixed(p.count) },
      );
    default:
      // An unknown code is never echoed back into the page.
      return '';
  }
}

/** The sentence for a plan error code from planFlight(). */
export function planErrorText(code) {
  if (code === 'too-large')
    return t('Too many waypoints: shrink the box or lower the overlap');
  if (code === 'empty' || code === 'too-narrow')
    return t('The box is too small to plan a flight');
  if (code === 'no-orbit-targets')
    return t('Turn on at least one orbit target');
  if (code === 'orbit-blocked-all')
    return t('The blocked sector leaves no open arc to fly');
  if (code === 'self-intersecting')
    return t('That polygon crosses itself. Remove a corner or draw it again.');
  return t('Draw a box on the globe first');
}
