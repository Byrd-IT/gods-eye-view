import test from 'node:test';
import assert from 'node:assert/strict';
import {
  claimPointer,
  pointerOwner,
  releasePointer,
  resetPointerOwnership,
} from '../data/inputOwnership.js';
import {
  IMAGERY_BOX_POINTER_OWNER,
  initImageryBoxTool,
} from './imageryBoxTool.js';
import { boxToolFakes } from '../layers/recentImagery/testDoubles.mjs';
import { createImageryBoxPreview } from '../layers/recentImagery/rendering.js';
import { fakeDrawPort } from '../testSupport/fakeDrawPort.mjs';

function fixture(options = {}) {
  resetPointerOwnership();
  const fakes = boxToolFakes();
  const draw = fakeDrawPort();
  const boxes = [];
  const cancels = [];
  const actives = [];
  const tool = initImageryBoxTool({
    viewer: fakes.viewer,
    createPreview: (viewer, dragBox) =>
      createImageryBoxPreview(viewer, dragBox, { draw }),
    pickWorld: fakes.pickWorld,
    documentRef: fakes.documentRef,
    onBox: (box) => boxes.push(box),
    onCancel: (reason, message) => cancels.push([reason, message]),
    onActive: (active) => actives.push(active),
    ...options,
  });
  const camera = fakes.viewer.scene.screenSpaceCameraController;
  // The stock action as it runs now: the input port holds them, so it is
  // the original while not suppressed, and none while it is.
  const stockAction = (type) =>
    fakes.stockEnabled(type === 'LEFT_CLICK' ? 'select' : 'dblclickFollow')
      ? type === 'LEFT_CLICK'
        ? fakes.originalClick
        : fakes.originalDouble
      : undefined;
  // The preview's fill or outline set, while it is live.
  const previewSet = (part) =>
    [...draw.sets.values()].find(
      (r) =>
        !r.disposed &&
        r.spec.id.startsWith('recent-imagery-box:') &&
        r.spec.id.endsWith(`:${part}`),
    );
  // Whether the box shows: its fill and its outline, drawn and shown.
  const preview = () =>
    ['fill', 'outline'].every((part) => {
      const set = previewSet(part);
      return (
        Boolean(set?.items.size) &&
        [...set.items.values()].every((item) => item.show !== false)
      );
    });
  return {
    ...fakes,
    draw,
    previewSet,
    tool,
    boxes,
    cancels,
    actives,
    camera,
    stockAction,
    preview,
  };
}

test('a session claims the pointer, borrows the stock clicks, freezes the camera only mid-drag and returns everything with the box', async () => {
  const f = fixture();
  assert.equal(f.tool.start(), true);
  assert.equal(pointerOwner(), IMAGERY_BOX_POINTER_OWNER);
  assert.equal(f.stockAction('LEFT_CLICK'), undefined);
  assert.equal(f.stockAction('LEFT_DOUBLE_CLICK'), undefined);
  assert.ok(f.documentRef.classes.has('gev-imagery-box'));
  assert.equal(f.camera.enableInputs, true, 'not frozen before the press');
  f.fire('LEFT_DOWN', { position: { x: 250, y: 125 } });
  assert.equal(f.camera.enableInputs, false);
  assert.equal(f.preview(), false, 'a press alone has no box to draw');
  f.fire('MOUSE_MOVE', { endPosition: { x: 500, y: 250 } });
  assert.equal(f.preview(), true, 'the box shows as it is dragged');
  const rect = () => f.previewSet('fill').items.get('box').geometry.rect;
  assert.deepEqual(
    Object.values(rect()).map((v) => Math.round(v * 1e6) / 1e6),
    [-97.85, 30.3, -97.8, 30.35],
  );
  assert.equal(f.previewSet('outline').items.get('edge').style.kind, 'dash');
  assert.equal(f.previewSet('outline').items.get('edge').mode, 'draped');
  f.fire('MOUSE_MOVE', { endPosition: { x: 500, y: 10 } }); // sky: ignored
  f.fire('LEFT_UP', { position: { x: 500, y: 250 } });
  assert.equal(f.boxes.length, 1);
  const { west, south, east, north } = f.boxes[0];
  assert.deepEqual(
    [west, south, east, north].map((v) => Math.round(v * 1e6) / 1e6),
    [-97.85, 30.3, -97.8, 30.35],
  );
  assert.deepEqual(f.cancels, []);
  assert.equal(f.tool.isActive(), false);
  assert.equal(pointerOwner(), null);
  assert.equal(f.stockAction('LEFT_CLICK'), f.originalClick);
  assert.equal(f.stockAction('LEFT_DOUBLE_CLICK'), f.originalDouble);
  assert.equal(f.camera.enableInputs, true);
  assert.equal(f.preview(), false);
  assert.equal(f.documentRef.classes.has('gev-imagery-box'), false);
  assert.equal(f.documentRef.listeners.length, 0);
  assert.equal(f.bound(), false);
  assert.deepEqual(f.actives, [true, false]);
  await f.tool.destroy();
});

