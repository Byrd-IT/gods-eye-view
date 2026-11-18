// Grey drawing at the draw port (B12f on upstream's renderer seam #1760).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GREY_ALPHA,
  GREY_SET_LAYERS,
  MODE_CLEARED,
  MODE_LIVE,
  createGreyPainter,
  greyColor,
  greyControlOf,
  greyDrawPort,
  greyItem,
  greyLayerOfSet,
} from './greyPainter.js';
import {
  LIVE_DRAW_FEEDS,
  MODE_GREY,
  createLiveFeedDraw,
} from './liveFeedDraw.js';
import { FEED_STATE_EVENT } from './feedChips.js';
import { fakeWindow } from './fakeDom.mjs';
import { fakeDrawPort } from '../../testSupport/fakeDrawPort.mjs';

const RED = [1, 0, 0, 1];
const src = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

/** A wrapped fake port and its records; `modes` decides each layer's mode. */
function setup(modes = new Map()) {
  const raw = fakeDrawPort();
  const port = greyDrawPort(raw);
  const control = greyControlOf(port);
  control.setModeOf((layerId) => modes.get(layerId) ?? MODE_LIVE);
  const record = (id) => raw.sets.get(id);
  return { raw, port, control, modes, record };
}

const isGrey = ([r, g, b]) => r === g && g === b;

test('greyColor: grey of the same kind, faded to the flights stale alpha', () => {
  const [r, g, b, a] = greyColor(RED);
  assert.ok(isGrey([r, g, b]));
  assert.equal(a, GREY_ALPHA);
  assert.match(greyColor('#ff0000'), /^rgba\((\d+), \1, \1, 0\.45\)$/);
  assert.match(greyColor('rgba(0, 0, 255, 0.5)'), /, 0\.225\)$/);
  // an unread colour still greys (mid grey), never throws
  assert.match(greyColor('hsl(10 50% 50%)'), /^rgba\(\d+, \d+, \d+, 0\.45\)$/);
  // white (an icon's default tint) greys too
  assert.match(greyColor(undefined), /^rgba\((\d+), \1, \1, 0\.45\)$/);
});

test('every live-draw feed layer has its draw sets on the grey list', () => {
  const listed = new Set(GREY_SET_LAYERS.map((entry) => entry.layerId));
  for (const { layerId } of Object.values(LIVE_DRAW_FEEDS))
    assert.ok(listed.has(layerId), layerId);
  // only satellites (no empty answer clears them) hide instead of greying
  assert.deepEqual(
    GREY_SET_LAYERS.filter((e) => e.hideWhenCleared).map((e) => e.layerId),
    ['satellites'],
  );
});

test('the grey prefixes are the ids upstream layers give their draw sets', () => {
  const uses = [
    ['../../data/aircraftIconLayer.js', '${layerId}-icons:', 'flights-'],
    ['../../data/aircraftModelLayer.js', '${setPrefix}-models:', 'flights-'],
    ['../../layers/flights/rendering.js', "setPrefix: 'flights'", 'flights-'],
    [
      '../../layers/military/rendering.js',
      "setPrefix: 'military'",
      'military-',
    ],
    ['../../layers/vessels/rendering.js', 'ais-vessels:${', 'ais-vessels:'],
    [
      '../../layers/firms/lifecycle.js',
      "FIRMS_CELL_SET_PREFIX = 'firms'",
      'firms:',
    ],
    ['../../layers/firms/rendering.js', 'firms:${', 'firms:'],
    [
      '../../layers/perimeters/index.js',
      "PERIMETER_SET_PREFIX = 'fire-perimeters'",
      'fire-perimeters:',
    ],
    [
      '../../layers/cyclones/rendering.js',
      "CYCLONE_SET_PREFIX = 'weather-cyclones'",
      'weather-cyclones:',
    ],
    [
      '../../layers/launches/rendering.js',
      'rocket-launches:${',
      'rocket-launches:',
    ],
    ['../../layers/transit/rendering.js', 'transit:${', 'transit:'],
    [
      '../../layers/bikeshare/rendering.js',
      "BIKESHARE_SET_ID = 'bikeshare'",
      'bikeshare:',
    ],
    ['../../layers/satellites/rendering.js', 'satellites:${', 'satellites:'],
  ];
  for (const [file, literal, prefix] of uses) {
    assert.ok(src(file).includes(literal), `${file} no longer has ${literal}`);
    assert.ok(
      GREY_SET_LAYERS.some((entry) => entry.prefix === prefix),
      prefix,
    );
  }
  assert.equal(greyLayerOfSet('flights-icons:3').layerId, 'flights');
  assert.equal(greyLayerOfSet('flights-tracked-model:1').layerId, 'flights');
  assert.equal(greyLayerOfSet('ais-vessels:2').layerId, 'ais-live-vessels');
  assert.equal(greyLayerOfSet('firms:1:cells').layerId, 'local-firms');
  assert.equal(greyLayerOfSet('gev-trail:x'), null);
  assert.equal(greyLayerOfSet('earthquakes:1:points'), null);
});

