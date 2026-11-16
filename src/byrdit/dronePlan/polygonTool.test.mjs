import assert from 'node:assert/strict';
import test from 'node:test';
import {
  pointerOwner,
  resetPointerOwnership,
} from '../../data/inputOwnership.js';
import { boxToolFakes } from '../../layers/recentImagery/testDoubles.mjs';
import {
  POLYGON_CLOSE_PX,
  POLYGON_POINTER_OWNER,
  initPolygonTool,
} from './polygonTool.js';

// The shared fake Cesium has no point entities or callback properties; add
// what the corner dots and the rubber band need.
function drawingCesium(base) {
  return {
    ...base,
    Cartesian3: {
      ...base.Cartesian3,
      fromDegrees: (lon, lat) => ({ lon, lat }),
    },
    HeightReference: { CLAMP_TO_GROUND: 'clamp' },
    Color: {
      fromCssColorString: (css) => ({
        css,
        withAlpha: (alpha) => ({ css, alpha }),
      }),
    },
    CallbackProperty: class {
      constructor(read) {
        this.read = read;
      }
    },
  };
}

function fixture(onRing = () => true, { project } = {}) {
  resetPointerOwnership();
  const fakes = boxToolFakes();
  const rings = [];
  const cancels = [];
  const changes = [];
  const tool = initPolygonTool({
    viewer: fakes.viewer,
    cesium: drawingCesium(fakes.cesium),
    pickWorld: fakes.pickWorld,
    documentRef: fakes.documentRef,
    ...(project ? { project } : {}),
    onRing: (ring) => {
      rings.push(ring);
      return onRing(ring);
    },
    onCancel: (reason) => cancels.push(reason),
    onChange: (state) => changes.push(state),
  });
  const stock = (type) =>
    fakes.viewer.screenSpaceEventHandler.getInputAction(fakes.types[type]);
  const click = (x, y) => fakes.fire('LEFT_CLICK', { position: { x, y } });
  const move = (x, y) =>
    fakes.fire('MOUSE_MOVE', { endPosition: { x, y } });
  /** The preview data source's entities, or [] when none is attached. */
  const entities = () => fakes.viewer.dataSources.sources[0]?.entities.values ?? [];
  const dots = () => entities().filter((e) => e.point);
  const lines = () => entities().filter((e) => e.polyline);
  return {
    ...fakes,
    tool,
    rings,
    cancels,
    changes,
    stock,
    click,
    move,
    entities,
    dots,
    lines,
  };
}

// A canvas pixel is where the fake pickWorld would find that lon/lat; a
// camera pan shifts every projected point by the same number of pixels.
function panned(pan) {
  return (_viewer, lon, lat) => ({
    x: ((lon + 97.9) / 0.2) * 1000 + pan.dx,
    y: ((30.4 - lat) / 0.2) * 500 + pan.dy,
  });
}

test('clicks add corners, Backspace removes the last, Escape gives the pointer back', () => {
  const f = fixture();
  assert.equal(f.tool.start(), true);
  assert.equal(pointerOwner(), POLYGON_POINTER_OWNER);
  assert.equal(f.stock('LEFT_CLICK'), undefined);
  f.click(200, 200);
  f.click(400, 200);
  f.click(400, 350);
  assert.equal(f.tool.vertexCount(), 3);
  assert.equal(f.key('Backspace').prevented, true);
  assert.equal(f.tool.vertexCount(), 2);
  assert.equal(f.key('Escape').prevented, true);
  assert.equal(f.tool.isActive(), false);
  assert.equal(pointerOwner(), null);
  assert.equal(f.stock('LEFT_CLICK'), f.originalClick);
  assert.deepEqual(f.cancels, ['escape']);
  assert.equal(f.rings.length, 0);
});

test('a double-click closes a polygon and returns the pointer', () => {
  const f = fixture();
  f.tool.start();
  f.click(200, 200);
  f.click(500, 200);
  f.click(500, 360);
  // The click that starts the double-click adds a corner, then the double-click
  // removes that corner and closes.
  f.click(360, 280);
  f.fire('LEFT_DOUBLE_CLICK', { position: { x: 360, y: 280 } });
  assert.equal(f.rings.length, 1);
  assert.equal(f.rings[0].length, 3);
  assert.equal(f.tool.isActive(), false);
  assert.equal(pointerOwner(), null);
});

