import assert from 'node:assert/strict';
import test from 'node:test';
import {
  claimPointer,
  releasePointer,
  resetPointerOwnership,
} from '../../data/inputOwnership.js';
import { boxToolFakes } from '../../layers/recentImagery/testDoubles.mjs';
import { initDronePlan, planSummary } from './panel.js';
import { createBuildingFootprintProvider } from './buildingFootprints.js';
import { downtownPayload, okResponse } from './buildingFixtures.mjs';
import { createDronePlanVoice } from './dronePlanVoice.js';
import { metersPerDegree } from './geo.js';
import { MAX_OBSTACLES } from './obstacles.js';
import { readZip } from './zip.js';

// ---------------------------------------------------------------- DOM stub --
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.style = {};
    this._text = '';
    this._class = new Set();
    const classes = this._class;
    this.classList = {
      add: (...n) => n.forEach((x) => classes.add(x)),
      remove: (...n) => n.forEach((x) => classes.delete(x)),
      contains: (n) => classes.has(n),
      toggle: (n, on) =>
        (on ?? !classes.has(n)) ? classes.add(n) : classes.delete(n),
    };
  }
  get className() {
    return [...this._class].join(' ');
  }
  set className(v) {
    this._class = new Set(String(v).split(/\s+/).filter(Boolean));
    const classes = this._class;
    this.classList.contains = (n) => classes.has(n);
    this.classList.add = (...n) => n.forEach((x) => classes.add(x));
    this.classList.remove = (...n) => n.forEach((x) => classes.delete(x));
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this.children = [];
    this._text = String(v ?? '');
  }
  setAttribute(k, v) {
    this.attributes.set(k, String(v));
    if (k === 'class') this.className = v;
  }
  getAttribute(k) {
    return this.attributes.has(k) ? this.attributes.get(k) : null;
  }
  removeAttribute(k) {
    this.attributes.delete(k);
  }
  append(...nodes) {
    for (const n of nodes) {
      n.parentNode?.children.splice(n.parentNode.children.indexOf(n), 1);
      n.parentNode = this;
      this.children.push(n);
    }
  }
  after(...nodes) {
    const parent = this.parentNode;
    for (const n of nodes)
      n.parentNode?.children.splice(n.parentNode.children.indexOf(n), 1);
    const at = parent.children.indexOf(this) + 1;
    parent.children.splice(at, 0, ...nodes);
    nodes.forEach((n) => (n.parentNode = parent));
  }
  replaceChildren(...nodes) {
    this.children = [];
    this._text = '';
    this.append(...nodes);
  }
  addEventListener(type, fn) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type, fn) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((f) => f !== fn),
    );
  }
  dispatch(type) {
    for (const fn of this.listeners.get(type) ?? []) fn({ target: this });
  }
  click() {
    if (!this.disabled) this.dispatch('click');
  }
  querySelector() {
    return null;
  }
}
const all = (node, pred, out = []) => {
  if (pred(node)) out.push(node);
  node.children.forEach((c) => all(c, pred, out));
  return out;
};

function makeDoc() {
  const panel = new El('div');
  panel.classList.add('collapsed');
  const body = new El('div');
  // The card's own collapse button is the launcher; the rail's chrome flips
  // `collapsed` when it is pressed, which this stub does the same way.
  const entry = new El('button');
  entry.addEventListener('click', () => {
    panel.classList.toggle('collapsed');
  });
  panel.querySelector = (sel) =>
    sel === '.panel-collapse-btn' ? entry : null;
  const byId = new Map([
    ['drone-plan-panel', panel],
    ['drone-plan-panel-body', body],
  ]);
  return {
    panel,
    body,
    entry,
    doc: {
      getElementById: (id) => byId.get(id) ?? null,
      createElement: (tag) => new El(tag),
      querySelector: () => null,
      body: new El('body'),
    },
  };
}

// ----------------------------------------------------------- Cesium fakes --
function makeWorld({ sample }) {
  const fakes = boxToolFakes();
  class CustomDataSource {
    constructor(name) {
      this.name = name;
      const values = [];
      this.entities = {
        values,
        add: (e) => (values.push(e), e),
        remove: (e) => {
          const i = values.indexOf(e);
          if (i >= 0) values.splice(i, 1);
        },
        removeAll: () => values.splice(0),
      };
    }
  }
  class EllipsoidTerrainProvider {}
  const cesium = {
    ...fakes.cesium,
    CustomDataSource,
    EllipsoidTerrainProvider,
    PolylineDashMaterialProperty: class {
      constructor(options) {
        this.options = options;
      }
    },
    Cartesian2: class {
      constructor(x, y) {
        this.x = x;
        this.y = y;
      }
    },
    CornerType: { MITERED: 'mitered', BEVELED: 'beveled' },
    Cartesian3: {
      fromDegreesArray: (v) => v,
      fromDegreesArrayHeights: (v) => ({ heights: v }),
      fromDegrees: (lon, lat, h) =>
        h === undefined ? [lon, lat] : [lon, lat, h],
    },
    Cartographic: {
      fromDegrees: (lon, lat) => ({ longitude: lon, latitude: lat }),
    },
    HeightReference: { CLAMP_TO_GROUND: 'clamp' },
    sampleTerrainMostDetailed: (provider, cartos) => sample(cartos),
  };
  const viewer = {
    ...fakes.viewer,
    terrainProvider: { requestTileGeometry() {} },
  };
  return { viewer, cesium, fakes };
}

const boxM = (w, h) => {
  const m = metersPerDegree(30.27);
  return {
    west: -97.77 - w / 2 / m.lon,
    east: -97.77 + w / 2 / m.lon,
    south: 30.27 - h / 2 / m.lat,
    north: 30.27 + h / 2 / m.lat,
  };
};
const flat = (cartos, height = 100) => cartos.map((c) => ({ ...c, height }));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

function setup({ sample = async (cartos) => flat(cartos) } = {}) {
  resetPointerOwnership();
  const dom = makeDoc();
  const world = makeWorld({ sample: (cartos) => sample(cartos) });
  const downloads = [];
  const handle = initDronePlan({
    viewer: world.viewer,
    cesium: world.cesium,
    document: dom.doc,
    downloadFile: (name, bytes, type) => downloads.push({ name, bytes, type }),
  });
  const find = (pred) => all(dom.body, pred);
  const control = (label) =>
    find((n) => n.getAttribute('aria-label') === label)[0];
  const buttons = (attr) =>
    find((n) => n.tagName === 'BUTTON' && n.attributes.has(attr));
  const stats = () => {
    const dts = find((n) => n.tagName === 'DT');
    return Object.fromEntries(
      dts.map((dt) => {
        const dl = dt.parentNode;
        return [
          dt.textContent,
          dl.children[dl.children.indexOf(dt) + 1].textContent,
        ];
      }),
    );
  };
  const status = () =>
    find((n) => n.className.includes('gev-dp-status'))[0].textContent;
  return {
    ...dom,
    ...world,
    handle,
    downloads,
    find,
    control,
    buttons,
    stats,
    status,
  };
}

// ------------------------------------------------------------------ tests --
test('DRAW BOX has a data-action the QA script can click', () => {
  const w = setup();
  const draw = w.find(
    (n) => n.tagName === 'BUTTON' && n.textContent === 'DRAW BOX',
  );
  assert.equal(draw.length, 1);
  assert.equal(draw[0].getAttribute('data-action'), 'draw-box');
  w.handle.destroy();
});

test('a committed plan bumps the panel nonce, and a second plan bumps it again', async () => {
  const w = setup();
  assert.equal(w.panel.dataset.planNonce, undefined);
  assert.equal(w.handle.setBox(boxM(300, 200)), true);
  await w.handle.replan();
  assert.equal(w.panel.dataset.state, 'ready');
  assert.equal(w.panel.dataset.planNonce, '1');
  w.handle.getState().options.aglM = 60;
  await w.handle.replan();
  assert.equal(w.panel.dataset.planNonce, '2');
  assert.equal(w.panel.dataset.state, 'ready');
  w.handle.destroy();
});

test('a failed plan does not bump the nonce', async () => {
  const w = setup();
  assert.equal(w.handle.setBox(boxM(300, 200)), true);
  await w.handle.replan();
  assert.equal(w.panel.dataset.planNonce, '1');
  Object.assign(w.handle.getState().options, {
    aglM: 10,
    frontOverlap: 95,
    sideOverlap: 95,
  });
  w.handle.setBox(boxM(3000, 3000));
  await w.handle.replan();
  assert.equal(w.panel.dataset.state, 'idle');
  assert.equal(w.panel.dataset.planNonce, '1');
  w.handle.destroy();
});