test('the renderer hands layers the grey-wrapped draw port (one fork line)', () => {
  const app = src('../../render/cesium/appRenderer.js');
  assert.match(app, /draw: greyDrawPort\(ports\.draw\),/);
  assert.match(
    app,
    /import \{ greyDrawPort \} from '\.\.\/\.\.\/byrdit\/historyUi\/greyPainter\.js';/,
  );
  // and the painter itself stays Cesium-free and clock-free
  const own = src('./greyPainter.js');
  assert.doesNotMatch(own, /from 'cesium'|import\('cesium'\)/);
});

test('a grey layer is drawn grey; live again gives back its own items', () => {
  const { port, control, modes, record } = setup();
  const icons = port.icons({ id: 'flights-icons:1' });
  icons.set([
    { id: 'a', color: RED, position: { x: 1, y: 2, z: 3 } },
    { id: 'b', position: { x: 4, y: 5, z: 6 } },
  ]);
  assert.deepEqual(record('flights-icons:1').items.get('a').color, RED);

  modes.set('flights', MODE_GREY);
  control.changed();
  const a = record('flights-icons:1').items.get('a');
  assert.ok(isGrey(a.color));
  assert.equal(a.color[3], GREY_ALPHA);
  assert.deepEqual(a.position, { x: 1, y: 2, z: 3 }, 'only the colour');
  assert.match(record('flights-icons:1').items.get('b').color, /^rgba/);

  // what the layer writes while grey draws grey; the layer's item is unchanged
  const own = { id: 'c', color: RED };
  icons.upsert([own]);
  assert.ok(isGrey(record('flights-icons:1').items.get('c').color));
  assert.deepEqual(own.color, RED);
  icons.remove(['b']);
  assert.equal(record('flights-icons:1').items.has('b'), false);

  modes.set('flights', MODE_LIVE);
  control.changed();
  assert.deepEqual(record('flights-icons:1').items.get('a').color, RED);
  assert.deepEqual(record('flights-icons:1').items.get('c').color, RED);
  assert.equal(record('flights-icons:1').items.has('b'), false);
});

test('sets of other layers and fork sets are never touched', () => {
  const modes = new Map([
    ['flights', MODE_GREY],
    ['earthquakes', MODE_GREY],
  ]);
  const { raw, port } = setup(modes);
  const quakes = port.points({ id: 'earthquakes:1:points' });
  quakes.set([{ id: 'q', color: RED }]);
  assert.deepEqual(
    raw.sets.get('earthquakes:1:points').items.get('q').color,
    RED,
  );
  const trail = port.lines({ id: 'gev-trail:flights:x' });
  trail.set([{ id: 't', style: { kind: 'solid', color: RED } }]);
  assert.deepEqual(
    raw.sets.get('gev-trail:flights:x').items.get('t').style.color,
    RED,
  );
});