test('clicking the first corner closes without adding another point', () => {
  const f = fixture();
  f.tool.start();
  f.click(200, 200);
  f.click(500, 200);
  f.click(500, 360);
  f.click(204, 204);
  assert.equal(f.rings.length, 1);
  assert.equal(f.rings[0].length, 3);
  assert.equal(f.tool.isActive(), false);
});

test('a rejected ring stays open so the last corner can be removed', () => {
  const f = fixture(() => false);
  f.tool.start();
  f.click(200, 200);
  f.click(500, 200);
  f.click(500, 360);
  f.click(204, 204);
  assert.equal(f.rings.length, 1);
  assert.equal(f.tool.isActive(), true);
  assert.equal(f.tool.vertexCount(), 3);
  f.tool.destroy();
  assert.equal(pointerOwner(), null);
});

const triangle = (f) => {
  f.click(200, 200);
  f.click(500, 200);
  f.click(500, 360);
};

test('finish() closes with 3 corners, and does nothing with fewer', () => {
  const f = fixture();
  f.tool.start();
  f.click(200, 200);
  f.click(500, 200);
  assert.equal(f.tool.canFinish(), false);
  assert.equal(f.tool.finish(), false);
  assert.equal(f.rings.length, 0);
  assert.equal(f.tool.isActive(), true);
  f.click(500, 360);
  assert.equal(f.tool.canFinish(), true);
  assert.equal(f.tool.finish(), true);
  assert.equal(f.rings.length, 1);
  assert.equal(f.rings[0].length, 3);
  assert.equal(f.tool.isActive(), false);
  assert.equal(pointerOwner(), null);
  // Nothing to finish once the tool is idle.
  assert.equal(f.tool.finish(), false);
  assert.equal(f.tool.canFinish(), false);
});

test('a rejected finish() keeps the tool open with its corners', () => {
  const f = fixture(() => false);
  f.tool.start();
  triangle(f);
  assert.equal(f.tool.finish(), false);
  assert.equal(f.tool.isActive(), true);
  assert.equal(f.tool.vertexCount(), 3);
  f.tool.destroy();
});

test('Enter does nothing with fewer than 3 corners and closes with 3', () => {
  const f = fixture();
  f.tool.start();
  f.click(200, 200);
  f.click(500, 200);
  const early = f.key('Enter');
  // Consumed, so a focused DRAW POLYGON button does not also fire and cancel.
  assert.equal(early.prevented, true);
  assert.equal(f.rings.length, 0);
  assert.equal(f.tool.isActive(), true);
  assert.equal(f.tool.vertexCount(), 2);
  f.click(500, 360);
  const done = f.key('Enter');
  assert.equal(done.prevented, true);
  assert.equal(f.rings.length, 1);
  assert.equal(f.rings[0].length, 3);
  assert.equal(f.tool.isActive(), false);
  assert.equal(pointerOwner(), null);
});

test('Enter and Backspace are left alone while the user types in a field', () => {
  const f = fixture();
  f.tool.start();
  triangle(f);
  const typing = (key, tagName) => {
    const event = {
      key,
      target: { tagName, type: 'text' },
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
    };
    f.documentRef.listeners.find(([type]) => type === 'keydown')[1](event);
    return event;
  };
  assert.equal(typing('Enter', 'INPUT').prevented, false);
  assert.equal(typing('Backspace', 'INPUT').prevented, false);
  assert.equal(f.tool.vertexCount(), 3);
  assert.equal(f.tool.isActive(), true);
  assert.equal(typing('Enter', 'BUTTON').prevented, true);
  assert.equal(f.rings.length, 1);
});

test('undo() and Backspace remove the last corner and report the count', () => {
  const f = fixture();
  assert.equal(f.tool.undo(), false);
  f.tool.start();
  assert.equal(f.tool.undo(), false);
  triangle(f);
  assert.deepEqual(f.changes.at(-1), { count: 3, canFinish: true });
  assert.equal(f.tool.undo(), true);
  assert.deepEqual(f.changes.at(-1), { count: 2, canFinish: false });
  assert.equal(f.key('Backspace').prevented, true);
  assert.equal(f.tool.vertexCount(), 1);
  f.tool.undo();
  assert.equal(f.tool.vertexCount(), 0);
  assert.equal(f.tool.undo(), false);
  f.tool.cancel();
  assert.deepEqual(f.changes.at(-1), { count: 0, canFinish: false });
});