test('a sky press, a click without a drag and Escape each say why', async () => {
  const f = fixture();
  f.tool.start();
  f.fire('LEFT_DOWN', { position: { x: 250, y: 10 } });
  assert.deepEqual(f.cancels.at(-1), [
    'sky',
    'Press on the ground, not the sky',
  ]);
  assert.equal(f.tool.isActive(), true, 'a sky press keeps the session');
  f.fire('LEFT_DOWN', { position: { x: 250, y: 125 } });
  f.fire('LEFT_UP', { position: { x: 250, y: 125 } });
  assert.deepEqual(f.cancels.at(-1), ['degenerate', 'Drag to size the box']);
  f.tool.start();
  assert.equal(f.key('Escape').prevented, true);
  assert.deepEqual(f.cancels.at(-1), ['escape', undefined]);
  assert.equal(pointerOwner(), null);
  await f.tool.destroy();
});

test('an Escape interceptor that claims the key leaves the tool armed; the next Escape cancels', async () => {
  let claim = true;
  let asked = 0;
  const f = fixture({
    onEscape: () => {
      asked += 1;
      return claim;
    },
  });
  f.tool.start();
  const first = f.key('Escape');
  assert.equal(asked, 1);
  assert.equal(
    first.prevented && first.stopped,
    true,
    'the key goes no further',
  );
  assert.equal(f.tool.isActive(), true);
  claim = false;
  f.key('Escape');
  assert.deepEqual(f.cancels, [['escape', undefined]]);
  f.tool.start();
  f.key('Enter');
  assert.equal(asked, 2, 'other keys never reach the interceptor');
  await f.tool.destroy();
});

test('a session takes the pointer from another tool, which is told', async () => {
  const f = fixture();
  let lost = 0;
  claimPointer('draw', { onLost: () => (lost += 1) });
  assert.equal(f.tool.start(), true);
  assert.equal(pointerOwner(), IMAGERY_BOX_POINTER_OWNER);
  assert.equal(lost, 1);
  assert.deepEqual(f.cancels, []);
  await f.tool.destroy();
});

test('a newer tool taking the pointer mid-drag cancels the session and returns everything', async () => {
  const f = fixture();
  f.tool.start();
  f.fire('LEFT_DOWN', { position: { x: 250, y: 125 } });
  f.fire('MOUSE_MOVE', { endPosition: { x: 500, y: 250 } });
  assert.equal(f.camera.enableInputs, false);
  const lease = claimPointer('draw');
  assert.equal(f.tool.isActive(), false);
  assert.deepEqual(f.cancels, [['cancel', undefined]], 'as if cancelled');
  assert.deepEqual(f.actives, [true, false]);
  assert.equal(f.camera.enableInputs, true, 'the camera is back');
  assert.equal(f.preview(), false, 'no box is left on the globe');
  assert.equal(f.stockAction('LEFT_CLICK'), f.originalClick);
  assert.equal(f.bound(), false);
  assert.equal(f.documentRef.classes.has('gev-imagery-box'), false);
  assert.equal(pointerOwner(), 'draw', 'the newer tool keeps it');
  f.fire('LEFT_UP', { position: { x: 500, y: 250 } });
  assert.deepEqual(f.boxes, [], 'the drag it ended hands over no box');
  releasePointer(lease);
  await f.tool.destroy();
});

