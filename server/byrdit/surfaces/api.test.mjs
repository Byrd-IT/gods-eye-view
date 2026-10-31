import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Writable } from 'node:stream';
import { readGeoTiff } from '../../../tools/droneSurface/geotiff.mjs';
import { boundsOf, buildSurface, utmToLonLat } from '../../../tools/droneSurface/build-surface.mjs';
import { encodeSurface, parseSurface } from '../../../src/byrdit/dronePlan/surfaceGrid.js';
import { lonLatToUtm } from '../../../src/byrdit/dronePlan/utm.js';
import { createSurfaceHandler, listSurfaces } from './api.js';

/** A tiny single-band float32 GeoTIFF (striped, uncompressed, little endian). */
function makeTiff({ width, height, values, originE, originN, cell, zone, nodata = -9999 }) {
  const entries = [];
  const extra = [];
  const dataOff = 8;
  const data = Buffer.alloc(width * height * 4);
  values.forEach((v, i) => data.writeFloatLE(v, i * 4));
  const tail = [];
  let tailBase = dataOff + data.length;
  const addTail = (buf) => {
    const off = tailBase;
    tail.push(buf);
    tailBase += buf.length;
    return off;
  };
  const dbl = (arr) => {
    const b = Buffer.alloc(arr.length * 8);
    arr.forEach((v, i) => b.writeDoubleLE(v, i * 8));
    return b;
  };
  const sh = (arr) => {
    const b = Buffer.alloc(arr.length * 2);
    arr.forEach((v, i) => b.writeUInt16LE(v, i * 2));
    return b;
  };
  const e = (tag, type, n, val) => entries.push({ tag, type, n, val });
  e(256, 4, 1, width);
  e(257, 4, 1, height);
  e(258, 3, 1, 32);
  e(259, 3, 1, 1);
  e(273, 4, 1, dataOff);
  e(277, 3, 1, 1);
  e(278, 4, 1, height);
  e(279, 4, 1, data.length);
  e(339, 3, 1, 3);
  e(33550, 12, 3, addTail(dbl([cell, cell, 0])));
  e(33922, 12, 6, addTail(dbl([0, 0, 0, originE, originN, 0])));
  e(34735, 3, 8, addTail(sh([1, 1, 0, 1, 3072, 0, 1, 32600 + zone])));
  const ndStr = Buffer.from(`${nodata}\0`);
  e(42113, 2, ndStr.length, addTail(ndStr));
  entries.sort((a, b) => a.tag - b.tag);
  const ifdOff = tailBase;
  const ifd = Buffer.alloc(2 + entries.length * 12 + 4);
  ifd.writeUInt16LE(entries.length, 0);
  entries.forEach((en, i) => {
    const o = 2 + i * 12;
    ifd.writeUInt16LE(en.tag, o);
    ifd.writeUInt16LE(en.type, o + 2);
    ifd.writeUInt32LE(en.n, o + 4);
    if (en.type === 3 && en.n === 1) ifd.writeUInt16LE(en.val, o + 8);
    else ifd.writeUInt32LE(en.val, o + 8);
  });
  const head = Buffer.alloc(8);
  head.write('II', 0);
  head.writeUInt16LE(42, 2);
  head.writeUInt32LE(ifdOff, 4);
  void extra;
  return Buffer.concat([head, data, ...tail, ifd]);
}

const ORIGIN = lonLatToUtm(-95.1, 32.55, 15, true);

test('geotiff: reads size, corner, zone and values', () => {
  const t = readGeoTiff(
    makeTiff({
      width: 3,
      height: 2,
      values: [1, 2, 3, 4, 5, -9999],
      originE: ORIGIN.e,
      originN: ORIGIN.n,
      cell: 0.5,
      zone: 15,
    }),
  );
  assert.equal(t.width, 3);
  assert.equal(t.height, 2);
  assert.equal(t.zone, 15);
  assert.equal(t.cellX, 0.5);
  assert.equal(t.originE, ORIGIN.e);
  assert.equal(t.data[4], 5);
  assert.equal(t.nodata, -9999);
  assert.throws(() => readGeoTiff(Buffer.from('not a tiff at all')));
});

