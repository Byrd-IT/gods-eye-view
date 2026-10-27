import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FALLBACK_HALF_DEG,
  VIEW_MIN_INTERVAL_MS,
  VIEW_PARAM_RE,
  appendFlightView,
  cameraViewBox,
  createFlightViewTracker,
  normalizeViewBox,
  randomViewSid,
} from './flightView.js';
import { flightViewLease, parseFlightView } from './feeds.js';
import { createFlightSource } from '../../sources/live/standalone.js';

// B20 item 5: camera -> view box helper and the flights request touch point.

const RAD = Math.PI / 180;

test('normalizeViewBox: +10 % margin, clamp, 1-degree minimum, 2 decimals', () => {
  assert.deepEqual(
    normalizeViewBox([-100, 30, -90, 40]),
    [-100.5, 29.5, -89.5, 40.5],
  );
  // latitude clamped
  assert.deepEqual(normalizeViewBox([-10, 80, 10, 90]), [-11, 79.5, 11, 90]);
  // tiny view grows to 1 degree
  const tiny = normalizeViewBox([-97.75, 30.25, -97.74, 30.26]);
  assert.ok(
    tiny[2] - tiny[0] >= 0.99 && tiny[3] - tiny[1] >= 0.99,
    tiny.join(),
  );
  // the whole world
  assert.deepEqual(
    normalizeViewBox([-180, -90, 180, 90]),
    [-180, -90, 180, 90],
  );
  // crossing the antimeridian stays west > east
  const pac = normalizeViewBox([170, -10, -170, 10]);
  assert.ok(pac[0] > pac[2], pac.join());
  assert.equal(pac[0], 169);
  assert.equal(pac[2], -169);
  assert.equal(normalizeViewBox([NaN, 0, 1, 1]), null);
  for (const b of [
    normalizeViewBox([-100, 30, -90, 40]),
    pac,
    tiny,
    normalizeViewBox([-180, -90, 180, 90]),
  ]) {
    assert.match(b.join(','), VIEW_PARAM_RE);
    assert.ok(parseFlightView(b.join(',')), b.join());
  }
});

test('cameraViewBox reads computeViewRectangle (radians); horizon view falls back around the camera', () => {
  const viewer = {
    camera: {
      computeViewRectangle: () => ({
        west: -100 * RAD,
        south: 30 * RAD,
        east: -90 * RAD,
        north: 40 * RAD,
      }),
      positionCartographic: { latitude: 35 * RAD, longitude: -95 * RAD },
    },
    scene: { globe: { ellipsoid: {} } },
  };
  assert.deepEqual(cameraViewBox(viewer), [-100.5, 29.5, -89.5, 40.5]);
  viewer.camera.computeViewRectangle = () => undefined;
  const fb = cameraViewBox(viewer);
  assert.ok(
    Math.abs(fb[0] - (-95 - FALLBACK_HALF_DEG * 1.1)) < 0.01,
    fb.join(),
  );
  assert.equal(cameraViewBox({}), null);
  assert.equal(cameraViewBox(null), null);
});

test('tracker: at most one new view per 5 s per tab, stable sid', () => {
  let t = 0;
  let box = [-100, 30, -90, 40];
  const tr = createFlightViewTracker({
    now: () => t,
    sid: 'tab-aaaaaaaa',
    boxOf: () => box,
  });
  const q1 = tr.query({});
  assert.deepEqual(q1, { view: '-100,30,-90,40', vsid: 'tab-aaaaaaaa' });
  box = [0, 0, 10, 10];
  t += VIEW_MIN_INTERVAL_MS - 1;
  assert.equal(tr.query({}).view, '-100,30,-90,40', 'unchanged inside 5 s');
  t += 1;
  assert.equal(tr.query({}).view, '0,0,10,10');
  const none = createFlightViewTracker({ boxOf: () => null });
  assert.deepEqual(none.query({}), {});
  assert.match(randomViewSid(), /^[A-Za-z0-9_-]{22}$/);
});

test('appendFlightView only adds well-formed params', () => {
  const p = new URLSearchParams();
  appendFlightView(p, { view: '-100,30,-90,40', vsid: 'tab-aaaaaaaa' });
  assert.equal(p.toString(), 'view=-100%2C30%2C-90%2C40&vsid=tab-aaaaaaaa');
  const q = new URLSearchParams();
  appendFlightView(q, { view: 'javascript:1', vsid: '<x>' });
  appendFlightView(q, {});
  appendFlightView(q, undefined);
  assert.equal(q.toString(), '');
  const r = new URLSearchParams();
  appendFlightView(r, { view: '1,2,3,4', vsid: 'bad id!' });
  assert.equal(r.toString(), 'view=1%2C2%2C3%2C4');
});

test('touch point: the flights source sends view + vsid with lat/lon', async () => {
  const seen = [];
  const source = createFlightSource({
    fetchImpl: async (url) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ time: 1, states: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  await source.getSnapshot({
    latitude: 30,
    longitude: -97,
    view: '-100,29,-95,33',
    vsid: 'tab-bbbbbbbb',
  });
  await source.getSnapshot({ latitude: 30, longitude: -97 });
  assert.equal(
    seen[0],
    '/api/flights?lat=30.0000&lon=-97.0000&view=-100%2C29%2C-95%2C33&vsid=tab-bbbbbbbb',
  );
  assert.equal(
    seen[1],
    '/api/flights?lat=30.0000&lon=-97.0000',
    'unchanged without a view',
  );
});

test('bridge lease: vsid or a hash of the view; invalid views create no demand', () => {
  const u = (q) => new URL(`http://x/?${q}`);
  assert.deepEqual(
    flightViewLease(u('view=-100,29,-95,33&vsid=tab-cccccccc')),
    {
      sid: 'tab-cccccccc',
      bbox: '-100,29,-95,33',
    },
  );
  const anon = flightViewLease(u('view=-100,29,-95,33'));
  assert.match(anon.sid, /^view-[0-9a-f]{8}$/);
  assert.equal(
    flightViewLease(u('view=-100,29,-95,33')).sid,
    anon.sid,
    'stable',
  );
  for (const bad of [
    '',
    'view=1,2,3',
    'view=-181,0,0,1',
    'view=0,10,5,5',
    'view=a,b,c,d',
    'lat=1&lon=2',
  ])
    assert.equal(flightViewLease(u(bad)), null, bad);
});
