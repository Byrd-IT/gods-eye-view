import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DAYLIGHT_PLANETS,
  MIN_DISC_PX,
  bodiesModel,
  drawBodies,
  moonPhasePolygon,
  planetRadius,
  planetVisible,
  screenDirectionTowards,
} from './bodyLayer.js';
import { skyEphemeris } from './ephemeris.js';
import { enuFromAzEl, makeView } from './skyMath.js';
import { makeProjector } from './starLayer.js';

const HOUSTON = { latDeg: 29.7604, lonDeg: -95.3698, heightM: 16.7 };

const shoelace = (pts) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
};

test('Moon phase outline: lit area = k * pi * r^2, bright limb on +x', () => {
  for (const k of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
    const pts = moonPhasePolygon(k, 50, 400);
    const area = shoelace(pts);
    assert.ok(
      Math.abs(area - k * Math.PI * 2500) < 2500 * 0.002,
      `k ${k} area ${area}`,
    );
  }
  const crescent = moonPhasePolygon(0.2, 10);
  assert.ok(
    crescent.every((p) => p.x >= -1e-9),
    'crescent on the bright side',
  );
});

test('daylight rules: Sun, Moon, Venus and Jupiter only; Uranus/Neptune need the telescopic switch', () => {
  const p = (name, magnitude, telescopic = false) => ({
    name,
    magnitude,
    telescopic,
  });
  const day = { sunAltDeg: 20, lim: -4 };
  assert.deepEqual(DAYLIGHT_PLANETS, ['Venus', 'Jupiter']);
  assert.equal(planetVisible(p('Venus', -4.2), day), true);
  assert.equal(planetVisible(p('Jupiter', -2.0), day), true);
  assert.equal(planetVisible(p('Mars', -2.5), day), false);
  assert.equal(planetVisible(p('Saturn', 0.5), day), false);
  assert.equal(planetVisible(p('Mercury', -1), day), false);
  const night = { sunAltDeg: -30, lim: 6.5 };
  assert.equal(planetVisible(p('Saturn', 0.5), night), true);
  assert.equal(
    planetVisible(p('Mars', 1.4), { sunAltDeg: -3, lim: -1.5 }),
    false,
  );
  assert.equal(planetVisible(p('Uranus', 5.7, true), night), false);
  assert.equal(
    planetVisible(p('Uranus', 5.7, true), { ...night, telescopic: true }),
    true,
  );
  assert.equal(
    planetVisible(p('Neptune', 7.8, true), { ...day, telescopic: true }),
    false,
  );
  assert.equal(planetRadius(-4), 6);
  assert.equal(planetRadius(7.8), 2.5);
});

test('bright limb direction on screen points at the Sun', () => {
  const view = makeView({ azDeg: 180, elDeg: 30, fovDeg: 60 });
  const project = makeProjector(view, 1000, 800);
  const moon = enuFromAzEl(180, 30);
  // Sun to the right (west of south = larger azimuth) -> +x
  const right = screenDirectionTowards(moon, enuFromAzEl(230, 30), project);
  assert.ok(Math.abs(Math.cos(right) - 1) < 0.05, `right ${right}`);
  // Sun below -> +y (canvas down)
  const below = screenDirectionTowards(moon, enuFromAzEl(180, -20), project);
  assert.ok(Math.abs(below - Math.PI / 2) < 0.05, `below ${below}`);
});

test('Sun and Moon: true angular size, never under 14 px; Moon phase from the ephemeris', () => {
  // First hour after 2026-10-20 with the Moon high in a dark sky (waxing).
  let eph = null;
  for (let h = 0; h < 24 * 12 && !eph; h++) {
    const e = skyEphemeris(
      Date.parse('2026-10-20T00:00:00Z') + h * 3600_000,
      HOUSTON,
      { refraction: true },
    );
    if (e.moon.elDeg > 20 && e.sun.elDeg < -20) eph = e;
  }
  assert.ok(eph, 'found a night with the Moon up');
  const wide = makeView({
    azDeg: eph.moon.azDeg,
    elDeg: eph.moon.elDeg,
    fovDeg: 100,
  });
  const narrow = makeView({ ...wide, fovDeg: 5 });
  const opts = { width: 1280, height: 800, sunAltDeg: eph.sun.elDeg, lim: 6.5 };
  const moonWide = bodiesModel(eph, { ...opts, view: wide }).find(
    (b) => b.kind === 'moon',
  );
  assert.equal(moonWide.r, MIN_DISC_PX / 2);
  assert.ok(Math.abs(moonWide.x - 640) < 1 && Math.abs(moonWide.y - 400) < 1);
  const moonNarrow = bodiesModel(eph, { ...opts, view: narrow }).find(
    (b) => b.kind === 'moon',
  );
  const pxPerDeg = makeProjector(narrow, 1280, 800).pxPerDeg;
  assert.ok(
    Math.abs(moonNarrow.r - (eph.moon.angularDiameterDeg * pxPerDeg) / 2) <
      1e-6,
  );
  assert.ok(moonNarrow.r > 50, `true size at fov 5: r ${moonNarrow.r}`);
  assert.equal(moonNarrow.phase.fraction, eph.moon.illuminatedFraction);
  // The Sun is below the horizon at this instant: not drawn.
  assert.equal(
    bodiesModel(eph, {
      ...opts,
      view: makeView({ azDeg: eph.sun.azDeg, elDeg: 0, fovDeg: 100 }),
    }).some((b) => b.kind === 'sun'),
    false,
  );
});

test('daylight model draws the Sun but no faint planet; planets off -> nothing', () => {
  const ms = Date.parse('2026-10-11T18:00:00Z'); // 13:00 CDT
  const eph = skyEphemeris(ms, HOUSTON, { refraction: true });
  assert.ok(eph.sun.elDeg > 30);
  const names = new Set();
  for (let az = 0; az < 360; az += 45)
    for (const b of bodiesModel(eph, {
      view: makeView({ azDeg: az, elDeg: 45, fovDeg: 100 }),
      width: 1280,
      height: 800,
      sunAltDeg: eph.sun.elDeg,
      lim: -4,
      telescopic: true,
    }))
      names.add(b.name);
  assert.ok(names.has('Sun'));
  for (const name of names)
    assert.ok(['Sun', 'Moon', 'Venus', 'Jupiter'].includes(name), name);
  const calls = [];
  const ctx = new Proxy(
    {},
    {
      get: (t, k) => (k in t ? t[k] : (...a) => calls.push(k)),
      set: (t, k, v) => ((t[k] = v), true),
    },
  );
  assert.equal(drawBodies(ctx, []), 0);
  assert.equal(calls.filter((k) => k === 'fill').length, 0);
  assert.deepEqual(bodiesModel(null, {}), []);
});