test('a plan overtaken by a newer one does not bump the nonce', async () => {
  const slow = deferred();
  let calls = 0;
  const w = setup({
    sample: async (cartos) => {
      calls += 1;
      if (calls === 1) await slow.promise;
      return flat(cartos);
    },
  });
  w.handle.setBox(boxM(300, 200));
  const first = w.handle.replan();
  await w.handle.replan();
  assert.equal(w.panel.dataset.planNonce, '1');
  slow.resolve();
  await first;
  assert.equal(w.panel.dataset.planNonce, '1');
  w.handle.destroy();
});

test('a drawn box becomes stats, a path on the globe and downloadable missions', async () => {
  const w = setup();
  assert.ok(w.handle);
  assert.equal(w.panel.hidden, false, 'the card is always on the rail');
  assert.equal(w.panel.classList.contains('collapsed'), true, 'and starts collapsed');
  assert.equal(w.handle.setBox(boxM(400, 200)), true);
  await w.handle.replan();
  const stats = w.stats();
  assert.equal(stats.Photos, String(w.handle.getResult().totals.photoCount));
  assert.match(stats['Ground detail'], /cm\/px/);
  assert.equal(w.panel.dataset.state, 'ready');
  const entities = w.viewer.dataSources.sources.find(
    (s) => s.name === 'gev-drone-plan',
  ).entities.values;
  assert.ok(entities.some((e) => e.name === 'Takeoff'));
  assert.ok(entities.some((e) => e.polyline && e.name === 'Mission 1'));
  assert.equal(
    w.buttons('data-mission').length,
    w.handle.getResult().missions.length,
  );
  w.buttons('data-mission')[0].click();
  assert.equal(w.downloads.length, 1);
  assert.match(
    w.downloads[0].name,
    /^gev-drone-plan-\d{8}-\d{4}-m1of\d+\.kmz$/,
  );
  const kmz = readZip(w.downloads[0].bytes);
  const waylines = new TextDecoder().decode(kmz.get('wpmz/waylines.wpml'));
  assert.equal(
    (waylines.match(/<Placemark>/g) || []).length,
    w.handle.getResult().missions[0].waypointCount,
  );
  w.buttons('data-download')[0].click();
  assert.match(w.downloads[1].name, /-all\.zip$/);
  assert.ok(readZip(w.downloads[1].bytes).has('README.txt'));
  w.handle.destroy();
});

test('while terrain is being read the old plan cannot be downloaded', async () => {
  const gate = deferred();
  let hold = false;
  const w = setup({
    sample: async (cartos) => {
      if (hold) await gate.promise;
      return flat(cartos);
    },
  });
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  assert.equal(w.buttons('data-mission')[0].disabled, false);
  hold = true;
  w.handle.getState().options.aglM = 60;
  const pending = w.handle.replan();
  assert.equal(w.panel.dataset.state, 'busy');
  assert.equal(
    w.buttons('data-mission')[0].disabled,
    true,
    'buttons are off while busy',
  );
  w.handle.downloadMission(0);
  w.handle.downloadAll();
  assert.equal(w.downloads.length, 0, 'no file from the stale plan');
  gate.resolve();
  await pending;
  assert.equal(w.buttons('data-mission')[0].disabled, false);
  assert.equal(w.handle.getResult().plan.options.aglM, 60);
  w.handle.destroy();
});

test('a slow earlier plan cannot overwrite a newer one', async () => {
  const slow = deferred();
  let calls = 0;
  const w = setup({
    sample: async (cartos) => {
      calls += 1;
      if (calls === 1) await slow.promise;
      return flat(cartos);
    },
  });
  w.handle.setBox(boxM(300, 200));
  w.handle.getState().options.aglM = 50;
  const first = w.handle.replan();
  w.handle.getState().options.aglM = 100;
  await w.handle.replan();
  assert.equal(w.handle.getResult().plan.options.aglM, 100);
  slow.resolve();
  await first;
  assert.equal(
    w.handle.getResult().plan.options.aglM,
    100,
    'the stale answer was dropped',
  );
  w.handle.destroy();
});

test('an unplannable box clears the busy state', async () => {
  const gate = deferred();
  let hold = true;
  const w = setup({
    sample: async (cartos) => {
      if (hold) await gate.promise;
      return flat(cartos);
    },
  });
  w.handle.setBox(boxM(300, 200));
  const slow = w.handle.replan();
  assert.equal(w.panel.dataset.state, 'busy');
  hold = false;
  Object.assign(w.handle.getState().options, {
    aglM: 10,
    frontOverlap: 95,
    sideOverlap: 95,
  });
  w.handle.setBox(boxM(3000, 3000));
  await w.handle.replan();
  assert.equal(w.handle.getState().busy, false);
  assert.equal(w.panel.dataset.state, 'idle');
  assert.match(w.status(), /Too many waypoints/);
  gate.resolve();
  await slow;
  w.handle.destroy();
});

test('terrain that could not be fully read locks the files until the person accepts or retries', async () => {
  let complete = false;
  let bad = null;
  const w = setup({
    sample: async (cartos) => {
      // One particular point is unreadable until `complete` flips, however it
      // is batched, so the retry for the gap fails the same way.
      bad ??= `${cartos[3].longitude},${cartos[3].latitude}`;
      return cartos.map((c) => ({
        ...c,
        height:
          !complete && `${c.longitude},${c.latitude}` === bad ? undefined : 100,
      }));
    },
  });
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  const result = w.handle.getResult();
  assert.equal(result.terrainComplete, false);
  assert.ok(result.warnings.some((x) => x.code === 'terrain-partial'));
  assert.equal(w.buttons('data-mission')[0].disabled, true);
  assert.equal(w.buttons('data-download')[0].disabled, true);
  w.handle.downloadMission(0);
  assert.equal(w.downloads.length, 0);
  // Ticking the box takes responsibility for the heights.
  const [ack] = w.find((n) => n.getAttribute('data-ack') === 'terrain');
  ack.checked = true;
  ack.dispatch('change');
  assert.equal(w.buttons('data-mission')[0].disabled, false);
  w.handle.downloadMission(0);
  assert.equal(w.downloads.length, 1);
  // Reading the terrain again, now complete, unlocks without the box.
  complete = true;
  w.buttons('data-retry')[0].click();
  await new Promise((r) => setTimeout(r, 40));
  await w.handle.replan();
  assert.equal(w.handle.getResult().terrainComplete, true);
  assert.equal(
    w.find((n) => n.getAttribute('data-ack') === 'terrain').length,
    0,
  );
  assert.equal(w.buttons('data-mission')[0].disabled, false);
  w.handle.destroy();
});

test('the aircraft code field overrides the preset, and clearing it returns to the preset code', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  const field = w.control('DJI aircraft code in the mission file');
  const code = () => {
    w.handle.downloadMission(0);
    const bytes = w.downloads.at(-1).bytes;
    const way = new TextDecoder().decode(
      readZip(bytes).get('wpmz/waylines.wpml'),
    );
    return /<wpml:droneEnumValue>(\d+)</.exec(way)[1];
  };
  assert.equal(code(), '68');
  field.value = '99';
  field.dispatch('change');
  assert.equal(code(), '99');
  field.value = '';
  field.dispatch('change');
  assert.equal(code(), '68', 'an empty field is the preset code, not 0');
  assert.equal(field.value, '68');
  field.value = '12.5';
  field.dispatch('change');
  assert.equal(code(), '68', 'a non-integer is ignored');
  w.handle.destroy();
});

test('picking a takeoff point says so when another tool holds the pointer', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  const lease = claimPointer('draw');
  const set = w.buttons('title').find((b) => b.textContent === 'SET');
  set.click();
  assert.match(w.status(), /Another tool is using the pointer/);
  releasePointer(lease);
  w.handle.destroy();
});

test('close and destroy return the pointer, the globe and the entry state', async () => {
  const w = setup();
  w.entry.click(); // expand the rail card
  await Promise.resolve();
  assert.equal(w.panel.classList.contains('collapsed'), false);
  assert.equal(w.handle.isOpen(), true);
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  w.handle.close();
  assert.equal(w.panel.classList.contains('collapsed'), true);
  assert.equal(w.panel.hidden, false, 'a closed card stays on the rail');
  assert.equal(w.handle.isOpen(), false);
  assert.equal(w.handle.getResult(), null);
  const source = w.viewer.dataSources.sources.find(
    (s) => s.name === 'gev-drone-plan',
  );
  assert.equal(source.entities.values.length, 0);
  w.handle.destroy();
  await new Promise((r) => setTimeout(r, 0)); // the data source detaches async
  assert.equal(
    w.viewer.dataSources.sources.some((s) => s.name === 'gev-drone-plan'),
    false,
  );
});

