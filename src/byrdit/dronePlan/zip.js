/**
 * A tiny ZIP writer/reader. A KMZ is a ZIP, and GEV has no zip library on its
 * dependency list, so this covers exactly what the Drone Flight Plan tool
 * needs: STORED (uncompressed) entries with a correct CRC-32, which every unzip
 * tool and DJI Fly read. The reader handles the same subset and exists so the
 * tests (and the QA script) can open what the writer produced.
 */
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1)
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const toBytes = (data) =>
  typeof data === 'string' ? textEncoder.encode(data) : data;

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const time =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2);
  const day =
    ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/**
 * Build a ZIP archive.
 * @param {{ name: string, data: string | Uint8Array }[]} entries
 * @param {Date} [when] Timestamp stored on every entry.
 * @returns {Uint8Array}
 */
export function makeZip(entries, when = new Date()) {
  const { time, day } = dosDateTime(when);
  const chunks = [];
  const central = [];
  let offset = 0;
  const push = (bytes) => {
    chunks.push(bytes);
    offset += bytes.length;
  };
  for (const entry of entries) {
    const name = textEncoder.encode(entry.name);
    const data = toBytes(entry.data);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    central.push({ name, crc, size: data.length, offset });
    push(new Uint8Array(local.buffer));
    push(name);
    push(data);
  }
  const centralStart = offset;
  for (const c of central) {
    const head = new DataView(new ArrayBuffer(46));
    head.setUint32(0, 0x02014b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 20, true);
    head.setUint16(8, 0x0800, true);
    head.setUint16(10, 0, true);
    head.setUint16(12, time, true);
    head.setUint16(14, day, true);
    head.setUint32(16, c.crc, true);
    head.setUint32(20, c.size, true);
    head.setUint32(24, c.size, true);
    head.setUint16(28, c.name.length, true);
    head.setUint32(42, c.offset, true);
    push(new Uint8Array(head.buffer));
    push(c.name);
  }
  const centralSize = offset - centralStart;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, central.length, true);
  end.setUint16(10, central.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralStart, true);
  push(new Uint8Array(end.buffer));
  const out = new Uint8Array(offset);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * Read a ZIP made of STORED entries (what makeZip writes).
 * @param {Uint8Array} bytes
 * @returns {Map<string, Uint8Array>} entry name to contents
 * @throws {Error} on a malformed archive, a compressed entry or a bad CRC
 */
export function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('Not a ZIP archive');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const files = new Map();
  for (let n = 0; n < count; n += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) {
      throw new Error('Corrupt ZIP central directory');
    }
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = textDecoder.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    if (method !== 0) throw new Error(`Unsupported ZIP method for ${name}`);
    if (view.getUint32(localAt, true) !== 0x04034b50) {
      throw new Error('Corrupt ZIP local header');
    }
    const localName = view.getUint16(localAt + 26, true);
    const localExtra = view.getUint16(localAt + 28, true);
    const start = localAt + 30 + localName + localExtra;
    const data = bytes.slice(start, start + size);
    if (crc32(data) !== crc) throw new Error(`Bad CRC for ${name}`);
    files.set(name, data);
    at += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

export { crc32 };
