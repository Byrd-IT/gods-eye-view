import assert from 'node:assert/strict';
import test from 'node:test';
import {
  claimPointer,
  releasePointer,
  resetPointerOwnership,
} from '../../data/inputOwnership.js';
import { boxToolFakes } from '../../layers/recentImagery/testDoubles.mjs';
import { initDronePlan } from './panel.js';
import { metersPerDegree } from './geo.js';
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
  panel.hidden = true;
  panel.classList.add('collapsed');
  const body = new El('div');
  const entry = new El('button');
  const byId = new Map([
    ['drone-plan-panel', panel],
    ['drone-plan-panel-body', body],
    ['drone-plan-button', entry],
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
    Cartesian3: {
      fromDegreesArray: (v) => v,
      fromDegrees: (lon, lat) => [lon, lat],
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
test('a drawn box becomes stats, a path on the globe and downloadable missions', async () => {
  const w = setup();
  assert.ok(w.handle);
  assert.equal(w.panel.hidden, true, 'the card starts hidden');
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
  w.entry.click();
  assert.equal(w.panel.hidden, false);
  assert.equal(w.entry.getAttribute('aria-pressed'), 'true');
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  w.entry.click();
  assert.equal(w.panel.hidden, true);
  assert.equal(w.entry.getAttribute('aria-pressed'), 'false');
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
  const use = w.buttons('data-action')[0];
  use.click();
  await w.handle.replan();
  const r = w.handle.getResult();
  assert.equal(r.plan.options.photoMode, 'interval');
  assert.equal(r.plan.options.aglM, 120);
  assert.equal(r.plan.options.presetId, 'dji-mavic-3');
  assert.equal(r.plan.speedLimitedBy, null);
  pick(w, 'Mode', 'splat-orbit');
  w.buttons('data-action')[0].click();
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