test('a takeoff pick far from the box is refused with the reason, a near one is taken', async () => {
  const w = setup();
  const box = boxM(300, 200);
  w.handle.setBox(box);
  await w.handle.replan();
  const m = metersPerDegree(30.27);
  const far = { lon: -97.77 + (150 + 3000) / m.lon, lat: 30.27 };
  assert.equal(w.handle.setTakeoff(far), false);
  assert.match(w.status(), /from the box; keep it within 1,000 m/);
  assert.equal(w.handle.getState().takeoff, null);
  const near = { lon: -97.77 + (150 + 200) / m.lon, lat: 30.27 };
  assert.equal(w.handle.setTakeoff(near), true);
  await w.handle.replan();
  assert.equal(w.handle.getResult().plan.takeoff.custom, true);
  w.handle.destroy();
});

test('a plan with missions over the battery time or cut off at the mission cap cannot be downloaded', async () => {
  const w = setup();
  w.handle.setBox(boxM(2500, 2500));
  Object.assign(w.handle.getState().options, {
    aglM: 100,
    batteryMin: 5,
    speedMs: 4,
  });
  await w.handle.replan();
  const result = w.handle.getResult();
  assert.equal(result.truncated, true);
  assert.ok(result.missions.length <= 60);
  assert.ok(w.buttons('data-mission').every((b) => b.disabled));
  assert.equal(w.buttons('data-download')[0].disabled, true);
  w.handle.downloadAll();
  w.handle.downloadMission(0);
  assert.equal(w.downloads.length, 0);
  assert.match(w.status(), /Too many missions/);
  w.handle.destroy();
});

test('the old plan cannot be downloaded in the moment between an option change and the new plan', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  const slider = w.control('Height above ground');
  slider.value = '90';
  slider.dispatch('input');
  assert.equal(w.buttons('data-mission')[0].disabled, true, 'locked at once');
  w.handle.downloadMission(0);
  assert.equal(w.downloads.length, 0);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(w.handle.getResult().plan.options.aglM, 90);
  assert.equal(w.buttons('data-mission')[0].disabled, false);
  w.handle.downloadMission(0);
  assert.equal(w.downloads.length, 1);
  w.handle.destroy();
});

test('closing the tool forgets the terrain it read', async () => {
  let reads = 0;
  const w = setup({
    sample: async (cartos) => {
      reads += 1;
      return flat(cartos);
    },
  });
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  const first = reads;
  await w.handle.replan();
  assert.equal(reads, first, 'a repeat plan is served from the cache');
  w.handle.close();
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  assert.ok(reads > first, 'after close the heights are read again');
  w.handle.destroy();
});

test('switching the terrain provider forgets the heights read from the old one', async () => {
  let reads = 0;
  const w = setup({
    sample: async (cartos) => {
      reads += 1;
      return flat(cartos);
    },
  });
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  const first = reads;
  await w.handle.replan();
  assert.equal(reads, first, 'same provider: served from the cache');
  w.viewer.terrainProvider = { requestTileGeometry() {} };
  await w.handle.replan();
  assert.ok(reads > first, 'a new provider is read afresh');
  w.handle.destroy();
});

test('drawing a new box (or setBox) drops the takeoff point picked for the old one', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  const m = metersPerDegree(30.27);
  assert.equal(
    w.handle.setTakeoff({ lon: -97.77 + 100 / m.lon, lat: 30.27 }),
    true,
  );
  assert.notEqual(w.handle.getState().takeoff, null);
  w.handle.setBox(boxM(250, 250));
  assert.equal(w.handle.getState().takeoff, null);
  w.handle.destroy();
});

// ------------------------------------------------------- aircraft picker --
const pick = (w, label, value) => {
  const c = w.control(label);
  c.value = value;
  c.dispatch('change');
};
const rowOf = (control) => control.parentNode.parentNode;

test('every aircraft can be picked; the summary, recommended block and KMZ gate follow it', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  const info = () =>
    w.find((n) => n.attributes.get('data-role') === 'preset-info')[0]
      .textContent;
  for (const [id, name, kmz] of [
    ['dji-mini-5-pro', 'Mini 5 Pro', true],
    ['dji-mini-4-pro', 'Mini 4 Pro', true],
    ['dji-air-3', 'Air 3', false],
    ['dji-air-3s', 'Air 3S', false],
    ['dji-mavic-3', 'Mavic 3', false],
    ['dji-phantom-4', 'Phantom 4', false],
  ]) {
    pick(w, 'Aircraft', id);
    await w.handle.replan();
    assert.match(info(), /shutter/);
    assert.ok(
      w.find((n) => n.attributes.get('data-role') === 'recommended')[0].children
        .length > 0,
      `${name} recommendation shown`,
    );
    assert.equal(
      w.buttons('data-mission').every((b) => !b.disabled),
      kmz,
      `${name} KMZ buttons`,
    );
    assert.equal(w.buttons('data-download')[0].disabled, !kmz);
  }
  w.handle.destroy();
});

test('the Phantom 4 shows the reason, its preview stays, and no file can be made', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  pick(w, 'Aircraft', 'dji-phantom-4');
  await w.handle.replan();
  const why = w.find(
    (n) => n.attributes.get('data-code') === 'kmz-unavailable',
  );
  assert.equal(why.length, 1);
  assert.match(why[0].textContent, /DJI GO 4/);
  assert.ok(w.handle.getResult().missions.length > 0, 'path still planned');
  w.handle.downloadMission(0);
  w.handle.downloadAll();
  assert.equal(w.downloads.length, 0);
  // an aircraft code typed in cannot unlock it
  const field = w.control('DJI aircraft code in the mission file');
  field.value = '68';
  field.dispatch('change');
  w.handle.downloadMission(0);
  assert.equal(w.downloads.length, 0);
  w.handle.destroy();
});

test('an aircraft without a known code stays locked until a code is typed in', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  pick(w, 'Aircraft', 'dji-air-3');
  await w.handle.replan();
  w.handle.downloadMission(0);
  assert.equal(w.downloads.length, 0);
  assert.equal(
    w.find((n) => n.attributes.get('data-code') === 'kmz-unavailable').length,
    1,
  );
  const field = w.control('DJI aircraft code in the mission file');
  field.value = '77';
  field.dispatch('change');
  // no replan: the buttons and the reason follow the code at once
  assert.equal(
    w.buttons('data-mission').every((b) => !b.disabled),
    true,
  );
  assert.equal(
    w.find((n) => n.attributes.get('data-code') === 'kmz-unavailable').length,
    0,
  );
  w.handle.downloadMission(0);
  assert.equal(w.downloads.length, 1);
  field.value = '';
  field.dispatch('change');
  assert.equal(
    w.buttons('data-mission').every((b) => b.disabled),
    true,
  );
  w.handle.destroy();
});

test('USE RECOMMENDED applies the aircraft and mode values and the plan honours them', async () => {
  const w = setup();
  w.handle.setBox(boxM(400, 300));
  pick(w, 'Aircraft', 'dji-mavic-3');
  pick(w, 'Mode', 'fast-survey');
  const use = w
    .buttons('data-action')
    .find((b) => b.getAttribute('data-action') === 'use-recommended');
  use.click();
  await w.handle.replan();
  const r = w.handle.getResult();
  assert.equal(r.plan.options.photoMode, 'interval');
  assert.equal(r.plan.options.aglM, 120);
  assert.equal(r.plan.options.presetId, 'dji-mavic-3');
  assert.equal(r.plan.speedLimitedBy, null);
  pick(w, 'Mode', 'splat-orbit');
  use.click();
  await w.handle.replan();
  assert.equal(w.handle.getResult().plan.options.pattern, 'orbit');
  w.handle.destroy();
});

test('P3: the photo-mode row is hidden for an orbit and back for a grid', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  const photos = w.control('Photos');
  assert.equal(rowOf(photos).hidden, false);
  pick(w, 'Mode', 'splat-orbit');
  assert.equal(rowOf(photos).hidden, true);
  pick(w, 'Mode', 'mapping-grid');
  assert.equal(rowOf(photos).hidden, false);
  w.handle.destroy();
});

test('the shutter control feeds the blur limit', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  pick(w, 'Aircraft', 'dji-mavic-3');
  const speed = w.control('Speed');
  speed.value = '15';
  speed.dispatch('input');
  pick(w, 'Shutter speed', '250');
  await w.handle.replan();
  const r = w.handle.getResult();
  assert.equal(r.plan.options.shutterDenominator, 250);
  assert.equal(r.plan.speedLimitedBy, 'blur');
  assert.ok(
    w.find((n) => n.attributes.get('data-code') === 'speed-blur-limited')
      .length === 1,
  );
  w.handle.destroy();
});

