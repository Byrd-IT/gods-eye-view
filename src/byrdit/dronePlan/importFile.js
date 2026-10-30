/**
 * Open a file the person picked in the Drone Flight Plan panel: a DJI Fly or
 * GEV `.kmz`, or a `.gevplan`. Pure (bytes in, data out) so it can be tested
 * without a browser. DISPLAY > Import (src/data/geoFileImport.js) is separate
 * and untouched.
 */
import { checkMission, missionIdFromFileName, parseDjiKmz } from './djiKmz.js';
import {
  MAX_GEVPLAN_BYTES,
  importFromMission,
  parseGevPlanFile,
} from './planDoc.js';

export const MAX_IMPORT_FILE_BYTES = 25 * 1024 * 1024;

/**
 * @param {Uint8Array} bytes
 * @param {string} fileName
 * @param {{ preset?: object, droneEnumValue?: number|null }} [ctx] selected aircraft
 * @returns {Promise<
 *   | { kind: 'error', code: string }
 *   | { kind: 'gevplan', details: object, plan: object }
 *   | { kind: 'mission', item: object, warnings: object[], mission: object }>}
 */
export async function openDroneFile(bytes, fileName, ctx = {}) {
  if (!(bytes instanceof Uint8Array) || !bytes.length) {
    return { kind: 'error', code: 'empty' };
  }
  const lower = String(fileName ?? '').toLowerCase();
  if (lower.endsWith('.gevplan') || lower.endsWith('.json')) {
    if (bytes.length > MAX_GEVPLAN_BYTES)
      return { kind: 'error', code: 'too-large' };
    try {
      const { details, plan } = parseGevPlanFile(
        new TextDecoder().decode(bytes),
      );
      return { kind: 'gevplan', details, plan };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'not-a-plan';
      return {
        kind: 'error',
        code: ['newer-version', 'too-large'].includes(code)
          ? code
          : 'not-a-plan',
      };
    }
  }
  if (bytes.length > MAX_IMPORT_FILE_BYTES)
    return { kind: 'error', code: 'too-large' };
  const mission = await parseDjiKmz(bytes, { fileName });
  const warnings = checkMission(mission, ctx);
  if (mission.error) return { kind: 'error', code: mission.error, warnings };
  if (!mission.waypoints.length)
    return { kind: 'error', code: 'no-waypoints', warnings };
  const gev = /GEV/i.test(mission.meta?.author ?? '');
  const base = String(fileName)
    .split(/[\\/]/)
    .pop()
    .replace(/\.kmz$/i, '');
  const item = importFromMission(mission, {
    id: `import-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: (missionIdFromFileName(fileName) ?? base).slice(0, 120),
    source: gev ? 'gev' : 'dji',
  });
  if (!item) return { kind: 'error', code: 'no-waypoints', warnings };
  return { kind: 'mission', item, warnings, mission };
}

/** What the preview draws for a stored import or a stored plan. */
export function drawableFor(id, color, plan) {
  const lines = (plan.imports ?? []).map((i) => i.waypoints);
  const rings = (plan.areas ?? []).map((a) => {
    if (a.kind === 'polygon') return a.ring;
    const b = a.box;
    return [
      { lon: b.west, lat: b.south },
      { lon: b.east, lat: b.south },
      { lon: b.east, lat: b.north },
      { lon: b.west, lat: b.north },
    ];
  });
  const poi = (plan.imports ?? []).flatMap((i) =>
    i.waypoints.filter((w) => w.poi).map((w) => w.poi),
  );
  return { id, color, lines, rings, poi };
}
