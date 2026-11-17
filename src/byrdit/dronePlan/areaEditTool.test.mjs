import assert from 'node:assert/strict';
import test from 'node:test';
import {
  claimPointer,
  pointerOwner,
  releasePointer,
  resetPointerOwnership,
} from '../../data/inputOwnership.js';
import { boxToolFakes } from './testDoubles.mjs';
import { moveArea } from './areaEdit.js';
import {
  AREA_EDIT_POINTER_OWNER,
  DRAG_START_PX,
  HANDLE_HIT_PX,
  initAreaEditTool,
} from './areaEditTool.js';

// The fake canvas maps 1 px to 0.00002 deg (about 2 m), centred on pixel
// (500, 250) at (-97.77, 30.27), so a few hundred pixels is a real survey.
const SCALE = 0.00002;
const worldAt = (x, y) => ({
  lon: -97.77 + (x - 500) * SCALE,
  lat: 30.27 - (y - 250) * SCALE,
});
const pixelOf = (lon, lat, pan = { dx: 0, dy: 0 }) => ({
  x: (lon + 97.77) / SCALE + 500 + pan.dx,
  y: (30.27 - lat) / SCALE + 250 + pan.dy,
});

/** A ~220 m square, corners at pixels (400,200) (510,200) (510,310) (400,310). */
const squareRing = () =>
  [
    [400, 200],
    [510, 200],
    [510, 310],
    [400, 310],
  ].map(([x, y]) => worldAt(x, y));
const polygonArea = () => ({
  id: 'area-1',
  name: 'Area 1',
  kind: 'polygon',
  ring: squareRing(),
});
const boxArea = () => {
  const a = worldAt(400, 310);
  const b = worldAt(510, 200);
  return {
    id: 'area-2',
    name: 'Area 2',
    kind: 'rect',
    box: { west: a.lon, south: a.lat, east: b.lon, north: b.lat },
  };
};

function fixture({ onCommit = () => true, pan = { dx: 0, dy: 0 } } = {}) {
  resetPointerOwnership();
  const fakes = boxToolFakes();
  const cesium = {
    ...fakes.cesium,
    Cartesian3: {
      ...fakes.cesium.Cartesian3,
      fromDegrees: (lon, lat) => ({ lon, lat }),
    },
    HeightReference: { CLAMP_TO_GROUND: 'clamp' },
    Color: {
      fromCssColorString: (css) => ({
        css,
        withAlpha: (alpha) => ({ css, alpha }),
      }),
    },
  };
  const commits = [];
  const rejects = [];
  const exits = [];
  const actives = [];
  const changes = [];
  const tool = initAreaEditTool({
    viewer: fakes.viewer,
    cesium,
    pickWorld: (_viewer, nx, ny) => worldAt(nx * 1000, ny * 500),
    project: (_viewer, lon, lat) => pixelOf(lon, lat, pan),
    documentRef: fakes.documentRef,
    onCommit: (id, shape) => {
      commits.push({ id, shape });
      return onCommit(id, shape);
    },
    onReject: (message, reason) => rejects.push({ message, reason }),
    onExit: (reason) => exits.push(reason),
    onActive: (active) => actives.push(active),
    onChange: (state) => changes.push(state),
  });
  const entities = () =>
    fakes.viewer.dataSources.sources[0]?.entities.values ?? [];
  const dots = () => entities().filter((e) => e.point);
  const outline = () => entities().find((e) => e.polyline)?.polyline;
  const down = (x, y) => fakes.fire('LEFT_DOWN', { position: { x, y } });
  const move = (x, y) => fakes.fire('MOUSE_MOVE', { endPosition: { x, y } });
  const up = (x, y) => fakes.fire('LEFT_UP', { position: { x, y } });
  const drag = (from, to, steps = 3) => {
    down(...from);
    for (let i = 1; i <= steps; i += 1) {
      move(
        from[0] + ((to[0] - from[0]) * i) / steps,
        from[1] + ((to[1] - from[1]) * i) / steps,
      );
    }
    up(...to);
  };
  const click = (x, y) => {
    down(x, y);
    up(x, y);
  };
  const camera = () => fakes.viewer.scene.screenSpaceCameraController;
  return {
    ...fakes,
    tool,
    commits,
    rejects,
    exits,
    actives,
    changes,
    entities,
    dots,
    outline,
    down,
    move,
    up,
    drag,
    click,
    camera,
  };
}