test('picking Mapping grid keeps a double-grid pattern; another mode changes it', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  pick(w, 'Pattern', 'double');
  pick(w, 'Mode', 'mapping-grid');
  assert.equal(w.control('Pattern').value, 'double');
  pick(w, 'Mode', 'splat-orbit');
  assert.equal(w.control('Pattern').value, 'orbit');
  w.handle.destroy();
});

test('P3: a plan whose camera limit is below the minimum planned speed cannot be downloaded', async () => {
  const w = setup();
  w.handle.setBox(boxM(60, 60));
  // 1/60 s is not on the shutter list, but the planner accepts it: at 10 m the
  // blur limit then falls under the 0.1 m/s floor.
  Object.assign(w.handle.getState().options, {
    aglM: 10,
    shutterDenominator: 60,
  });
  await w.handle.replan();
  const codes = w.handle.getResult().warnings.map((x) => x.code);
  assert.ok(codes.includes('speed-below-minimum'), codes.join());
  assert.ok(!codes.includes('too-many-missions'), codes.join());
  assert.equal(
    w.buttons('data-mission').every((b) => b.disabled),
    true,
  );
  w.handle.downloadMission(0);
  assert.equal(w.downloads.length, 0);
  w.handle.destroy();
});

test('P3: the shutter control shows a real option before any interaction', () => {
  const w = setup();
  assert.equal(w.control('Shutter speed').value, '1000');
  w.handle.destroy();
});

test('PLAN ALL RECOMMENDED PASSES plans every pass and zips them; a change makes it stale', async () => {
  const w = setup();
  const btn = () =>
    w
      .buttons('data-action')
      .find((b) => b.getAttribute('data-action') === 'plan-suite');
  assert.equal(btn().disabled, true, 'off with no area');
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  assert.equal(btn().disabled, false);
  await w.handle.planSuite();
  const suite = w.handle.getState().suite;
  assert.deepEqual(
    suite.passes.map((p) => p.id),
    ['nadir', 'oblique60', 'oblique45', 'orbit'],
  );
  assert.ok(suite.passes.every((p) => p.result?.missions.length >= 1));
  const dl = w
    .buttons('data-download')
    .find((b) => b.getAttribute('data-download') === 'suite');
  assert.equal(dl.disabled, false);
  w.handle.downloadSuite();
  assert.equal(w.downloads.length, 1);
  assert.match(w.downloads[0].name, /-all-passes\.zip$/);
  const names = [...readZip(w.downloads[0].bytes).keys()];
  assert.ok(names.includes('README.txt'));
  for (const id of ['nadir', 'oblique60', 'oblique45', 'orbit']) {
    assert.ok(
      names.some((n) => n.includes(`-${id}/`) && n.endsWith('.kmz')),
      id,
    );
  }
  w.handle.getState().options.aglM = 60;
  await w.handle.replan();
  assert.equal(
    w.handle.getState().suite,
    null,
    'a replan drops the stale suite',
  );
  w.handle.destroy();
});

test('voice handle methods drive the same plan the buttons do', async () => {
  const w = setup();
  w.handle.open({ draw: false });
  assert.equal(w.handle.isOpen(), true);
  assert.equal(w.handle.applyOptions({ aglM: 80 }), true);
  assert.equal(w.handle.getState().options.aglM, 80);
  w.handle.setBox(boxM(300, 200));
  assert.equal(w.handle.getState().areas.length, 1);
  const id = w.handle.getState().areas[0].id;
  assert.equal(w.handle.removeArea(id), true);
  assert.equal(w.handle.getState().areas.length, 0);
  w.handle.setBox(boxM(300, 200));
  assert.equal(w.handle.useRecommended('mapping-grid'), true);
  assert.equal(typeof w.handle.downloadsAllowed(), 'boolean');
  assert.equal(typeof w.handle.suiteAllowed(), 'boolean');
  w.handle.destroy();
});

test('close drops the all-passes plan so voice cannot download it', async () => {
  const w = setup();
  w.handle.open({ draw: false });
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  await w.handle.planSuite();
  assert.equal(w.handle.suiteAllowed(), true);
  const voice = createDronePlanVoice(w.handle);
  const closed = await voice.close();
  assert.equal(closed.cleared, true);
  assert.equal(w.handle.getState().suite, null);
  assert.equal(w.handle.suiteAllowed(), false);
  const result = await voice.download({ which: 'suite' });
  assert.equal(result.ok, false);
  w.handle.destroy();
});

// ------------------------------------------------- orbit targets + clearance --
const targetIds = (w) =>
  (w.handle.getState().options.orbitTargets ?? []).map((x) => x.id);

test('orbit: targets are recommended from the area and listed with a remove button', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  pick(w, 'Mode', 'splat-orbit');
  await w.handle.replan();
  const list = w.handle.getState().options.orbitTargets;
  assert.equal(list.length, 1);
  assert.equal(list[0].source, 'area', 'no footprints: the area centre');
  assert.equal(w.buttons('data-remove-target').length, 1);
  assert.equal(w.handle.getResult().plan.orbit.targets.length, 1);
  assert.ok(w.control('Tree / obstacle height'));
  assert.equal(w.handle.getState().options.obstacleHeightM, 15);
  w.handle.destroy();
});

test('orbit: building footprints from the provider become the recommended targets', async () => {
  resetPointerOwnership();
  const dom = makeDoc();
  const world = makeWorld({ sample: (c) => flat(c) });
  const m = metersPerDegree(30.27);
  const sq = (dx, dy, s) =>
    [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => ({
      lon: -97.77 + (dx + (a * s) / 2) / m.lon,
      lat: 30.27 + (dy + (b * s) / 2) / m.lat,
    }));
  const handle = initDronePlan({
    viewer: world.viewer,
    cesium: world.cesium,
    document: dom.doc,
    downloadFile: () => {},
    getBuildingFootprints: async () => [
      { ring: sq(-50, 0, 20), label: 'House' },
      { ring: sq(60, 20, 40), label: 'Barn' },
    ],
  });
  handle.setBox(boxM(300, 200));
  handle.applyOptions({ pattern: 'orbit' });
  await handle.replan();
  await new Promise((r) => setTimeout(r, 5));
  await handle.replan();
  assert.deepEqual(
    handle.getState().options.orbitTargets.map((x) => x.label),
    ['Barn', 'House'],
  );
  handle.destroy();
});

test('orbit: map clicks add custom targets inside the area only; targets can be removed', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  pick(w, 'Mode', 'splat-orbit');
  await w.handle.replan();
  const m = metersPerDegree(30.27);
  const inside = { lon: -97.77 + 50 / m.lon, lat: 30.27 };
  const outside = { lon: -97.77 + 900 / m.lon, lat: 30.27 };
  assert.equal(w.handle.addOrbitTarget(outside), false);
  assert.equal(w.handle.addOrbitTarget(inside), true);
  await w.handle.replan();
  assert.equal(targetIds(w).length, 2);
  assert.equal(w.handle.getResult().plan.orbit.targets.length, 2);
  assert.ok(
    w.handle.getResult().plan.legs.some((l) => l.kind === 'transit'),
    'the two targets are joined by a transit above the trees',
  );
  // The list is now the user's: a replan does not rebuild it.
  await w.handle.replan();
  assert.equal(targetIds(w).length, 2);
  const custom = w.handle
    .getState()
    .options.orbitTargets.find((x) => x.source === 'custom');
  assert.equal(w.handle.setOrbitTargetActive(custom.id, false), true);
  await w.handle.replan();
  assert.equal(w.handle.getResult().plan.orbit.targets.length, 1);
  assert.equal(w.handle.removeOrbitTarget(custom.id), true);
  assert.equal(w.handle.removeOrbitTarget('nope'), false);
  assert.equal(targetIds(w).length, 1);
  w.handle.recommendTargets();
  assert.equal(
    w.handle.getState().options.orbitTargets[0].source,
    'area',
    'RECOMMEND drops the hand edits',
  );
  w.handle.destroy();
});

test('orbit: removing every target falls back to the area centre', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  pick(w, 'Mode', 'splat-orbit');
  await w.handle.replan();
  const only = targetIds(w)[0];
  w.handle.removeOrbitTarget(only);
  await w.handle.replan();
  // An empty touched list falls back to the area centre rather than failing.
  assert.equal(w.handle.getResult().plan.orbit.targets.length, 1);
  w.handle.destroy();
});

