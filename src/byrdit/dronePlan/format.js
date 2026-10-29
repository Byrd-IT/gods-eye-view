/**
 * Text for the Drone Flight Plan panel: number formatting and the warning
 * sentences. Every sentence is a literal t() call so the i18n scanner sees it.
 */
import { formatNumber, t } from '../../i18n/index.js';
import { FT_PER_M } from './planner.js';

const fixed = (value, digits = 0) =>
  formatNumber(value, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

/** `80 m · 262 ft` */
export function heightText(metres) {
  return `${fixed(metres)} m · ${fixed(metres * FT_PER_M)} ft`;
}

/** `1.2 km` or `640 m` */
export function distanceText(metres) {
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
        'Height capped at {cap} m ({ft} ft) above ground; you asked for {requested} m',
        {
          cap: fixed(p.cap),
          ft: fixed(p.cap * FT_PER_M),
          requested: fixed(p.requested),
        },
      );
    case 'speed-camera-limited':
      return t(
        'Speed lowered from {requested} to {limited} m/s so the camera can keep up with the photo spacing',
        { requested: fixed(p.requested, 1), limited: fixed(p.limited, 1) },
      );
    case 'speed-blur-limited':
      return t(
        'Speed lowered from {requested} to {limited} m/s so photos stay sharp at a 1/{shutter} s shutter',
        {
          requested: fixed(p.requested, 1),
          limited: fixed(p.limited, 1),
          shutter: fixed(p.shutter),
        },
      );
    case 'speed-below-minimum':
      return t(
        'This camera cannot keep up even at {min} m/s with these settings (limit {limit} m/s): lower the overlap or fly higher',
        { min: fixed(p.minMs, 1), limit: fixed(p.limitMs, 2) },
      );
    case 'vlos':
      return t(
        'The furthest waypoint is {distance} m from takeoff: keep the aircraft in sight',
        { distance: fixed(p.distanceM) },
      );
    case 'terrain-unknown':
      return t(
        'Terrain heights unavailable, so flat ground is assumed and heights are NOT terrain-aware',
      );
    case 'rel-height-over-limit':
      return t(
        'The ground varies by {range} m: this plan reaches {max} m above the takeoff point, over the {limit} m height limit DJI Fly starts with. Lower the height, take off from higher ground, or raise the limit in DJI Fly',
        {
          range: fixed(p.terrainRangeM),
          max: fixed(p.maxRelM),
          limit: fixed(p.limitM),
        },
      );
    case 'terrain-partial':
      return t(
        'Heights could not be read for {count} waypoints; their ground height is guessed from the nearest read point, so those heights may be wrong',
        { count: fixed(p.count) },
      );
    case 'below-takeoff':
      return t(
        'Part of the route is only {min} m above the takeoff point. Take off from lower ground or raise the height',
        { min: fixed(p.minRelM, 1) },
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
        'That takeoff point is {distance} m from the box; keep it within {limit} m. The box centre is used instead',
        { distance: fixed(p.distanceM), limit: fixed(p.limitM) },
      );
    case 'areas-spread':
      return t(
        'Some areas are more than {limit} m from the takeoff point, so those flights are a longer transit',
        { limit: fixed(p.limitM) },
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
  if (code === 'self-intersecting')
    return t(
      'That polygon crosses itself. Remove a corner or draw it again.',
    );
  return t('Draw a box on the globe first');
}
