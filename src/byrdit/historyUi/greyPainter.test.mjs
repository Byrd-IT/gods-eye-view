import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  GREY_ALPHA,
  GREY_TARGETS,
  createGreyPainter,
  greyColor,
} from './greyPainter.js';
import { createLiveFeedDraw, MODE_GREY, MODE_LIVE } from './liveFeedDraw.js';
import { FEED_STATE_EVENT } from './feedChips.js';
import { ALL_HISTORY_ADAPTERS } from './historyEventAdapters.js';
import { fakeWindow } from './fakeDom.mjs';
import {
  registerSpriteCollection,
  spriteCollectionOf,
  unregisterSpriteCollection,
} from '../../data/spriteOrder.js';

const RED = Cesium.Color.RED;

function fakeViewer(dataSources = []) {
  const handlers = new Set();
  let renders = 0;
  return {
    clock: {
      currentTime: Cesium.JulianDate.fromIso8601('2026-10-16T12:00:00Z'),
    },
    dataSources: {
      getByName: (name) => dataSources.filter((d) => d.name === name),
    },
    scene: {
      preRender: {
        addEventListener(fn) {
          handlers.add(fn);
          return () => handlers.delete(fn);
        },
      },
      requestRender: () => renders++,
    },
    frame: () => [...handlers].forEach((fn) => fn()),
    handlers,
    get renders() {
      return renders;
    },
  };
}

/** A real billboard collection whose GPU update is stubbed. */
function billboards(colors) {
  const c = new Cesium.BillboardCollection();
  for (const color of colors)
    c.add({ position: Cesium.Cartesian3.fromDegrees(-97, 30), color });
  let updates = 0;
  c.update = () => updates++;
  return { c, updates: () => updates };
}

test('greyColor: desaturated, faded to the flights stale alpha', () => {
  const g = greyColor(RED);
  assert.equal(g.red, g.green);
  assert.equal(g.green, g.blue);
  assert.ok(Math.abs(g.alpha - GREY_ALPHA) < 1e-9);
  assert.ok(
    greyColor(Cesium.Color.WHITE).red > greyColor(Cesium.Color.BLACK).red,
  );
});

test('targets cover every swappable layer but satellites (chip only)', () => {
  const layers = new Set(ALL_HISTORY_ADAPTERS.map((a) => a.layerId));
  assert.deepEqual(new Set(Object.keys(GREY_TARGETS)), layers);
});

test('spriteCollectionOf reads the sprite registry (one-line touch point)', () => {
  const c = {};
  registerSpriteCollection('flights', c);
  assert.equal(spriteCollectionOf('flights'), c);
  unregisterSpriteCollection('flights', c);
  assert.equal(spriteCollectionOf('flights'), null);
});

test('a grey layer is greyed right before it draws, and restored when live', () => {
  let mode = MODE_LIVE;
  const { c, updates } = billboards([RED, Cesium.Color.YELLOW]);
  const viewer = fakeViewer();
  const painter = createGreyPainter({
    viewer,
    modeOf: (id) => (id === 'flights' ? mode : MODE_LIVE),
    collectionOf: (id) => (id === 'flights' ? c : null),
  });
  painter.start();
  viewer.frame(); // adopts the collection
  c.update({});
  assert.ok(Cesium.Color.equals(c.get(0).color, RED), 'live: untouched');
  mode = MODE_GREY;
  c.update({});
  const g = c.get(0).color;
  assert.equal(g.red, g.green);
  assert.ok(g.alpha < 0.5);
  assert.equal(updates(), 2, 'the original update still runs');
  // the layer sets its own colour while grey: greyed from the new colour
  c.get(1).color = Cesium.Color.BLUE;
  c.update({});
  assert.ok(Cesium.Color.equals(c.get(1).color, greyColor(Cesium.Color.BLUE)));
  mode = MODE_LIVE;
  c.update({});
  assert.ok(Cesium.Color.equals(c.get(0).color, RED));
  assert.ok(Cesium.Color.equals(c.get(1).color, Cesium.Color.BLUE));
  // a cleared layer stays grey until the emptied answer removed it
  mode = 'cleared';
  c.update({});
  assert.equal(Cesium.Color.equals(c.get(0).color, RED), false);
  painter.destroy();
  c.update({});
  assert.ok(Cesium.Color.equals(c.get(0).color, RED), 'destroy restores');
});

test('points: colour and outline greyed, restored', () => {
  let grey = true;
  const c = new Cesium.PointPrimitiveCollection();
  c.add({
    position: Cesium.Cartesian3.fromDegrees(0, 0),
    color: RED,
    outlineColor: Cesium.Color.YELLOW,
  });
  c.update = () => {};
  const painter = createGreyPainter({
    viewer: fakeViewer(),
    modeOf: () => (grey ? MODE_GREY : MODE_LIVE),
    collectionOf: (id) => (id === 'bikeshare' ? c : null),
  });
  painter.pass();
  c.update();
  const p = c.get(0);
  assert.equal(p.color.red, p.color.blue);
  assert.equal(p.outlineColor.red, p.outlineColor.blue);
  grey = false;
  c.update();
  assert.ok(Cesium.Color.equals(p.color, RED));
  assert.ok(Cesium.Color.equals(p.outlineColor, Cesium.Color.YELLOW));
});

