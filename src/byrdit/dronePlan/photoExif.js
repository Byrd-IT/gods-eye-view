/**
 * Reads where and how a drone photo was taken from the first bytes of a JPEG:
 * EXIF (GPS, time, focal length, size) and the DJI XMP block.
 *
 * Real DJI Mini 5 Pro stills (checked on 622 photos, 2026-10-30): the EXIF GPS
 * tags are present but EMPTY on the first photos of a flight (before the GPS
 * fix) and the position is only in the XMP (`drone-dji:GpsLatitude`, signed
 * decimals). So the XMP is read too, and the EXIF position is used only when
 * it is a real one. Heights come from the XMP (`RelativeAltitude` is metres
 * above the takeoff point, `AbsoluteAltitude` is above sea level); the EXIF
 * altitude is the fallback for the absolute one.
 *
 * Pure: bytes in, a plain object out. Nothing is read from or written to the
 * network, a file or storage. Input is untrusted: every read is bounds
 * checked, loops are capped, and nothing throws.
 */

/** How many leading bytes of a file hold everything this reads. */
export const HEADER_BYTES = 160 * 1024;

const MAX_SEGMENTS = 64;
const MAX_IFD_ENTRIES = 512;
const MAX_STRING = 256;
const XMP_ID = 'http://ns.adobe.com/xap/1.0/\0';
const EXIF_ID = 'Exif\0\0';

const ascii = (bytes, start, end) => {
  let s = '';
  for (let i = start; i < end && i < bytes.length; i += 1)
    s += String.fromCharCode(bytes[i]);
  return s;
};

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** A TIFF structure: byte order, bounds-checked reads. */
function tiffReader(bytes, base) {
  const little = bytes[base] === 0x49 && bytes[base + 1] === 0x49;
  const big = bytes[base] === 0x4d && bytes[base + 1] === 0x4d;
  if (!little && !big) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o) =>
    o >= 0 && base + o + 2 <= bytes.length
      ? view.getUint16(base + o, little)
      : null;
  const u32 = (o) =>
    o >= 0 && base + o + 4 <= bytes.length
      ? view.getUint32(base + o, little)
      : null;
  const s32 = (o) =>
    o >= 0 && base + o + 4 <= bytes.length
      ? view.getInt32(base + o, little)
      : null;
  if (u16(2) !== 42) return null;
  return { u16, u32, s32, base, bytes, view, little };
}

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

/** The values of one IFD entry: numbers (rationals as fractions) or a string. */
function entryValues(r, entryOffset) {
  const tag = r.u16(entryOffset);
  const type = r.u16(entryOffset + 2);
  const count = r.u32(entryOffset + 4);
  const size = TYPE_SIZE[type];
  if (tag == null || type == null || count == null || !size) return null;
  if (count === 0 || count > 4096) return { tag, type, value: [] };
  const total = size * count;
  const at = total <= 4 ? entryOffset + 8 : r.u32(entryOffset + 8);
  if (at == null || at < 0 || r.base + at + total > r.bytes.length) return null;
  if (type === 2) {
    const end = Math.min(at + count, at + MAX_STRING);
    const raw = ascii(r.bytes, r.base + at, r.base + end);
    return { tag, type, value: raw.split('\0')[0].trim() };
  }
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const o = at + i * size;
    if (type === 1 || type === 7) out.push(r.bytes[r.base + o]);
    else if (type === 3) out.push(r.u16(o));
    else if (type === 4) out.push(r.u32(o));
    else if (type === 9) out.push(r.s32(o));
    else {
      const a = type === 5 ? r.u32(o) : r.s32(o);
      const b = type === 5 ? r.u32(o + 4) : r.s32(o + 4);
      out.push(a == null || !b ? null : a / b);
    }
  }
  return { tag, type, value: out };
}

/** Every entry of the IFD at `offset` as { tag: { type, value } }. */
function readIfd(r, offset) {
  const tags = {};
  const n = r.u16(offset);
  if (n == null || n > MAX_IFD_ENTRIES) return tags;
  for (let i = 0; i < n; i += 1) {
    const e = entryValues(r, offset + 2 + i * 12);
    if (e) tags[e.tag] = e;
  }
  return tags;
}

