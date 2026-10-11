import assert from 'node:assert/strict';
import test from 'node:test';
import { azDelta, drawOverlay, overlayModel } from './overlay.js';
import { makeView } from './skyMath.js';

const W = 1200;
const H = 800;

test('looking north at the horizon: N label at the screen centre on the horizon line', () => {
  const model = overlayModel({
    view: makeView({ azDeg: 0, elDeg: 0, fovDeg: 100 }),
    width: W,
    height: H,
  });
  const n = model.cardinals.find((c) => c.label === 'N');
  assert.ok(Math.abs(n.x - W / 2) < 1e-6);
  assert.ok(Math.abs(n.y - H / 2) < 1e-6);
  const labels = model.cardinals.map((c) => c.label).sort();
  assert.deepEqual(labels, ['N', 'NE', 'NW']);
  assert.ok(
    model.cardinals.find((c) => c.label === 'NE').x > W / 2,
    'east is to the right',
  );
  assert.ok(model.horizon.length > 10);
  assert.equal(model.ground, null, 'real horizon: no painted ground');
});

test('looking up, the horizon leaves the view and only the compass strip remains', () => {
  const model = overlayModel({
    view: makeView({ azDeg: 90, elDeg: 80, fovDeg: 60 }),
    width: W,
    height: H,
  });
  assert.equal(model.cardinals.length, 0);
  assert.ok(model.compass.length > 0);
  const centre = model.compass.reduce((best, t) =>
    Math.abs(t.x - W / 2) < Math.abs(best.x - W / 2) ? t : best,
  );
  assert.equal(centre.azDeg, 90);
  assert.equal(centre.label, 'E');
});

test('flat horizon paints the ground below the horizon and a sky gradient until nautical dusk', () => {
  const day = overlayModel({
    view: makeView({ azDeg: 180, elDeg: 10, fovDeg: 70 }),
    width: W,
    height: H,
    flatHorizon: true,
    sunAltDeg: 30,
  });
  assert.ok(day.ground.length > 4);
  assert.ok(
    day.horizon.every((p) => p.y > H / 2),
    'horizon below centre when looking up 10 deg',
  );
  assert.equal(day.gradient.alpha, 0.92);
  const night = overlayModel({
    view: makeView({ elDeg: 10 }),
    width: W,
    height: H,
    flatHorizon: true,
    sunAltDeg: -30,
  });
  assert.equal(night.gradient, null, 'night: the skybox shows instead');
  const realDusk = overlayModel({
    view: makeView({ elDeg: 10 }),
    width: W,
    height: H,
    sunAltDeg: -4,
  });
  assert.ok(realDusk.wash.alpha > 0);
  assert.equal(realDusk.gradient, null);
});

test('alt/az grid only when asked', () => {
  const view = makeView({ azDeg: 45, elDeg: 40, fovDeg: 90 });
  assert.equal(overlayModel({ view, width: W, height: H }).grid.length, 0);
  const grid = overlayModel({ view, width: W, height: H, grid: true }).grid;
  assert.ok(grid.some((l) => l.kind === 'alt' && l.value === 45));
  assert.ok(grid.some((l) => l.kind === 'az' && l.value === 30));
});

test('compass strip ticks are in order and cover the horizontal fov', () => {
  const model = overlayModel({
    view: makeView({ azDeg: 350, elDeg: 0, fovDeg: 60 }),
    width: W,
    height: H,
  });
  const xs = model.compass.map((t) => t.x);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] > xs[i - 1]);
  assert.ok(model.compass.some((t) => t.label === 'N'));
  assert.equal(azDelta(10, 350), 20);
  assert.equal(azDelta(350, 10), -20);
});

test('drawOverlay paints without throwing on a recording context', () => {
  const calls = [];
  const ctx = new Proxy(
    {},
    {
      get: (target, key) =>
        key in target
          ? target[key]
          : key === 'createLinearGradient'
            ? () => ({ addColorStop: () => {} })
            : (...args) => calls.push([key, args.length]),
      set: (target, key, value) => {
        target[key] = value;
        return true;
      },
    },
  );
  const model = overlayModel({
    view: makeView({ elDeg: 5 }),
    width: W,
    height: H,
    flatHorizon: true,
    grid: true,
    sunAltDeg: -3,
  });
  drawOverlay(ctx, model, { width: W, height: H });
  assert.ok(calls.some(([k]) => k === 'fillText'));
  assert.equal(calls[0][0], 'clearRect');
});
