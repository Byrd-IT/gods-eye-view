import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import test from 'node:test';
import {
  GRID,
  decodeRow,
  obstaclesProxy,
  parseBox,
  parseFaaPayload,
  parseTiffHeader,
  quadkey,
  summarizeCells,
  undoPredictor,
} from './obstacles.js';

// --------------------------------------------------------------- fixtures --
const faaFixture = {
  features: [
    {
      attributes: { OAS_Number: '48-012345', Type_Code: 'TOWER', AGL: 200 },
      geometry: { x: -95.01, y: 32.58 },
    },
    {
      attributes: { OAS_Number: '48-012346', Type_Code: 'BLDG', AGL: 100 },
      geometry: { x: -95.02, y: 32.59 },
    },
    // No height, no position, a duplicate and a bad id: all dropped.
    { attributes: { OAS_Number: '48-1', AGL: 0 }, geometry: { x: 1, y: 1 } },
    { attributes: { OAS_Number: '48-2', AGL: 50 }, geometry: {} },
    {
      attributes: { OAS_Number: '48-012345', Type_Code: 'TOWER', AGL: 200 },
      geometry: { x: -95.01, y: 32.58 },
    },
    {
      attributes: { OAS_Number: '<script>', AGL: 50 },
      geometry: { x: 1, y: 1 },
    },
  ],
};

/** A tiny BigTIFF the way the canopy tiles are laid out. */
function makeTiff({ width, rows, predictor = 2, x0 = -10575000, y0 = 3860000 }) {
  const height = rows.length;
  const strips = rows.map((r) => {
    const delta = Uint8Array.from(r, (v, i) => (v - (i ? r[i - 1] : 0)) & 255);
    return deflateSync(delta);
  });
  const ifdAt = 16;
  const entries = 12;
  const ifdSize = 8 + entries * 20 + 8;
  const offTable = ifdAt + ifdSize;
  const cntTable = offTable + height * 8;
  const scaleAt = cntTable + height * 8;
  const tieAt = scaleAt + 24;
  let at = tieAt + 48;
  const stripPos = strips.map((s) => {
    const pos = at;
    at += s.length;
    return pos;
  });
  const buf = Buffer.alloc(at);
  buf.write('II', 0, 'latin1');
  buf.writeUInt16LE(43, 2);
  buf.writeUInt16LE(8, 4);
  buf.writeBigUInt64LE(BigInt(ifdAt), 8);
  buf.writeBigUInt64LE(BigInt(entries), ifdAt);
  let e = ifdAt + 8;
  const tag = (id, type, count, value) => {
    buf.writeUInt16LE(id, e);
    buf.writeUInt16LE(type, e + 2);
    buf.writeBigUInt64LE(BigInt(count), e + 4);
    if (type === 3) buf.writeUInt16LE(value, e + 12);
    else buf.writeBigUInt64LE(BigInt(value), e + 12);
    e += 20;
  };
  tag(256, 3, 1, width);
  tag(257, 3, 1, height);
  tag(258, 3, 1, 8);
  tag(259, 3, 1, 8);
  tag(273, 16, height, offTable);
  tag(277, 3, 1, 1);
  tag(278, 3, 1, 1);
  tag(279, 16, height, cntTable);
  tag(317, 3, 1, predictor);
  tag(339, 3, 1, 1);
  tag(33550, 12, 3, scaleAt);
  tag(33922, 12, 6, tieAt);
  strips.forEach((s, i) => {
    buf.writeBigUInt64LE(BigInt(stripPos[i]), offTable + i * 8);
    buf.writeBigUInt64LE(BigInt(s.length), cntTable + i * 8);
    s.copy(buf, stripPos[i]);
  });
  buf.writeDoubleLE(100, scaleAt);
  buf.writeDoubleLE(100, scaleAt + 8);
  buf.writeDoubleLE(x0, tieAt + 24);
  buf.writeDoubleLE(y0, tieAt + 32);
  return buf;
}