const ringPixels = (ring) => ring.map((p) => pixelOf(p.lon, p.lat));
const closeTo = (actual, expected, eps = 0.01) =>
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${actual} is not within ${eps} of ${expected}`,
  );

test('starting an edit claims the pointer and draws the handles', () => {
  const f = fixture();
  assert.equal(f.tool.start(polygonArea()), true);
  assert.equal(pointerOwner(), AREA_EDIT_POINTER_OWNER);
  assert.equal(f.tool.isActive(), true);
  assert.equal(f.tool.areaId(), 'area-1');
  assert.deepEqual(f.actives, [true]);
  // 4 corners, 4 edge midpoints, 1 centre; plus the outline.
  assert.equal(f.dots().length, 9);
  assert.ok(f.outline());
  const sizes = f.dots().map((d) => d.point.pixelSize);
  assert.ok(sizes[4] < sizes[0], 'midpoint handles are smaller than corners');
  // The stock click handlers are borrowed while editing.
  assert.equal(
    f.viewer.screenSpaceEventHandler.getInputAction(f.types.LEFT_CLICK),
    undefined,
  );
  f.tool.cancel('done');
  assert.equal(
    f.viewer.screenSpaceEventHandler.getInputAction(f.types.LEFT_CLICK),
    f.originalClick,
  );
  assert.equal(
    f.viewer.screenSpaceEventHandler.getInputAction(f.types.LEFT_DOUBLE_CLICK),
    f.originalDouble,
  );
});

test('a box gets its 4 corners and a centre handle', () => {
  const f = fixture();
  f.tool.start(boxArea());
  assert.equal(f.dots().length, 5);
  assert.equal(f.tool.cornerCount(), 4);
  assert.equal(f.tool.canRemoveCorner(), false);
  f.tool.destroy();
});

test('start is refused while another tool holds the pointer, or for no area', () => {
  const f = fixture();
  const lease = claimPointer('someone-else');
  assert.equal(f.tool.start(polygonArea()), false);
  assert.equal(f.tool.isActive(), false);
  releasePointer(lease);
  assert.equal(f.tool.start({ id: 'x', kind: 'polygon', ring: [] }), false);
  assert.equal(f.tool.start(null), false);
  assert.equal(pointerOwner(), null);
});

test('dragging a corner freezes the camera, updates live and commits on release', () => {
  const f = fixture();
  f.tool.start(polygonArea());
  f.down(510, 200);
  assert.equal(f.camera().enableInputs, false);
  // Below the drag threshold nothing moves yet.
  f.move(510 + DRAG_START_PX - 1, 200);
  assert.equal(f.commits.length, 0);
  f.move(540, 190);
  assert.equal(f.commits.length, 0, 'no commit while dragging');
  const live = f.outline().positions;
  const second = live.slice(2, 4);
  closeTo(second[0], worldAt(540, 190).lon, 1e-9);
  closeTo(second[1], worldAt(540, 190).lat, 1e-9);
  f.up(540, 190);
  assert.equal(f.camera().enableInputs, true);
  assert.equal(f.commits.length, 1);
  const { id, shape } = f.commits[0];
  assert.equal(id, 'area-1');
  assert.equal(shape.kind, 'polygon');
  assert.equal(shape.ring.length, 4);
  const px = ringPixels(shape.ring);
  closeTo(px[1].x, 540);
  closeTo(px[1].y, 190);
  closeTo(px[0].x, 400);
  closeTo(px[3].y, 310);
  assert.ok(shape.box, 'the validated shape carries its bounding box');
  assert.equal(f.tool.isActive(), true, 'edit mode stays on');
  f.tool.destroy();
});

test('a press that is not on a handle leaves the camera to pan', () => {
  const f = fixture();
  f.tool.start(polygonArea());
  f.down(700, 400);
  assert.equal(f.camera().enableInputs, true);
  f.move(720, 420);
  f.up(720, 420);
  assert.equal(f.commits.length, 0);
  f.tool.destroy();
});

test('the camera setting it found is the one it puts back', () => {
  const f = fixture();
  f.camera().enableInputs = false;
  f.tool.start(polygonArea());
  f.drag([510, 200], [530, 200]);
  assert.equal(f.camera().enableInputs, false);
  f.camera().enableInputs = true;
  f.tool.destroy();
});

test('the grab point does not jump: the handle keeps its offset to the pointer', () => {
  const f = fixture();
  f.tool.start(polygonArea());
  // Press 10 px off the corner centre (inside the hit radius), drag 40 px right.
  f.drag([516, 205], [556, 205]);
  const px = ringPixels(f.commits[0].shape.ring);
  closeTo(px[1].x, 550);
  closeTo(px[1].y, 200);
  f.tool.destroy();
});

test('the centre handle moves the whole polygon by metres', () => {
  const f = fixture();
  const area = polygonArea();
  f.tool.start(area);
  const centre = pixelOf(
    area.ring.reduce((s, p) => s + p.lon, 0) / 4,
    area.ring.reduce((s, p) => s + p.lat, 0) / 4,
  );
  f.drag([centre.x, centre.y], [centre.x + 60, centre.y + 30]);
  assert.equal(f.commits.length, 1);
  const expected = moveArea(
    { kind: 'polygon', ring: area.ring },
    60 * SCALE * 96223.98731264126,
    -30 * SCALE * 110856.9873928434,
  ).ring;
  f.commits[0].shape.ring.forEach((p, i) => {
    closeTo(p.lon, expected[i].lon, 2e-7);
    closeTo(p.lat, expected[i].lat, 2e-7);
  });
  const moved = ringPixels(f.commits[0].shape.ring);
  closeTo(moved[0].x, 460, 0.5);
  closeTo(moved[0].y, 230, 0.5);
  f.tool.destroy();
});

test('a box corner drag resizes it and it stays an axis-aligned rectangle', () => {
  const f = fixture();
  const area = boxArea();
  f.tool.start(area);
  // North-east corner is at pixel (510, 200).
  f.drag([510, 200], [560, 150]);
  assert.equal(f.commits.length, 1);
  const { shape } = f.commits[0];
  assert.equal(shape.kind, 'rect');
  assert.equal(shape.ring, undefined);
  assert.equal(shape.box.west, area.box.west);
  assert.equal(shape.box.south, area.box.south);
  closeTo(shape.box.east, worldAt(560, 150).lon, 1e-9);
  closeTo(shape.box.north, worldAt(560, 150).lat, 1e-9);
  f.tool.destroy();
});

test('dragging a box corner past the opposite one flips the box, not refuses it', () => {
  const f = fixture();
  f.tool.start(boxArea());
  f.drag([510, 200], [330, 360]);
  assert.equal(f.commits.length, 1);
  const { box } = f.commits[0].shape;
  assert.ok(box.west < box.east && box.south < box.north);
  closeTo(box.west, worldAt(330, 360).lon, 1e-9);
  closeTo(box.south, worldAt(330, 360).lat, 1e-9);
  f.tool.destroy();
});

test('the box centre handle moves the box without resizing it', () => {
  const f = fixture();
  const area = boxArea();
  f.tool.start(area);
  const c = pixelOf(
    (area.box.west + area.box.east) / 2,
    (area.box.south + area.box.north) / 2,
  );
  f.drag([c.x, c.y], [c.x + 40, c.y - 40]);
  const { box } = f.commits[0].shape;
  closeTo(box.east - box.west, area.box.east - area.box.west, 1e-9);
  closeTo(box.north - box.south, area.box.north - area.box.south, 1e-9);
  assert.ok(box.west > area.box.west && box.south > area.box.south);
  f.tool.destroy();
});

test('clicking an edge handle adds a corner there', () => {
  const f = fixture();
  f.tool.start(polygonArea());
  // The top edge runs (400,200)-(510,200): midpoint at (455,200).
  f.click(455, 200);
  assert.equal(f.commits.length, 1);
  const { ring } = f.commits[0].shape;
  assert.equal(ring.length, 5);
  const px = ringPixels(ring);
  closeTo(px[1].x, 455, 0.01);
  closeTo(px[1].y, 200, 0.01);
  assert.equal(f.tool.cornerCount(), 5);
  assert.equal(f.tool.selectedCorner(), 1, 'the new corner is selected');
  // And the new corner can be dragged.
  f.drag([455, 200], [455, 170]);
  const dragged = ringPixels(f.commits[1].shape.ring);
  closeTo(dragged[1].y, 170);
  f.tool.destroy();
});

test('dragging an edge handle adds the corner and carries it', () => {
  const f = fixture();
  f.tool.start(polygonArea());
  f.drag([455, 310], [455, 360]);
  assert.equal(f.commits.length, 1);
  const px = ringPixels(f.commits[0].shape.ring);
  assert.equal(px.length, 5);
  // Edge 2 runs (510,310)-(400,310); the new corner is inserted after index 2.
  closeTo(px[3].x, 455);
  closeTo(px[3].y, 360);
  f.tool.destroy();
});

test('a corner can be selected and removed, never below 3 corners', () => {
  const f = fixture();
  f.tool.start(polygonArea());
  assert.equal(f.tool.canRemoveCorner(), false);
  f.click(510, 310);
  assert.equal(f.tool.selectedCorner(), 2);
  assert.equal(f.tool.canRemoveCorner(), true);
  assert.equal(f.changes.at(-1).selectedCorner, 2);
  assert.equal(f.changes.at(-1).canRemoveCorner, true);
  assert.equal(f.commits.length, 0, 'selecting changes nothing');
  assert.equal(f.tool.removeSelectedCorner(), true);
  assert.equal(f.commits.length, 1);
  assert.equal(f.commits[0].shape.ring.length, 3);
  assert.equal(f.tool.selectedCorner(), null);
  assert.equal(f.tool.canRemoveCorner(), false);
  // Down to a triangle: its corners cannot be removed.
  f.click(400, 200);
  assert.equal(f.tool.selectedCorner(), 0);
  assert.equal(f.tool.canRemoveCorner(), false);
  assert.equal(f.tool.removeSelectedCorner(), false);
  assert.equal(f.commits.length, 1);
  assert.equal(f.rejects.at(-1).reason, 'too-few-corners');
  assert.equal(f.tool.cornerCount(), 3);
  f.tool.destroy();
});

test('Delete and Backspace remove the selected corner; typing in a field does not', () => {
  const f = fixture();
  f.tool.start(polygonArea());
  f.click(400, 310);
  const typing = {
    key: 'Delete',
    target: { tagName: 'INPUT', type: 'text' },
    preventDefault() {},
  };
  f.documentRef.listeners.find(([type]) => type === 'keydown')[1](typing);
  assert.equal(f.commits.length, 0);
  assert.equal(f.key('Delete').prevented, true);
  assert.equal(f.commits.length, 1);
  assert.equal(f.commits[0].shape.ring.length, 3);
  f.tool.cancel();
  // Backspace with a corner selected, on a fresh session.
  const g = fixture();
  g.tool.start({
    ...polygonArea(),
    ring: [...squareRing(), worldAt(380, 250)],
  });
  g.click(400, 200);
  assert.equal(g.key('Backspace').prevented, true);
  assert.equal(g.commits.length, 1);
  assert.equal(g.commits[0].shape.ring.length, 4);
  // Nothing selected: the key is left alone.
  assert.equal(g.key('Delete').prevented, false);
  g.tool.destroy();
});

test('a shape that crosses itself is refused and the old one stays', () => {
  const f = fixture();
  const area = polygonArea();
  f.tool.start(area);
  // Pull the top-right corner down across the bottom edge: a bow-tie.
  f.drag([510, 200], [450, 330]);
  assert.equal(f.commits.length, 0);
  assert.equal(f.rejects.length, 1);
  assert.equal(f.rejects[0].reason, 'self-intersecting');
  assert.match(f.rejects[0].message, /crosses itself/);
  // The handles are back where they were; the next drag starts from there.
  const dots = f.dots().map((d) => pixelOf(d.position.lon, d.position.lat));
  closeTo(dots[1].x, 510);
  closeTo(dots[1].y, 200);
  f.drag([510, 200], [530, 200]);
  assert.equal(f.commits.length, 1);
  assert.equal(f.camera().enableInputs, true);
  f.tool.destroy();
});

test('a box that would be too small or too large is refused', () => {
  const f = fixture();
  f.tool.start(boxArea());
  f.drag([510, 200], [405, 305]);
  assert.equal(f.commits.length, 0);
  assert.equal(f.rejects.at(-1).reason, 'degenerate');
  // 600 px is more than a kilometre and a half in each direction.
  f.drag([510, 200], [510 + 1600, 200]);
  assert.equal(f.commits.length, 0);
  assert.equal(f.rejects.at(-1).reason, 'too-large');
  f.tool.destroy();
});

test('the outline turns red while the shape would be refused', () => {
  const f = fixture();
  f.tool.start(polygonArea());
  f.down(510, 200);
  f.move(520, 200);
  assert.equal(f.outline().material.css, '#8be9ff');
  f.move(450, 330);
  assert.equal(f.outline().material.css, '#ff5555');
  f.move(520, 200);
  assert.equal(f.outline().material.css, '#8be9ff');
  f.up(520, 200);
  assert.equal(f.commits.length, 1);
  f.tool.destroy();
});

test('a commit the panel refuses puts the old shape back', () => {
  const f = fixture({ onCommit: () => false });
  const area = polygonArea();
  f.tool.start(area);
  f.drag([510, 200], [560, 200]);
  assert.equal(f.commits.length, 1);
  // Still the original: the dot is back and a second drag starts from it.
  const dots = f.dots().map((d) => pixelOf(d.position.lon, d.position.lat));
  closeTo(dots[1].x, 510);
  f.drag([510, 200], [520, 200]);
  assert.equal(f.commits.length, 2);
  const px = ringPixels(f.commits[1].shape.ring);
  closeTo(px[1].x, 520);
  f.tool.destroy();
});

test('an accepted commit becomes the base of the next drag', () => {
  const f = fixture();
  f.tool.start(polygonArea());
  f.drag([510, 200], [540, 200]);
  f.drag([540, 200], [570, 200]);
  assert.equal(f.commits.length, 2);
  closeTo(ringPixels(f.commits[1].shape.ring)[1].x, 570);
  assert.equal(f.commits[1].shape.ring.length, 4);
  f.tool.destroy();
});

test('handle hits use the live camera and the hit radius', () => {
  const pan = { dx: 0, dy: 0 };
  const f = fixture({ pan });
  f.tool.start(polygonArea());
  f.down(510 + HANDLE_HIT_PX + 4, 200);
  assert.equal(f.camera().enableInputs, true, 'just outside: no grab');
  f.up(0, 0);
  f.down(510 + HANDLE_HIT_PX - 4, 200);
  assert.equal(f.camera().enableInputs, false, 'just inside: grabbed');
  f.up(510, 200);
  // The camera pans: the corner is now drawn at (610, 260).
  pan.dx = 100;
  pan.dy = 60;
  f.down(510, 200);
  assert.equal(f.camera().enableInputs, true, 'the old pixel is not a handle');
  f.down(610, 260);
  assert.equal(f.camera().enableInputs, false);
  f.up(610, 260);
  assert.equal(f.camera().enableInputs, true);
  f.tool.destroy();
});

test('Escape leaves edit mode and gives everything back', () => {
  const f = fixture();
  f.tool.start(polygonArea());
  const live = f.handler();
  assert.equal(f.key('Escape').prevented, true);
  assert.equal(f.tool.isActive(), false);
  assert.deepEqual(f.exits, ['escape']);
  assert.deepEqual(f.actives, [true, false]);
  assert.equal(pointerOwner(), null);
  assert.equal(live.destroyed, true);
  assert.equal(f.viewer.dataSources.sources.length, 0);
  assert.equal(f.documentRef.listeners.length, 0);
  assert.equal(f.camera().enableInputs, true);
  assert.equal(f.changes.at(-1).areaId, null);
});

test('Escape during a drag drops the drag and keeps editing', () => {
  const f = fixture();
  f.tool.start(polygonArea());
  f.down(510, 200);
  f.move(560, 220);
  f.key('Escape');
  assert.equal(f.tool.isActive(), true);
  assert.equal(f.camera().enableInputs, true);
  assert.equal(f.commits.length, 0);
  const dots = f.dots().map((d) => pixelOf(d.position.lon, d.position.lat));
  closeTo(dots[1].x, 510);
  f.up(560, 220);
  assert.equal(f.commits.length, 0);
  f.tool.destroy();
});

test('cancel and destroy in the middle of a drag thaw the camera and clean up', () => {
  for (const how of ['cancel', 'destroy']) {
    const f = fixture();
    f.tool.start(polygonArea());
    f.down(510, 200);
    f.move(560, 220);
    assert.equal(f.camera().enableInputs, false);
    const live = f.handler();
    f.tool[how]('switch');
    assert.equal(f.camera().enableInputs, true, how);
    assert.equal(live.destroyed, true, how);
    assert.equal(f.viewer.dataSources.sources.length, 0, how);
    assert.equal(f.documentRef.listeners.length, 0, how);
    assert.equal(pointerOwner(), null, how);
    assert.equal(f.commits.length, 0, how);
    // Late events do nothing.
    f.up(560, 220);
    f.move(100, 100);
    assert.equal(f.commits.length, 0, how);
  }
});

test('a pointer release outside the canvas still ends the drag', () => {
  const f = fixture();
  f.tool.start(polygonArea());
  f.down(510, 200);
  f.move(560, 200);
  const release = f.documentRef.listeners.find(
    ([type]) => type === 'pointerup',
  );
  assert.ok(release, 'a document pointerup listener is live during a drag');
  release[1]();
  assert.equal(f.camera().enableInputs, true);
  assert.equal(f.commits.length, 1);
  assert.equal(
    f.documentRef.listeners.some(([type]) => type === 'pointerup'),
    false,
  );
  f.tool.destroy();
});

test('start on another area while editing switches without dropping the pointer', () => {
  const f = fixture();
  f.tool.start(polygonArea());
  assert.equal(f.tool.start(boxArea()), true);
  assert.equal(f.tool.areaId(), 'area-2');
  assert.equal(f.dots().length, 5);
  assert.equal(pointerOwner(), AREA_EDIT_POINTER_OWNER);
  assert.equal(f.viewer.dataSources.sources.length, 1);
  f.tool.destroy();
  assert.equal(f.viewer.dataSources.sources.length, 0);
});

test('a missing viewer or commit handler gives no tool', () => {
  assert.equal(initAreaEditTool({ onCommit: () => true }), null);
  assert.equal(initAreaEditTool({ viewer: { scene: {} } }), null);
});

test('an edge drag that is dropped puts the earlier corner selection back', () => {
  const f = fixture();
  f.tool.start(polygonArea());
  f.click(510, 310);
  assert.equal(f.tool.selectedCorner(), 2);
  f.down(455, 310);
  f.move(455, 360);
  f.key('Escape');
  assert.equal(f.tool.selectedCorner(), 2, 'Escape during the drag');
  f.up(455, 360);
  assert.equal(f.commits.length, 0);
  f.tool.destroy();
});