test('lines, shapes, points and models: every colour field greyed', () => {
  const lines = greyItem('lines', {
    id: 'l',
    style: { kind: 'split', color: RED, behind: RED },
    depthFail: { kind: 'solid', color: RED },
    segmentColors: [RED, '#00ff00'],
  });
  assert.ok(isGrey(lines.style.color));
  assert.ok(isGrey(lines.style.behind));
  assert.ok(isGrey(lines.depthFail.color));
  assert.ok(isGrey(lines.segmentColors[0]));
  assert.match(lines.segmentColors[1], /^rgba\((\d+), \1, \1/);
  const shape = greyItem('shapes', {
    id: 's',
    fill: '#ff000080',
    outline: RED,
  });
  assert.match(shape.fill, /^rgba\((\d+), \1, \1/);
  assert.ok(isGrey(shape.outline));
  const imageFill = { image: 'x.png' };
  assert.equal(
    greyItem('shapes', { id: 's', fill: imageFill }).fill,
    imageFill,
  );
  const point = greyItem('points', { id: 'p', color: RED, outlineColor: RED });
  assert.ok(isGrey(point.color) && isGrey(point.outlineColor));
  const model = greyItem('models', { id: 'm', tint: RED });
  assert.ok(isGrey(model.tint));
  assert.deepEqual(model.colorBlend, { mode: 'mix', amount: 0.85 });
});

test('packed column colours grey while grey, and come back', () => {
  const modes = new Map();
  const raw = fakeDrawPort();
  const drawn = [];
  const base = raw.icons;
  raw.icons = (spec) => {
    const set = base(spec);
    set.setColumns = (cols) => drawn.push(cols);
    return set;
  };
  const port = greyDrawPort(raw);
  const control = greyControlOf(port);
  control.setModeOf((id) => modes.get(id) ?? MODE_LIVE);
  const set = port.icons({ id: 'ais-vessels:1' });
  const colors = new Uint8Array([255, 0, 0, 200]);
  set.setColumns({ ids: ['v'], colors, dirty: [{ start: 0, end: 1 }] });
  assert.equal(drawn.at(-1).colors, colors);
  modes.set('ais-live-vessels', MODE_GREY);
  control.changed();
  const grey = drawn.at(-1).colors;
  assert.equal(grey[0], grey[1]);
  assert.equal(grey[1], grey[2]);
  assert.equal(grey[3], Math.round(200 * GREY_ALPHA));
  assert.equal(drawn.at(-1).dirty, undefined, 'all rows rewritten');
  assert.deepEqual([...colors], [255, 0, 0, 200], "the layer's own columns");
  modes.set('ais-live-vessels', MODE_LIVE);
  control.changed();
  assert.equal(drawn.at(-1).colors, colors);
});

test('satellites: grey while grey, hidden while cleared, own show back when live', () => {
  const { port, control, modes, record } = setup();
  const points = port.points({ id: 'satellites:1:points' });
  points.set([{ id: '25544', color: RED }]);
  modes.set('satellites', MODE_GREY);
  control.changed();
  assert.ok(isGrey(record('satellites:1:points').items.get('25544').color));
  assert.equal(record('satellites:1:points').show, true);

  modes.set('satellites', MODE_CLEARED);
  control.changed();
  assert.equal(record('satellites:1:points').show, false);
  // the layer hides itself meanwhile: kept, and given back when live
  points.show = false;
  assert.equal(points.show, false);
  points.show = true;
  assert.equal(record('satellites:1:points').show, false, 'still cleared');

  modes.set('satellites', MODE_LIVE);
  control.changed();
  assert.equal(record('satellites:1:points').show, true);
  assert.deepEqual(record('satellites:1:points').items.get('25544').color, RED);
});

test('a cleared layer that is not satellites is greyed, not hidden', () => {
  const { port, control, modes, record } = setup();
  port.shapes({ id: 'fire-perimeters:1:fills' }).set([{ id: 'f', fill: RED }]);
  modes.set('fire-perimeters', MODE_CLEARED);
  control.changed();
  assert.equal(record('fire-perimeters:1:fills').show, true);
  assert.ok(isGrey(record('fire-perimeters:1:fills').items.get('f').fill));
});

test('a set made while its layer is grey draws grey from its first write', () => {
  const { port, modes, record } = setup(new Map([['transit', MODE_GREY]]));
  port.icons({ id: 'transit:1:still' }).set([{ id: 's', color: RED }]);
  assert.ok(isGrey(record('transit:1:still').items.get('s').color));
});

test('a disposed set is dropped; a repaint never writes to it', () => {
  const { port, control, modes } = setup();
  const set = port.points({ id: 'bikeshare:1:stations' });
  set.set([{ id: 'x', color: RED }]);
  set.dispose();
  modes.set('bikeshare', MODE_GREY);
  assert.doesNotThrow(() => control.changed());
  assert.deepEqual(control.setsByLayer(), {});
});

test('via the gate: grey feed state greys, a swapped layer is never greyed', () => {
  const win = fakeWindow('http://gev.test/', async () => new Response('{}'));
  const swapped = new Set();
  const gate = createLiveFeedDraw({
    target: win,
    getRouter: () => ({ isSwapped: (id) => swapped.has(id) }),
  });
  gate.install();
  const raw = fakeDrawPort();
  const port = greyDrawPort(raw);
  const control = greyControlOf(port);
  let frames = 0;
  const painter = createGreyPainter({
    modeOf: (id) => gate.paintModeOf(id),
    control,
    requestFrame: () => (frames += 1),
  });
  painter.start();
  gate.subscribe(() => painter.changed());
  port.icons({ id: 'military-icons:1' }).set([{ id: 'm', color: RED }]);

  win.dispatchEvent({
    type: FEED_STATE_EVENT,
    detail: { feed: 'military', state: 'grey', draw: true },
  });
  assert.ok(frames >= 2, 'a frame is asked');
  assert.ok(isGrey(raw.sets.get('military-icons:1').items.get('m').color));

  swapped.add('military'); // history shows the recording: own colours
  painter.changed();
  assert.deepEqual(raw.sets.get('military-icons:1').items.get('m').color, RED);

  swapped.delete('military');
  painter.changed();
  assert.ok(isGrey(raw.sets.get('military-icons:1').items.get('m').color));
  painter.destroy(); // the history shell goes: everything live again
  assert.deepEqual(raw.sets.get('military-icons:1').items.get('m').color, RED);
  gate.destroy();
});

test('wrapping is once per port; the wrapper keeps the port API', () => {
  const raw = fakeDrawPort();
  const port = greyDrawPort(raw);
  assert.equal(greyDrawPort(port), port);
  assert.equal(greyDrawPort(raw), port, 'a raw port is wrapped once');
  assert.equal(typeof port.clampState, 'function');
  assert.equal(port.clampState(), raw.clampState());
  assert.equal(greyControlOf(port), greyControlOf(raw));
});