test('orbit: obstacle height raises the orbit and shows the fly-over height', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  pick(w, 'Mode', 'splat-orbit');
  w.handle.applyOptions({ obstacleHeightM: 45, orbitHeightsM: [20, 30] });
  await w.handle.replan();
  const plan = w.handle.getResult().plan;
  assert.equal(plan.orbit.minAglM, 50);
  assert.ok(
    plan.legs
      .flatMap((l) => l.waypoints)
      .every((wp) => wp.aglM >= 50),
  );
  assert.ok(
    w.handle.getResult().warnings.some(
      (x) => x.code === 'orbit-raised-for-obstacles',
    ),
  );
  assert.ok(w.stats()['Fly-over height']);
  w.handle.destroy();
});

// ------------------------------------------- all passes on the globe --
const PASS_IDS = ['nadir', 'oblique60', 'oblique45', 'orbit'];
const globe = (w) =>
  w.viewer.dataSources.sources.find((x) => x.name === 'gev-drone-plan').entities
    .values;
const passLines = (w, id) =>
  globe(w).filter((e) => e.polyline && e.name?.startsWith(`${id} mission`));
const singleLines = (w) =>
  globe(w).filter((e) => e.polyline && /^Mission \d/.test(e.name ?? ''));
const toggles = (w) =>
  w.find((n) => n.tagName === 'INPUT' && n.attributes.has('data-pass-visible'));
const toggle = (w, id) =>
  toggles(w).find((n) => n.getAttribute('data-pass-visible') === id);
const flip = (box) => {
  box.checked = !box.checked;
  box.dispatch('change');
};

test('PLAN ALL RECOMMENDED PASSES draws every pass and replaces the single plan on the globe', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  assert.ok(singleLines(w).length >= 1, 'single plan drawn first');
  await w.handle.planSuite();
  assert.equal(singleLines(w).length, 0, 'the suite replaces the single plan');
  for (const id of PASS_IDS) assert.ok(passLines(w, id).length >= 1, id);
  const materials = new Set(
    PASS_IDS.map((id) => {
      const m = passLines(w, id)[0].polyline.material;
      return m.options ? `dash-${m.options.dashLength}` : 'solid';
    }),
  );
  assert.deepEqual(
    [...materials].sort(),
    ['dash-18', 'dash-6', 'solid'],
    'nadir solid, oblique60 dashed, oblique45 dotted, orbit solid',
  );
  assert.ok(passLines(w, 'orbit')[0].polyline.positions.heights);
  assert.equal(globe(w).filter((e) => e.name === 'Takeoff').length, 1);
  w.handle.destroy();
});

test('every pass row has a checked checkbox and a colour swatch; hiding one removes only its drawing', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  await w.handle.planSuite();
  assert.deepEqual(
    toggles(w).map((n) => n.getAttribute('data-pass-visible')),
    PASS_IDS,
  );
  assert.ok(toggles(w).every((n) => n.checked && !n.disabled));
  const swatches = w.find((n) => n.className.includes('gev-dp-swatch'));
  assert.equal(swatches.length, 4);
  assert.equal(new Set(swatches.map((n) => n.style.backgroundColor)).size, 4);
  flip(toggle(w, 'oblique60'));
  assert.equal(passLines(w, 'oblique60').length, 0);
  for (const id of ['nadir', 'oblique45', 'orbit']) {
    assert.ok(passLines(w, id).length >= 1, id);
  }
  assert.equal(w.handle.getState().suiteHidden.has('oblique60'), true);
  flip(toggle(w, 'oblique60'));
  assert.ok(passLines(w, 'oblique60').length >= 1, 'shown again');
  w.handle.destroy();
});

test('pass visibility survives a re-render but resets when a new suite is planned', async () => {
  // Partial terrain makes the suite show its acknowledge box, whose change
  // re-renders the panel without replanning.
  const w = setup({
    sample: async (cartos) => cartos.map((c) => ({ ...c, height: undefined })),
  });
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  await w.handle.planSuite();
  flip(toggle(w, 'nadir'));
  const ack = w.find(
    (n) =>
      n.tagName === 'INPUT' && n.getAttribute('data-ack') === 'suite-terrain',
  )[0];
  assert.ok(ack, 'the terrain-ack box exists');
  flip(ack);
  assert.equal(
    toggle(w, 'nadir').checked,
    false,
    'still unchecked after render',
  );
  assert.equal(passLines(w, 'nadir').length, 0);
  await w.handle.planSuite();
  assert.equal(toggle(w, 'nadir').checked, true, 'new suite: all visible');
  assert.ok(passLines(w, 'nadir').length >= 1);
  w.handle.destroy();
});

test('a pass with no result has a disabled, unchecked checkbox and no drawing', async () => {
  // Partial terrain shows the acknowledge box, whose change re-renders.
  const w = setup({
    sample: async (cartos) => cartos.map((c) => ({ ...c, height: undefined })),
  });
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  await w.handle.planSuite();
  const st = w.handle.getState();
  st.suite.passes[1] = {
    ...st.suite.passes[1],
    result: null,
    error: { code: 'x' },
  };
  flip(
    w.find(
      (n) =>
        n.tagName === 'INPUT' && n.getAttribute('data-ack') === 'suite-terrain',
    )[0],
  );
  assert.equal(toggle(w, 'oblique60').disabled, true);
  assert.equal(toggle(w, 'oblique60').checked, false);
  assert.equal(toggle(w, 'nadir').disabled, false);
  w.handle.destroy();
});

test('a replan or closing the panel removes the suite drawing and restores the single plan', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  await w.handle.planSuite();
  assert.ok(passLines(w, 'nadir').length >= 1);
  w.handle.getState().options.aglM = 60;
  await w.handle.replan();
  assert.equal(w.handle.getState().suite, null);
  for (const id of PASS_IDS) assert.equal(passLines(w, id).length, 0, id);
  assert.ok(singleLines(w).length >= 1, 'single plan back');
  await w.handle.planSuite();
  assert.equal(singleLines(w).length, 0);
  w.handle.close();
  assert.equal(globe(w).length, 0, 'close clears everything');
  w.handle.destroy();
});

// ------------------------------------------- OSM building lookup wiring --
test('orbit: the Overpass provider feeds the panel; targets get sized orbits and roof-aware rings', async () => {
  resetPointerOwnership();
  const dom = makeDoc();
  const world = makeWorld({ sample: (c) => flat(c) });
  const calls = [];
  const provider = createBuildingFootprintProvider({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return okResponse(downtownPayload());
    },
  });
  const handle = initDronePlan({
    viewer: world.viewer,
    cesium: world.cesium,
    document: dom.doc,
    downloadFile: () => {},
    getBuildingFootprints: provider,
  });
  handle.setBox(boxM(300, 200));
  handle.applyOptions({ pattern: 'orbit' });
  await handle.replan();
  await new Promise((r) => setTimeout(r, 10));
  await handle.replan();
  assert.equal(calls.length, 1, 'one lookup per area set');
  assert.equal(calls[0].url, '/api/overpass');
  const targets = handle.getState().options.orbitTargets;
  assert.ok(targets.length >= 3 && targets.every((x) => x.source === 'building'));
  assert.ok(targets.every((x) => x.radiusM >= 10 && x.radiusM <= 300));
  const orbit = handle.getResult().plan.orbit;
  const hall = orbit.targets.find((x) => x.label === 'Hall');
  assert.equal(hall.roofHeightM, 12);
  assert.equal(hall.heightM, 6);
  assert.ok(hall.ringsAglM.every((h) => h >= 12 + 15 && h >= orbit.minAglM));
  handle.destroy();
});

test('orbit: a failing or timed-out lookup falls back to the area centre', async () => {
  for (const fetchImpl of [
    async () => ({ ok: false, status: 500 }),
    () => new Promise(() => {}),
  ]) {
    resetPointerOwnership();
    const dom = makeDoc();
    const world = makeWorld({ sample: (c) => flat(c) });
    const handle = initDronePlan({
      viewer: world.viewer,
      cesium: world.cesium,
      document: dom.doc,
      downloadFile: () => {},
      getBuildingFootprints: createBuildingFootprintProvider({ fetchImpl, timeoutMs: 15 }),
    });
    handle.setBox(boxM(300, 200));
    handle.applyOptions({ pattern: 'orbit' });
    await handle.replan();
    await new Promise((r) => setTimeout(r, 50));
    await handle.replan();
    const targets = handle.getState().options.orbitTargets;
    assert.deepEqual(targets.map((x) => x.source), ['area']);
    assert.equal(handle.getResult().plan.orbit.targets[0].radiusM, handle.getResult().plan.options.orbitRadiusM);
    handle.destroy();
  }
});

// --------------------------------------------------------------- 3D check --
const checkOf = (w, prefix) =>
  globe(w).filter((e) => e.name?.startsWith(`3D check ${prefix}`));