test('entities of a named data source: grey constants, originals restored', () => {
  let grey = false;
  const ds = new Cesium.CustomDataSource('fire-perimeters');
  const poly = ds.entities.add({
    polygon: {
      hierarchy: Cesium.Cartesian3.fromDegreesArray([0, 0, 1, 0, 1, 1]),
      material: RED.withAlpha(0.5),
      outlineColor: Cesium.Color.ORANGE,
    },
  });
  const bb = ds.entities.add({ billboard: { image: 'x.png' } });
  const other = new Cesium.CustomDataSource('earthquakes');
  const quake = other.entities.add({ point: { color: RED } });
  const origMaterial = poly.polygon.material;
  const viewer = fakeViewer([ds, other]);
  const painter = createGreyPainter({
    viewer,
    modeOf: (id) => (grey && id === 'fire-perimeters' ? MODE_GREY : MODE_LIVE),
    collectionOf: () => null,
  });
  painter.start();
  grey = true;
  viewer.frame();
  const t = viewer.clock.currentTime;
  const m = poly.polygon.material.getValue(t).color;
  assert.equal(m.red, m.green);
  assert.ok(Math.abs(m.alpha - 0.5 * GREY_ALPHA) < 1e-6);
  assert.equal(
    bb.billboard.color.getValue(t).red,
    bb.billboard.color.getValue(t).blue,
  );
  assert.ok(
    Cesium.Color.equals(quake.point.color.getValue(t), RED),
    'other layer',
  );
  // an entity added while grey is greyed on the next frame
  const late = ds.entities.add({ point: { color: Cesium.Color.LIME } });
  viewer.frame();
  assert.equal(
    late.point.color.getValue(t).red,
    late.point.color.getValue(t).blue,
  );
  grey = false;
  viewer.frame();
  assert.equal(poly.polygon.material, origMaterial, 'the same property back');
  assert.equal(bb.billboard.color, undefined);
  assert.ok(
    Cesium.Color.equals(late.point.color.getValue(t), Cesium.Color.LIME),
  );
});

test('via the gate: grey feed state greys, a swapped layer is never greyed', () => {
  const win = fakeWindow('http://gev.test/', async () => new Response('{}'));
  const swapped = new Set();
  const gate = createLiveFeedDraw({
    target: win,
    getRouter: () => ({ isSwapped: (id) => swapped.has(id) }),
  });
  gate.install();
  const { c } = billboards([RED]);
  const viewer = fakeViewer();
  const painter = createGreyPainter({
    viewer,
    modeOf: (id) => gate.paintModeOf(id),
    collectionOf: (id) => (id === 'military' ? c : null),
  });
  gate.subscribe(() => painter.changed());
  win.dispatchEvent({
    type: FEED_STATE_EVENT,
    detail: { feed: 'military', state: 'grey', draw: true },
  });
  assert.ok(viewer.renders >= 1, 'a frame is asked');
  c.update({});
  assert.equal(c.get(0).color.red, c.get(0).color.blue);
  swapped.add('military'); // history shows the recording: own colours
  c.update({});
  assert.ok(Cesium.Color.equals(c.get(0).color, RED));
});

/** A Model stand-in (instanceof Cesium.Model; no glTF load in node). */
function model(id, color) {
  const m = Object.create(Cesium.Model.prototype);
  for (const [k, v] of Object.entries({
    id,
    color,
    show: true,
    colorBlendMode: Cesium.ColorBlendMode.HIGHLIGHT,
    colorBlendAmount: 0.5,
  }))
    Object.defineProperty(m, k, { value: v, writable: true, enumerable: true });
  return m;
}

test('the layer 3D models (same ids as its sprites) are greyed and restored', () => {
  let mode = MODE_GREY;
  const sprites = new Cesium.BillboardCollection();
  sprites.add({ id: 'a10001', position: Cesium.Cartesian3.fromDegrees(0, 0) });
  sprites.update = () => {};
  const models = new Cesium.PrimitiveCollection();
  const m = model('a10001', undefined);
  models.add(m);
  models.update = () => {};
  const foreign = new Cesium.PrimitiveCollection();
  const other = model('zz9999', RED);
  foreign.add(other);
  foreign.update = () => {};
  const viewer = fakeViewer();
  const top = [sprites, models, foreign];
  viewer.scene.primitives = { length: top.length, get: (i) => top[i] };
  const painter = createGreyPainter({
    viewer,
    modeOf: () => mode,
    collectionOf: (id) => (id === 'flights' ? sprites : null),
  });
  painter.pass();
  models.update({});
  foreign.update({});
  assert.equal(m.color.red, m.color.blue);
  assert.equal(m.colorBlendMode, Cesium.ColorBlendMode.MIX);
  assert.ok(Cesium.Color.equals(other.color, RED), 'another layer model');
  mode = MODE_LIVE;
  models.update({});
  assert.equal(m.color, undefined);
  assert.equal(m.colorBlendMode, Cesium.ColorBlendMode.HIGHLIGHT);
  assert.equal(m.colorBlendAmount, 0.5);
});