test('builder: top over ground, holes stay holes, coarser cells keep the highest tree', () => {
  const mk = (values) =>
    readGeoTiff(
      makeTiff({ width: 4, height: 4, values, originE: ORIGIN.e, originN: ORIGIN.n, cell: 0.5, zone: 15 }),
    );
  const dsm = mk([10, 10, 30, 10, 10, 10, 10, 10, -9999, 10, 10, 10, 10, 10, 10, 10]);
  const dtm = mk(new Array(16).fill(8));
  const base = { dsm, dtm, id: 'x', name: 'x', capturedAt: '2026-10-30', bounds: boundsOf(dsm) };
  const fine = buildSurface({ ...base });
  assert.equal(fine.meta.cols, 4);
  assert.equal(fine.top[2], 30);
  assert.equal(fine.ground[2], 8);
  assert.ok(Number.isNaN(fine.top[8]), 'a hole stays a hole');
  const coarse = buildSurface({ ...base, cellM: 1 });
  assert.equal(coarse.meta.cols, 2);
  assert.equal(coarse.meta.cellM, 1);
  assert.equal(coarse.top[0], 10);
  assert.equal(coarse.top[1], 30, 'the tallest point in the block wins');
  // A top below its own ground is lifted to the ground.
  const low = buildSurface({ ...base, dsm: mk(new Array(16).fill(5)) });
  assert.equal(low.top[0], 8);
  // Different zones are refused.
  assert.throws(() => buildSurface({ ...base, dtm: { ...dtm, zone: 14 } }));
  // The file round-trips.
  const back = parseSurface(encodeSurface(fine.meta, fine.top, fine.ground));
  assert.equal(back.top[2], 30);
});

test('builder: utm back to lon/lat agrees with the forward maths', () => {
  const p = utmToLonLat(ORIGIN.e, ORIGIN.n, 15, true);
  assert.ok(Math.abs(p.lon - -95.1) < 1e-7 && Math.abs(p.lat - 32.55) < 1e-7);
});

function fakeRes() {
  const chunks = [];
  const res = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  res.headers = {};
  res.setHeader = (k, v) => {
    res.headers[k] = v;
  };
  const end = res.end.bind(res);
  res.end = (b) => {
    if (b !== undefined) chunks.push(Buffer.from(b));
    end();
    return res;
  };
  Object.defineProperty(res, 'body', { get: () => Buffer.concat(chunks) });
  return res;
}
const done = (res) => new Promise((r) => (res.writableFinished ? r() : res.once('finish', r)));

test('api: needs identity, lists headers, serves one file, refuses path tricks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'surf-'));
  try {
    const t = readGeoTiff(
      makeTiff({ width: 2, height: 2, values: [9, 9, 9, 9], originE: ORIGIN.e, originN: ORIGIN.n, cell: 1, zone: 15 }),
    );
    const built = buildSurface({ dsm: t, dtm: t, id: 'ranch-1', name: 'Ranch', capturedAt: '2026-10-30', bounds: boundsOf(t) });
    writeFileSync(join(dir, 'ranch-1.gevsurf'), Buffer.from(encodeSurface(built.meta, built.top, built.ground)));
    writeFileSync(join(dir, 'broken.gevsurf'), 'nope');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    assert.deepEqual(listSurfaces(dir).map((s) => s.id), ['ranch-1']);
    const env = { GEV_SURFACE_DIR: dir, GEV_ADMIN_USER: 'byrdit', GEV_TRUSTED_PROXIES: '127.0.0.1' };
    const h = createSurfaceHandler({ env });
    const call = (url, headers = { 'x-gev-user': 'byrdit' }, method = 'GET') => {
      const res = fakeRes();
      let nexted = false;
      h({ url, method, headers, socket: { remoteAddress: '127.0.0.1' } }, res, () => { nexted = true; });
      return { res, nexted };
    };
    assert.equal(call('/other').nexted, true);
    const out = call('/api/byrdit/surfaces', {});
    assert.equal(out.res.statusCode, 401);
    assert.equal(JSON.parse(out.res.body).error, 'no-identity');
    const ok = call('/api/byrdit/surfaces');
    assert.equal(ok.res.statusCode, 200);
    {
      assert.equal(JSON.parse(ok.res.body).surfaces[0].id, 'ranch-1');
      const one = call('/api/byrdit/surfaces/ranch-1');
      assert.equal(one.res.statusCode, 200);
      await done(one.res);
      const bytes = one.res.body;
      assert.equal(String(one.res.headers['content-length']), String(bytes.length));
      assert.equal(
        parseSurface(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)).meta.id,
        'ranch-1',
      );
    }
    for (const bad of ['../etc/passwd', '..%2f..%2fetc', 'ranch-1.gevsurf', 'BROKEN', 'missing']) {
      const r = call(`/api/byrdit/surfaces/${bad}`);
      assert.ok(r.nexted || [401, 404].includes(r.res.statusCode), bad);
      assert.ok(!String(r.res.body).includes(dir), 'no path in the answer');
    }
    assert.equal(call('/api/byrdit/surfaces', { 'x-gev-user': 'byrdit' }, 'POST').res.statusCode, 405);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