const checkBox = (w, key) =>
  w.find((n) => n.getAttribute('data-check') === key)[0];
const checkSlider = (w, key) =>
  w.find((n) => n.getAttribute('data-check-slider') === key)[0];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('3D check section: defaults are zone 10 m, curtain on, one pyramid, and it says visual only', async () => {
  const w = setup();
  const section = w.find((n) => n.getAttribute('data-role') === '3d-check')[0];
  assert.ok(section, 'section exists');
  const text = section.textContent;
  assert.match(text, /Visual check only/);
  assert.match(text, /no trees or power lines/);
  assert.equal(checkBox(w, 'enabled').checked, true);
  assert.equal(checkBox(w, 'zone').checked, true);
  assert.equal(checkBox(w, 'curtain').checked, true, 'curtain on by default');
  assert.equal(checkBox(w, 'footprints').checked, true);
  assert.equal(checkSlider(w, 'width').value, '10');
  assert.equal(checkBox(w, 'frustum').value, 'one');
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  assert.ok(checkOf(w, 'zone').length >= 1);
  assert.ok(checkOf(w, 'curtain').length >= 1);
  assert.ok(checkOf(w, 'footprint').length >= 1);
  assert.equal(checkOf(w, 'view').length, 5, 'one pyramid');
  assert.equal(checkOf(w, 'zone')[0].polylineVolume.shape[1].x, 10);
  w.handle.destroy();
});

test('3D check: the width slider rebuilds only the zone, after it settles', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  const curtain = checkOf(w, 'curtain').slice();
  const slider = checkSlider(w, 'width');
  slider.value = '18';
  slider.dispatch('input');
  slider.value = '20';
  slider.dispatch('input');
  assert.equal(checkOf(w, 'zone')[0].polylineVolume.shape[1].x, 10, 'debounced');
  await wait(260);
  assert.equal(checkOf(w, 'zone')[0].polylineVolume.shape[1].x, 20);
  assert.ok(checkOf(w, 'curtain').every((e, i) => e === curtain[i]));
  assert.match(
    w.find((n) => n.tagName === 'OUTPUT' && /20 m/.test(n.textContent))[0].textContent,
    /20 m/,
  );
  w.handle.destroy();
});

test('3D check: toggles remove only their own layer; master switch removes all', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  const flipTo = (key, on) => {
    const box = checkBox(w, key);
    box.checked = on;
    box.dispatch('change');
  };
  flipTo('curtain', false);
  assert.equal(checkOf(w, 'curtain').length, 0);
  assert.ok(checkOf(w, 'zone').length && checkOf(w, 'footprint').length);
  flipTo('zone', false);
  assert.equal(checkOf(w, 'zone').length, 0);
  flipTo('footprints', false);
  assert.equal(checkOf(w, 'footprint').length, 0);
  assert.equal(checkOf(w, 'view').length, 5);
  const view = checkBox(w, 'frustum');
  view.value = 'off';
  view.dispatch('change');
  assert.equal(checkOf(w, 'view').length, 0);
  flipTo('curtain', true);
  assert.ok(checkOf(w, 'curtain').length);
  flipTo('enabled', false);
  assert.equal(globe(w).filter((e) => e.name?.startsWith('3D check')).length, 0);
  assert.equal(checkBox(w, 'zone').disabled, true);
  w.handle.destroy();
});

test('3D check: the photo slider steps one pyramid through the plan and the readout follows', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  const slider = checkSlider(w, 'photo');
  const photos = Number(slider.max);
  assert.ok(photos > 10, `photos ${photos}`);
  assert.equal(slider.value, '1');
  const readout = () =>
    w.find((n) => n.getAttribute('data-role') === 'check-readout')[0].textContent;
  assert.match(readout(), /Photo 1 of/);
  const first = checkOf(w, 'view')[0].polygon.hierarchy.heights.slice(0, 3);
  slider.value = '9';
  slider.dispatch('input');
  assert.equal(checkOf(w, 'view').length, 5);
  assert.match(readout(), /Photo 9 of/);
  assert.notDeepEqual(
    checkOf(w, 'view')[0].polygon.hierarchy.heights.slice(0, 3),
    first,
  );
  const view = checkBox(w, 'frustum');
  view.value = 'thinned';
  view.dispatch('change');
  assert.ok(checkOf(w, 'view').length > 5);
  assert.equal(checkSlider(w, 'photo').disabled, true, 'slider only in one-at-a-time mode');
  w.handle.destroy();
});

test('3D check follows each pass checkbox and goes with replan and destroy', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  await w.handle.planSuite();
  const passesOf = (prefix) =>
    new Set(checkOf(w, prefix).map((e) => e.name.split(': ')[1].split(' ')[0]));
  assert.deepEqual([...passesOf('zone')].sort(), [...PASS_IDS].sort());
  flip(toggle(w, 'oblique60'));
  assert.equal(passesOf('zone').has('oblique60'), false);
  assert.equal(passesOf('curtain').has('oblique60'), false);
  assert.equal(passesOf('zone').has('nadir'), true);
  assert.match(
    w.find((n) => n.getAttribute('data-role') === 'check-readout')[0].textContent,
    /Photo 1 of/,
  );
  w.handle.setBox(boxM(200, 200));
  await w.handle.replan();
  assert.equal(passesOf('zone').has('nadir'), false, 'replan drops the suite layers');
  assert.ok(checkOf(w, 'zone').length >= 1, 'single plan drawn instead');
  w.handle.destroy();
  assert.equal(globe(w).length, 0);
});

// -------------------------------------------------- per-obstacle heights --
const obstacleRows = () => [
  { id: 'faa-48-1', kind: 'tower', source: 'faa', lon: -97.77, lat: 30.27, radiusM: 6, estimatedHeightM: 61, heightM: 61 },
  { id: 'chm-1', kind: 'tree', source: 'canopy', lon: -97.7695, lat: 30.2703, radiusM: 20, estimatedHeightM: 18, heightM: 18 },
];

function obstacleWorld(fetchObstacles) {
  resetPointerOwnership();
  const dom = makeDoc();
  const world = makeWorld({ sample: async (c) => flat(c) });
  const overlays = [];
  const handle = initDronePlan({
    viewer: world.viewer,
    cesium: world.cesium,
    document: dom.doc,
    downloadFile: () => {},
    getBuildingFootprints: async () => [],
    fetchObstacles,
    overlay: { set: (l) => overlays.push(l), clear: () => overlays.push(null) },
  });
  const find = (pred) => all(dom.body, pred);
  const heightBox = (id) =>
    find((n) => n.getAttribute('data-obstacle-height') === id)[0];
  const button = (attr, id) =>
    find((n) => n.tagName === 'BUTTON' && n.getAttribute(attr) === id)[0];
  return { ...dom, ...world, handle, overlays, find, heightBox, button };
}
const settle = () => new Promise((r) => setTimeout(r, 15));

test('obstacles: open-data estimates appear in the panel with their source', async () => {
  const w = obstacleWorld(async () => ({
    obstacles: obstacleRows(),
    status: { faa: 'ok', canopy: 'ok' },
  }));
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  await settle();
  const list = w.handle.obstacles.list();
  assert.deepEqual(list.map((o) => o.id).sort(), ['chm-1', 'faa-48-1']);
  assert.equal(w.heightBox('faa-48-1').value, '61');
  const text = w.find((n) => n.className.includes('gev-dp-obstacle-source')).map((n) => n.textContent);
  assert.ok(text.some((x) => x.includes('FAA obstacle file: 61 m')), text.join('|'));
  assert.ok(w.overlays.some((l) => l?.some((e) => e.title === 'tower 61 m')));
  assert.match(
    w.find((n) => n.className.includes('gev-dp-obstacle-disclaimer'))[0].textContent,
    /not a survey.*Trees grow.*Power lines.*not flight-tested/s,
  );
  w.handle.destroy();
});

test('obstacles: typing a height changes the column and the plan, Reset goes back, x removes', async () => {
  const w = obstacleWorld(async () => ({ obstacles: obstacleRows(), status: {} }));
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  await settle();
  const box = w.heightBox('faa-48-1');
  box.value = '90';
  box.dispatch('input');
  const o = w.handle.obstacles.list().find((x) => x.id === 'faa-48-1');
  assert.equal(o.heightM, 90);
  assert.equal(o.userEdited, true);
  assert.equal(w.handle.getState().options.obstacles.find((x) => x.id === 'faa-48-1').heightM, 90);
  w.overlays.length = 0;
  w.handle.obstacles.setHeight('chm-1', 25);
  assert.ok(w.overlays.at(-1).some((e) => e.title === 'tree 25 m'));
  const reset = w.button('data-reset-obstacle', 'faa-48-1');
  assert.equal(reset.disabled, false);
  reset.dispatch('click');
  assert.equal(w.handle.obstacles.list().find((x) => x.id === 'faa-48-1').heightM, 61);
  w.button('data-remove-obstacle', 'chm-1').dispatch('click');
  assert.deepEqual(w.handle.obstacles.list().map((x) => x.id), ['faa-48-1']);
  w.handle.destroy();
});