test('double-click and clicking the first corner still close', () => {
  const f = fixture();
  f.tool.start();
  triangle(f);
  // A real double-click is two clicks then the double-click event.
  f.click(360, 280);
  f.click(360, 280);
  f.fire('LEFT_DOUBLE_CLICK', { position: { x: 360, y: 280 } });
  assert.equal(f.rings.length, 1);
  assert.equal(f.rings[0].length, 4);
  f.tool.start();
  triangle(f);
  f.click(210, 190);
  assert.equal(f.rings.length, 2);
  assert.equal(f.rings[1].length, 3);
});

test('the first-corner close area is 24 px and follows the camera', () => {
  assert.equal(POLYGON_CLOSE_PX, 24);
  const pan = { dx: 0, dy: 0 };
  const f = fixture(() => true, { project: panned(pan) });
  f.tool.start();
  triangle(f);
  // 30 px away: outside the close area, so it adds a corner.
  f.click(230, 200);
  assert.equal(f.tool.vertexCount(), 4);
  f.tool.undo();
  // The camera pans 100 px right: the first corner is now drawn at (300, 200).
  pan.dx = 100;
  f.click(200, 200);
  assert.equal(
    f.tool.vertexCount(),
    4,
    'the old pixel is no longer the first corner',
  );
  f.tool.undo();
  f.click(320, 210);
  assert.equal(f.rings.length, 1);
  assert.equal(f.rings[0].length, 3);
  assert.equal(f.tool.isActive(), false);
});

test('every corner is a dot and the first is bigger and a different colour', () => {
  const f = fixture();
  f.tool.start();
  assert.equal(f.dots().length, 0);
  triangle(f);
  const dots = f.dots();
  assert.equal(dots.length, 3);
  assert.ok(dots[0].point.pixelSize > dots[1].point.pixelSize);
  assert.equal(dots[1].point.pixelSize, dots[2].point.pixelSize);
  assert.notEqual(dots[0].point.color.css, dots[1].point.color.css);
  assert.equal(dots[0].point.heightReference, 'clamp');
  assert.ok(dots[0].point.pixelSize >= 10);
  f.tool.undo();
  assert.equal(f.dots().length, 2);
});

test('a rubber band runs from the last corner to the cursor and goes with the tool', () => {
  const f = fixture();
  f.tool.start();
  f.click(200, 200);
  const band = () =>
    f
      .lines()
      .map((e) => e.polyline.positions)
      .find((p) => typeof p?.read === 'function');
  assert.ok(band());
  f.move(600, 250);
  const [lon, lat] = [-97.9 + 0.2 * 0.6, 30.4 - 0.2 * 0.5];
  const read = band().read();
  assert.equal(read.length, 4);
  assert.ok(Math.abs(read[0] - (-97.9 + 0.2 * 0.2)) < 1e-9);
  assert.ok(Math.abs(read[2] - lon) < 1e-9);
  assert.ok(Math.abs(read[3] - lat) < 1e-9);
  // Over the sky nothing moves it.
  f.move(600, 10);
  assert.ok(Math.abs(band().read()[2] - lon) < 1e-9);
  f.tool.cancel();
  assert.equal(f.handler(), null);
  f.move(100, 100);
});

test('a mouse move before any corner draws nothing', () => {
  const f = fixture();
  f.tool.start();
  f.move(300, 300);
  assert.equal(f.entities().length, 0);
  f.tool.destroy();
});

test('cancel and destroy remove the handler, listeners, class and data source', () => {
  for (const how of ['cancel', 'destroy']) {
    const f = fixture();
    f.tool.start();
    triangle(f);
    assert.equal(f.viewer.dataSources.sources.length, 1);
    assert.equal(f.documentRef.listeners.length, 1);
    assert.equal(f.documentRef.classes.size, 1);
    const live = f.handler();
    assert.ok(live);
    f.tool[how]();
    assert.equal(live.destroyed, true, how);
    assert.equal(f.handler(), null);
    assert.equal(f.viewer.dataSources.sources.length, 0, how);
    assert.equal(f.documentRef.listeners.length, 0, how);
    assert.equal(f.documentRef.classes.size, 0, how);
    assert.equal(pointerOwner(), null, how);
    assert.equal(f.stock('LEFT_CLICK'), f.originalClick, how);
    assert.equal(f.stock('LEFT_DOUBLE_CLICK'), f.originalDouble, how);
  }
});

test('finishing releases the preview as well', () => {
  const f = fixture();
  f.tool.start();
  triangle(f);
  f.tool.finish();
  assert.equal(f.viewer.dataSources.sources.length, 0);
  assert.equal(f.documentRef.listeners.length, 0);
  assert.equal(f.handler(), null);
});