// ------------------------------------------------------------------ tests --
test('parseBox: only a small, ordered, real box', () => {
  const q = (o) => new URLSearchParams(o);
  assert.deepEqual(
    parseBox(q({ west: '-95.02', south: '32.58', east: '-94.99', north: '32.6' })),
    { west: -95.02, south: 32.58, east: -94.99, north: 32.6 },
  );
  for (const bad of [
    {},
    { west: 'a', south: '1', east: '2', north: '3' },
    { west: '2', south: '1', east: '1', north: '3' },
    { west: '0', south: '0', east: '1', north: '1' },
    { west: '0', south: '89', east: '0.01', north: '89.01' },
    { west: '-181', south: '0', east: '-180.9', north: '0.01' },
  ])
    assert.equal(parseBox(q(bad)), null, JSON.stringify(bad));
});

test('FAA rows: feet become metres, the kind follows the type code, junk is dropped', () => {
  const out = parseFaaPayload(faaFixture);
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((o) => [o.id, o.kind, o.source, o.estimatedHeightM]),
    [
      ['faa-48-012345', 'tower', 'faa', 61],
      ['faa-48-012346', 'building', 'faa', 30.5],
    ],
  );
  assert.equal(out[0].lon, -95.01);
  assert.deepEqual(parseFaaPayload(null), []);
  assert.deepEqual(parseFaaPayload({ features: 'x' }), []);
});

test('quadkey: the tile holding a known point', () => {
  assert.equal(quadkey(-95.0, 32.58), '023113220');
  assert.equal(quadkey(0, 0, 1), '3');
  assert.equal(quadkey(-179.9, 84, 2), '00');
});

test('TIFF header: reads the layout, refuses anything else', () => {
  const tiff = makeTiff({ width: 4, rows: [[1, 2, 3, 4]] });
  const info = parseTiffHeader(tiff);
  assert.equal(info.width, 4);
  assert.equal(info.height, 1);
  assert.ok(info.stripOffsets > 0 && info.scaleAt > 0 && info.tiepointAt > 0);
  assert.throws(
    () => parseTiffHeader(makeTiff({ width: 4, rows: [[1, 2, 3, 4]], predictor: 1 })),
    /unsupported_tiff/,
  );
  assert.throws(() => parseTiffHeader(Buffer.from('MM\0*\0\0\0\0')), /unsupported_tiff/);
  assert.throws(() => parseTiffHeader(Buffer.alloc(4)), /unsupported_tiff/);
});

test('rows: the predictor is undone and a wrong-sized row is refused', () => {
  const row = [5, 6, 20, 19];
  const delta = Uint8Array.from(row, (v, i) => (v - (i ? row[i - 1] : 0)) & 255);
  assert.deepEqual([...undoPredictor(Uint8Array.from(delta))], row);
  assert.deepEqual([...decodeRow(deflateSync(delta), 4)], row);
  assert.throws(() => decodeRow(deflateSync(delta), 5), /bad_row/);
});

test('canopy cells: coverage and the 90th percentile make a tree patch', () => {
  const box = { west: -95.02, south: 32.58, east: -94.98, north: 32.62 };
  const rows = [
    {
      cellRow: 0,
      samples: [
        ...[10, 12, 14, 16, 18, 20, 22, 24, 26, 28].map((v) => ({ cellCol: 0, value: v })),
        // sparse cell: 1 of 10 tall enough, below 25 percent coverage
        { cellCol: 1, value: 15 },
        ...Array.from({ length: 9 }, () => ({ cellCol: 1, value: 0 })),
        // cell of 2 m shrubs: below the tree minimum
        ...Array.from({ length: 10 }, () => ({ cellCol: 2, value: 2 })),
      ],
    },
  ];
  const out = summarizeCells(rows, box);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'tree');
  assert.equal(out[0].source, 'canopy');
  assert.equal(out[0].estimatedHeightM, 28);
  assert.equal(out[0].coverage, 1);
  assert.ok(out[0].lon > box.west && out[0].lon < box.east);
  assert.ok(out[0].radiusM >= 3);
});

// ------------------------------------------------------ the route itself --
function fakeRes() {
  return {
    status: null,
    body: '',
    destroyed: false,
    writeHead(s) {
      this.status = s;
    },
    end(b) {
      this.body = b;
    },
  };
}
const call = async (proxy, url, method = 'GET', remote = '10.0.0.5') => {
  let handler;
  proxy.configureServer({ middlewares: { use: (_p, h) => (handler = h) } });
  const res = fakeRes();
  await handler({ method, url, socket: { remoteAddress: remote }, headers: {} }, res);
  return { status: res.status, body: res.body ? JSON.parse(res.body) : null };
};
const jsonResponse = (value, status = 200) => ({
  ok: status === 200,
  status,
  headers: new Headers({ 'content-type': 'application/json' }),
  body: null,
  json: async () => value,
  text: async () => JSON.stringify(value),
});
const BOX = '?west=-95.02&south=32.58&east=-94.99&north=32.6';