test('obstacles: an edit survives a new look-up, and a failing look-up never blocks the plan', async () => {
  let fail = false;
  const w = obstacleWorld(async () => {
    if (fail) throw new Error('down');
    return { obstacles: obstacleRows(), status: {} };
  });
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  await settle();
  w.handle.obstacles.setHeight('faa-48-1', 99);
  const mine = w.handle.obstacles.add({ lon: -97.7701, lat: 30.2701 });
  assert.ok(mine);
  fail = true;
  w.handle.obstacles.refresh();
  await settle();
  assert.equal(w.handle.obstacles.list().find((x) => x.id === 'faa-48-1').heightM, 99);
  assert.ok(w.handle.obstacles.list().some((x) => x.id === mine.id));
  assert.match(
    w.find((n) => n.className.includes('gev-dp-obstacle-status'))[0].textContent,
    /unavailable/,
  );
  await w.handle.replan();
  assert.equal(w.panel.dataset.state, 'ready');
  w.handle.destroy();
});

test('obstacles: a tall obstacle lifts the plan and warns; the plan keeps working with none', async () => {
  const w = obstacleWorld(async () => ({ obstacles: [], status: {} }));
  w.handle.setBox(boxM(160, 160));
  w.handle.getState().options.aglM = 40;
  await w.handle.replan();
  const before = w.handle.getResult().missions.flatMap((m) => m.waypoints).map((p) => p.aglM);
  assert.ok(before.every((h) => h === 40));
  w.handle.obstacles.add({ lon: -97.77, lat: 30.27, heightM: 80 });
  await settle();
  await w.handle.replan();
  const after = w.handle.getResult();
  assert.ok(after.missions.flatMap((m) => m.waypoints).some((p) => p.aglM >= 85));
  assert.ok(after.warnings.some((x) => x.code === 'obstacle-raised'));
  w.handle.destroy();
});

test('obstacles: closing the panel and starting over forgets the obstacles', async () => {
  const w = obstacleWorld(async () => ({ obstacles: obstacleRows(), status: {} }));
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  await settle();
  assert.equal(w.handle.obstacles.list().length, 2);
  w.handle.destroy();
  assert.equal(w.handle.obstacles.list().length, 0);
});

test('obstacles: Reset and x still redraw the list while that button has focus', async () => {
  const w = obstacleWorld(async () => ({ obstacles: obstacleRows(), status: {} }));
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  await settle();
  w.handle.obstacles.setHeight('faa-48-1', 90);
  // Like a browser: the list contains whatever is inside it.
  const listNode = w.find((n) => n.className.includes('gev-dp-obstacle-list'))[0];
  listNode.contains = (n) => all(listNode, (x) => x === n).length > 0;
  const reset = w.button('data-reset-obstacle', 'faa-48-1');
  w.doc.activeElement = reset;
  reset.dispatch('click');
  assert.equal(w.heightBox('faa-48-1').value, '61', 'the box shows the estimate again');
  const remove = w.button('data-remove-obstacle', 'chm-1');
  w.doc.activeElement = remove;
  remove.dispatch('click');
  assert.equal(w.button('data-remove-obstacle', 'chm-1'), undefined, 'the row is gone');
  w.handle.destroy();
});

test('obstacles: Enter in a height box (change, box still focused) enables Reset in place', async () => {
  const w = obstacleWorld(async () => ({ obstacles: obstacleRows(), status: {} }));
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  await settle();
  const listNode = w.find((n) => n.className.includes('gev-dp-obstacle-list'))[0];
  listNode.contains = (n) => all(listNode, (x) => x === n).length > 0;
  const box = w.heightBox('faa-48-1');
  w.doc.activeElement = box;
  box.value = '90';
  const resetBefore = w.button('data-reset-obstacle', 'faa-48-1');
  assert.equal(resetBefore.disabled, true, 'nothing edited yet');
  box.dispatch('input'); // typing: the box must not be rebuilt under the caret
  assert.equal(w.heightBox('faa-48-1'), box, 'same node while typing');
  box.dispatch('change'); // Enter or blur commits
  const reset = w.button('data-reset-obstacle', 'faa-48-1');
  assert.equal(reset, resetBefore, 'the row is not rebuilt, so a click on Reset is not lost');
  assert.equal(w.heightBox('faa-48-1'), box, 'keyboard focus stays in the box');
  assert.equal(reset.disabled, false, 'Reset follows the committed edit');
  w.doc.activeElement = reset; // a click moves focus to the button first
  reset.dispatch('click');
  assert.equal(w.heightBox('faa-48-1').value, '61');
  w.handle.destroy();
});

test('obstacles: the status line shows THIS look-up\'s "not planned" count', async () => {
  const many = Array.from({ length: MAX_OBSTACLES + 7 }, (_, i) => ({
    id: `faa-48-${i}`,
    kind: 'tower',
    source: 'faa',
    lon: -97.77 + i * 1e-5,
    lat: 30.27,
    radiusM: 6,
    estimatedHeightM: 100 - i * 0.1,
    heightM: 100 - i * 0.1,
  }));
  const w = obstacleWorld(async () => ({ obstacles: many, status: {} }));
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  await settle();
  const text = w.find((n) => n.className.includes('gev-dp-obstacle-status'))[0].textContent;
  assert.ok(text.includes('7 more not planned'), text);
  w.handle.destroy();
});

test('obstacles: a newer look-up aborts the older one', async () => {
  const signals = [];
  const w = obstacleWorld(async (areas, opts) => {
    signals.push(opts?.signal);
    return { obstacles: [], status: {} };
  });
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  await settle();
  w.handle.obstacles.refresh();
  await settle();
  assert.ok(signals.length >= 2);
  assert.equal(signals[0].aborted, true);
  assert.equal(signals.at(-1).aborted, false);
  w.handle.destroy();
  assert.equal(signals.at(-1).aborted, true);
});

test('obstacles: an obstacle the operator added can be set to a tower, and the credit line is shown', async () => {
  const w = obstacleWorld(async () => ({ obstacles: obstacleRows(), status: {} }));
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  await settle();
  const mine = w.handle.obstacles.add({ lon: -97.7701, lat: 30.2701 });
  const sel = w.find((n) => n.getAttribute?.('data-obstacle-kind') === mine.id)[0];
  assert.ok(sel, 'a kind selector for user obstacles');
  assert.equal(w.find((n) => n.getAttribute?.('data-obstacle-kind') === 'faa-48-1').length, 0, 'not for open-data rows');
  sel.value = 'tower';
  sel.dispatch('change');
  const o = w.handle.obstacles.list().find((x) => x.id === mine.id);
  assert.equal(o.kind, 'tower');
  assert.equal(o.radiusM, 6);
  assert.match(
    w.find((n) => n.className.includes('gev-dp-obstacle-credit'))[0].textContent,
    /Meta and WRI \(CC BY 4\.0\).*FAA.*OpenStreetMap/,
  );
  w.handle.destroy();
});

// ------------------------------------------------------------------ Adjust --
const roleNode = (w, role) =>
  w.find((n) => n.getAttribute('data-role') === role)[0];