test('destroy mid-drag restores the camera, releases the claim and detaches the preview', async () => {
  const f = fixture();
  f.tool.start();
  f.fire('LEFT_DOWN', { position: { x: 250, y: 125 } });
  assert.ok(f.previewSet('fill') && f.previewSet('outline'));
  const destroying = f.tool.destroy();
  assert.equal(f.tool.destroy(), destroying);
  await destroying;
  assert.equal(f.camera.enableInputs, true);
  assert.equal(pointerOwner(), null);
  assert.equal(f.previewSet('fill'), undefined, 'the preview is gone');
  assert.equal(f.previewSet('outline'), undefined);
  assert.equal(f.stockAction('LEFT_CLICK'), f.originalClick);
  assert.equal(f.tool.start(), false);
  assert.equal(initImageryBoxTool({ viewer: null, onBox() {} }), null);
});

test('a second tool can reuse the drag under its own claim, preview, cursor class and box limits', async () => {
  const limits = [];
  const f = fixture({
    owner: 'drone-plan-box',
    bodyClass: 'gev-drone-box',
    validate: (box) => {
      limits.push(box);
      return { ok: true, box };
    },
  });
  assert.equal(f.tool.start(), true);
  assert.equal(pointerOwner(), 'drone-plan-box');
  assert.ok(f.documentRef.classes.has('gev-drone-box'));
  assert.equal(f.documentRef.classes.has('gev-imagery-box'), false);
  f.fire('LEFT_DOWN', { position: { x: 250, y: 125 } });
  f.fire('LEFT_UP', { position: { x: 500, y: 250 } });
  assert.equal(limits.length, 1, 'its own validator decided');
  assert.equal(f.boxes.length, 1);
  assert.equal(f.documentRef.classes.has('gev-drone-box'), false);
  assert.equal(pointerOwner(), null);
  await f.tool.destroy();
});

test('shorterArc keeps a dateline drag on the short arc; the default still min/maxes', async () => {
  const pickWorld = (_viewer, nx, ny) =>
    ny < 0.05 ? null : { lon: nx < 0.5 ? 179.5 : -179.5, lat: 1 };
  const accept = (box) => ({ ok: true, box });
  const plain = fixture({ pickWorld, validate: accept });
  plain.tool.start();
  plain.fire('LEFT_DOWN', { position: { x: 100, y: 200 } });
  plain.fire('LEFT_UP', { position: { x: 800, y: 250 } });
  assert.ok(plain.boxes[0].west < plain.boxes[0].east, 'default stays min/max');
  assert.ok(plain.boxes[0].east - plain.boxes[0].west > 180);
  await plain.tool.destroy();

  const wrapped = fixture({ pickWorld, shorterArc: true, validate: accept });
  wrapped.tool.start();
  wrapped.fire('LEFT_DOWN', { position: { x: 100, y: 200 } });
  wrapped.fire('LEFT_UP', { position: { x: 800, y: 250 } });
  assert.ok(wrapped.boxes[0].west > wrapped.boxes[0].east);
  const span = wrapped.boxes[0].east + 360 - wrapped.boxes[0].west;
  assert.ok(span < 2, `short span ${span}`);
  await wrapped.tool.destroy();
});

test('a second tool keeps its own refusal text for a box that is too small', async () => {
  const f = fixture({
    validate: () => ({
      ok: false,
      reason: 'degenerate',
      message: 'at least 20 m a side',
    }),
  });
  f.tool.start();
  f.fire('LEFT_DOWN', { position: { x: 250, y: 125 } });
  f.fire('LEFT_UP', { position: { x: 251, y: 126 } });
  assert.deepEqual(f.cancels.at(-1), ['degenerate', 'at least 20 m a side']);
  await f.tool.destroy();
});