test('route: FAA, with a fixture and no live network', async () => {
  const urls = [];
  const proxy = obstaclesProxy({
    fetchImpl: async (url) => {
      urls.push(String(url));
      const text = JSON.stringify(faaFixture);
      return new Response(text, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const r = await call(proxy, `/faa${BOX}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.source, 'faa');
  assert.equal(r.body.obstacles.length, 2);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /^https:\/\/services6\.arcgis\.com\//);
  // Cached: a second ask does not go upstream.
  await call(proxy, `/faa${BOX}`);
  assert.equal(urls.length, 1);
});

test('route: canopy reads the tile with range requests and finds tree patches', async () => {
  const width = 600;
  const rows = [];
  for (let r = 0; r < 600; r += 1)
    rows.push(Array.from({ length: width }, (_, c) => (c < 300 ? 20 : 0)));
  // Put the tile origin north-west of the box so the box is inside it.
  const merc = (lon) => (lon * 20037508.342789244) / 180;
  const mercLat = (lat) =>
    Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) * 6378137;
  const tiff = makeTiff({ width, rows, x0: merc(-95.1), y0: mercLat(32.7) });
  const ranges = [];
  const proxy = obstaclesProxy({
    fetchImpl: async (url, init) => {
      const m = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
      const [start, end] = [Number(m[1]), Number(m[2])];
      ranges.push([start, end]);
      assert.match(String(url), /\/chm\/\d{9}\.tif$/);
      return new Response(tiff.subarray(start, end + 1), { status: 206 });
    },
  });
  const r = await call(proxy, `/canopy${BOX}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.obstacles.length > 0 && r.body.obstacles.length <= 40);
  for (const o of r.body.obstacles) {
    assert.equal(o.kind, 'tree');
    assert.equal(o.estimatedHeightM, 20);
  }
  // Columns west of pixel 300 hold trees; columns east of it are bare.
  const split = -95.1 + (300 * 100) / 111319;
  assert.ok(r.body.obstacles.every((o) => o.lon < split + 0.003));
  assert.ok(ranges.every(([a, b]) => b - a < 1024 * 1024), 'never the whole file');
  assert.ok(ranges.length <= 4 + GRID * 2 + 4, 'sampling is capped');
});

test('route: a tile that cannot be read is an error, never "no trees"', async () => {
  const proxy = obstaclesProxy({
    fetchImpl: async () => new Response('nope', { status: 404 }),
  });
  const r = await call(proxy, `/canopy${BOX}`);
  assert.equal(r.status, 502);
});

test('route: failures never leak upstream text', async () => {
  const proxy = obstaclesProxy({
    fetchImpl: async () => {
      throw new Error('connect ECONNREFUSED https://user:secret@example.com/?key=abc123');
    },
  });
  const r = await call(proxy, `/faa${BOX}`);
  assert.equal(r.status, 502);
  assert.deepEqual(r.body, { error: 'obstacles_unavailable', source: 'faa' });
  assert.ok(!JSON.stringify(r.body).includes('secret'));
});

test('route: bad method, route, box and the rate limit', async () => {
  const proxy = obstaclesProxy({
    fetchImpl: async () => new Response(JSON.stringify(faaFixture), { status: 200 }),
  });
  assert.equal((await call(proxy, `/faa${BOX}`, 'POST')).status, 405);
  assert.equal((await call(proxy, `/nope${BOX}`)).status, 404);
  assert.equal((await call(proxy, '/faa?west=1')).status, 400);
  let last = 0;
  for (let i = 0; i < 40; i += 1) {
    last = (await call(proxy, `/faa?west=-95.02&south=${(32.58 - i * 0.0001).toFixed(4)}&east=-94.99&north=32.6`, 'GET', '10.9.9.9')).status;
  }
  assert.equal(last, 429);
  void jsonResponse;
});