test('Adjust: the section sits right after the plan buttons and the suite list, and holds the safety zone, orbit targets and obstacle heights', () => {
  const w = setup();
  const adjust = roleNode(w, 'adjust');
  assert.ok(adjust, 'Adjust section exists');
  const kids = adjust.parentNode.children;
  const at = (node) => kids.indexOf(node);
  const suite = roleNode(w, 'suite');
  const summary = roleNode(w, 'plan-summary');
  assert.equal(at(summary), at(suite) + 1, 'summary right after the suite list');
  assert.equal(at(adjust), at(summary) + 1, 'Adjust right after the summary');
  const useRec = w
    .buttons('data-action')
    .find((b) => b.getAttribute('data-action') === 'use-recommended');
  const planAll = w
    .buttons('data-action')
    .find((b) => b.getAttribute('data-action') === 'plan-suite');
  assert.ok(at(useRec) < at(planAll) && at(planAll) < at(suite));
  assert.equal(at(adjust) - at(useRec) <= 5, true, 'close under the buttons');
  const inside = (node) => {
    for (let n = node; n; n = n.parentNode) if (n === adjust) return true;
    return false;
  };
  assert.ok(inside(roleNode(w, '3d-check')), 'safety zone (3D check)');
  assert.ok(inside(checkSlider(w, 'width')), 'zone half-width slider');
  assert.ok(inside(checkSlider(w, 'photo')), 'photo stepper');
  assert.ok(inside(roleNode(w, 'check-readout')), 'readout');
  assert.ok(
    inside(w.buttons('data-action').find((b) => b.getAttribute('data-action') === 'recommend-targets')),
    'orbit targets',
  );
  assert.ok(
    inside(w.buttons('data-action').find((b) => b.getAttribute('data-action') === 'add-obstacle')),
    'obstacle heights',
  );
  // Order inside: safety zone, orbit targets, obstacle heights.
  const order = [
    roleNode(w, '3d-check'),
    w.buttons('data-action').find((b) => b.getAttribute('data-action') === 'recommend-targets'),
    w.buttons('data-action').find((b) => b.getAttribute('data-action') === 'add-obstacle'),
  ].map((n) => {
    let top = n;
    while (top.parentNode !== adjust) top = top.parentNode;
    return adjust.children.indexOf(top);
  });
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.equal(new Set(order).size, 3);
  w.handle.destroy();
});

test('Adjust: Orbit targets show for the Orbit pattern, and after PLAN ALL with a grid pattern, not for a plain grid', async () => {
  const w = setup();
  const targetsHidden = () => roleNode(w, 'orbit-targets').hidden;
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  assert.equal(w.handle.getState().options.pattern, 'grid');
  assert.equal(targetsHidden(), true, 'plain grid: hidden');
  await w.handle.planSuite();
  assert.ok(w.handle.getState().suite, 'suite planned');
  assert.equal(w.handle.getState().options.pattern, 'grid');
  assert.equal(targetsHidden(), false, 'after PLAN ALL: shown');
  assert.equal(w.buttons('data-remove-target').length, 1, 'a target is listed');
  assert.equal(
    w.handle.getState().suite.passes.find((p) => p.id === 'orbit').result.plan.orbit.targets.length,
    1,
  );
  // Removing a target replans (the suite goes stale) but the list stays.
  w.buttons('data-remove-target')[0].click();
  await w.handle.replan();
  assert.equal(w.handle.getState().suite, null);
  assert.equal(targetsHidden(), false, 'still shown after an edit');
  w.handle.destroy();
  const o = setup();
  o.handle.setBox(boxM(300, 200));
  pick(o, 'Mode', 'splat-orbit');
  await o.handle.replan();
  assert.equal(
    roleNode(o, 'orbit-targets').hidden,
    false,
    'Orbit pattern: shown',
  );
  o.handle.destroy();
});

// ------------------------------------------------------------ plan summary --
const summaryText = (w) => roleNode(w, 'plan-summary').textContent;
const fakeResult = (durationS, missionCount) => ({
  totals: { durationS, missionCount },
});

test('summary: a single plan shows time in the air, flights and batteries from its totals', async () => {
  const w = setup();
  assert.equal(roleNode(w, 'plan-summary').hidden, true, 'nothing without a plan');
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  const { totals } = w.handle.getResult();
  const min = w.handle.getState().options.batteryMin;
  const text = summaryText(w);
  const b = Math.max(1, Math.ceil(totals.durationS / (min * 60)));
  const fl = `${totals.missionCount} flight${totals.missionCount === 1 ? '' : 's'}`;
  const ba = `about ${b} batter${b === 1 ? 'y' : 'ies'}`;
  assert.match(text, /^Total: .* flying · /);
  assert.ok(text.includes(` · ${fl} · ${ba} (${min} min each)`), text);
  assert.doesNotMatch(text, /on site/);
  w.handle.destroy();
});

test('summary: PLAN ALL shows the grand total over all passes, hidden ones included; it clears with the plan', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  await w.handle.planSuite();
  const st = w.handle.getState();
  const flights = st.suite.passes.reduce((n, p) => n + p.result.totals.missionCount, 0);
  const seconds = st.suite.passes.reduce((n, p) => n + p.result.totals.durationS, 0);
  const expected = planSummary({ suite: st.suite, result: null, batteryMin: st.options.batteryMin });
  assert.equal(expected.flights, flights);
  assert.equal(expected.durationS, seconds);
  const hidden = summaryText(w);
  w.handle.getState().suiteHidden.add('oblique45');
  w.handle.getState().suiteHidden.add('orbit');
  assert.equal(summaryText(w), hidden, 'hiding passes does not change the total');
  assert.ok(hidden.includes(` · ${flights} flights · `), hidden);
  w.handle.destroy();
});

test('summary math: ceil of air time over battery time, at least one battery', () => {
  const r = (s, n) => planSummary({ suite: null, result: fakeResult(s, n), batteryMin: 25 });
  assert.equal(r(26 * 60, 2).batteries, 2, '26 min on 25 min batteries');
  assert.equal(r(25 * 60, 1).batteries, 1);
  assert.equal(r(60, 1).batteries, 1);
  assert.equal(r(0, 1).batteries, 1, 'at least one with a plan');
  assert.equal(planSummary({ suite: null, result: null, batteryMin: 25 }), null);
  assert.equal(
    planSummary({ suite: null, result: fakeResult(600, 1), batteryMin: 0 }).minutes,
    25,
    'bad battery time falls back to 25',
  );
});

test('summary: more flights than batteries adds the shared-battery note', async () => {
  const w = setup();
  const sum = planSummary({ suite: null, result: fakeResult(20 * 60, 3), batteryMin: 25 });
  assert.equal(sum.batteries, 1);
  assert.equal(sum.sharedBatteries, true);
  assert.equal(planSummary({ suite: null, result: fakeResult(40 * 60, 2), batteryMin: 25 }).sharedBatteries, false);
  // A real plan with more flights than batteries: a long area at a tiny
  // battery time gives several flights per battery-length of air time.
  w.handle.applyOptions({ batteryMin: 600 });
  w.handle.setBox(boxM(900, 700));
  await w.handle.replan();
  const { totals } = w.handle.getResult();
  assert.ok(totals.missionCount >= 2, `needs 2+ flights, got ${totals.missionCount}`);
  assert.match(summaryText(w), /about 1 battery \(600 min each\)/);
  assert.match(summaryText(w), /200-waypoint limit/);
  w.handle.destroy();
});

test('summary: a pass that did not plan is left out of the total and named', () => {
  const suite = {
    passes: [
      { id: 'nadir', label: 'Nadir', result: fakeResult(600, 1) },
      { id: 'oblique60', label: 'Oblique 60', result: fakeResult(900, 2) },
      { id: 'orbit', label: 'Orbits', result: null, error: 'x' },
    ],
  };
  const s = planSummary({ suite, result: null, batteryMin: 25 });
  assert.equal(s.durationS, 1500);
  assert.equal(s.flights, 3);
  assert.deepEqual(s.failed, ['Orbits']);
  assert.equal(planSummary({ suite: { passes: [{ id: 'a', label: 'A', result: null }] }, result: null, batteryMin: 25 }), null);
});

test('PLAN ALL: a late building-footprint reply does not wipe the suite, and the orbit pass uses the buildings', async () => {
  for (const pattern of ['grid', 'orbit']) {
    resetPointerOwnership();
    const dom = makeDoc();
    const world = makeWorld({ sample: (cartos) => flat(cartos) });
    const late = deferred();
    const handle = initDronePlan({
      viewer: world.viewer,
      cesium: world.cesium,
      document: dom.doc,
      downloadFile: () => {},
      getBuildingFootprints: () => late.promise,
    });
    handle.setBox(boxM(300, 200));
    handle.applyOptions({ pattern });
    await handle.replan();
    const planned = handle.planSuite();
    await wait(10);
    const c = metersPerDegree(30.27);
    const corner = (a, b) => ({
      lon: -97.77 + (a * 20) / c.lon,
      lat: 30.27 + (b * 20) / c.lat,
    });
    late.resolve([
      { ring: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)], label: 'Hall' },
    ]);
    await planned;
    await wait(400);
    assert.ok(handle.getState().suite, `${pattern}: the suite survives the late reply`);
    const targets = handle.getState().suite.passes.find((p) => p.id === 'orbit').result.plan.orbit.targets;
    assert.deepEqual(targets.map((x) => x.label), ['Hall'], `${pattern}: orbit pass uses the building`);
    handle.destroy();
  }
});

test('Adjust: RECOMMEND after PLAN ALL keeps a grid pattern a grid', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  await w.handle.planSuite();
  w.handle.recommendTargets();
  assert.equal(w.handle.getState().options.pattern, 'grid');
  w.handle.destroy();
});