const first = (e) =>
  e && Array.isArray(e.value) && finite(e.value[0]) ? e.value[0] : null;
const text = (e) => (e && typeof e.value === 'string' ? e.value : '');

/** Degrees from [deg, min, sec] rationals; null if any part is missing. */
function dms(e) {
  const v = e?.value;
  if (!Array.isArray(v) || v.length < 3 || !v.every(finite)) return null;
  return v[0] + v[1] / 60 + v[2] / 3600;
}

/** "2026:10:30 13:09:19" (no zone) as milliseconds read as UTC. */
function exifTimeMs(raw, subsec) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(
    raw ?? '',
  );
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (!finite(ms)) return null;
  const frac = /^\d{1,3}/.exec(subsec ?? '');
  return ms + (frac ? Number(frac[0].padEnd(3, '0')) : 0);
}

function readExif(bytes, base) {
  const r = tiffReader(bytes, base);
  if (!r) return null;
  const ifd0Offset = r.u32(4);
  if (ifd0Offset == null) return null;
  const ifd0 = readIfd(r, ifd0Offset);
  const exifPtr = first(ifd0[0x8769]);
  const gpsPtr = first(ifd0[0x8825]);
  const exif = exifPtr ? readIfd(r, exifPtr) : {};
  const gps = gpsPtr ? readIfd(r, gpsPtr) : {};
  let lat = dms(gps[2]);
  let lon = dms(gps[4]);
  if (lat != null && /^S/i.test(text(gps[1]))) lat = -lat;
  if (lon != null && /^W/i.test(text(gps[3]))) lon = -lon;
  const alt = first(gps[6]);
  return {
    make: text(ifd0[0x010f]),
    model: text(ifd0[0x0110]),
    lat,
    lon,
    altM: alt == null ? null : first(gps[5]) === 1 ? -alt : alt,
    timeText: text(exif[0x9003]) || text(ifd0[0x0132]),
    timeMs: exifTimeMs(
      text(exif[0x9003]) || text(ifd0[0x0132]),
      text(exif[0x9291]),
    ),
    focalMm: first(exif[0x920a]),
    focal35Mm: first(exif[0xa405]),
    widthPx: first(exif[0xa002]),
    heightPx: first(exif[0xa003]),
  };
}

/** One XMP value from either `ns:Name="v"` or `<ns:Name>v</ns:Name>`. */
function xmpValue(xmp, name) {
  const attr = new RegExp(`:${name}\\s*=\\s*"([^"]{0,200})"`, 'i').exec(xmp);
  if (attr) return attr[1].trim();
  const elem = new RegExp(
    `<[\\w-]+:${name}>\\s*([^<]{0,200}?)\\s*</`,
    'i',
  ).exec(xmp);
  return elem ? elem[1].trim() : '';
}

const xmpNumber = (xmp, name) => {
  const raw = xmpValue(xmp, name);
  if (!/^[+-]?\d+(\.\d+)?$/.test(raw)) return null;
  const v = Number(raw);
  return finite(v) ? v : null;
};

function readXmp(xmp) {
  const created = xmpValue(xmp, 'CreateDate');
  const withZone = /(Z|[+-]\d{2}:\d{2})$/.test(created);
  const parsed = withZone ? Date.parse(created) : NaN;
  return {
    lat: xmpNumber(xmp, 'GpsLatitude'),
    lon: xmpNumber(xmp, 'GpsLongitude'),
    absAltM: xmpNumber(xmp, 'AbsoluteAltitude'),
    relAltM: xmpNumber(xmp, 'RelativeAltitude'),
    gimbalPitchDeg: xmpNumber(xmp, 'GimbalPitchDegree'),
    gimbalYawDeg: xmpNumber(xmp, 'GimbalYawDegree'),
    flightYawDeg: xmpNumber(xmp, 'FlightYawDegree'),
    calibratedFocalPx: xmpNumber(xmp, 'CalibratedFocalLength'),
    product: xmpValue(xmp, 'ProductName'),
    timeMs: Number.isFinite(parsed) ? parsed : null,
  };
}

