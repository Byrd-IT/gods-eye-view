/**
 * Parse three-line TLE catalog text into `{ name, line1, line2 }` entries.
 * Malformed sets are skipped without dropping the valid sets that follow.
 */
export function parseTleText(text) {
  const lines = String(text)
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const result = [];
  for (let i = 0; i < lines.length - 2; i++) {
    const name = lines[i];
    const line1 = lines[i + 1];
    const line2 = lines[i + 2];
    const cat1 = tleCatalogNumber(line1);
    const cat2 = tleCatalogNumber(line2);
    if (
      line1.startsWith('1 ') &&
      line2.startsWith('2 ') &&
      cat1 !== null &&
      cat1 === cat2
    ) {
      result.push({ name, line1, line2 });
      i += 2;
    }
  }
  return result;
}

// Alpha-5: a letter A–Z, skipping I and O, then exactly four digits.
const ALPHA5 = /^[A-HJ-NP-Z]\d{4}$/;
const DIGITS = /^\d+$/;

/**
 * The catalog number a catalog field stands for, or null for any other field.
 *
 * A field is either plain digits or Alpha-5, the TLE spelling of numbers above
 * 99999: the letter stands for 10–33 in the ten-thousands place, skipping I
 * and O, so 100000 is "A0000" and 339999 is "Z9999". Anything else (a sign, a
 * decimal point, hex, an embedded space, a lowercase or trailing letter) is
 * not a catalog number.
 * @param {string} field the field with any leading spaces already removed
 * @returns {number | null}
 */
function decodeCatalogField(field) {
  if (DIGITS.test(field)) return Number(field);
  if (!ALPHA5.test(field)) return null;
  const letter = field[0];
  let tens = letter.charCodeAt(0) - 65 + 10;
  if (letter > 'I') tens -= 1;
  if (letter > 'O') tens -= 1;
  return tens * 10000 + Number(field.slice(1));
}

/**
 * NORAD catalog number of a satrec as a number, or NaN.
 *
 * satellite.js keeps the TLE's five-character field verbatim in
 * `satrec.satnum`, and `Number("A0000")` is NaN, so every Alpha-5 satellite
 * would share one NaN key. Digits of any length (an OMM satrec carries the
 * number unpadded) and Alpha-5 decode; anything else, blank included, is NaN.
 * @param {string} satnum
 * @returns {number}
 */
export function noradIdFromSatnum(satnum) {
  return decodeCatalogField(String(satnum ?? '').trim()) ?? Number.NaN;
}

/** The NORAD catalog number from TLE line 1 or 2 (columns 3–7), or null. */
export function tleCatalogNumber(line) {
  const field = String(line).slice(2, 7);
  return decodeCatalogField(field.replace(/^ +/, ''));
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
