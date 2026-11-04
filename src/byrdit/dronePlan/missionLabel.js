/**
 * Mission labels: every flight GEV exports carries a short code (M7, or M7-2
 * for the second flight of plan 7) so the missions on the controller can be
 * told apart, and the files, the preview picture and the cheat sheet all use
 * the same code.
 *
 * What DJI Fly actually shows (verified 2026-11-03 on the RC 2 dump in
 * "DJI Controler Files/Android/data/dji.go.v5/files/waypoint"):
 *   - the KMZ holds only wpmz/template.kml and wpmz/waylines.wpml, with no
 *     mission name anywhere, so a name or picture inside the KMZ is never read;
 *   - the name in the DJI Fly list belongs to the placeholder mission (it is
 *     set when the placeholder is created, and DJI Fly keeps it in its own
 *     database, not in the file);
 *   - the picture is a separate waypoint/map_preview/<UUID>/<UUID>.jpg that
 *     DJI Fly (or MavenBridge) writes, and DJI Fly caches it.
 * So the reliable label is the NAME of the placeholder: this module produces
 * the code to give each placeholder, and the file names, picture and cheat
 * sheet that match it.
 *
 * Pure: no DOM, no network.
 */
import { jobSlug } from './areas.js';

const pad2 = (n) => String(n).padStart(2, '0');
const isNo = (n) => Number.isInteger(n) && n > 0;

/** `M7` (the name to give a placeholder in DJI Fly). */
export const missionCode = (no) => `M${no}`;

/**
 * The code of one flight of a plan: `M7` when the plan is one flight,
 * `M7-2` for the second of several.
 */
export function flightCode(no, index = 0, total = 1) {
  return total > 1 ? `${missionCode(no)}-${index + 1}` : missionCode(no);
}

/** Same as flightCode but zero-padded so files sort: `M07`, `M07-2`. */
export function flightCodePadded(no, index = 0, total = 1) {
  return total > 1 ? `M${pad2(no)}-${index + 1}` : `M${pad2(no)}`;
}

const cleanName = (name) =>
  String(name ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();

/** `M07 ring A` (or `M07-2 ring A (2 of 3)`): the visible name of a flight. */
export function flightTitle(label, index = 0, total = 1) {
  const name = cleanName(label.name);
  const code = flightCodePadded(label.no, index, total);
  const part = total > 1 ? ` (${index + 1} of ${total})` : '';
  return `${code}${name ? ` ${name}` : ''}${part}`;
}

/**
 * The KMZ file name: `M07_ring-A.kmz`, `M07-2_ring-A.kmz` for flight 2 of
 * several. Plain ASCII, no spaces, safe on Windows and the controller.
 */
export function flightFileName(label, index = 0, total = 1, ext = 'kmz') {
  const base = flightCodePadded(label.no, index, total);
  const slug = cleanName(label.name)
    ? jobSlug(label.name)
        .replace(/\.+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-|-$/g, '')
    : '';
  return `${base}${slug ? `_${slug}` : ''}.${ext}`;
}

/** `M07_ring-A`: the start of every file of a plan (zip names, pictures). */
export const labelStem = (label) =>
  flightFileName(label, 0, 1, 'x').replace(/\.x$/, '');

const CONTROLLER_ID =
  /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

/**
 * A controller mission id as it may be used in a file name: only a real UUID
 * (the plan body is stored as opaque JSON, so an id can hold anything).
 * @returns {string|null}
 */
export const controllerFileId = (id) =>
  typeof id === 'string' && CONTROLLER_ID.test(id) ? id : null;

/** Does this label carry a usable plan number? */
export const hasLabel = (label) => Boolean(label && isNo(label.no));