/** The JPEG segments we care about: the EXIF block and the XMP packet. */
function findSegments(bytes) {
  let exifAt = -1;
  let xmp = null;
  let sizeFromFrame = null;
  let p = 2;
  for (let n = 0; n < MAX_SEGMENTS && p + 4 <= bytes.length; n += 1) {
    if (bytes[p] !== 0xff) break;
    const marker = bytes[p + 1];
    if (marker === 0xff) {
      p += 1;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 1) {
      p += 2;
      continue;
    }
    const len = (bytes[p + 2] << 8) | bytes[p + 3];
    if (len < 2) break;
    const start = p + 4;
    const end = Math.min(p + 2 + len, bytes.length);
    if (marker === 0xe1) {
      if (exifAt < 0 && ascii(bytes, start, start + 6) === EXIF_ID)
        exifAt = start + 6;
      else if (!xmp && ascii(bytes, start, start + XMP_ID.length) === XMP_ID) {
        xmp = new TextDecoder('utf-8').decode(
          bytes.subarray(start + XMP_ID.length, end),
        );
      }
    } else if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc &&
      end - start >= 5
    ) {
      sizeFromFrame = {
        heightPx: (bytes[start + 1] << 8) | bytes[start + 2],
        widthPx: (bytes[start + 3] << 8) | bytes[start + 4],
      };
    }
    if (marker === 0xda) break;
    p = p + 2 + len;
  }
  return { exifAt, xmp, sizeFromFrame };
}

const validPosition = (lat, lon) =>
  finite(lat) &&
  finite(lon) &&
  Math.abs(lat) <= 90 &&
  Math.abs(lon) <= 180 &&
  // The camera's "no fix" value; DJI writes it before the GPS locks.
  !(lat === 0 && lon === 0);

/**
 * @param {Uint8Array} bytes the start of a JPEG (HEADER_BYTES is enough)
 * @param {string} [name] the file name, for messages only
 * @returns {{ ok: true, photo: object } | { ok: false, reason: string, name: string }}
 *   reason: 'not-jpeg' | 'no-position'
 */
export function readPhotoMeta(bytes, name = '') {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4)
    return { ok: false, reason: 'not-jpeg', name };
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8)
    return { ok: false, reason: 'not-jpeg', name };
  const { exifAt, xmp: xmpText, sizeFromFrame } = findSegments(bytes);
  const exif = exifAt >= 0 ? readExif(bytes, exifAt) : null;
  const xmp = xmpText ? readXmp(xmpText) : null;

  // The EXIF position when it is a real one; the DJI XMP otherwise.
  let lat = null;
  let lon = null;
  let source = null;
  if (exif && validPosition(exif.lat, exif.lon)) {
    lat = exif.lat;
    lon = exif.lon;
    source = 'exif';
  } else if (xmp && validPosition(xmp.lat, xmp.lon)) {
    lat = xmp.lat;
    lon = xmp.lon;
    source = 'xmp';
  }
  if (source == null) return { ok: false, reason: 'no-position', name };

  const widthPx = exif?.widthPx ?? sizeFromFrame?.widthPx ?? null;
  const heightPx = exif?.heightPx ?? sizeFromFrame?.heightPx ?? null;
  const photo = {
    name,
    lat,
    lon,
    positionSource: source,
    absAltM: xmp?.absAltM ?? exif?.altM ?? null,
    relAltM: xmp?.relAltM ?? null,
    timeMs: xmp?.timeMs ?? exif?.timeMs ?? null,
    timeText: exif?.timeText ?? '',
    make: exif?.make ?? '',
    model: exif?.model || xmp?.product || '',
    focalMm: exif?.focalMm ?? null,
    focal35Mm: exif?.focal35Mm ?? null,
    calibratedFocalPx: xmp?.calibratedFocalPx ?? null,
    widthPx,
    heightPx,
    gimbalPitchDeg: xmp?.gimbalPitchDeg ?? null,
    gimbalYawDeg: xmp?.gimbalYawDeg ?? null,
  };
  return { ok: true, photo };
}
