/**
 * "Plan all recommended passes": the set of capture passes a Gaussian splat
 * (or any 3D model) wants over the same area, planned at once with the
 * recommended settings for the chosen aircraft. Pure (no DOM): the panel runs
 * each pass through planAreas()/assembleAreaPlan() and this module names the
 * passes, picks their options and writes the one ZIP.
 *
 * Passes (guidance from the splat/photogrammetry sources behind recommend.js):
 *   1. nadir     - grid straight down: the base map and the ground
 *   2. oblique60 - double grid, camera 60 deg down, at the recommended height
 *   3. oblique45 - double grid, camera 45 deg down, lower: facades, edges
 *   4. orbit     - rings round the centre at two heights, camera on the centre
 */
import { getPreset } from './presets.js';
import { recommend, recommendedOptions } from './recommend.js';
import { makeZip } from './zip.js';
import { bundleEntries } from './wpml.js';
import { jobSlug } from './areas.js';

export const SUITE_PASSES = Object.freeze([
  Object.freeze({ id: 'nadir', label: 'Nadir grid (straight down)', mode: 'mapping-grid', pattern: 'grid' }),
  Object.freeze({ id: 'oblique60', label: 'Oblique double grid, 60 deg', mode: 'mapping-grid', pattern: 'double', tiltPitchDeg: -60 }),
  Object.freeze({ id: 'oblique45', label: 'Low oblique double grid, 45 deg', mode: 'mapping-grid', pattern: 'double', tiltPitchDeg: -45, aglM: 50 }),
  Object.freeze({ id: 'orbit', label: 'Orbits (two heights)', mode: 'splat-orbit', pattern: 'orbit' }),
]);

/** Planner options a pass keeps from the panel (everything but the recipe). */
const KEEP = ['presetId', 'direction', 'batteryMin', 'maxWaypoints', 'orbitRadiusM', 'takeoff', 'jobGrouping'];

/**
 * The planner options for every pass.
 * @param {object} base The panel's current options (aircraft, battery, takeoff...).
 * @returns {{id:string,label:string,options:object}[]}
 */
export function suiteOptions(base = {}) {
  const preset = getPreset(base.presetId);
  if (!preset) return [];
  return SUITE_PASSES.map((pass) => {
    const rec = recommend(preset, pass.mode, { orbitRadiusM: base.orbitRadiusM ?? undefined });
    const options = { ...recommendedOptions(rec) };
    for (const key of KEEP) if (base[key] !== undefined) options[key] = base[key];
    options.pattern = pass.pattern;
    if (pass.tiltPitchDeg !== undefined) options.tiltPitchDeg = pass.tiltPitchDeg;
    if (pass.aglM !== undefined) options.aglM = pass.aglM;
    return { id: pass.id, label: pass.label, options };
  });
}

export const passFolder = (index, pass) => `pass-${index + 1}-${jobSlug(pass.id)}`;

/** README for the all-passes ZIP. */
export function suiteReadme(passes, when = new Date()) {
  const lines = [
    'GEV Drone Flight Plan: all recommended passes',
    `Made: ${when.toISOString()}`,
    '',
    'NOT FLIGHT-TESTED. Check airspace and local rules, keep the aircraft in sight,',
    'and fly the first mission short and supervised.',
    '',
    'Fly every pass over the same area and process ALL the photos together',
    '(one splat / one ODM run). Each folder is one pass; each KMZ in it is one battery.',
    'Camera settings are in each folder README.',
    '',
  ];
  passes.forEach((pass, i) => {
    const r = pass.result;
    if (!r) {
      lines.push(`${passFolder(i, pass)}: ${pass.label} - NOT PLANNED (${pass.error ?? 'no result'})`);
      return;
    }
    const t = r.totals;
    lines.push(
      `${passFolder(i, pass)}: ${pass.label} - ${t.missionCount} missions, ${t.photoCount} photos, ${Math.round(t.durationS / 60)} min flying`,
    );
  });
  return `${lines.join('\n')}\n`;
}

/** One ZIP: a folder per pass (its missions and README) plus a top README. */
export function buildSuiteZip(passes, opts = {}) {
  const when = opts.when ? new Date(opts.when) : new Date();
  const entries = [];
  passes.forEach((pass, i) => {
    if (!pass.result) return;
    const folder = passFolder(i, pass);
    for (const e of bundleEntries(pass.result, { ...opts, when })) {
      entries.push({ name: `${folder}/${e.name}`, data: e.data });
    }
  });
  entries.push({ name: 'README.txt', data: suiteReadme(passes, when) });
  return makeZip(entries, when);
}
