/**
 * CelesTrak GP CSV (FORMAT=csv) parser, shared by the satellites layer
 * (src/layers/satellites/orbits.js) and the Sky view satellite worker
 * (src/byrdit/skyView/satWorker.js) so the two can never disagree about which
 * rows a catalog holds. Pure and Cesium-free so it also runs inside a worker.
 *
 * TLE is dead: objects catalogued after 2026-07-11 carry 6-digit NORAD
 * numbers that the fixed-width TLE format cannot hold. CSV carries the same
 * orbital elements as named OMM columns, fed straight into satellite.js
 * json2satrec() (its OMM/JSON entry point). Groups arrive as one record per
 * satellite with a header row.
 */
export const GP_CSV_HEADER = 'OBJECT_NAME,OBJECT_ID,EPOCH,';

/**
 * Parse GP CSV text into `{ name, gp }` records (`gp` = OMM field map).
 * @param {string} text CSV body as served by /api/celestrak/<group>.
 * @returns {Array<{ name: string, gp: Record<string, string> }>}
 */
export function parseGP(text) {
  // NOTE: split on the REGEX /\r?\n/, not the string '\r?\n'. CelesTrak
  // serves GP CSV with CRLF line endings; a string separator never
  // matches, leaving the whole response as one "line" so the header check
  // fails and every catalog silently parses as zero satellites.
  const lines = String(text || '')
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.length > 0);
  if (lines.length < 2 || !lines[0].startsWith(GP_CSV_HEADER)) return [];
  const cols = lines[0].split(',');
  const idx = Object.fromEntries(cols.map((c, i) => [c, i]));
  const result = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    const gp = {};
    for (const c of cols) gp[c] = cells[idx[c]];
    if (!gp.OBJECT_NAME || !gp.NORAD_CAT_ID) continue;
    result.push({ name: gp.OBJECT_NAME, gp });
  }
  return result;
}
