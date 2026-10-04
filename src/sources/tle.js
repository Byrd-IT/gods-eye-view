/**
 * Parse three-line TLE catalog text into `{ name, line1, line2 }` entries.
 * Blocks whose second and third lines are not TLE lines 1 and 2 are skipped.
 */
export function parseTleText(text) {
  const lines = String(text)
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const result = [];
  for (let i = 0; i < lines.length - 2; i += 3) {
    const name = lines[i];
    const line1 = lines[i + 1];
    const line2 = lines[i + 2];
    if (line1.startsWith('1 ') && line2.startsWith('2 ')) {
      result.push({ name, line1, line2 });
    }
  }
  return result;
}

/** The NORAD catalog number from TLE line 1, or null. */
export function tleCatalogNumber(line1) {
  const number = Number.parseInt(String(line1).slice(2, 7), 10);
  return Number.isInteger(number) ? number : null;
}

// Byrd-IT fork: CelesTrak FORMAT=tle cannot represent the 6-digit NORAD
// numbers assigned since 2026-07-11, so this fork's CelesTrak proxy serves GP
// CSV (OMM columns, CRLF). Readers detect the format and feed CSV records to
// satellite.js json2satrec() instead of twoline2satrec().
const GP_CSV_HEADER = 'OBJECT_NAME,OBJECT_ID,EPOCH,';

/** True when catalog text is CelesTrak GP CSV rather than three-line TLE. */
export function isGpCsvText(text) {
  return String(text || '')
    .trimStart()
    .startsWith(GP_CSV_HEADER);
}

/**
 * Parse CelesTrak GP CSV into `{ name, norad, gp }` entries, where `gp` is the
 * OMM record json2satrec() accepts. Rows without a name or catalog number are
 * skipped. Splits on the regex /\r?\n/ because CelesTrak serves CRLF.
 */
export function parseGpCsvText(text) {
  const lines = String(text || '')
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  if (lines.length < 2 || !lines[0].startsWith(GP_CSV_HEADER)) return [];
  const cols = lines[0].split(',');
  const result = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    const gp = {};
    cols.forEach((col, index) => {
      gp[col] = cells[index];
    });
    const norad = Number.parseInt(gp.NORAD_CAT_ID, 10);
    if (!gp.OBJECT_NAME || !Number.isInteger(norad)) continue;
    result.push({ name: gp.OBJECT_NAME, norad, gp });
  }
  return result;
}
