import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  crc32,
  makeZip,
  makeZipDeflated,
  readZip,
  readZipAsync,
} from './zip.js';

const WHEN = new Date(2026, 10, 16, 12, 30, 10);
const text = (s) => new TextEncoder().encode(s);
const body = `${'<wpml:index>0</wpml:index>\n'.repeat(400)}tail`;

/** Walk the central directory: method, sizes, crc and name of every entry. */
function directory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (view.getUint32(end, true) !== 0x06054b50) end -= 1;
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out = [];
  for (let n = 0; n < count; n += 1) {
    assert.equal(view.getUint32(at, true), 0x02014b50);
    const nameLen = view.getUint16(at + 28, true);
    const localAt = view.getUint32(at + 42, true);
    out.push({
      name: new TextDecoder().decode(
        bytes.subarray(at + 46, at + 46 + nameLen),
      ),
      method: view.getUint16(at + 10, true),
      crc: view.getUint32(at + 16, true),
      packed: view.getUint32(at + 20, true),
      size: view.getUint32(at + 24, true),
      localMethod: view.getUint16(localAt + 8, true),
      localCrc: view.getUint32(localAt + 14, true),
      localPacked: view.getUint32(localAt + 18, true),
      localSize: view.getUint32(localAt + 22, true),
    });
    at +=
      46 +
      nameLen +
      view.getUint16(at + 30, true) +
      view.getUint16(at + 32, true);
  }
  return out;
}

test('makeZipDeflated writes method 8 with the CRC of the UNCOMPRESSED data', async () => {
  const zip = await makeZipDeflated(
    [{ name: 'wpmz/waylines.wpml', data: body }],
    WHEN,
  );
  const [entry] = directory(zip);
  assert.equal(entry.method, 8);
  assert.equal(entry.localMethod, 8);
  assert.equal(entry.crc, crc32(text(body)));
  assert.equal(entry.localCrc, entry.crc);
  assert.equal(entry.size, text(body).length);
  assert.equal(entry.localSize, entry.size);
  assert.ok(
    entry.packed > 0 && entry.packed < entry.size / 5,
    `${entry.packed}`,
  );
  assert.equal(entry.localPacked, entry.packed);
});

test('the repo readers open what it writes (async reader inflates; sync reader refuses DEFLATE)', async () => {
  const entries = [
    { name: 'wpmz/template.kml', data: '<kml/>' },
    { name: 'wpmz/waylines.wpml', data: body },
    { name: 'README.txt', data: 'COMPACT TEST FILE\n' },
  ];
  const zip = await makeZipDeflated(entries, WHEN);
  const files = await readZipAsync(zip);
  assert.deepEqual(
    [...files.keys()],
    entries.map((e) => e.name),
  );
  for (const e of entries) {
    assert.equal(new TextDecoder().decode(files.get(e.name)), e.data);
  }
  assert.throws(() => readZip(zip), /Unsupported ZIP method/);
});

test('an entry that does not shrink (random bytes, tiny text, empty) stays STORED', async () => {
  const noise = new Uint8Array(2000);
  let x = 12345;
  for (let i = 0; i < noise.length; i += 1) {
    x = (x * 1103515245 + 12345) >>> 0;
    noise[i] = x >>> 24;
  }
  const zip = await makeZipDeflated(
    [
      { name: 'photo.jpg', data: noise },
      { name: 'a.txt', data: 'x' },
      { name: 'empty.txt', data: new Uint8Array(0) },
      { name: 'big.txt', data: body },
    ],
    WHEN,
  );
  const dir = directory(zip);
  assert.deepEqual(
    dir.map((d) => [d.name, d.method]),
    [
      ['photo.jpg', 0],
      ['a.txt', 0],
      ['empty.txt', 0],
      ['big.txt', 8],
    ],
  );
  const files = await readZipAsync(zip);
  assert.deepEqual(files.get('photo.jpg'), noise);
  assert.equal(files.get('empty.txt').length, 0);
  // A STORED-only archive of the same entries is readable by the sync reader.
  assert.deepEqual(
    readZip(makeZip([{ name: 'photo.jpg', data: noise }], WHEN)).get(
      'photo.jpg',
    ),
    noise,
  );
});

test('it is deterministic and smaller than the STORED archive', async () => {
  const entries = [{ name: 'wpmz/waylines.wpml', data: body }];
  const a = await makeZipDeflated(entries, WHEN);
  const b = await makeZipDeflated(entries, WHEN);
  assert.deepEqual(a, b);
  assert.ok(a.length < makeZip(entries, WHEN).length / 4);
});

test('UTF-8 entry names survive', async () => {
  const zip = await makeZipDeflated(
    [{ name: 'flüge/Ä-1.txt', data: body }],
    WHEN,
  );
  assert.deepEqual([...(await readZipAsync(zip)).keys()], ['flüge/Ä-1.txt']);
});

test('the system unzip accepts it: unzip -t and unzip -p give the original bytes', async (t) => {
  if (spawnSync('unzip', ['-v']).error) {
    t.skip('unzip is not installed');
    return;
  }
  const entries = [
    { name: 'wpmz/template.kml', data: '<?xml version="1.0"?><kml/>' },
    { name: 'wpmz/waylines.wpml', data: body },
    { name: 'README.txt', data: 'COMPACT TEST FILE\n'.repeat(50) },
  ];
  const zip = await makeZipDeflated(entries, WHEN);
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-zip-'));
  const file = path.join(dir, 'compact.kmz');
  writeFileSync(file, zip);
  const tested = execFileSync('unzip', ['-t', file]).toString();
  assert.match(tested, /No errors detected/);
  for (const e of entries) {
    const out = execFileSync('unzip', ['-p', file, e.name], {
      maxBuffer: 1 << 24,
    });
    assert.equal(out.toString('utf8'), e.data, e.name);
  }
  const listing = execFileSync('unzip', ['-v', file]).toString();
  assert.match(listing, /Defl:N/);
});