test('the shared default disarms after a refusal; keepActiveOnInvalid stays armed for the next drag', async () => {
  // Recent Imagery's behavior is unchanged: one refused box ends the session.
  const shared = fixture({
    validate: () => ({ ok: false, reason: 'degenerate' }),
  });
  shared.tool.start();
  shared.fire('LEFT_DOWN', { position: { x: 250, y: 125 } });
  shared.fire('LEFT_UP', { position: { x: 251, y: 126 } });
  assert.equal(shared.tool.isActive(), false);
  assert.equal(pointerOwner(), null);
  await shared.tool.destroy();

  // The drone box stays armed after its own refusal, keeps the pointer and
  // the camera is given back for the next drag.
  let refuse = true;
  const drone = fixture({
    owner: 'drone-plan-box',
    bodyClass: 'gev-drone-box',
    keepActiveOnInvalid: true,
    validate: (box) =>
      refuse
        ? { ok: false, reason: 'degenerate', message: 'at least 20 m a side' }
        : { ok: true, box },
  });
  drone.tool.start();
  drone.fire('LEFT_DOWN', { position: { x: 250, y: 125 } });
  drone.fire('LEFT_UP', { position: { x: 251, y: 126 } });
  assert.equal(drone.tool.isActive(), true, 'still armed after the refusal');
  assert.equal(pointerOwner(), 'drone-plan-box');
  assert.deepEqual(drone.cancels.at(-1), [
    'degenerate',
    'at least 20 m a side',
  ]);
  assert.equal(drone.camera.enableInputs, true, 'the drag released the camera');
  assert.equal(drone.preview(), false, 'the refused drag left no box');

  // The next drag is accepted without restarting the tool.
  refuse = false;
  drone.fire('LEFT_DOWN', { position: { x: 250, y: 125 } });
  drone.fire('MOUSE_MOVE', { endPosition: { x: 500, y: 250 } });
  drone.fire('LEFT_UP', { position: { x: 500, y: 250 } });
  assert.equal(drone.boxes.length, 1);
  assert.equal(drone.tool.isActive(), false);
  assert.equal(pointerOwner(), null);
  await drone.tool.destroy();
});

test('createPreview is the tool dependency: it draws the live drag and is destroyed with the tool', async () => {
  const calls = [];
  let previewViewer = null;
  let liveBox = null;
  const fakePreview = {
    setVisible: (visible) => calls.push(['visible', visible]),
    changed: () => calls.push(['changed']),
    destroy: () => {
      calls.push(['destroy']);
      return Promise.resolve();
    },
  };
  const f = fixture({
    createPreview: (viewer, dragBox) => {
      previewViewer = viewer;
      // The box is read at draw time, not at creation.
      const originalChanged = fakePreview.changed;
      fakePreview.changed = () => {
        liveBox = dragBox();
        originalChanged();
      };
      return fakePreview;
    },
  });
  assert.equal(previewViewer, f.viewer);
  f.tool.start();
  f.fire('LEFT_DOWN', { position: { x: 250, y: 125 } });
  assert.deepEqual(calls.at(-1), ['visible', true]);
  f.fire('MOUSE_MOVE', { endPosition: { x: 500, y: 250 } });
  assert.equal(calls.at(-1)[0], 'changed');
  assert.deepEqual(
    [liveBox.west, liveBox.south, liveBox.east, liveBox.north].map(
      (v) => Math.round(v * 1e6) / 1e6,
    ),
    [-97.85, 30.3, -97.8, 30.35],
  );
  f.fire('LEFT_UP', { position: { x: 500, y: 250 } });
  assert.deepEqual(calls.at(-1), ['visible', false]);
  await f.tool.destroy();
  assert.deepEqual(calls.at(-1), ['destroy']);
});
