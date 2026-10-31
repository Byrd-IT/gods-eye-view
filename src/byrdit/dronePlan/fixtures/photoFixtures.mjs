/** Test helper: builds JPEG headers laid out like a real DJI Mini 5 Pro still. */
// ------------------------------------------------------ synthetic JPEGs --
// Built to the same layout as a real DJI Mini 5 Pro still (coordinates here
// are made up: this file is public).
export const u16 = (v) => [v & 255, v >> 8];
export const u32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24];
const rat = (n, d) => [...u32(n), ...u32(d)];

export function tiff({
  gps,
  model = 'FC9313',
  focal = [867, 100],
  f35 = 24,
  w = 4096,
  h = 3072,
  time = '2026:10:30 13:09:19',
}) {
  // layout: header(8) IFD0 ExifIFD GPSIFD then a data area
  const data = [];
  const dataBase = 400;
  const put = (bytes) => {
    const at = dataBase + data.length;
    data.push(...bytes);
    return at;
  };
  const entry = (tag, type, count, valueOrOffset) => [
    ...u16(tag),
    ...u16(type),
    ...u32(count),
    ...u32(valueOrOffset),
  ];
  const str = (s) => [...Buffer.from(`${s}\0`, 'latin1')];
  const modelAt = put(str(model));
  const timeAt = put(str(time));
  const focalAt = put(rat(...focal));
  const ifd0 = [
    ...u16(3),
    ...entry(0x0110, 2, model.length + 1, modelAt),
    ...entry(0x8769, 4, 1, 100),
    ...entry(0x8825, 4, 1, 200),
    ...u32(0),
  ];
  const exif = [
    ...u16(5),
    ...entry(0x9003, 2, 20, timeAt),
    ...entry(0x920a, 5, 1, focalAt),
    ...entry(0xa002, 4, 1, w),
    ...entry(0xa003, 4, 1, h),
    ...entry(0xa405, 3, 1, f35),
    ...u32(0),
  ];
  let gpsBytes;
  if (gps === 'empty') {
    // As the real files before the GPS fix: tags present, nothing in them.
    gpsBytes = [
      ...u16(3),
      ...entry(0x0001, 2, 1, 0),
      ...entry(0x0002, 5, 0, 0),
      ...entry(0x0004, 5, 0, 0),
      ...u32(0),
    ];
  } else if (gps) {
    const d = (deg) => {
      const a = Math.abs(deg);
      const dd = Math.floor(a);
      const mm = Math.floor((a - dd) * 60);
      const ss = ((a - dd) * 60 - mm) * 60;
      return put([
        ...rat(dd, 1),
        ...rat(mm, 1),
        ...rat(Math.round(ss * 10000), 10000),
      ]);
    };
    const latAt = d(gps.lat);
    const lonAt = d(gps.lon);
    const altAt = put(rat(Math.round(gps.alt * 1000), 1000));
    gpsBytes = [
      ...u16(6),
      ...entry(0x0001, 2, 2, gps.lat < 0 ? 0x53 : 0x4e),
      ...entry(0x0002, 5, 3, latAt),
      ...entry(0x0003, 2, 2, gps.lon < 0 ? 0x57 : 0x45),
      ...entry(0x0004, 5, 3, lonAt),
      ...entry(0x0005, 1, 1, 0),
      ...entry(0x0006, 5, 1, altAt),
      ...u32(0),
    ];
  } else gpsBytes = [...u16(0), ...u32(0)];
  const out = new Array(dataBase).fill(0);
  out.splice(0, 8, 0x49, 0x49, 42, 0, 8, 0, 0, 0);
  out.splice(8, ifd0.length, ...ifd0);
  out.splice(100, exif.length, ...exif);
  out.splice(200, gpsBytes.length, ...gpsBytes);
  return [...out, ...data];
}

export function xmpText({
  lat,
  lon,
  abs,
  rel,
  pitch = -90,
  created = '2026-10-30T13:09:19-05:00',
  extra = '',
}) {
  const pos =
    lat == null
      ? ''
      : `   drone-dji:GpsLatitude="${lat}"\n   drone-dji:GpsLongitude="${lon}"\n`;
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description\n   xmp:CreateDate="${created}"\n${pos}   drone-dji:AbsoluteAltitude="${abs}"\n   drone-dji:RelativeAltitude="${rel}"\n   drone-dji:GimbalPitchDegree="${pitch}"\n   drone-dji:ProductName="Mini5Pro"${extra}></rdf:Description></rdf:RDF></x:xmpmeta>`;
}

export function jpeg({ exif, xmp, tail = [] }) {
  const seg = (marker, payload) => [
    0xff,
    marker,
    (payload.length + 2) >> 8,
    (payload.length + 2) & 255,
    ...payload,
  ];
  const bytes = [0xff, 0xd8];
  if (exif)
    bytes.push(...seg(0xe1, [...Buffer.from('Exif\0\0', 'latin1'), ...exif]));
  if (xmp)
    bytes.push(
      ...seg(0xe1, [
        ...Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'),
        ...Buffer.from(xmp, 'utf8'),
      ]),
    );
  bytes.push(
    ...seg(
      0xc0,
      [8, 0x0c, 0x00, 0x10, 0x00, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
    ),
    ...tail,
  );
  return new Uint8Array(bytes);
}
