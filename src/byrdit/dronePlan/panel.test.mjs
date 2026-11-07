import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../../../server/byrdit/planLibrary/store.js';
import { createPlanLibraryHandler } from '../../../server/byrdit/planLibrary/api.js';
import { createLibraryClient } from './libraryClient.js';
import { warningText } from './libraryPanel.js';
import {
  claimPointer,
  releasePointer,
  resetPointerOwnership,
} from '../../data/inputOwnership.js';
import { boxToolFakes } from '../../layers/recentImagery/testDoubles.mjs';
import {
  initDronePlan,
  planSummary,
  captureFigures,
  captureTiltDeg,
  continuousBatteryLines,
  WARNING_TONE_COLOR,
} from './panel.js';
import { createBuildingFootprintProvider } from './buildingFootprints.js';
import { downtownPayload, okResponse } from './buildingFixtures.mjs';
import { createDronePlanVoice } from './dronePlanVoice.js';
import { readPlan, serializePlan } from './planDoc.js';
import { getPreset } from './presets.js';
import { assembleMissions, footprint, planFlight, spacing, writtenSpacingM } from './planner.js';
import { BATTERY_PAUSE_SOURCE, batteryPauseEstimate } from './preview.js';
import { batteryBreaks } from './batteryBreaks.js';
import { readmeText } from './wpml.js';
import {
  clearOverlaySource,
  getWorldOverlayDiagnostics,
} from '../../overlays/worldOverlay.js';
import { SHUTTER_DENOMINATORS, speedLimits } from './speed.js';
import { metersPerDegree } from './geo.js';
import { MAX_OBSTACLES } from './obstacles.js';
import { readZip } from './zip.js';
import { checkMission, parseDjiKmz } from './djiKmz.js';
import { makeGrid } from './surfaceFixtures.mjs';

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
  dispatch(type, ev = {}) {
    for (const fn of this.listeners.get(type) ?? [])
      fn({ target: this, ...ev });
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
  panel.querySelector = (sel) => (sel === '.panel-collapse-btn' ? entry : null);
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
function makeWorld({ sample, wrapPositions = false }) {
  const fakes = boxToolFakes();
  class ConstantPositionProperty {
    constructor(value) {
      this.value = value;
    }
    getValue() {
      return this.value;
    }
  }
  class CustomDataSource {
    constructor(name) {
      this.name = name;
      const values = [];
      this.entities = {
        values,
        add: (e) => {
          if (
            wrapPositions &&
            e?.position &&
            typeof e.position.getValue !== 'function'
          ) {
            e = { ...e, position: new ConstantPositionProperty(e.position) };
          }
          values.push(e);
          return e;
        },
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
        wrapPositions
          ? { x: lon, y: lat, z: h ?? 0 }
          : h === undefined
            ? [lon, lat]
            : [lon, lat, h],
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

// A browser's localStorage, in memory. The panel opens in feet unless this
// browser chose otherwise; most tests here were written in metres.
const memoryStorage = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    map,
  };
};

function setup({
  sample = async (cartos) => flat(cartos),
  libraryClient,
  surfaceClient,
  renderPreview,
  storage = memoryStorage({ 'gev.dronePlan.units': 'm' }),
  wrapPositions = false,
} = {}) {
  resetPointerOwnership();
  const dom = makeDoc();
  const world = makeWorld({
    sample: (cartos) => sample(cartos),
    wrapPositions,
  });
  const downloads = [];
  const handle = initDronePlan({
    viewer: world.viewer,
    cesium: world.cesium,
    document: dom.doc,
    downloadFile: (name, bytes, type) => downloads.push({ name, bytes, type }),
    libraryClient,
    ...(renderPreview ? { renderPreview } : {}),
    ...(surfaceClient ? { surfaceClient } : {}),
    unitStorage: storage,
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
    storage,
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
  assert.equal(
    w.panel.classList.contains('collapsed'),
    true,
    'and starts collapsed',
  );
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
    [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([a, b]) => ({
      lon: -97.77 + (dx + (a * s) / 2) / m.lon,
      lat: 30.27 + (dy + (b * s) / 2) / m.lat,
    }));
  const handle = initDronePlan({
    unitStorage: memoryStorage({ 'gev.dronePlan.units': 'm' }),
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
  w.handle.applyOptions({
    obstacleHeightM: 45,
    orbitHeightsM: [20, 30],
    orbitRingMode: 'heights',
  });
  await w.handle.replan();
  const plan = w.handle.getResult().plan;
  assert.equal(plan.orbit.minAglM, 50);
  assert.ok(plan.legs.flatMap((l) => l.waypoints).every((wp) => wp.aglM >= 50));
  assert.ok(
    w.handle
      .getResult()
      .warnings.some((x) => x.code === 'orbit-raised-for-obstacles'),
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
    unitStorage: memoryStorage({ 'gev.dronePlan.units': 'm' }),
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
  assert.ok(
    targets.length >= 3 && targets.every((x) => x.source === 'building'),
  );
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
      unitStorage: memoryStorage({ 'gev.dronePlan.units': 'm' }),
      viewer: world.viewer,
      cesium: world.cesium,
      document: dom.doc,
      downloadFile: () => {},
      getBuildingFootprints: createBuildingFootprintProvider({
        fetchImpl,
        timeoutMs: 15,
      }),
    });
    handle.setBox(boxM(300, 200));
    handle.applyOptions({ pattern: 'orbit' });
    await handle.replan();
    await new Promise((r) => setTimeout(r, 50));
    await handle.replan();
    const targets = handle.getState().options.orbitTargets;
    assert.deepEqual(
      targets.map((x) => x.source),
      ['area'],
    );
    assert.equal(
      handle.getResult().plan.orbit.targets[0].radiusM,
      handle.getResult().plan.options.orbitRadiusM,
    );
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
  assert.equal(checkBox(w, 'footprints').value, 'selected');
  assert.deepEqual(
    checkBox(w, 'footprints').children.map((o) => o.textContent),
    ['Selected photo only', 'All photos', 'Off'],
  );
  assert.equal(checkSlider(w, 'width').value, '10');
  assert.equal(checkBox(w, 'frustum').value, 'one');
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  assert.ok(checkOf(w, 'zone').length >= 1);
  assert.ok(checkOf(w, 'curtain').length >= 1);
  assert.equal(
    checkOf(w, 'footprint').length,
    0,
    'no bulk footprints by default',
  );
  assert.equal(
    checkOf(w, 'current').length,
    2,
    'the photo in view: fill and outline',
  );
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
  assert.equal(
    checkOf(w, 'zone')[0].polylineVolume.shape[1].x,
    10,
    'debounced',
  );
  await wait(260);
  assert.equal(checkOf(w, 'zone')[0].polylineVolume.shape[1].x, 20);
  assert.ok(checkOf(w, 'curtain').every((e, i) => e === curtain[i]));
  assert.match(
    w.find((n) => n.tagName === 'OUTPUT' && /20 m/.test(n.textContent))[0]
      .textContent,
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
  const setFootprints = (value) => {
    const select = checkBox(w, 'footprints');
    select.value = value;
    select.dispatch('change');
  };
  assert.equal(
    checkOf(w, 'footprint').length,
    0,
    'default: no bulk footprints',
  );
  assert.equal(checkOf(w, 'current').length, 2, 'default: the photo in view');
  setFootprints('all');
  assert.ok(checkOf(w, 'footprint').length > 1);
  flipTo('curtain', false);
  assert.equal(checkOf(w, 'curtain').length, 0);
  assert.ok(checkOf(w, 'zone').length && checkOf(w, 'footprint').length);
  flipTo('zone', false);
  assert.equal(checkOf(w, 'zone').length, 0);
  setFootprints('off');
  assert.equal(checkOf(w, 'footprint').length, 0);
  assert.equal(checkOf(w, 'current').length, 0, 'off hides the photo in view');
  setFootprints('selected');
  assert.equal(checkOf(w, 'footprint').length, 0);
  assert.equal(checkOf(w, 'current').length, 2);
  setFootprints('off');
  assert.equal(checkOf(w, 'view').length, 5);
  const view = checkBox(w, 'frustum');
  view.value = 'off';
  view.dispatch('change');
  assert.equal(checkOf(w, 'view').length, 0);
  flipTo('curtain', true);
  assert.ok(checkOf(w, 'curtain').length);
  flipTo('enabled', false);
  assert.equal(
    globe(w).filter((e) => e.name?.startsWith('3D check')).length,
    0,
  );
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
    w.find((n) => n.getAttribute('data-role') === 'check-readout')[0]
      .textContent;
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
  assert.equal(
    checkSlider(w, 'photo').disabled,
    true,
    'slider only in one-at-a-time mode',
  );
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
    w.find((n) => n.getAttribute('data-role') === 'check-readout')[0]
      .textContent,
    /Photo 1 of/,
  );
  w.handle.setBox(boxM(200, 200));
  await w.handle.replan();
  assert.equal(
    passesOf('zone').has('nadir'),
    false,
    'replan drops the suite layers',
  );
  assert.ok(checkOf(w, 'zone').length >= 1, 'single plan drawn instead');
  w.handle.destroy();
  assert.equal(globe(w).length, 0);
});

// -------------------------------------------------- per-obstacle heights --
const obstacleRows = () => [
  {
    id: 'faa-48-1',
    kind: 'tower',
    source: 'faa',
    lon: -97.77,
    lat: 30.27,
    radiusM: 6,
    estimatedHeightM: 61,
    heightM: 61,
  },
  {
    id: 'chm-1',
    kind: 'tree',
    source: 'canopy',
    lon: -97.7695,
    lat: 30.2703,
    radiusM: 20,
    estimatedHeightM: 18,
    heightM: 18,
  },
];

function obstacleWorld(fetchObstacles) {
  resetPointerOwnership();
  const dom = makeDoc();
  const world = makeWorld({ sample: async (c) => flat(c) });
  const overlays = [];
  const handle = initDronePlan({
    unitStorage: memoryStorage({ 'gev.dronePlan.units': 'm' }),
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
  const text = w
    .find((n) => n.className.includes('gev-dp-obstacle-source'))
    .map((n) => n.textContent);
  assert.ok(
    text.some((x) => x.includes('FAA obstacle file: 61 m')),
    text.join('|'),
  );
  assert.ok(w.overlays.some((l) => l?.some((e) => e.title === 'tower 61 m')));
  assert.match(
    w.find((n) => n.className.includes('gev-dp-obstacle-disclaimer'))[0]
      .textContent,
    /not a survey.*Trees grow.*Power lines.*not flight-tested/s,
  );
  w.handle.destroy();
});

test('obstacles: typing a height changes the column and the plan, Reset goes back, x removes', async () => {
  const w = obstacleWorld(async () => ({
    obstacles: obstacleRows(),
    status: {},
  }));
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  await settle();
  const box = w.heightBox('faa-48-1');
  box.value = '90';
  box.dispatch('input');
  const o = w.handle.obstacles.list().find((x) => x.id === 'faa-48-1');
  assert.equal(o.heightM, 90);
  assert.equal(o.userEdited, true);
  assert.equal(
    w.handle.getState().options.obstacles.find((x) => x.id === 'faa-48-1')
      .heightM,
    90,
  );
  w.overlays.length = 0;
  w.handle.obstacles.setHeight('chm-1', 25);
  assert.ok(w.overlays.at(-1).some((e) => e.title === 'tree 25 m'));
  const reset = w.button('data-reset-obstacle', 'faa-48-1');
  assert.equal(reset.disabled, false);
  reset.dispatch('click');
  assert.equal(
    w.handle.obstacles.list().find((x) => x.id === 'faa-48-1').heightM,
    61,
  );
  w.button('data-remove-obstacle', 'chm-1').dispatch('click');
  assert.deepEqual(
    w.handle.obstacles.list().map((x) => x.id),
    ['faa-48-1'],
  );
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
  assert.equal(
    w.handle.obstacles.list().find((x) => x.id === 'faa-48-1').heightM,
    99,
  );
  assert.ok(w.handle.obstacles.list().some((x) => x.id === mine.id));
  assert.match(
    w.find((n) => n.className.includes('gev-dp-obstacle-status'))[0]
      .textContent,
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
  const before = w.handle
    .getResult()
    .missions.flatMap((m) => m.waypoints)
    .map((p) => p.aglM);
  assert.ok(before.every((h) => h === 40));
  w.handle.obstacles.add({ lon: -97.77, lat: 30.27, heightM: 80 });
  await settle();
  await w.handle.replan();
  const after = w.handle.getResult();
  assert.ok(
    after.missions.flatMap((m) => m.waypoints).some((p) => p.aglM >= 85),
  );
  assert.ok(after.warnings.some((x) => x.code === 'obstacle-raised'));
  w.handle.destroy();
});

test('obstacles: closing the panel and starting over forgets the obstacles', async () => {
  const w = obstacleWorld(async () => ({
    obstacles: obstacleRows(),
    status: {},
  }));
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  await settle();
  assert.equal(w.handle.obstacles.list().length, 2);
  w.handle.destroy();
  assert.equal(w.handle.obstacles.list().length, 0);
});

test('obstacles: Reset and x still redraw the list while that button has focus', async () => {
  const w = obstacleWorld(async () => ({
    obstacles: obstacleRows(),
    status: {},
  }));
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  await settle();
  w.handle.obstacles.setHeight('faa-48-1', 90);
  // Like a browser: the list contains whatever is inside it.
  const listNode = w.find((n) =>
    n.className.includes('gev-dp-obstacle-list'),
  )[0];
  listNode.contains = (n) => all(listNode, (x) => x === n).length > 0;
  const reset = w.button('data-reset-obstacle', 'faa-48-1');
  w.doc.activeElement = reset;
  reset.dispatch('click');
  assert.equal(
    w.heightBox('faa-48-1').value,
    '61',
    'the box shows the estimate again',
  );
  const remove = w.button('data-remove-obstacle', 'chm-1');
  w.doc.activeElement = remove;
  remove.dispatch('click');
  assert.equal(
    w.button('data-remove-obstacle', 'chm-1'),
    undefined,
    'the row is gone',
  );
  w.handle.destroy();
});

test('obstacles: Enter in a height box (change, box still focused) enables Reset in place', async () => {
  const w = obstacleWorld(async () => ({
    obstacles: obstacleRows(),
    status: {},
  }));
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  await settle();
  const listNode = w.find((n) =>
    n.className.includes('gev-dp-obstacle-list'),
  )[0];
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
  assert.equal(
    reset,
    resetBefore,
    'the row is not rebuilt, so a click on Reset is not lost',
  );
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
  const text = w.find((n) => n.className.includes('gev-dp-obstacle-status'))[0]
    .textContent;
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
  const w = obstacleWorld(async () => ({
    obstacles: obstacleRows(),
    status: {},
  }));
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  await settle();
  const mine = w.handle.obstacles.add({ lon: -97.7701, lat: 30.2701 });
  const sel = w.find(
    (n) => n.getAttribute?.('data-obstacle-kind') === mine.id,
  )[0];
  assert.ok(sel, 'a kind selector for user obstacles');
  assert.equal(
    w.find((n) => n.getAttribute?.('data-obstacle-kind') === 'faa-48-1').length,
    0,
    'not for open-data rows',
  );
  sel.value = 'tower';
  sel.dispatch('change');
  const o = w.handle.obstacles.list().find((x) => x.id === mine.id);
  assert.equal(o.kind, 'tower');
  assert.equal(o.radiusM, 6);
  assert.match(
    w.find((n) => n.className.includes('gev-dp-obstacle-credit'))[0]
      .textContent,
    /Meta and WRI \(CC BY 4\.0\).*FAA.*OpenStreetMap/,
  );
  w.handle.destroy();
});

// ------------------------------------------------------------------ Adjust --
const roleNode = (w, role) =>
  w.find((n) => n.getAttribute('data-role') === role)[0];

test('Steps: nine numbered collapsible steps hold every control in the planned order', () => {
  const w = setup();
  const steps = w.find(
    (n) => n.tagName === 'DETAILS' && n.getAttribute('data-step'),
  );
  assert.deepEqual(
    steps.map((n) => n.getAttribute('data-step')),
    [
      'area',
      'aircraft',
      'shots',
      'orbits',
      'obstacles',
      'flight',
      'plan',
      'check',
      'export',
    ],
  );
  const title = (n) => n.children[0].children[1].textContent;
  const num = (n) => n.children[0].children[0].textContent;
  assert.deepEqual(steps.map(num), [
    '1',
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
    '8',
    '9',
  ]);
  assert.deepEqual(steps.map(title), [
    'Area',
    'Aircraft & camera',
    'Shots',
    'Orbits',
    'Obstacles & safety',
    'Flight & battery',
    'Plan',
    'Check (3D)',
    'Save & export',
  ]);
  const inside = (step, node) => {
    for (let n = node; n; n = n.parentNode) if (n === step) return true;
    return false;
  };
  const stepOf = (node) => steps.findIndex((s) => inside(s, node)) + 1;
  const action = (name) =>
    w
      .buttons('data-action')
      .find((b) => b.getAttribute('data-action') === name);
  assert.equal(stepOf(action('draw-box')), 1);
  assert.equal(stepOf(action('draw-polygon')), 1);
  assert.equal(stepOf(w.control('Aircraft')), 2);
  assert.equal(stepOf(w.control('Shutter speed')), 2);
  assert.equal(stepOf(w.control('DJI aircraft code in the mission file')), 2);
  assert.equal(stepOf(w.control('Mode')), 3);
  assert.equal(stepOf(action('use-recommended')), 3);
  assert.equal(stepOf(w.control('Pattern')), 3);
  assert.equal(stepOf(w.control('Height above ground')), 3);
  assert.equal(stepOf(w.control('Front overlap')), 3);
  assert.equal(stepOf(w.control('Camera tilt')), 3);
  assert.equal(stepOf(w.control('Flight direction')), 3);
  assert.equal(stepOf(w.control('Photos')), 3);
  assert.equal(stepOf(w.control('Orbit radius')), 4);
  assert.equal(stepOf(w.control('Target height')), 4);
  assert.equal(stepOf(action('recommend-targets')), 4);
  assert.equal(stepOf(w.control('Tree / obstacle height')), 5);
  assert.equal(stepOf(action('add-obstacle')), 5);
  assert.equal(stepOf(checkSlider(w, 'width')), 5);
  // Speed and front overlap sit together in the Speed & photo timing section.
  assert.equal(stepOf(w.control('Speed')), 3);
  assert.equal(
    stepOf(w.control('Usable flight time per battery (minutes)')),
    6,
  );
  assert.equal(stepOf(w.control('Processing jobs')), 6);
  assert.equal(stepOf(action('plan-suite')), 7);
  assert.equal(stepOf(roleNode(w, 'suite')), 7);
  assert.equal(stepOf(roleNode(w, 'plan-summary')), 7);
  assert.equal(stepOf(roleNode(w, '3d-check')), 8);
  assert.equal(stepOf(checkSlider(w, 'photo')), 8);
  assert.equal(stepOf(checkBox(w, 'footprints')), 8);
  assert.equal(stepOf(checkSlider(w, 'alpha-zone')), 8);
  assert.equal(stepOf(roleNode(w, 'check-readout')), 8);
  assert.equal(
    stepOf(w.find((n) => n.className.includes('gev-dp-library-host'))[0]),
    9,
  );
  assert.equal(stepOf(w.find((n) => n.className === 'gev-dp-missions')[0]), 9);
  w.handle.destroy();
});

test('Steps: each header carries a one-line summary of its current values', async () => {
  const w = setup();
  const line = (key) =>
    w.find((n) => n.getAttribute('data-step-line') === key)[0].textContent;
  assert.match(line('area'), /Nothing drawn yet/);
  assert.match(line('shots'), /Mapping grid.*Grid.*80 m.*80% \/ 70%/);
  assert.match(line('flight'), /m\/s.*25 min battery/);
  assert.match(line('plan'), /Not planned yet/);
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  assert.match(line('area'), /areas: 1/);
  assert.match(line('plan'), /photos: \d+.*missions: 1/);
  assert.match(line('check'), /on.*zone.*curtain.*footprints/);
  w.handle.destroy();
});

test('Steps: the orbit step is hidden until orbits are in the plan', async () => {
  const w = setup();
  const orbits = () =>
    w.find((n) => n.getAttribute('data-step') === 'orbits')[0].hidden;
  assert.equal(orbits(), true);
  pick(w, 'Mode', 'splat-orbit');
  assert.equal(orbits(), false);
  w.handle.destroy();
});

test('Steps: open or closed is remembered per browser', () => {
  const storage = memoryStorage({ 'gev.dronePlan.units': 'm' });
  const w = setup({ storage });
  const step = (key) => w.find((n) => n.getAttribute('data-step') === key)[0];
  assert.equal(step('area').getAttribute('open'), '');
  assert.equal(step('flight').getAttribute('open'), null);
  step('flight').setAttribute('open', '');
  step('flight').dispatch('toggle');
  step('area').removeAttribute('open');
  step('area').dispatch('toggle');
  w.handle.destroy();
  const saved = JSON.parse(storage.getItem('gev.dronePlan.steps'));
  assert.equal(saved.flight, true);
  assert.equal(saved.area, false);
  const again = setup({ storage });
  const step2 = (key) =>
    again.find((n) => n.getAttribute('data-step') === key)[0];
  assert.equal(step2('flight').getAttribute('open'), '');
  assert.equal(step2('area').getAttribute('open'), null);
  again.handle.destroy();
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
    w.handle.getState().suite.passes.find((p) => p.id === 'orbit').result.plan
      .orbit.targets.length,
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
  assert.equal(
    roleNode(w, 'plan-summary').hidden,
    true,
    'nothing without a plan',
  );
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
  const flights = st.suite.passes.reduce(
    (n, p) => n + p.result.totals.missionCount,
    0,
  );
  const seconds = st.suite.passes.reduce(
    (n, p) => n + p.result.totals.durationS,
    0,
  );
  const expected = planSummary({
    suite: st.suite,
    result: null,
    batteryMin: st.options.batteryMin,
  });
  assert.equal(expected.flights, flights);
  assert.equal(expected.durationS, seconds);
  const hidden = summaryText(w);
  w.handle.getState().suiteHidden.add('oblique45');
  w.handle.getState().suiteHidden.add('orbit');
  assert.equal(
    summaryText(w),
    hidden,
    'hiding passes does not change the total',
  );
  assert.ok(hidden.includes(` · ${flights} flights · `), hidden);
  w.handle.destroy();
});

test('summary math: ceil of air time over battery time, at least one battery', () => {
  const r2 = (m) =>
    planSummary({ suite: null, result: fakeResult(600, 1), batteryMin: m });
  const r = (s, n) =>
    planSummary({ suite: null, result: fakeResult(s, n), batteryMin: 25 });
  assert.equal(r(26 * 60, 2).batteries, 2, '26 min on 25 min batteries');
  assert.equal(r(25 * 60, 1).batteries, 1);
  assert.equal(r(60, 1).batteries, 1);
  assert.equal(r(0, 1).batteries, 1, 'at least one with a plan');
  assert.equal(
    planSummary({ suite: null, result: null, batteryMin: 25 }),
    null,
  );
  assert.equal(
    planSummary({ suite: null, result: fakeResult(600, 1), batteryMin: 0 })
      .minutes,
    25,
    'bad battery time falls back to 25',
  );
  assert.equal(r2(600).minutes, 60, 'clamped to the planner range');
});

test('summary: more flights than batteries adds the shared-battery note', async () => {
  const w = setup();
  const sum = planSummary({
    suite: null,
    result: fakeResult(20 * 60, 3),
    batteryMin: 25,
  });
  assert.equal(sum.batteries, 1);
  assert.equal(sum.sharedBatteries, true);
  assert.equal(
    planSummary({ suite: null, result: fakeResult(40 * 60, 2), batteryMin: 25 })
      .sharedBatteries,
    false,
  );
  // A real plan with more flights than batteries: a low waypoint cap splits the plan into flights while the
  // air time still fits one 60 min battery.
  w.handle.applyOptions({ batteryMin: 60 });
  w.handle.getState().options.maxWaypoints = 40;
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  const { totals } = w.handle.getResult();
  assert.ok(
    totals.missionCount >= 2,
    `needs 2+ flights, got ${totals.missionCount}`,
  );
  assert.ok(totals.durationS <= 60 * 60, 'fits one battery');
  assert.match(summaryText(w), /about 1 battery \(60 min each\)/);
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
  assert.equal(
    planSummary({
      suite: { passes: [{ id: 'a', label: 'A', result: null }] },
      result: null,
      batteryMin: 25,
    }),
    null,
  );
});

test('PLAN ALL: a late building-footprint reply does not wipe the suite, and the orbit pass uses the buildings', async () => {
  for (const pattern of ['grid', 'orbit']) {
    resetPointerOwnership();
    const dom = makeDoc();
    const world = makeWorld({ sample: (cartos) => flat(cartos) });
    const late = deferred();
    const handle = initDronePlan({
      unitStorage: memoryStorage({ 'gev.dronePlan.units': 'm' }),
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
      {
        ring: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)],
        label: 'Hall',
      },
    ]);
    await planned;
    await wait(400);
    assert.ok(
      handle.getState().suite,
      `${pattern}: the suite survives the late reply`,
    );
    const targets = handle.getState().suite.passes.find((p) => p.id === 'orbit')
      .result.plan.orbit.targets;
    assert.deepEqual(
      targets.map((x) => x.label),
      ['Hall'],
      `${pattern}: orbit pass uses the building`,
    );
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

// ----------------------------------------------------------- plan library --
test('a saved plan reopens editable: areas, settings, takeoff, targets and mission ids', async () => {
  const w = setup();
  w.handle.setBox(boxM(400, 200));
  await w.handle.replan();
  w.handle.applyOptions(
    { aglM: 65, speedMs: 4, pattern: 'double' },
    { planNow: true },
  );
  await w.handle.replan();
  const state = w.handle.getState();
  state.controllerIds = ['9560F7B3-DAA9-481A-B2F5-37CCF3B8B996'];
  const doc = JSON.parse(JSON.stringify(await snapshotOf(w)));
  assert.equal(doc.schema, 'gevplan');
  assert.equal(doc.options.aglM, 65);
  assert.equal(doc.options.pattern, 'double');
  assert.equal(doc.areas.length, 1);
  assert.deepEqual(doc.controllerIds, ['9560F7B3-DAA9-481A-B2F5-37CCF3B8B996']);
  // A different panel opens the stored plan.
  const w2 = setup();
  await w2.handle.loadPlan(doc);
  const s2 = w2.handle.getState();
  assert.equal(s2.options.aglM, 65);
  assert.equal(s2.options.pattern, 'double');
  assert.equal(s2.areas.length, 1);
  assert.deepEqual(s2.areas[0].box, state.areas[0].box);
  assert.deepEqual(s2.controllerIds, ['9560F7B3-DAA9-481A-B2F5-37CCF3B8B996']);
  assert.equal(w2.panel.dataset.state, 'ready', 're-planned after opening');
  assert.equal(
    w2.handle.getResult().totals.photoCount,
    w.handle.getResult().totals.photoCount,
  );
  w.handle.destroy();
  w2.handle.destroy();
});

async function snapshotOf(w) {
  const { serializePlan } = await import('./planDoc.js');
  const s = w.handle.getState();
  return serializePlan(s, {
    controllerIds: s.controllerIds,
    imports: s.imports,
  });
}

test('a controller mission id names the exported KMZ <UUID>.kmz, in the zip too', async () => {
  const w = setup();
  w.handle.setBox(boxM(400, 200));
  await w.handle.replan();
  const id = '8A05BD5F-A9CE-4867-923F-7AACC02AF9A9';
  w.handle.getState().controllerIds = [id];
  w.buttons('data-mission')[0].click();
  assert.equal(w.downloads[0].name, `${id}.kmz`);
  w.buttons('data-download')[0].click();
  const names = [...readZip(w.downloads[1].bytes).keys()];
  assert.ok(names.includes(`${id}.kmz`), names.join(','));
  const readme = new TextDecoder().decode(
    readZip(w.downloads[1].bytes).get('README.txt'),
  );
  assert.match(readme, /waypoint\/<UUID>\/<UUID>\.kmz/);
  assert.match(readme, /NOT verified by a real file/);
  w.handle.destroy();
});

test('controller ids keep their flight positions through open, import and edit', async () => {
  const { readFileSync } = await import('node:fs');
  const w = setup();
  const X = '9560F7B3-DAA9-481A-B2F5-37CCF3B8B996';
  const Y = '8A05BD5F-A9CE-4867-923F-7AACC02AF9A9';
  const area = {
    kind: 'rect',
    name: 'A',
    box: { west: -97.1, east: -97.09, south: 30.1, north: 30.11 },
  };
  await w.handle.loadPlan({
    schema: 'gevplan',
    version: 1,
    areas: [area],
    controllerIds: [null, X],
  });
  assert.deepEqual(w.handle.getState().controllerIds, [null, X]);
  const box = () =>
    w.find((n) => n.getAttribute?.('data-field') === 'controller-ids')[0];
  // Importing Y fills the empty first slot; X stays second.
  const bytes = new Uint8Array(
    readFileSync(
      new URL(`./fixtures/djifly-mini5pro/${Y}.kmz`, import.meta.url),
    ),
  );
  await w.handle.library().importBytes(bytes, `${Y}.kmz`);
  assert.deepEqual(w.handle.getState().controllerIds, [Y, X]);
  // A text edit that blanks the first line keeps X second.
  box().value = `\n${X}`;
  box().dispatch('change');
  assert.deepEqual(w.handle.getState().controllerIds, [null, X]);
  assert.equal(box().value, `\n${X}`);
  w.handle.destroy();
});

test('opening a plan with a bad document is refused and changes nothing', async () => {
  const w = setup();
  w.handle.setBox(boxM(400, 200));
  await w.handle.replan();
  await assert.rejects(
    () => w.handle.loadPlan({ schema: 'nope' }),
    /not-a-plan/,
  );
  assert.equal(w.handle.getState().areas.length, 1);
  w.handle.destroy();
});

test('importing a DJI Fly KMZ draws it, remembers the mission id and lists compatibility findings', async () => {
  const { readFileSync } = await import('node:fs');
  const w = setup();
  const id = '8A05BD5F-A9CE-4867-923F-7AACC02AF9A9';
  const bytes = new Uint8Array(
    readFileSync(
      new URL(`./fixtures/djifly-mini5pro/${id}.kmz`, import.meta.url),
    ),
  );
  const out = await w.handle.library().importBytes(bytes, `${id} (1).kmz`);
  assert.equal(out.kind, 'mission');
  const s = w.handle.getState();
  assert.equal(s.imports.length, 1);
  assert.equal(s.imports[0].waypoints.length, 2);
  assert.deepEqual(s.controllerIds, [id]);
  const source = w.viewer.dataSources.sources.find(
    (x) => x.name === 'gev-drone-plan',
  );
  assert.ok(
    source.entities.values.some((e) => e.polyline),
    'a line is on the map',
  );
  const findings = w.find((n) => n.attributes?.has?.('data-code'));
  assert.deepEqual(
    findings.map((n) => n.getAttribute('data-code')),
    ['far-apart'],
  );
  // A bad file is reported, not thrown.
  const bad = await w.handle
    .library()
    .importBytes(new Uint8Array([1, 2, 3]), 'x.kmz');
  assert.equal(bad.kind, 'error');
  w.handle.destroy();
});

test('with no library (not signed in) the panel says so and import still works', async () => {
  const w = setup();
  await new Promise((r) => setTimeout(r, 10));
  const note = w.find(
    (n) => n.getAttribute?.('data-role') === 'library-note',
  )[0];
  assert.match(note.textContent, /Sign in through byrd-it\.com/);
  w.handle.destroy();
});

// ------------------------------------------- library UI end to end --
async function server() {
  const root = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), 'gevui-'));
  const handler = createPlanLibraryHandler({
    store: createStore({ root }),
    env: { GEV_TRUSTED_PROXIES: '127.0.0.1' },
  });
  const srv = http.createServer((req, res) =>
    handler(req, res, () => {
      res.statusCode = 404;
      res.end();
    }),
  );
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const clientFor = (user) =>
    createLibraryClient({
      base: `http://127.0.0.1:${port}/api/byrdit/plans`,
      fetchImpl: (url, init) =>
        fetch(url, {
          ...init,
          headers: {
            ...init.headers,
            ...(user ? { 'x-gev-user': user } : {}),
            host: `127.0.0.1:${port}`,
          },
        }),
    });
  return {
    clientFor,
    close: async () => {
      await new Promise((r) => srv.close(r));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const settleUi = () => new Promise((r) => setTimeout(r, 250));
const btn = (w, action) =>
  w.find(
    (n) => n.tagName === 'BUTTON' && n.getAttribute('data-action') === action,
  );
const field = (w, name) =>
  w.find((n) => n.getAttribute?.('data-field') === name)[0];
const rows = (w) => w.find((n) => n.getAttribute?.('data-plan'));

test('save, list, reopen, rename, version restore, trash and restore through the panel', async () => {
  const srv = await server();
  try {
    const w = setup({ libraryClient: srv.clientFor('alice') });
    w.doc.defaultView = { prompt: () => 'Renamed', confirm: () => true };
    await settleUi();
    assert.match(
      w.find((n) => n.getAttribute?.('data-role') === 'library-note')[0]
        .textContent,
      /Signed in as alice/,
    );
    w.handle.setBox(boxM(400, 200));
    await w.handle.replan();
    field(w, 'name').value = 'Barn';
    field(w, 'site').value = 'Farm';
    btn(w, 'library-save')[0].click();
    await settleUi();
    assert.equal(rows(w).length, 1);
    assert.match(rows(w)[0].textContent, /Barn/);
    assert.match(rows(w)[0].textContent, /v1/);
    // change a setting and save again: version 2
    w.handle.applyOptions({ aglM: 55 }, { planNow: true });
    await w.handle.replan();
    btn(w, 'library-save')[0].click();
    await settleUi();
    assert.match(rows(w)[0].textContent, /v2/);
    // reopen into a fresh panel
    const w2 = setup({ libraryClient: srv.clientFor('alice') });
    w2.doc.defaultView = w.doc.defaultView;
    await settleUi();
    btn(w2, 'plan-open')[0].click();
    await settleUi();
    assert.equal(w2.handle.getState().options.aglM, 55);
    assert.equal(field(w2, 'name').value, 'Barn');
    assert.equal(w2.handle.getResult() !== null, true);
    // versions: restore v1 (aglM was the default) = new save v3
    btn(w2, 'plan-versions')[0].click();
    await settleUi();
    const restore = btn(w2, 'version-restore');
    assert.ok(restore.length >= 1);
    restore.at(-1).click();
    await settleUi();
    assert.match(rows(w2)[0].textContent, /v3/);
    // rename, delete to trash, trash list, restore
    btn(w2, 'plan-rename')[0].click();
    await settleUi();
    assert.match(rows(w2)[0].textContent, /Renamed/);
    btn(w2, 'plan-delete')[0].click();
    await settleUi();
    assert.equal(rows(w2).length, 0);
    btn(w2, 'library-trash-toggle')[0].click();
    await settleUi();
    assert.equal(rows(w2).length, 1);
    btn(w2, 'plan-restore')[0].click();
    await settleUi();
    assert.equal(rows(w2).length, 0, 'it left the trash list');
    btn(w2, 'library-trash-toggle')[0].click();
    await settleUi();
    assert.equal(rows(w2).length, 1);
    w.handle.destroy();
    w2.handle.destroy();
  } finally {
    await srv.close();
  }
});

test('another user sees nothing; the admin sees all users read-only', async () => {
  const srv = await server();
  try {
    const a = setup({ libraryClient: srv.clientFor('alice') });
    await settleUi();
    a.handle.setBox(boxM(400, 200));
    await a.handle.replan();
    field(a, 'name').value = 'Alice plan';
    btn(a, 'library-save')[0].click();
    await settleUi();
    const b = setup({ libraryClient: srv.clientFor('bob') });
    await settleUi();
    assert.equal(rows(b).length, 0);
    const admin = setup({ libraryClient: srv.clientFor('byrdit') });
    await settleUi();
    assert.equal(
      rows(admin).length,
      0,
      'own plans only until the filter is switched',
    );
    const scope = admin.find(
      (n) => n.getAttribute?.('data-role') === 'library-scope',
    )[0];
    assert.equal(scope.hidden, false);
    scope.value = 'all';
    scope.dispatch('change');
    await settleUi();
    assert.equal(rows(admin).length, 1);
    assert.equal(rows(admin)[0].getAttribute('data-owner'), 'alice');
    assert.equal(
      btn(admin, 'plan-delete').length,
      0,
      'no delete on others plans',
    );
    assert.equal(btn(admin, 'plan-rename').length, 0);
    assert.equal(btn(admin, 'plan-open').length, 1);
    btn(admin, 'plan-open')[0].click();
    await settleUi();
    assert.equal(admin.handle.getState().areas.length, 1);
    assert.match(
      admin.find((n) => n.getAttribute?.('data-role') === 'library-note')[0]
        .textContent,
      /read-only/,
    );
    assert.equal(
      btn(admin, 'library-save')[0].disabled,
      true,
      'cannot save over it',
    );
    // non-admins never get the filter
    assert.equal(
      b.find((n) => n.getAttribute?.('data-role') === 'library-scope')[0]
        .hidden,
      true,
    );
    for (const w of [a, b, admin]) w.handle.destroy();
  } finally {
    await srv.close();
  }
});

test('a request with no trusted identity gives the sign-in note and no list', async () => {
  const srv = await server();
  try {
    const w = setup({ libraryClient: srv.clientFor(null) });
    await settleUi();
    assert.match(
      w.find((n) => n.getAttribute?.('data-role') === 'library-note')[0]
        .textContent,
      /Sign in through byrd-it\.com/,
    );
    assert.equal(btn(w, 'library-save')[0].disabled, true);
    w.handle.destroy();
  } finally {
    await srv.close();
  }
});

test('every compatibility code has a sentence', () => {
  const codes = [
    'read-empty',
    'read-not-a-kmz',
    'namespace',
    'no-waylines',
    'template-fallback',
    'template-shape',
    'no-template',
    'no-config',
    'no-drone',
    'drone-mismatch',
    'no-waypoints',
    'too-many',
    'index-gap',
    'bad-coordinates',
    'height-mode',
    'no-height',
    'height-range',
    'speed-range',
    'poi-missing',
    'group-mode',
    'group-ids',
    'action-ids',
    'far-apart',
  ];
  for (const code of codes)
    assert.notEqual(warningText({ code, args: {} }), code, code);
});

// -------------------------------------------------------------------- units --
const unitBtn = (w, system) =>
  w
    .buttons('data-action')
    .find((b) => b.getAttribute('data-action') === `units-${system}`);

test('units: feet by default, the ft/m switch changes every shown length and speed', async () => {
  const w = setup({ storage: memoryStorage() });
  assert.equal(unitBtn(w, 'ft').getAttribute('aria-pressed'), 'true');
  assert.equal(unitBtn(w, 'm').getAttribute('aria-pressed'), 'false');
  const out = (label) =>
    w.control(label).parentNode.children.find((n) => n.tagName === 'OUTPUT')
      .textContent;
  assert.equal(out('Height above ground'), '262 ft');
  // The speed readout also gives miles per hour, so 16 ft/s is not read as mph.
  const speedNow = w.handle.getState().options.speedMs;
  assert.equal(
    out('Speed'),
    `${(speedNow * 3.28084).toFixed(1)} ft/s · ${((speedNow * 3600) / 1609.344).toFixed(1)} mph`,
  );
  assert.equal(w.control('Height above ground').max, '1500');
  assert.equal(w.control('Height above ground').step, '10');
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  assert.match(w.stats().Speed, /ft\/s$/);
  assert.match(w.stats().Route, / (ft|mi)$/);
  unitBtn(w, 'm').click();
  assert.equal(unitBtn(w, 'm').getAttribute('aria-pressed'), 'true');
  assert.equal(out('Height above ground'), '80 m');
  assert.match(w.stats().Speed, / m\/s$/);
  assert.equal(w.control('Height above ground').max, '457.2');
  {
    // A range input stops at the last min + n*step at or below max: the
    // planning maximum must be on that grid, and so must a typical 5 m value.
    const c = w.control('Height above ground');
    const onGrid = (v) => {
      const n = (Number(v) - Number(c.min)) / Number(c.step);
      return Math.abs(n - Math.round(n)) < 1e-6;
    };
    assert.ok(onGrid(c.max), 'the slider can reach 457.2 m');
    for (const v of [80, 120, 400, 455]) assert.ok(onGrid(v), `${v} m`);
  }
  assert.equal(w.storage.getItem('gev.dronePlan.units'), 'm');
  unitBtn(w, 'ft').click();
  assert.equal(out('Height above ground'), '262 ft');
  assert.equal(w.storage.getItem('gev.dronePlan.units'), 'ft');
  w.handle.destroy();
});

test('units: the choice is remembered per browser', () => {
  const storage = memoryStorage();
  const first = setup({ storage });
  unitBtn(first, 'm').click();
  first.handle.destroy();
  const second = setup({ storage });
  assert.equal(unitBtn(second, 'm').getAttribute('aria-pressed'), 'true');
  const label = second
    .control('Height above ground')
    .parentNode.children.find((n) => n.tagName === 'OUTPUT');
  assert.equal(label.textContent, '80 m');
  second.handle.destroy();
});

test('units: what is typed or slid in feet is stored in metres', async () => {
  const w = setup({ storage: memoryStorage() });
  const o = () => w.handle.getState().options;
  const agl = w.control('Height above ground');
  agl.value = '200';
  agl.dispatch('input');
  assert.equal(o().aglM, 60.96);
  const speed = w.control('Speed');
  speed.value = '10';
  speed.dispatch('input');
  assert.equal(o().speedMs, 3.048);
  const radius = w.control('Orbit radius');
  radius.value = '100';
  radius.dispatch('input');
  assert.equal(o().orbitRadiusM, 30.48);
  const tree = w.control('Tree / obstacle height');
  tree.value = '50';
  tree.dispatch('input');
  assert.equal(o().obstacleHeightM, 15.24);
  const rings = w.control('Orbit heights');
  rings.value = '130, 260';
  rings.dispatch('change');
  assert.deepEqual(o().orbitHeightsM, [39.62, 79.25]);
  const width = checkSlider(w, 'width');
  width.value = '50';
  width.dispatch('input');
  assert.equal(w.handle.getState().check.halfWidthM, 15.24);
  // Back in the controls the same numbers are shown in feet.
  assert.equal(w.control('Orbit heights').value, '130, 260');
  w.handle.destroy();
});

test('units: an obstacle height box takes feet and the plan gets metres', async () => {
  const w = setup({ storage: memoryStorage() });
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  w.handle.obstacles.add({ lon: -97.77, lat: 30.27, heightM: 20 });
  const [added] = w.handle.obstacles.list();
  assert.ok(added, 'the obstacle row exists');
  const box = w.find(
    (n) =>
      n.getAttribute('data-obstacle-height') !== null &&
      n.getAttribute('data-obstacle-height') !== undefined,
  )[0];
  assert.ok(box, 'its height box is on screen');
  assert.equal(box.value, '65.6', '20 m shows as feet');
  box.value = '100';
  box.dispatch('input');
  assert.equal(w.handle.obstacles.list()[0].heightM, 30.5);
  w.handle.destroy();
});

// The KMZ stamps createTime from the clock; hold the clock still so two runs
// of the same plan can be compared byte for byte.
const frozenClock = async (fn) => {
  const real = Date.now;
  Date.now = () => 1_790_000_000_000;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
};

test('units: the exported KMZ is byte-identical whichever unit is shown', async () => {
  const when = new Date('2026-10-30T12:00:00Z');
  const kmzFor = async (system, via) => {
    const w = setup({
      storage: memoryStorage({ 'gev.dronePlan.units': system }),
    });
    w.handle.setBox(boxM(300, 200));
    await w.handle.replan();
    if (via) via(w);
    await w.handle.replan();
    w.handle.downloadMission(0, when);
    const bytes = Buffer.from(w.downloads.at(-1).bytes);
    w.handle.destroy();
    return bytes;
  };
  const metres = await frozenClock(() => kmzFor('m'));
  const feet = await frozenClock(() => kmzFor('ft'));
  assert.ok(metres.length > 100);
  assert.deepEqual(feet, metres, 'same plan, same bytes');
  // Switching the unit back and forth on a live panel changes nothing either.
  const toggled = await frozenClock(() =>
    kmzFor('ft', (w) => {
      unitBtn(w, 'm').click();
      unitBtn(w, 'ft').click();
      unitBtn(w, 'm').click();
    }),
  );
  assert.deepEqual(toggled, metres);
});

test('units: a height typed in feet gives a KMZ in metres (DJI needs metres)', async () => {
  const when = new Date('2026-10-30T12:00:00Z');
  const run = async (system, value) => {
    const w = setup({
      storage: memoryStorage({ 'gev.dronePlan.units': system }),
    });
    w.handle.setBox(boxM(300, 200));
    const agl = w.control('Height above ground');
    agl.value = value;
    agl.dispatch('input');
    await w.handle.replan();
    w.handle.downloadMission(0, when);
    const bytes = Buffer.from(w.downloads.at(-1).bytes);
    const aglM = w.handle.getState().options.aglM;
    w.handle.destroy();
    return { bytes, aglM };
  };
  const ft = await frozenClock(() => run('ft', '200'));
  assert.equal(ft.aglM, 60.96);
  const m = await frozenClock(() => run('m', '60.96'));
  assert.deepEqual(ft.bytes, m.bytes, '200 ft is the same file as 60.96 m');
});

// -------------------------------------------------------- transparency UI --
test("transparency: four sliders, defaults are today's values, remembered per browser", async () => {
  const storage = memoryStorage({ 'gev.dronePlan.units': 'm' });
  const w = setup({ storage });
  // The shared fake colour has no alpha: give this test one that reports it.
  w.cesium.Color = {
    fromCssColorString: (css) => ({
      css,
      a: 1,
      withAlpha: (a) => ({ css, a }),
    }),
  };
  const val = (layer) => checkSlider(w, `alpha-${layer}`).value;
  assert.deepEqual(['zone', 'curtain', 'footprint', 'view'].map(val), [
    '16',
    '10',
    '5',
    '20',
  ]);
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  const mode = checkBox(w, 'footprints');
  mode.value = 'all';
  mode.dispatch('change');
  const slider = checkSlider(w, 'alpha-footprint');
  slider.value = '25';
  slider.dispatch('input');
  assert.equal(w.handle.getState().check.alpha.footprint, 0.25);
  await wait(250);
  assert.equal(checkOf(w, 'footprint')[0].polygon.material.a, 0.25);
  assert.equal(checkOf(w, 'zone')[0].polylineVolume.material.a, 0.16);
  w.handle.destroy();
  assert.equal(
    JSON.parse(storage.getItem('gev.dronePlan.alpha')).footprint,
    0.25,
  );
  const again = setup({ storage });
  assert.equal(checkSlider(again, 'alpha-footprint').value, '25');
  assert.equal(checkSlider(again, 'alpha-zone').value, '16');
  again
    .buttons('data-action')
    .find((b) => b.getAttribute('data-action') === 'reset-transparency')
    .click();
  assert.equal(checkSlider(again, 'alpha-footprint').value, '5');
  assert.equal(
    JSON.parse(storage.getItem('gev.dronePlan.alpha')).footprint,
    0.05,
  );
  again.handle.destroy();
});

test('units: editing one orbit height in feet leaves the others at their exact metres', () => {
  const w = setup({ storage: memoryStorage() });
  const rings = w.control('Orbit heights');
  rings.value = '131, 262';
  rings.dispatch('change');
  const [a, b] = w.handle.getState().options.orbitHeightsM;
  assert.equal(a, 39.93);
  rings.value = '131, 300';
  rings.dispatch('change');
  const after = w.handle.getState().options.orbitHeightsM;
  assert.equal(after[0], a, 'the untouched entry did not move');
  assert.notEqual(after[1], b);
  assert.equal(after[1], 91.44);
  w.handle.destroy();
});

// ----------------------------------------- orbit angles, sizes, paths, conflicts --
const planTilts = (w) =>
  [
    ...new Set(
      w.handle
        .getResult()
        .plan.legs.filter((l) => l.kind === 'orbit')
        .flatMap((l) => l.waypoints.map((x) => Math.round(-x.pitchDeg))),
    ),
  ].sort((a, b) => a - b);

test('orbit: rings follow the viewing angles field (25, 40, 55 by default)', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  pick(w, 'Mode', 'splat-orbit');
  w.handle.applyOptions({ orbitRadiusM: 40 });
  await w.handle.replan();
  assert.deepEqual(planTilts(w), [25, 40, 55]);
  assert.equal(w.handle.getState().options.orbitRingMode, 'angles');
  const angles = w.control('Viewing angles');
  angles.value = '30, 50';
  angles.dispatch('change');
  await w.handle.replan();
  assert.deepEqual(planTilts(w), [30, 50]);
  // Typed heights take over from the angles; clearing them goes back.
  const rings = w.control('Orbit heights');
  rings.value = '60, 90';
  rings.dispatch('change');
  assert.equal(w.handle.getState().options.orbitRingMode, 'heights');
  rings.value = '';
  rings.dispatch('change');
  assert.equal(w.handle.getState().options.orbitRingMode, 'angles');
  w.handle.destroy();
});

test('orbit: each target has its own editable size, pre-filled with the automatic value', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  pick(w, 'Mode', 'splat-orbit');
  await w.handle.replan();
  const id = w.handle.getState().options.orbitTargets[0].id;
  const sizeOf = () =>
    w.find((n) => n.attributes.get('data-target-size') === id)[0];
  const auto = Number(sizeOf().value);
  assert.ok(auto >= 30, `automatic diameter shown: ${auto}`);
  sizeOf().value = '90';
  sizeOf().dispatch('change');
  await w.handle.replan();
  assert.equal(w.handle.getState().options.orbitTargets[0].radiusM, 45);
  assert.equal(w.handle.getResult().plan.orbit.targets[0].radiusM, 45);
  assert.equal(sizeOf().value, '90');
  w.handle.destroy();
});

test('orbit: a blocked sector is typed per target and the orbit stays out of it', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  pick(w, 'Mode', 'splat-orbit');
  await w.handle.replan();
  const id = w.handle.getState().options.orbitTargets[0].id;
  const arc = (key) =>
    w.find(
      (n) => n.attributes.get('data-target-blocked') === `${id}:${key}`,
    )[0];
  arc('fromDeg').value = '20';
  arc('fromDeg').dispatch('change');
  arc('toDeg').value = '140';
  arc('toDeg').dispatch('change');
  await w.handle.replan();
  assert.deepEqual(w.handle.getState().options.orbitTargets[0].blocked, {
    fromDeg: 20,
    toDeg: 140,
  });
  const t0 = w.handle.getResult().plan.orbit.targets[0];
  assert.deepEqual(t0.blocked, { fromDeg: 20, toDeg: 140 });
  arc('toDeg').value = '';
  arc('toDeg').dispatch('change');
  assert.equal(w.handle.getState().options.orbitTargets[0].blocked, undefined);
  w.handle.destroy();
});

test('look-at path: added, listed with its target and height, edited and removed', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  pick(w, 'Mode', 'splat-orbit');
  await w.handle.replan();
  assert.equal(w.handle.toggleDrawPath(), true, 'drawing starts with a target');
  assert.equal(
    w.handle.toggleDrawPath(),
    false,
    'finishing with no points adds nothing',
  );
  const m = metersPerDegree(30.27);
  const p1 = { lon: -97.77 - 60 / m.lon, lat: 30.27 - 50 / m.lat };
  const p2 = { lon: -97.77 + 60 / m.lon, lat: 30.27 - 50 / m.lat };
  assert.equal(w.handle.addLookAtPath([p1]), false);
  assert.equal(w.handle.addLookAtPath([p1, p2]), true);
  await w.handle.replan();
  const path = w.handle.getState().options.lookAtPaths[0];
  assert.equal(path.targetId, w.handle.getState().options.orbitTargets[0].id);
  assert.ok(w.handle.getResult().plan.legs.some((l) => l.kind === 'lookat'));
  assert.equal(
    w.find((n) => n.attributes.get('data-lookat-path') === path.id).length,
    1,
  );
  const height = w.find(
    (n) => n.attributes.get('data-path-height') === path.id,
  )[0];
  height.value = '60';
  height.dispatch('change');
  assert.equal(w.handle.getState().options.lookAtPaths[0].aglM, 60);
  assert.equal(w.handle.removeLookAtPath(path.id), true);
  await w.handle.replan();
  assert.ok(!w.handle.getResult().plan.legs.some((l) => l.kind === 'lookat'));
  w.handle.destroy();
});

test('conflicts: the panel says what the check cannot see, and warns about a tall building', async () => {
  resetPointerOwnership();
  const dom = makeDoc();
  const world = makeWorld({ sample: (c) => flat(c) });
  const m = metersPerDegree(30.27);
  const tall = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([a, b]) => ({
    lon: -97.77 + (a * 60) / m.lon,
    lat: 30.27 + (b * 60) / m.lat,
  }));
  const handle = initDronePlan({
    unitStorage: memoryStorage({ 'gev.dronePlan.units': 'm' }),
    viewer: world.viewer,
    cesium: world.cesium,
    document: dom.doc,
    downloadFile: () => {},
    getBuildingFootprints: async () => [
      { ring: tall, label: 'Tower', heightM: 90 },
    ],
  });
  handle.setBox(boxM(300, 200));
  handle.applyOptions({ pattern: 'orbit' });
  await handle.replan();
  await new Promise((r) => setTimeout(r, 5));
  await handle.replan();
  const roles = (role) =>
    all(dom.body, (n) => n.attributes.get('data-role') === role);
  assert.match(
    roles('conflict-disclaimer')[0].textContent,
    /does NOT see trees, power lines or towers/,
  );
  assert.match(
    roles('conflict-disclaimer')[0].textContent,
    /never changes your route/,
  );
  handle.destroy();
});

// -------------------------------------------------------- surface model --
const surfaceStub = ({ tall = 35, fail = false } = {}) => {
  const grid = makeGrid({
    id: 'ranch',
    size: 600,
    origin: { lon: -97.77, lat: 30.27 },
    topAt: () => tall,
  });
  return {
    grid,
    list: async () => {
      if (fail) throw new Error('no-identity');
      return [{ ...grid.meta, bytes: 1 }];
    },
    load: async () => grid,
  };
};
const settleLoad = () => new Promise((r) => setTimeout(r, 30));
const textOf = (w, role) =>
  w
    .find((n) => n.getAttribute?.('data-role') === role)
    .map((n) => n.textContent)
    .join(' | ');

test('surface model: a route too close to the canopy is flagged, with the disclaimer, and never rerouted', async () => {
  const w = setup({ surfaceClient: surfaceStub() });
  w.handle.getState().options.aglM = 30;
  w.handle.setBox(boxM(200, 150));
  await w.handle.replan();
  await settleLoad();
  await w.handle.replan();
  const s = w.handle.getState();
  assert.equal(s.surface.status, 'ready');
  assert.deepEqual(s.surface.ids, ['ranch']);
  assert.ok(
    s.clearance.spanCount > 0,
    'the grid at 30 m is within reach of 35 m trees',
  );
  assert.equal(s.clearance.requiredM, 9.144);
  assert.match(
    textOf(w, 'clearance-summary'),
    /Too close to the surface model/,
  );
  assert.ok(
    w.find((n) => n.getAttribute?.('data-role') === 'clearance-span').length >
      0,
  );
  assert.match(
    textOf(w, 'surface-disclaimer'),
    /bare branches, single limbs, power lines or guy wires/,
  );
  assert.match(textOf(w, 'surface-disclaimer'), /trees change with the season/);
  assert.match(textOf(w, 'surface-disclaimer'), /never changed/);
  // The heights flown are the ones asked for: a warning never moves the route.
  const flown = w.handle
    .getResult()
    .plan.legs.flatMap((l) => l.waypoints.map((x) => x.aglM));
  assert.ok(
    flown.every((a) => Math.abs(a - 30) < 0.06),
    'no automatic reroute',
  );
  // The globe got red flags.
  assert.ok(
    w.viewer.dataSources.sources[0].entities.values.some(
      (e) =>
        e.name === 'Too close to the surface model' ||
        e.name === 'Closest point to the surface model',
    ),
  );
  // Higher and it passes.
  s.options.aglM = 60;
  await w.handle.replan();
  assert.equal(w.handle.getState().clearance.spanCount, 0);
  assert.match(textOf(w, 'clearance-none'), /keeps at least/);
  // Switched off: no check, no flags.
  w.handle.getState().surface.enabled = false;
  w.handle.getState().options.aglM = 30;
  await w.handle.replan();
  assert.equal(w.handle.getState().clearance, null);
  w.handle.destroy();
});

test('surface model: the settings are remembered and clamped, defaults are 20 ft + 10 ft', async () => {
  const storage = memoryStorage({ 'gev.dronePlan.units': 'ft' });
  const w = setup({ surfaceClient: surfaceStub(), storage });
  const s = w.handle.getState().surface;
  assert.equal(s.minM, 6.096);
  assert.equal(s.marginM, 3.048);
  w.handle.destroy();
  const store2 = memoryStorage({
    'gev.dronePlan.clearance': JSON.stringify({
      enabled: false,
      minM: 9999,
      marginM: -5,
    }),
  });
  const w2 = setup({ surfaceClient: surfaceStub(), storage: store2 });
  const s2 = w2.handle.getState().surface;
  assert.equal(s2.enabled, false);
  assert.equal(s2.minM, 61);
  assert.equal(s2.marginM, 0);
  w2.handle.destroy();
});

test('surface model: no model, no sign-in or a failed read falls back to the tree height and says so', async () => {
  for (const client of [
    { list: async () => [], load: async () => null },
    surfaceStub({ fail: true }),
  ]) {
    const w = setup({ surfaceClient: client });
    w.handle.setBox(boxM(200, 150));
    await w.handle.replan();
    await settleLoad();
    await w.handle.replan();
    const s = w.handle.getState();
    assert.equal(s.clearance, null);
    assert.ok(['none', 'signin'].includes(s.surface.status));
    assert.ok(s.result.plan.legs.length > 0, 'the plan is made without it');
    assert.match(
      textOf(w, 'surface-status'),
      /tree \/ obstacle height setting|Sign in/,
    );
    w.handle.destroy();
  }
});

test('surface model: an orbit plan inside the model takes its ring heights from it', async () => {
  const w = setup({ surfaceClient: surfaceStub({ tall: 40 }) });
  const o = w.handle.getState().options;
  o.pattern = 'orbit';
  o.obstacleHeightM = 15;
  w.handle.setBox(boxM(200, 150));
  await w.handle.replan();
  await settleLoad();
  await w.handle.replan();
  const p = w.handle.getResult().plan;
  assert.ok(p.orbit.surface && p.orbit.surface.fromSurface > 0);
  assert.ok(
    Math.min(
      ...p.legs
        .filter((l) => l.kind === 'orbit')
        .flatMap((l) => l.waypoints.map((x) => x.aglM)),
    ) >= 40,
  );
  // The probe is a live object and never reaches the saved options.
  assert.equal(
    JSON.stringify(w.handle.getState().options).includes('ringFloor'),
    false,
  );
  w.handle.destroy();
});

// ------------------------------------------------------------ photo check --
test('photo check: reads photos in the browser, plots them against the plan, flags missing points, saves a CSV', async () => {
  const { jpeg, tiff, xmpText } = await import('./fixtures/photoFixtures.mjs');
  const { plannedPhotoPoints } = await import('./photoCheck.js');
  const w = setup();
  w.handle.setBox(boxM(300, 150));
  await w.handle.replan();
  const planned = plannedPhotoPoints({ result: w.handle.getResult() });
  assert.ok(planned.length > 10);
  const shot = (p, i) => ({
    name: `DJI_${i}.jpg`,
    bytes: jpeg({
      exif: tiff({
        gps: { lat: p.lat, lon: p.lon, alt: 200 },
        time: `2026:10:30 13:${String(10 + (i >> 6)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`,
      }),
      xmp: xmpText({ lat: p.lat, lon: p.lon, abs: 200, rel: p.aglM ?? 50 }),
    }),
  });
  // every planned point photographed except the 4th
  const files = planned.filter((_, i) => i !== 3).map(shot);
  files.push({ name: 'notes.txt', bytes: new TextEncoder().encode('hello') });
  const pc = w.handle.photoCheck();
  const a = await pc.addFiles(files);
  assert.equal(a.summary.plannedCount, planned.length);
  assert.equal(a.summary.missingCount, 1);
  assert.equal(
    a.planned.findIndex((p) => !p.covered),
    3,
  );
  assert.ok(a.summary.gsdMedianCm > 0);
  const shown = w
    .find((n) => n.getAttribute?.('data-level'))
    .map((n) => n.textContent)
    .join('\n');
  assert.match(shown, /1 planned photo point has no photo/);
  assert.match(shown, /1 file is not a JPEG/);
  // the globe got the layer
  const src = w.viewer.dataSources.sources.find(
    (x) => x.name === 'gev-drone-plan',
  );
  assert.ok(src.entities.values.length > planned.length);
  // report
  w.buttons('data-action')
    .find((b) => b.getAttribute('data-action') === 'photos-report')
    .click();
  const csv = new TextDecoder().decode(w.downloads.at(-1).bytes);
  assert.equal(w.downloads.at(-1).name, 'photo-check.csv');
  assert.equal(csv.split('\n').length, 1 + a.photos.length + planned.length);
  // clear drops everything, photos and map layer
  w.buttons('data-action')
    .find((b) => b.getAttribute('data-action') === 'photos-clear')
    .click();
  assert.equal(pc.analysis(), null);
  w.handle.destroy();
});

test('photo check: with no plan it still checks spacing and ground detail; copies and bad files are reported', async () => {
  const { jpeg, tiff, xmpText } = await import('./fixtures/photoFixtures.mjs');
  const w = setup();
  const pc = w.handle.photoCheck();
  const mk = (i, lat) => ({
    name: `p${i}.jpg`,
    bytes: jpeg({
      exif: tiff({
        gps: { lat, lon: -97.5, alt: 200 },
        time: `2026:10:30 13:00:${String(i).padStart(2, '0')}`,
      }),
      xmp: xmpText({ lat, lon: -97.5, abs: 200, rel: 60 }),
    }),
  });
  const files = [0, 1, 2, 3].map((i) => mk(i, 30.1 + i * 0.0001));
  files.push({ ...files[0], name: 'p0 (1).jpg' });
  files.push({
    name: 'nopos.jpg',
    bytes: jpeg({ exif: tiff({ gps: 'empty' }) }),
  });
  const a = await pc.addFiles(files);
  assert.equal(a.summary.photoCount, 4);
  assert.equal(a.duplicates, 1);
  assert.equal(a.summary.plannedCount, 0);
  assert.ok(Math.abs(a.summary.gsdMedianCm - (60 / 2730.6667) * 100) < 0.01);
  const shown = w
    .find((n) => n.getAttribute?.('data-level'))
    .map((n) => n.textContent)
    .join('\n');
  assert.match(shown, /1 file has no position/);
  assert.match(shown, /No plan on the panel/);
  w.handle.destroy();
});

test('photo check: nothing is stored or sent anywhere', async () => {
  const { jpeg, tiff, xmpText } = await import('./fixtures/photoFixtures.mjs');
  const storage = memoryStorage({ 'gev.dronePlan.units': 'm' });
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    calls.push(args);
    return Promise.reject(new Error('no network'));
  };
  try {
    const w = setup({ storage });
    const before = JSON.stringify([...storage.map]);
    const calls0 = calls.length; // the panel's own plan library asks for its list on open
    await w.handle.photoCheck().addFiles([
      {
        name: 'a.jpg',
        bytes: jpeg({
          exif: tiff({ gps: { lat: 30.1, lon: -97.5, alt: 1 } }),
          xmp: xmpText({ lat: 30.1, lon: -97.5, abs: 1, rel: 50 }),
        }),
      },
    ]);
    assert.equal(JSON.stringify([...storage.map]), before);
    assert.equal(calls.length, calls0);
    w.handle.destroy();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('photo check: files chosen while others are still being read wait their turn', async () => {
  const { jpeg, tiff, xmpText } = await import('./fixtures/photoFixtures.mjs');
  const w = setup();
  const pc = w.handle.photoCheck();
  const mk = (i) => ({
    name: `p${i}.jpg`,
    bytes: jpeg({
      exif: tiff({
        gps: { lat: 30.1 + i * 0.0003, lon: -97.5, alt: 1 },
        time: `2026:10:30 13:00:${String(i).padStart(2, '0')}`,
      }),
      xmp: xmpText({ lat: 30.1 + i * 0.0003, lon: -97.5, abs: 1, rel: 50 }),
    }),
  });
  const first = pc.addFiles([mk(0), mk(1)]);
  const second = await pc.addFiles([mk(2), mk(3)]); // arrives while the first is reading
  assert.equal(second, null);
  const done = await first;
  assert.equal(done.summary.photoCount, 4);
  w.handle.destroy();
});

test('photo check: files dropped anywhere on the panel are caught, also during a read', async () => {
  const { jpeg, tiff, xmpText } = await import('./fixtures/photoFixtures.mjs');
  const w = setup();
  const pc = w.handle.photoCheck();
  const section = w.find(
    (n) => n.getAttribute?.('data-role') === 'photo-check',
  )[0];
  const top = w.panel;
  // nothing above the drone-plan panel (the rail with the other panels) listens
  for (let n = w.panel.parentNode; n; n = n.parentNode) {
    assert.equal((n.listeners.get('drop') ?? []).length, 0);
    assert.equal((n.listeners.get('dragover') ?? []).length, 0);
  }
  assert.equal(section.parentNode !== null, true);
  const mk = (i) => ({
    name: `g${i}.jpg`,
    bytes: jpeg({
      exif: tiff({
        gps: { lat: 30.1 + i * 0.0001, lon: -97.5, alt: 200 },
        time: `2026:10:30 13:00:0${i}`,
      }),
      xmp: xmpText({ lat: 30.1 + i * 0.0001, lon: -97.5, abs: 200, rel: 60 }),
    }),
  });
  let prevented = 0;
  let stopped = 0;
  const ev = (files) => ({
    preventDefault: () => (prevented += 1),
    stopPropagation: () => (stopped += 1),
    dataTransfer: { files },
  });
  const first = pc.addFiles([mk(0)]);
  top.dispatch('drop', ev([mk(1)])); // while the first read runs
  top.dispatch('dragover', ev([]));
  // text dragged over the panel is left alone
  const before = prevented;
  top.dispatch('drop', {
    preventDefault: () => (prevented += 1),
    dataTransfer: { types: ['text/plain'], files: [] },
  });
  assert.equal(prevented, before);
  await first;
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(prevented >= 2);
  assert.ok(stopped >= 1);
  assert.equal(pc.analysis().summary.photoCount, 2);
  w.handle.destroy();
});

test('photo check: a drop of only non-JPEG files says not-a-JPEG; JPEGs without a position say no-position', async () => {
  const { jpeg, tiff } = await import('./fixtures/photoFixtures.mjs');
  const w = setup();
  const pc = w.handle.photoCheck();
  const progress = () =>
    w.find((n) => n.getAttribute?.('data-role') === 'photo-progress')[0]
      .textContent;
  await pc.addFiles([{ name: 'a.txt', bytes: new TextEncoder().encode('x') }]);
  assert.match(progress(), /not a JPEG/);
  assert.doesNotMatch(progress(), /position/);
  pc.clear();
  await pc.addFiles([
    { name: 'a.txt', bytes: new TextEncoder().encode('x') },
    { name: 'nopos.jpg', bytes: jpeg({ exif: tiff({ gps: 'none' }) }) },
  ]);
  assert.match(progress(), /position/);
  w.handle.destroy();
});

test('an imported file feeds the 3D check: one footprint and pyramid per photo; a file with no photos says so', async () => {
  const { east, group, kmz, mark, LAT } =
    await import('./importKmzFixture.mjs');
  const w = setup();
  const readout = () =>
    w.find((n) => n.getAttribute('data-role') === 'check-readout')[0]
      .textContent;
  const withPhotos = kmz([
    mark(0, east(0), LAT, { groups: group(1, 0, 0, 'reachPoint') }),
    mark(1, east(10), LAT, { groups: group(2, 1, 1, 'reachPoint') }),
    mark(2, east(20), LAT, { groups: group(3, 2, 2, 'reachPoint') }),
    mark(3, east(60), LAT, { groups: group(4, 2, 3, 'multipleDistance', 20) }),
  ]);
  await w.handle.library().importBytes(withPhotos, 'photos.kmz');
  await wait(20);
  const checkView = checkBox(w, 'frustum');
  checkView.value = 'thinned';
  checkView.dispatch('change');
  const mode = checkBox(w, 'footprints');
  mode.value = 'all';
  mode.dispatch('change');
  // Three point photos + stations at 0, 20, 40 m on the 40 m leg.
  assert.equal(checkOf(w, 'footprint').length, 3 + 3);
  assert.equal(checkOf(w, 'view').length, 6 * 5);
  assert.match(readout(), /Photo 1 of 6: Import|Photo 1 of 6: photos/);
  // Hiding the import takes the check away again.
  const shown = w.find(
    (n) => n.getAttribute?.('aria-label') === 'Show on map',
  )[0];
  shown.checked = false;
  shown.dispatch('change');
  await wait(20);
  assert.equal(checkOf(w, 'footprint').length, 0);
  // A file with no photo action: no cones, and the readout says why.
  await w.handle
    .library()
    .importBytes(
      kmz([mark(0, east(0), LAT), mark(1, east(30), LAT)]),
      'nophoto.kmz',
    );
  await wait(20);
  assert.equal(checkOf(w, 'footprint').length, 0);
  assert.match(readout(), /No photo actions in nophoto/);
  w.handle.destroy();
});

test('the camera settings checklist shows in the panel, follows its preset and feeds the shutter', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  const list = () =>
    w
      .find((n) => n.attributes.get('data-role') === 'camera-checklist')[0]
      .children.map((li) => li.textContent);
  assert.deepEqual(list(), [
    'Photo size: 50 MP, 4:3 (8192 x 6144)',
    'Shutter: 1/1000 s or faster',
    'White balance: fixed (not auto)',
    'Exposure compensation (EV): -0.7',
    'Before launch: take a test photo and check it is 8192 x 6144',
  ]);
  pick(w, 'Shutter speed', '250');
  assert.equal(
    list()[1],
    'Shutter: 1/250 s or faster',
    'the checklist shows the shutter the plan assumes',
  );
  pick(w, 'Camera settings preset', 'test-12mp');
  assert.equal(
    w.control('Shutter speed').value,
    '500',
    'the preset feeds the blur shutter',
  );
  assert.equal(list()[0], 'Photo size: 12 MP, 4:3 (4096 x 3072)');
  assert.match(list()[4], /4096 x 3072/);
  await w.handle.replan();
  assert.equal(w.handle.getResult().plan.options.cameraPresetId, 'test-12mp');
  w.buttons('data-download')[0].click();
  const readme = new TextDecoder().decode(
    readZip(w.downloads.at(-1).bytes).get('README.txt'),
  );
  assert.match(readme, /Camera settings \(set in DJI Fly/);
  assert.match(readme, /Photo size: 12 MP, 4:3 \(4096 x 3072\)/);
  assert.match(readme, /Shutter required: 1\/500 s or faster/);
  assert.match(readme, /White balance: fixed \(not auto\)/);
  assert.match(readme, /\(EV\): -0\.7/);
  w.handle.destroy();
});

// ------------------------------------------------ mission labels (M1, M2) --
test('mission labels: a saved plan exports as M01_<name>.kmz with a picture, README and cheat sheet; flown is one click', async () => {
  const srv = await server();
  try {
    const copied = [];
    const rendered = [];
    const pic = new Uint8Array([0xff, 0xd8, 9, 9, 0xff, 0xd9]);
    const w = setup({
      libraryClient: srv.clientFor('alice'),
      renderPreview: async (spec) => {
        rendered.push(spec);
        return { bytes: pic, tile: false };
      },
    });
    w.doc.defaultView = {
      prompt: () => '',
      confirm: () => true,
      navigator: { clipboard: { writeText: async (t) => copied.push(t) } },
    };
    await settleUi();
    w.handle.setBox(boxM(400, 200));
    await w.handle.replan();
    // Not saved yet: no number, the old file name, and the note says how to get one.
    const note = () =>
      w.find((n) => n.getAttribute?.('data-role') === 'mission-label-note')[0]
        .textContent;
    assert.match(note(), /Save this plan in the Plan library/);
    w.handle.downloadMission(0);
    assert.match(w.downloads.at(-1).name, /^gev-drone-plan-/);
    assert.equal(
      btnPreview(w).every((b) => b.disabled),
      true,
      'no picture without a number',
    );

    field(w, 'name').value = 'Byrd Ranch ring A';
    btn(w, 'library-save')[0].click();
    await settleUi();
    assert.match(rows(w)[0].textContent, /^M1 · Byrd Ranch ring A/);
    assert.match(note(), /labelled M1/);
    await w.handle.replan();
    await settleUi();

    // One mission: M01_<slug>.kmz, the author is the visible title, and the check is clean.
    const total = w.handle.getResult().missions.length;
    w.handle.downloadMission(0);
    const one = w.downloads.at(-1);
    assert.equal(
      one.name,
      total > 1 ? 'M01-1_Byrd-Ranch-ring-A.kmz' : 'M01_Byrd-Ranch-ring-A.kmz',
    );
    const parsed = await parseDjiKmz(one.bytes, { fileName: one.name });
    assert.match(parsed.meta.author, /^M01(-1)? Byrd Ranch ring A/);
    assert.deepEqual(
      checkMission(parsed, { droneEnumValue: 68 }).filter(
        (f) => f.code === 'template-shape',
      ),
      [],
    );

    // The picture button gives a JPG named like the file.
    assert.equal(await w.handle.downloadPreview(0), true);
    assert.equal(
      w.downloads.at(-1).name,
      one.name.replace(/\.kmz$/, '_preview.jpg'),
    );
    assert.equal(w.downloads.at(-1).type, 'image/jpeg');
    assert.equal(rendered.at(-1).code, total > 1 ? 'M1-1' : 'M1');
    assert.ok(rendered.at(-1).points.length > 2, 'the route is what is drawn');

    // The ZIP carries the picture and the label block.
    w.buttons('data-download')[0].click();
    await settleUi();
    const zip = w.downloads.at(-1);
    assert.match(zip.name, /^M01_Byrd-Ranch-ring-A-all\.zip$/);
    const files = readZip(zip.bytes);
    assert.ok([...files.keys()].some((n) => n.endsWith('_preview.jpg')));
    assert.match(
      new TextDecoder().decode(files.get('README.txt')),
      /MISSION LABELS/,
    );

    // A second plan is M2; the first keeps M1 after a rename.
    w.handle.applyOptions({ aglM: 55 }, { planNow: true });
    await w.handle.replan();
    field(w, 'name').value = 'Shop';
    btn(w, 'library-save-new')[0].click();
    await settleUi();
    const lines = rows(w).map((r) => r.textContent);
    assert.ok(
      lines.some((l) => /^M1 · Byrd Ranch ring A/.test(l)),
      lines.join('|'),
    );
    assert.ok(
      lines.some((l) => /^M2 · Shop/.test(l)),
      lines.join('|'),
    );

    // Flown: one click, the row shows it, the cheat sheet copies with it.
    const shopRow = () => rows(w).find((r) => /^M2 /.test(r.textContent));
    assert.match(shopRow().textContent, /Planned/);
    const flown = shopRow().children.find(
      (c) => c.getAttribute?.('data-action') === 'plan-flown',
    );
    assert.equal(flown.textContent, 'MARK FLOWN');
    flown.click();
    await settleUi();
    assert.match(shopRow().textContent, /Flown \d{4}-\d{2}-\d{2}/);
    btn(w, 'library-cheat-copy')[0].click();
    await settleUi();
    assert.match(copied[0], /\[x\] M2 +Shop +- FLOWN \d{4}-\d{2}-\d{2}/);
    assert.match(copied[0], /\[ \] M1 +Byrd Ranch ring A +- not flown/);
    btn(w, 'library-cheat-print')[0].click();
    await settleUi();
    assert.equal(w.downloads.at(-1).name, 'GEV-mission-cheat-sheet.html');
    // Taking it back.
    shopRow()
      .children.find((c) => c.getAttribute?.('data-action') === 'plan-flown')
      .click();
    await settleUi();
    assert.match(shopRow().textContent, /Planned/);
    w.handle.destroy();
  } finally {
    await srv.close();
  }
});

const btnPreview = (w) =>
  w.find((n) => n.tagName === 'BUTTON' && n.attributes.has('data-preview'));

test('mission labels: the ZIP waits for a slow picture instead of shipping without it', async () => {
  const srv = await server();
  try {
    let calls = 0;
    const pic = new Uint8Array([0xff, 0xd8, 7, 0xff, 0xd9]);
    const w = setup({
      libraryClient: srv.clientFor('alice'),
      renderPreview: async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 120));
        return { bytes: pic, tile: false };
      },
    });
    w.doc.defaultView = { prompt: () => '', confirm: () => true };
    await settleUi();
    w.handle.setBox(boxM(400, 200));
    await w.handle.replan();
    field(w, 'name').value = 'Slow';
    btn(w, 'library-save')[0].click();
    await settleUi();
    // A fresh plan: the pictures are not drawn yet when the button is pressed.
    w.handle.applyOptions({ aglM: 70 }, { planNow: true });
    await w.handle.replan();
    const before = w.downloads.length;
    const pending = w.handle.downloadAll();
    assert.equal(
      w.downloads.length,
      before,
      'nothing is shipped before the picture exists',
    );
    assert.equal(typeof pending.then, 'function');
    assert.equal(await pending, true);
    const files = readZip(w.downloads.at(-1).bytes);
    assert.ok(
      [...files.keys()].some((n) => n.endsWith('_preview.jpg')),
      'the picture is in the zip',
    );
    assert.match(
      new TextDecoder().decode(files.get('README.txt')),
      /picture: M01(-1)?_Slow/,
    );
    assert.ok(calls >= 1);
    // The picture is cached: a second download is immediate (a plain true).
    assert.equal(w.handle.downloadAll(), true);
    w.handle.destroy();
  } finally {
    await srv.close();
  }
});

test('mission labels: a processed plan has no one-click flown toggle', async () => {
  const srv = await server();
  try {
    const w = setup({ libraryClient: srv.clientFor('alice') });
    w.doc.defaultView = { prompt: () => '', confirm: () => true };
    await settleUi();
    w.handle.setBox(boxM(400, 200));
    await w.handle.replan();
    field(w, 'name').value = 'P';
    btn(w, 'library-save')[0].click();
    await settleUi();
    assert.equal(btn(w, 'plan-flown').length, 1);
    btn(w, 'plan-flown')[0].click();
    await settleUi();
    assert.equal(btn(w, 'plan-flown')[0].textContent, 'NOT FLOWN');
    field(w, 'status').value = 'processed';
    btn(w, 'library-save')[0].click();
    await settleUi();
    assert.match(rows(w)[0].textContent, /Processed/);
    assert.equal(
      btn(w, 'plan-flown').length,
      0,
      'processed is not dropped by one click',
    );
    w.handle.destroy();
  } finally {
    await srv.close();
  }
});

test('mission labels: a suite zip stamps each picture with the code of its file, numbered across the passes', async () => {
  const srv = await server();
  try {
    const w = setup({
      libraryClient: srv.clientFor('alice'),
      renderPreview: async (spec) => ({
        bytes: new TextEncoder().encode(`PIC:${spec.code}`),
        tile: false,
      }),
    });
    w.doc.defaultView = { prompt: () => '', confirm: () => true };
    await settleUi();
    w.handle.setBox(boxM(300, 200));
    await w.handle.replan();
    field(w, 'name').value = 'Suite';
    btn(w, 'library-save')[0].click();
    await settleUi();
    await w.handle.planSuite();
    const passes = w.handle.getState().suite.passes;
    const total = passes.reduce((n, p) => n + p.result.missions.length, 0);
    assert.ok(total >= 4, 'several passes, so flights run across them');
    const before = w.downloads.length;
    assert.equal(await w.handle.downloadSuite(), true);
    assert.equal(w.downloads.length, before + 1);
    const files = readZip(w.downloads.at(-1).bytes);
    const names = [...files.keys()];
    const kmz = names.filter((n) => n.endsWith('.kmz'));
    assert.equal(kmz.length, total);
    for (const k of kmz) {
      const code = /\/(M01(?:-\d+)?)_Suite\.kmz$/.exec(k)?.[1];
      assert.ok(code, k);
      const pic = names.find((n) => n === k.replace(/\.kmz$/, '_preview.jpg'));
      assert.ok(pic, `${k} has its picture`);
      // The picture says M1-n (unpadded) where the file says M01-n.
      assert.equal(
        new TextDecoder().decode(files.get(pic)),
        `PIC:${code.replace(/^M0/, 'M')}`,
      );
    }
    w.handle.destroy();
  } finally {
    await srv.close();
  }
});

test('mission labels: a replan while the zip waits for its pictures drops the stale download', async () => {
  const srv = await server();
  try {
    const w = setup({
      libraryClient: srv.clientFor('alice'),
      renderPreview: async () => {
        await new Promise((r) => setTimeout(r, 120));
        return { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), tile: false };
      },
    });
    w.doc.defaultView = { prompt: () => '', confirm: () => true };
    await settleUi();
    w.handle.setBox(boxM(400, 200));
    await w.handle.replan();
    field(w, 'name').value = 'Stale';
    btn(w, 'library-save')[0].click();
    await settleUi();
    w.handle.applyOptions({ aglM: 66 }, { planNow: true });
    await w.handle.replan();
    const before = w.downloads.length;
    const pending = w.handle.downloadAll();
    assert.equal(typeof pending.then, 'function', 'it is waiting for pictures');
    w.handle.applyOptions({ aglM: 62 }, { planNow: true });
    await w.handle.replan();
    assert.equal(await pending, false, 'the old plan is not shipped');
    assert.equal(w.downloads.length, before);
    w.handle.destroy();
  } finally {
    await srv.close();
  }
});

test('mission labels: a crafted controller id is not used as the single-download file name', async () => {
  const srv = await server();
  try {
    const w = setup({ libraryClient: srv.clientFor('alice') });
    w.doc.defaultView = { prompt: () => '', confirm: () => true };
    await settleUi();
    w.handle.setBox(boxM(400, 200));
    await w.handle.replan();
    field(w, 'name').value = 'Id';
    btn(w, 'library-save')[0].click();
    await settleUi();
    w.handle.getState().controllerIds = ['../../evil'];
    w.handle.downloadMission(0);
    assert.match(w.downloads.at(-1).name, /^M01(-1)?_Id\.kmz$/);
    const uuid = '8A05BD5F-A9CE-4867-923F-7AACC02AF9A9';
    w.handle.getState().controllerIds = [uuid];
    w.handle.downloadMission(0);
    assert.equal(w.downloads.at(-1).name, `${uuid}.kmz`);
    w.handle.destroy();
  } finally {
    await srv.close();
  }
});

test('mission labels: a rename while the picture loads does not strip the pictures from the zip that waited', async () => {
  const srv = await server();
  try {
    const w = setup({
      libraryClient: srv.clientFor('alice'),
      renderPreview: async () => {
        await new Promise((r) => setTimeout(r, 120));
        return { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), tile: false };
      },
    });
    w.doc.defaultView = { prompt: () => '', confirm: () => true };
    await settleUi();
    w.handle.setBox(boxM(400, 200));
    await w.handle.replan();
    field(w, 'name').value = 'Before';
    btn(w, 'library-save')[0].click();
    await settleUi();
    w.handle.applyOptions({ aglM: 64 }, { planNow: true });
    await w.handle.replan();
    const pending = w.handle.downloadAll();
    field(w, 'name').value = 'After';
    btn(w, 'library-save')[0].click();
    await settleUi();
    assert.equal(await pending, true);
    const zip = w.downloads.find((d) => d.name.endsWith('-all.zip'));
    const names = [...readZip(zip.bytes).keys()];
    assert.ok(
      names.some((n) => n.endsWith('_preview.jpg')),
      names.join(),
    );
    w.handle.destroy();
  } finally {
    await srv.close();
  }
});

test('mission labels: trashing the open plan clears the labels at once; a picture that cannot be drawn warns before the zip', async () => {
  const srv = await server();
  try {
    const w = setup({
      libraryClient: srv.clientFor('alice'),
      renderPreview: async () => null,
    });
    w.doc.defaultView = { prompt: () => '', confirm: () => true };
    await settleUi();
    w.handle.setBox(boxM(400, 200));
    await w.handle.replan();
    field(w, 'name').value = 'Warn';
    btn(w, 'library-save')[0].click();
    await settleUi();
    const note = () =>
      w.find((n) => n.getAttribute?.('data-role') === 'mission-label-note')[0]
        .textContent;
    assert.match(note(), /labelled M1/);
    assert.equal(await w.handle.downloadAll(), true);
    assert.match(
      w.find((n) => n.dataset?.tone === 'warn')[0]?.textContent ?? '',
      /picture could not be drawn/,
    );
    btn(w, 'plan-delete')[0].click();
    await settleUi();
    assert.match(note(), /Save this plan in the Plan library/);
    w.handle.destroy();
  } finally {
    await srv.close();
  }
});
test('1500 ft: the slider reaches the planning maximum, plans at 457.2 m and says what the maximum is not', async () => {
  const w = setup({ storage: memoryStorage() });
  const o = () => w.handle.getState().options;
  const agl = w.control('Height above ground');
  assert.equal(agl.max, '1500');
  agl.value = '1500';
  agl.dispatch('input');
  assert.equal(o().aglM, 457.2, 'the top feet stop is exactly 457.2 m');
  const out = agl.parentNode.children.find(
    (n) => n.tagName === 'OUTPUT',
  ).textContent;
  assert.equal(out, '1,500 ft');
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  const result = w.handle.getResult();
  assert.equal(result.plan.options.aglM, 457.2);
  assert.ok(result.warnings.some((x) => x.code === 'agl-above-400ft'));
  assert.ok(!result.warnings.some((x) => x.code === 'agl-capped'));
  const shown = w.find(
    (n) => n.getAttribute?.('data-code') === 'agl-above-400ft',
  );
  assert.equal(shown.length, 1);
  assert.match(shown[0].textContent, /1,500 ft is only the most GEV will plan/);
  assert.match(shown[0].textContent, /does not approve a flight/);
  assert.match(shown[0].textContent, /airspace authorization/);
  w.handle.destroy();
});

const captureRole = (w, role) =>
  w.find((n) => n.getAttribute('data-role') === role)[0];

function liveFigures(w) {
  const o = w.handle.getState().options;
  return captureFigures({
    preset: getPreset(o.presetId),
    aglM: o.aglM,
    tiltDeg: captureTiltDeg(o),
    frontOverlap: o.frontOverlap,
    sideOverlap: o.sideOverlap,
    photoSpacingM: o.photoSpacingM,
    speedMs: o.speedMs,
    shutterDenominator: o.shutterDenominator,
  });
}

test('capture controls default to stop, continuous off, 200 waypoints and 20 usable minutes', () => {
  const w = setup();
  const o = w.handle.getState().options;
  assert.equal(o.captureMode, 'stop');
  assert.equal(o.continuousRoute, false);
  assert.equal(o.maxWaypoints, 200);
  assert.equal(o.usableBatteryMin, 20);
  assert.equal(o.photoSpacingM, null);
  assert.equal(w.control('Capture mode').value, 'stop');
  assert.equal(w.control('Maximum waypoints per file').value, '200');
  assert.equal(w.control('Usable minutes per battery').value, '20');
  assert.equal(w.control('One continuous route').checked, false);
  assert.equal(captureRole(w, 'capture-readout').hidden, true);
  const snap = serializePlan(w.handle.getState(), {});
  assert.equal(snap.options.captureMode, 'stop');
  assert.equal(snap.options.continuousRoute, false);
  assert.equal(snap.options.maxWaypoints, 200);
  assert.equal(snap.options.usableBatteryMin, 20);
  assert.equal(Object.hasOwn(snap.options, 'photoSpacingM'), false);
  const back = readPlan(snap);
  assert.equal(back.options.continuousRoute, false);
  assert.equal(back.options.maxWaypoints, 200);
  assert.equal(back.options.usableBatteryMin, 20);
  w.handle.destroy();
});

test('waypoint cap accepts 20 to 200; usable minutes clamp to 5..60 and empty returns 20', () => {
  const w = setup();
  const cap = w.control('Maximum waypoints per file');
  cap.value = '19';
  cap.dispatch('change');
  assert.equal(w.handle.getState().options.maxWaypoints, 20);
  assert.equal(cap.value, '20');
  cap.value = '100';
  cap.dispatch('change');
  assert.equal(w.handle.getState().options.maxWaypoints, 100);
  cap.value = '5000';
  cap.dispatch('change');
  assert.equal(w.handle.getState().options.maxWaypoints, 200);
  const bat = w.control('Usable minutes per battery');
  bat.value = '18';
  bat.dispatch('change');
  assert.equal(w.handle.getState().options.usableBatteryMin, 18);
  bat.value = '';
  bat.dispatch('change');
  assert.equal(w.handle.getState().options.usableBatteryMin, 20);
  bat.value = '90';
  bat.dispatch('change');
  assert.equal(w.handle.getState().options.usableBatteryMin, 60);
  bat.value = '3';
  bat.dispatch('change');
  assert.equal(w.handle.getState().options.usableBatteryMin, 5);
  w.handle.destroy();
});

test('distance mode shows unproven, wind, resume and clearance warnings and exported figures', () => {
  const w = setup();
  pick(w, 'Capture mode', 'distance');
  const readout = captureRole(w, 'capture-readout');
  assert.equal(readout.hidden, false);
  assert.match(readout.textContent, /NOT proven on the Mini 5 Pro/);
  assert.match(
    readout.textContent,
    /Each extra survey line in a battery adds 3 seconds/,
  );
  assert.match(
    readout.textContent,
    /clearance check is for the planned route only/,
  );
  assert.match(readout.textContent, /not proven to continue after a resume/);
  assert.match(readout.textContent, /Check the first resume/);
  assert.match(readout.textContent, /off by one photo spacing/);
  assert.equal(captureRole(w, 'capture-resume-timed'), undefined);
  const figs = liveFigures(w);
  assert.ok(figs.seconds < figs.minPhotoIntervalS);
  assert.equal(Number(readout.getAttribute('data-seconds')), figs.seconds);
  assert.equal(Number(readout.getAttribute('data-photo-m')), figs.photoM);
  assert.equal(Number(readout.getAttribute('data-front')), figs.frontPct);
  assert.equal(Number(readout.getAttribute('data-gsd')), figs.footprint.gsdCm);
  assert.equal(readout.getAttribute('data-limited-by'), figs.limits.limitedBy);
  assert.equal(
    captureRole(w, 'capture-interval-warn').getAttribute('data-tone'),
    'bad',
  );
  assert.match(
    captureRole(w, 'capture-footprint').textContent,
    /along the track/,
  );
  assert.match(captureRole(w, 'capture-overlap').textContent, /% front/);
  const table = captureRole(w, 'capture-shutter-table');
  assert.equal(table.children.length, SHUTTER_DENOMINATORS.length);
  const preset = getPreset(w.handle.getState().options.presetId);
  const row = table.children[2];
  const capSpeed = speedLimits({
    preset,
    photoSpacingM: 0,
    gsdCm: figs.footprint.gsdCm,
    shutterDenominator: SHUTTER_DENOMINATORS[2],
  });
  assert.equal(row.getAttribute('data-shutter'), '1000');
  assert.match(row.textContent, new RegExp(capSpeed.limitMs.toFixed(1)));
  w.handle.destroy();
});

test('timed mode says the shot is started by hand and warns that it may stop on resume', () => {
  const w = setup();
  pick(w, 'Capture mode', 'timed');
  const readout = captureRole(w, 'capture-readout');
  assert.match(readout.textContent, /start the timed shot by hand/);
  assert.match(readout.textContent, /Timed shot may stop/);
  assert.match(readout.textContent, /The tool cannot know the light/);
  assert.equal(captureRole(w, 'capture-unproven'), undefined);
  assert.equal(captureRole(w, 'capture-resume-distance'), undefined);
  assert.ok(captureRole(w, 'capture-resume-timed'));
  w.handle.destroy();
});

test('a forged imported plan cannot hide the Mini 5 Pro unproven notice', async () => {
  const w = setup();
  const area = {
    kind: 'rect',
    name: 'A',
    box: { west: -97.1, east: -97.09, south: 30.1, north: 30.11 },
  };
  await w.handle.loadPlan({
    schema: 'gevplan',
    version: 1,
    areas: [area],
    options: { captureMode: 'distance', intervalTriggerProven: true },
  });
  assert.equal(w.handle.getState().options.intervalTriggerProven, false);
  assert.ok(captureRole(w, 'capture-unproven'));
  assert.match(
    captureRole(w, 'capture-readout').textContent,
    /NOT proven on the Mini 5 Pro/,
  );
  assert.match(
    captureRole(w, 'capture-readout').textContent,
    /not proven to continue after a resume/,
  );
  assert.doesNotMatch(
    captureRole(w, 'capture-readout').textContent,
    /real-world proven/i,
  );
  assert.equal(
    Object.hasOwn(serializePlan(w.handle.getState(), {}).options, 'intervalTriggerProven'),
    false,
  );
  const result = w.handle.getState().result;
  assert.ok(result, 'forged plan still plans');
  const readme = readmeText(result);
  assert.match(readme, /NOT proven on the Mini 5 Pro/);
  assert.match(readme, /unproven distance trigger/);
  assert.doesNotMatch(readme, /real-world proven/i);
  assert.doesNotMatch(readme, /trigger is proven/i);
  w.handle.destroy();
});

test('voice and applyOptions cannot hide the Mini 5 Pro unproven notice', async () => {
  const w = setup();
  pick(w, 'Capture mode', 'distance');
  assert.equal(w.handle.getState().options.intervalTriggerProven, false);
  assert.ok(captureRole(w, 'capture-unproven'));
  assert.equal(w.handle.applyOptions({ intervalTriggerProven: 'yes' }), true);
  assert.equal(w.handle.getState().options.intervalTriggerProven, false);
  assert.ok(captureRole(w, 'capture-unproven'));
  assert.equal(w.handle.applyOptions({ intervalTriggerProven: true, speedMs: 6 }), true);
  assert.equal(w.handle.getState().options.speedMs, 6);
  assert.equal(w.handle.getState().options.intervalTriggerProven, false);
  assert.ok(captureRole(w, 'capture-unproven'));
  assert.match(
    captureRole(w, 'capture-readout').textContent,
    /NOT proven on the Mini 5 Pro/,
  );
  const voice = createDronePlanVoice(w.handle);
  const onlyFlag = await voice.options({ intervalTriggerProven: true });
  assert.equal(onlyFlag.ok, false);
  assert.equal(w.handle.getState().options.intervalTriggerProven, false);
  assert.ok(captureRole(w, 'capture-unproven'));
  const spoken = await voice.options({ intervalTriggerProven: true, speedMs: 7 });
  assert.equal(spoken.ok, true);
  assert.equal(w.handle.getState().options.speedMs, 7);
  assert.equal(w.handle.getState().options.intervalTriggerProven, false);
  assert.ok(captureRole(w, 'capture-unproven'));
  assert.match(
    captureRole(w, 'capture-readout').textContent,
    /NOT proven on the Mini 5 Pro/,
  );
  assert.equal(
    Object.hasOwn(serializePlan(w.handle.getState(), {}).options, 'intervalTriggerProven'),
    false,
  );
  w.handle.destroy();
});

test('fixed photo spacing follows feet and is saved in metres; overlap clears it', () => {
  const w = setup({ storage: memoryStorage({ 'gev.dronePlan.units': 'ft' }) });
  pick(w, 'Capture mode', 'distance');
  pick(w, 'Photo spacing', 'distance');
  assert.ok(w.handle.getState().options.photoSpacingM > 0);
  assert.match(
    w.find((n) => n.textContent.startsWith('Photo spacing ('))[0].textContent,
    /ft/,
  );
  const input = w.control('Fixed photo spacing');
  input.value = '100';
  input.dispatch('change');
  const metres = w.handle.getState().options.photoSpacingM;
  assert.ok(Math.abs(metres - 30.48) < 0.02, `got ${metres}`);
  const snap = serializePlan(w.handle.getState(), {});
  assert.equal(snap.options.photoSpacingM, metres);
  assert.equal(snap.options.captureMode, 'distance');
  pick(w, 'Photo spacing', 'overlap');
  assert.equal(w.handle.getState().options.photoSpacingM, null);
  assert.equal(
    Object.hasOwn(
      serializePlan(w.handle.getState(), {}).options,
      'photoSpacingM',
    ),
    false,
  );
  w.handle.destroy();
});

test('continuousRoute false is saved and stays off; checking it turns the plan continuous', async () => {
  const w = setup();
  w.handle.setBox(boxM(200, 120));
  pick(w, 'Capture mode', 'distance');
  assert.equal(w.handle.getState().options.continuousRoute, false);
  await w.handle.replan();
  assert.equal(w.handle.getResult().plan.options.captureMode, 'distance');
  assert.equal(w.handle.getResult().plan.options.continuousRoute, false);
  const box = w.control('One continuous route');
  box.checked = true;
  box.dispatch('change');
  assert.equal(w.handle.getState().options.continuousRoute, true);
  await w.handle.replan();
  assert.equal(w.handle.getResult().plan.options.continuousRoute, true);
  assert.match(
    captureRole(w, 'capture-readout').textContent,
    /Each extra survey line in a battery adds 3 seconds/,
  );
  w.handle.destroy();
});

test('the waypoint field is the cap the plan splits on', async () => {
  const w = setup();
  w.handle.setBox(boxM(400, 300));
  const cap = w.control('Maximum waypoints per file');
  cap.value = '20';
  cap.dispatch('change');
  await w.handle.replan();
  const result = w.handle.getResult();
  assert.ok(
    result.missions.length > 1,
    'a wide grid should exceed 20 waypoints',
  );
  assert.ok(result.missions.every((m) => m.waypointCount <= 20));
  assert.equal(result.plan.options.maxWaypoints, 20);
  w.handle.destroy();
});

test('continuous battery lines name globe markers and an unreachable round trip', () => {
  const far = { lon: -95, lat: 30, relHeightM: 80 };
  const result = {
    plan: {
      options: { continuousRoute: true },
      speedMs: 5,
      takeoff: { lon: -97, lat: 30 },
    },
    missions: [
      {
        waypoints: [far, { lon: far.lon + 0.01, lat: 30, relHeightM: 80 }],
      },
    ],
    totals: { speedMs: 5, durationS: 4000 },
  };
  const shown = continuousBatteryLines(result, 1);
  assert.equal(shown.estimate.breaks.length, 0);
  assert.equal(
    shown.estimate.unreachable[0].reason,
    'round-trip-exceeds-usable-minutes',
  );
  assert.equal(
    shown.lines.some((line) => /not a marker/i.test(line.text)),
    false,
  );
  const gap = shown.lines.find((line) => line.role === 'capture-unreachable');
  assert.equal(gap.tone, 'bad');
  assert.match(gap.text, /round trip already exceeds/);
  assert.match(gap.text, /not covered/);
  const stuck = {
    ...result,
    missions: [
      {
        waypoints: [
          { lon: -97.01, lat: 30, relHeightM: 80 },
          { lon: -96.5, lat: 30, relHeightM: 80 },
        ],
      },
    ],
  };
  const partial = continuousBatteryLines(stuck, 1);
  if (
    partial?.estimate.unreachable.some((gap) => gap.reason === 'no-progress')
  ) {
    assert.match(
      partial.lines.find((line) => line.role === 'capture-unreachable').text,
      /would not move forward/,
    );
  }
});

function realContinuousPlan() {
  const m = metersPerDegree(30.27);
  const box = {
    west: -97.77 - 1000 / m.lon,
    east: -97.77 + 1000 / m.lon,
    south: 30.27 - 600 / m.lat,
    north: 30.27 + 600 / m.lat,
  };
  const plan = planFlight(box, {
    aglM: 80,
    captureMode: 'distance',
    continuousRoute: true,
    speedMs: 8,
    usableBatteryMin: 12,
    batteryMin: 25,
    photoSpacingM: 25,
  });
  assert.equal(plan.error, undefined);
  assert.ok(plan.legs.length > 1, 'the fixture has survey lines to turn between');
  const ids = plan.legs.flatMap((leg) => leg.waypoints.map((w) => w.id));
  const built = assembleMissions(plan, {
    known: true,
    takeoffM: 40,
    wpM: ids.map(() => 40),
  });
  built.plan.options.usableBatteryMin = 12;
  return built;
}

test('panel, preview and readme agree on pause count, turns and distance for a real plan', () => {
  const built = realContinuousPlan();
  const mission = built.missions[0];
  const home = {
    lon: built.plan.takeoff.lon,
    lat: built.plan.takeoff.lat,
  };
  const oracle = batteryBreaks(mission.waypoints, {
    takeoff: home,
    speedMs: built.plan.speedMs,
    usableMin: 12,
    legs: mission.legs,
  });
  const bare = batteryBreaks(mission.waypoints, {
    takeoff: home,
    speedMs: built.plan.speedMs,
    usableMin: 12,
    photoSpacingM: 25,
  });
  assert.equal(oracle.legsUsed, true);
  assert.ok(
    oracle.breaks.some((mark) => mark.turnS >= 3),
    'a 3 second turn is on the pause',
  );
  assert.notDeepEqual(
    oracle.breaks.map((mark) => Math.round(mark.groundM)),
    bare.breaks.map((mark) => Math.round(mark.groundM)),
    'leg relationships move the pause; a bare polyline does not count turns',
  );
  assert.notEqual(
    oracle.breaks[0].photoCount,
    bare.breaks[0].photoCount,
    'station counts restart on each survey line',
  );

  const preview = batteryPauseEstimate(built, 12);
  assert.equal(preview.errors.length, 0);
  assert.equal(preview.breaks.length, oracle.breaks.length);
  preview.breaks.forEach((item, i) => {
    assert.equal(item.mark.groundM, oracle.breaks[i].groundM);
    assert.equal(item.mark.routeM, oracle.breaks[i].routeM);
    assert.equal(item.mark.turnS, oracle.breaks[i].turnS);
    assert.equal(item.mark.photoCount, oracle.breaks[i].photoCount);
  });

  const panel = continuousBatteryLines(built, 12);
  const pauses = panel.lines.filter((line) => line.role === 'capture-pause');
  assert.equal(pauses.length, oracle.breaks.length);
  pauses.forEach((line, i) => {
    assert.equal(line.groundM, oracle.breaks[i].groundM);
    assert.equal(line.turnS, oracle.breaks[i].turnS);
    assert.equal(line.photoCount, oracle.breaks[i].photoCount);
    assert.match(line.text, /Turn time in that battery/);
  });
  assert.equal(
    panel.lines.some((line) => line.role === 'capture-read-error'),
    false,
  );

  const readme = readmeText(built);
  const rows = [
    ...readme.matchAll(
      /distance (\d+) m from the file start, photo count (\d+) from the file start, about [\d.]+ min, turn time (\d+) s/g,
    ),
  ];
  assert.equal(rows.length, oracle.breaks.length);
  rows.forEach((row, i) => {
    assert.equal(Number(row[1]), Math.round(oracle.breaks[i].groundM));
    assert.equal(Number(row[2]), oracle.breaks[i].photoCount);
    assert.equal(Number(row[3]), oracle.breaks[i].turnS);
  });
  assert.match(readme, /Each extra survey line in a battery adds 3 seconds/);
  assert.doesNotMatch(readme, /turns are not in the model/);
});

test('an unreachable round trip is warned and is not called a fitting pause', () => {
  const far = { lon: -95, lat: 30, relHeightM: 80 };
  const route = [far, { lon: far.lon + 0.01, lat: 30, relHeightM: 80 }];
  const result = {
    plan: {
      options: {
        continuousRoute: true,
        usableBatteryMin: 1,
        captureMode: 'distance',
      },
      speedMs: 5,
      takeoff: { lon: -97, lat: 30 },
      preset: { name: 'Test', minPhotoIntervalS: 2 },
      footprint: { alongM: 20, acrossM: 30 },
      spacing: { photoM: 20, lineM: 30 },
    },
    missions: [
      {
        waypoints: route,
        legs: [
          {
            waypoints: route,
            captureMode: 'distance',
            photoSpacingM: 20,
            continued: false,
          },
        ],
        waypointCount: 2,
        photoCount: 1,
        distanceM: 900,
        durationS: 4000,
      },
    ],
    totals: { speedMs: 5, durationS: 4000, gsdCm: 1, photoCount: 1 },
    warnings: [],
  };
  const shown = continuousBatteryLines(result, 1);
  assert.equal(shown.estimate.breaks.length, 0);
  assert.equal(shown.estimate.covered, false);
  assert.equal(
    shown.estimate.unreachable[0].reason,
    'round-trip-exceeds-usable-minutes',
  );
  assert.ok(shown.estimate.unreachable[0].remainingGroundM > 0);
  const gap = shown.lines.find((line) => line.role === 'capture-unreachable');
  assert.equal(gap.tone, 'bad');
  assert.match(gap.text, /not covered/);
  assert.equal(
    shown.lines.some((line) => /No pause marker is needed/.test(line.text)),
    false,
  );
  const readme = readmeText(result);
  assert.match(readme, /UNREACHABLE:/);
  assert.match(readme, /not a pause plan/);
  assert.match(readme, /Remaining distance about \d+ m/);
  assert.doesNotMatch(readme, /fits in 1 usable minutes/);
  assert.doesNotMatch(readme, /No pause was guessed/);
  assert.equal(batteryPauseEstimate(result, 1).breaks.length, 0);
});

test('a valid route whose legs do not match is a read error, not a guessed pause', () => {
  const built = realContinuousPlan();
  const mission = built.missions[0];
  mission.legs = [
    {
      waypoints: [
        mission.waypoints[0],
        { lon: 0, lat: 0, relHeightM: mission.waypoints[0].relHeightM },
      ],
      captureMode: 'distance',
      photoSpacingM: 25,
    },
  ];
  const shown = continuousBatteryLines(built, 12);
  assert.equal(shown.estimate.breaks.length, 0);
  assert.equal(shown.estimate.covered, false);
  assert.match(shown.estimate.errors[0].message, /match|flatten/);
  const err = shown.lines.find((line) => line.role === 'capture-read-error');
  assert.equal(err.tone, 'bad');
  assert.match(err.text, /could not be read/);
  assert.match(err.text, /No pause was guessed/);
  assert.equal(
    shown.lines.some((line) => line.role === 'capture-pause'),
    false,
  );
  const readme = readmeText(built);
  assert.match(readme, /read error/);
  assert.match(readme, /No pause was guessed/);
  assert.doesNotMatch(readme, /fits in 12 usable minutes/);
  assert.doesNotMatch(readme, /not calculated \(no route or takeoff\)/);
});

test('a continuous plan restores usable minutes and does not say markers are missing', async () => {
  const w = setup();
  w.handle.setBox(boxM(600, 300));
  const o = w.handle.getState().options;
  o.captureMode = 'distance';
  o.continuousRoute = true;
  o.usableBatteryMin = 8;
  o.speedMs = 8;
  await w.handle.replan();
  const result = w.handle.getResult();
  assert.equal(result.plan.options.continuousRoute, true);
  assert.equal(result.plan.options.usableBatteryMin, 8);
  const readout = captureRole(w, 'capture-readout');
  assert.doesNotMatch(readout.textContent, /not a marker/i);
  assert.match(readout.textContent, /Each extra survey line in a battery adds 3 seconds/);
  assert.match(
    readout.textContent,
    /clearance check is for the planned route only/,
  );
  assert.match(readout.textContent, /Check the first resume/);
  assert.match(readout.textContent, /off by one photo spacing/);
  const pause = captureRole(w, 'capture-pause');
  assert.ok(pause);
  assert.equal(pause.getAttribute('data-tone'), 'warn');
  assert.equal(pause.style.color, WARNING_TONE_COLOR.warn);
  assert.match(
    pause.textContent,
    /marked on the globe|No pause marker is needed/,
  );
  w.handle.destroy();
});

test('speed above the camera limit is red and a line-end split is amber', async () => {
  const w = setup();
  w.handle.setBox(boxM(400, 200));
  const o = w.handle.getState().options;
  o.captureMode = 'distance';
  o.photoSpacingM = 8;
  o.speedMs = 15;
  await w.handle.replan();
  const speed = w.find(
    (n) => n.getAttribute('data-code') === 'speed-exceeds-camera-limit',
  );
  assert.equal(speed.length, 1);
  assert.equal(speed[0].getAttribute('data-tone'), 'bad');
  assert.equal(speed[0].style.color, WARNING_TONE_COLOR.bad);
  assert.match(speed[0].textContent, /does not slow down/);
  assert.match(speed[0].textContent, /photos can be missed/);
  w.handle.destroy();

  const wide = setup();
  wide.handle.setBox(boxM(200, 800));
  const wideOptions = wide.handle.getState().options;
  wideOptions.captureMode = 'distance';
  wideOptions.continuousRoute = true;
  wideOptions.maxWaypoints = 20;
  wideOptions.speedMs = 8;
  wideOptions.direction = 'ew';
  wideOptions.batteryMin = 5;
  await wide.handle.replan();
  const codes = wide.handle.getResult().warnings.map((item) => item.code);
  const split = wide.find(
    (n) => n.getAttribute('data-code') === 'line-end-split',
  );
  assert.equal(split.length, 1, codes.join(','));
  assert.equal(split[0].getAttribute('data-tone'), 'warn');
  assert.equal(split[0].style.color, WARNING_TONE_COLOR.warn);
  assert.match(split[0].textContent, /end of a line/);
  assert.match(split[0].textContent, /Battery time does not cut it/);
  const kept = wide.find((n) => n.getAttribute('data-code') === 'vlos');
  if (kept.length) assert.equal(kept[0].getAttribute('data-tone'), null);
  wide.handle.destroy();
});

test('distance interval uses the rounded KMZ spacing, not the raw overlap metres', () => {
  const w = setup();
  pick(w, 'Capture mode', 'distance');
  const o = w.handle.getState().options;
  const raw = spacing(
    footprint(getPreset(o.presetId), o.aglM, 0),
    o.frontOverlap,
    o.sideOverlap,
  ).photoM;
  const written = writtenSpacingM(raw);
  assert.notEqual(raw, written);
  assert.equal(
    Number(captureRole(w, 'capture-readout').getAttribute('data-photo-m')),
    written,
  );
  assert.equal(o.speedMs, getPreset(o.presetId).defaultSpeedMs);
  w.handle.destroy();
});

test('an interval under the camera minimum stays red and the count is theoretical', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  const o = w.handle.getState().options;
  const requested = o.speedMs;
  o.captureMode = 'distance';
  await w.handle.replan();
  assert.equal(w.handle.getState().options.speedMs, requested);
  assert.equal(w.handle.getResult().plan.speedMs, requested);
  const count = captureRole(w, 'capture-counts');
  assert.equal(count.getAttribute('data-tone'), 'bad');
  assert.equal(count.style.color, WARNING_TONE_COLOR.bad);
  assert.match(count.textContent, /theoretical/i);
  assert.match(count.textContent, /not photos the camera will take/i);
  assert.doesNotMatch(count.textContent, /Photos in the plan/);
  assert.equal(
    captureRole(w, 'capture-interval-warn').getAttribute('data-tone'),
    'bad',
  );
  w.handle.destroy();
});

test('timed mode labels stations as estimated, not photos the camera will take', async () => {
  const w = setup();
  w.handle.setBox(boxM(200, 120));
  const o = w.handle.getState().options;
  o.captureMode = 'timed';
  o.speedMs = 2;
  o.photoSpacingM = 20;
  await w.handle.replan();
  assert.equal(w.handle.getState().options.speedMs, 2);
  assert.equal(w.handle.getResult().plan.speedMs, 2);
  const count = captureRole(w, 'capture-counts');
  assert.match(count.textContent, /Estimated stations/);
  assert.match(count.textContent, /not a count of photos the camera will take/);
  assert.equal(count.getAttribute('data-tone'), null);
  const readout = w.find(
    (n) => n.getAttribute('data-role') === 'check-readout',
  )[0];
  assert.match(readout.textContent, /Estimated station 1 of/);
  assert.match(readout.textContent, /Not a photo the camera will take/);
  w.handle.destroy();
});

test('production panel supplies pause labels a ConstantPositionProperty can feed', async () => {
  clearOverlaySource(BATTERY_PAUSE_SOURCE);
  const w = setup({ wrapPositions: true });
  w.handle.setBox(boxM(1000, 600));
  const o = w.handle.getState().options;
  o.captureMode = 'distance';
  o.continuousRoute = true;
  o.speedMs = 8;
  o.usableBatteryMin = 12;
  await w.handle.replan();
  const pauses = w.cesium ? w.viewer : null;
  assert.ok(pauses);
  const drawn = w.viewer.dataSources.sources
    .flatMap((source) => source.entities.values)
    .filter((entity) => entity.name === 'Battery pause');
  assert.ok(drawn.length > 0);
  assert.equal(typeof drawn[0].position.getValue, 'function');
  const registered =
    getWorldOverlayDiagnostics().entriesBySource[BATTERY_PAUSE_SOURCE] ?? 0;
  assert.equal(registered, drawn.length);
  clearOverlaySource(BATTERY_PAUSE_SOURCE);
  w.handle.destroy();
  assert.equal(
    getWorldOverlayDiagnostics().entriesBySource[BATTERY_PAUSE_SOURCE] ?? 0,
    0,
  );
});

test('a custom camera minimum drives warnings, save/load and the planned speed limit', async () => {
  const w = setup();
  const note = () => captureRole(w, 'camera-interval-note').textContent;
  assert.match(note(), /derived\/unverified/);
  assert.equal(w.control('Camera minimum interval (s)').value, '');
  assert.equal(
    Object.hasOwn(serializePlan(w.handle.getState(), {}).options, 'minPhotoIntervalS'),
    false,
  );
  pick(w, 'Capture mode', 'distance');
  assert.equal(
    captureRole(w, 'capture-interval-warn').getAttribute('data-tone'),
    'bad',
  );

  const input = w.control('Camera minimum interval (s)');
  input.value = '0.5';
  input.dispatch('change');
  assert.equal(w.handle.getState().options.minPhotoIntervalS, 0.5);
  assert.equal(captureRole(w, 'capture-interval-warn'), undefined);
  assert.match(note(), /0\.5 s instead of the preset 5/);
  const open = captureRole(w, 'capture-readout');
  const secs = Number(open.getAttribute('data-seconds'));
  assert.ok(secs >= 0.5);
  assert.equal(
    Number(open.getAttribute('data-interval-ms')),
    Number(open.getAttribute('data-photo-m')) / 0.5,
  );

  input.value = '30';
  input.dispatch('change');
  assert.equal(
    captureRole(w, 'capture-interval-warn').getAttribute('data-tone'),
    'bad',
  );
  assert.match(captureRole(w, 'capture-interval-warn').textContent, /30/);
  assert.match(
    captureRole(w, 'capture-interval-derived').textContent,
    /30\.0 s instead of the preset 5/,
  );

  w.handle.setBox(boxM(300, 200));
  const snap = serializePlan(w.handle.getState(), {});
  assert.equal(snap.options.minPhotoIntervalS, 30);
  const fresh = setup();
  await fresh.handle.loadPlan(snap);
  assert.equal(fresh.handle.getState().options.minPhotoIntervalS, 30);
  assert.equal(fresh.control('Camera minimum interval (s)').value, '30');
  assert.match(captureRole(fresh, 'capture-interval-warn').textContent, /30/);
  const loaded = fresh.handle.getResult();
  assert.equal(loaded.plan.preset.minPhotoIntervalS, 30);
  assert.ok(
    Math.abs(
      loaded.plan.speedLimits.intervalMs -
        writtenSpacingM(loaded.plan.spacing.photoM) / 30,
    ) < 1e-6,
  );
  fresh.handle.destroy();

  input.value = '0';
  input.dispatch('change');
  assert.equal(w.handle.getState().options.minPhotoIntervalS, 30);
  assert.equal(input.value, '30');
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.match(note(), /was not used/);
  input.value = '';
  input.dispatch('change');
  assert.equal(w.handle.getState().options.minPhotoIntervalS, null);
  assert.equal(input.getAttribute('aria-invalid'), 'false');

  input.value = '12.5';
  input.dispatch('change');
  const agl = w.control('Height above ground');
  const metres = agl.value;
  w.find((n) => n.getAttribute('data-action') === 'units-ft')[0].click();
  assert.notEqual(agl.value, metres);
  assert.equal(w.control('Camera minimum interval (s)').value, '12.5');
  assert.equal(w.handle.getState().options.minPhotoIntervalS, 12.5);

  pick(w, 'Aircraft', 'dji-mavic-3');
  assert.equal(w.handle.getState().options.minPhotoIntervalS, null);
  assert.equal(w.control('Camera minimum interval (s)').value, '');
  w.handle.destroy();
});

// ------------------------------------------------ Speed & photo timing ----

const INTERVAL = 'Interval you can set in DJI Fly (s)';
const timingText = (w, role) => captureRole(w, role)?.textContent ?? '';
const insideDetails = (node) => {
  for (let n = node; n; n = n.parentNode) {
    if (n.getAttribute?.('data-role') === 'capture-details') return true;
  }
  return false;
};
const timedWorld = async (extra = {}) => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  const o = w.handle.getState().options;
  o.aglM = 100;
  o.speedMs = 3.2;
  o.captureMode = 'timed';
  Object.assign(o, extra);
  await w.handle.replan();
  return w;
};
const figuresNow = (w) => {
  const o = w.handle.getState().options;
  return captureFigures({
    preset: getPreset(o.presetId),
    aglM: o.aglM,
    tiltDeg: captureTiltDeg(o),
    frontOverlap: o.frontOverlap,
    sideOverlap: o.sideOverlap,
    speedMs: o.speedMs,
    shutterDenominator: o.shutterDenominator,
  });
};

test('timing: one compact section holds speed, wanted front overlap, the recommended interval and the interval you can set', () => {
  const w = setup();
  const section = captureRole(w, 'timing');
  assert.ok(section);
  assert.match(section.textContent, /Speed & photo timing/);
  // The speed and front-overlap controls live in this section; side overlap
  // does not, so it is not confused with the front overlap.
  const within = (control) => {
    for (let n = control; n; n = n.parentNode) if (n === section) return true;
    return false;
  };
  assert.ok(within(w.control('Speed')));
  assert.ok(within(w.control('Front overlap')));
  assert.equal(within(w.control('Side overlap')), false);
  assert.ok(captureRole(w, 'timing-recommended'));
  assert.ok(w.control(INTERVAL));
  w.handle.destroy();
});

test('timing: the recommended interval is the wanted spacing over the speed, in seconds', async () => {
  const w = await timedWorld();
  const o = w.handle.getState().options;
  const figs = figuresNow(w);
  const want = (figs.footprint.alongM * (1 - o.frontOverlap / 100)) / o.speedMs;
  const rec = captureRole(w, 'timing-recommended');
  assert.ok(Math.abs(Number(rec.getAttribute('data-seconds')) - want) < 1e-9);
  assert.match(
    timingText(w, 'timing-recommended'),
    new RegExp(`${want.toFixed(1)} s`),
  );
  // The speed readout names both units, so 15 is never read as mph.
  assert.match(w.control('Speed').parentNode.textContent, /m\/s · [\d.]+ mph/);
  w.handle.destroy();
});

test('timing: typing an interval shows the resulting front overlap at once and plans with it', async () => {
  const w = await timedWorld();
  const input = w.control(INTERVAL);
  input.value = '7';
  input.dispatch('input');
  const o = w.handle.getState().options;
  assert.equal(o.timedIntervalS, 7);
  const figs = figuresNow(w);
  const spacing = writtenSpacingM(o.speedMs * 7);
  const front = (1 - spacing / figs.footprint.alongM) * 100;
  const result = captureRole(w, 'timing-result');
  assert.ok(Math.abs(Number(result.getAttribute('data-front')) - front) < 1e-9);
  assert.match(result.textContent, new RegExp(`${front.toFixed(1)}%`));
  assert.match(result.textContent, /wanted 80%/);
  await w.handle.replan();
  const plan = w.handle.getResult().plan;
  assert.equal(plan.options.timedIntervalS, 7);
  assert.ok(plan.spacing.photoM > 0);
  assert.equal(w.handle.getResult().missions[0].legs[0].photoSpacingM, spacing);
  assert.equal(plan.speedMs, 3.2, 'the speed is never changed to fit the interval');
  w.handle.destroy();
});

test('timing: 5, 7 and 10 are quick-fill examples; CLEAR removes the interval; any positive number works', async () => {
  const w = await timedWorld();
  const chips = w.find((n) => n.getAttribute('data-role') === 'timing-chip');
  assert.deepEqual(chips.map((c) => c.getAttribute('data-seconds')), ['5', '7', '10']);
  chips[1].click();
  assert.equal(w.handle.getState().options.timedIntervalS, 7);
  assert.equal(w.control(INTERVAL).value, '7');
  chips[2].click();
  assert.equal(w.handle.getState().options.timedIntervalS, 10);
  const input = w.control(INTERVAL);
  input.value = '6.5';
  input.dispatch('change');
  assert.equal(w.handle.getState().options.timedIntervalS, 6.5);
  w.find((n) => n.getAttribute('data-action') === 'timing-clear')[0].click();
  assert.equal(w.handle.getState().options.timedIntervalS, null);
  assert.equal(w.control(INTERVAL).value, '');
  assert.equal(captureRole(w, 'timing-result').hidden, true);
  w.handle.destroy();
});

test('timing: zero, negative and oversized intervals are refused, not stored', async () => {
  const w = await timedWorld({ timedIntervalS: 7 });
  const input = w.control(INTERVAL);
  for (const bad of ['0', '-3', '99999']) {
    input.value = bad;
    input.dispatch('change');
    assert.equal(w.handle.getState().options.timedIntervalS, 7, bad);
    assert.equal(input.value, '7', bad);
    assert.equal(input.getAttribute('aria-invalid'), 'true', bad);
    assert.match(timingText(w, 'timing-interval-note'), /was not used/);
  }
  input.value = '8';
  input.dispatch('change');
  assert.equal(input.getAttribute('aria-invalid'), 'false');
  assert.equal(w.handle.getState().options.timedIntervalS, 8);
  w.handle.destroy();
});

test('timing: an interval that is too long for the wanted overlap says so and offers a speed, which only a click applies', async () => {
  const w = await timedWorld();
  const o = w.handle.getState().options;
  const input = w.control(INTERVAL);
  input.value = '10';
  input.dispatch('input');
  const result = captureRole(w, 'timing-result');
  assert.equal(result.getAttribute('data-state'), 'short');
  assert.equal(result.getAttribute('data-tone'), 'warn');
  const fit = captureRole(w, 'timing-fit');
  assert.equal(fit.hidden, false);
  const fitMs = Number(fit.getAttribute('data-speed-ms'));
  assert.ok(fitMs > 0 && fitMs < o.speedMs);
  assert.equal(o.speedMs, 3.2, 'nothing changed the speed');
  w.find((n) => n.getAttribute('data-action') === 'timing-use-speed')[0].click();
  assert.equal(w.handle.getState().options.speedMs, fitMs);
  assert.equal(captureRole(w, 'timing-result').getAttribute('data-state'), 'meets');
  assert.equal(captureRole(w, 'timing-fit').hidden, true);
  w.handle.destroy();
});

test('timing: an interval under the camera minimum is flagged and the overlap is called theoretical', async () => {
  const w = await timedWorld();
  const min = getPreset(w.handle.getState().options.presetId).minPhotoIntervalS;
  const input = w.control(INTERVAL);
  input.value = String(min / 2);
  input.dispatch('input');
  const note = captureRole(w, 'timing-under-minimum');
  assert.ok(note);
  assert.equal(note.getAttribute('data-tone'), 'bad');
  assert.match(note.textContent, /theoretical/);
  assert.equal(note.hidden, false);
  assert.equal(insideDetails(note), false, 'an important warning is not folded away');
  w.handle.destroy();
});

test('timing: outside Timed shot the interval is not asked for, and one click switches to it', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  assert.equal(captureRole(w, 'timing-timed').hidden, true);
  assert.equal(captureRole(w, 'timing-recommended').hidden, false);
  w.find((n) => n.getAttribute('data-action') === 'timing-use-timed')[0].click();
  const o = w.handle.getState().options;
  assert.equal(o.captureMode, 'timed');
  assert.equal(w.control('Capture mode').value, 'timed');
  assert.equal(captureRole(w, 'timing-timed').hidden, false);
  assert.equal(o.timedIntervalS, null, 'switching does not invent an interval');
  pick(w, 'Capture mode', 'distance');
  assert.equal(captureRole(w, 'timing-timed').hidden, true);
  w.handle.destroy();
});

test('timing: the interval is ignored by stop and distance capture, so the plan does not change', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  await w.handle.replan();
  const before = w.handle.getResult().missions[0].legs[0].photoSpacingM;
  w.handle.getState().options.timedIntervalS = 7;
  await w.handle.replan();
  assert.equal(w.handle.getResult().missions[0].legs[0].photoSpacingM, before);
  w.handle.destroy();
});

test('timing: a speed the plan lowers is shown as lowered, not as the requested one', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  const o = w.handle.getState().options;
  o.speedMs = mphForTest(16);
  await w.handle.replan();
  const plan = w.handle.getResult().plan;
  assert.ok(plan.speedMs < o.speedMs);
  const note = captureRole(w, 'timing-planned');
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /not the .* you asked for/);
  assert.equal(note.getAttribute('data-tone'), 'warn');
  // Timed shot keeps the requested speed: nothing to say.
  pick(w, 'Capture mode', 'timed');
  await w.handle.replan();
  assert.equal(w.handle.getResult().plan.speedMs, o.speedMs);
  assert.equal(captureRole(w, 'timing-planned').hidden, true);
  w.handle.destroy();
});

test('timing: Stop mode rounding to 0.01 m/s is not called a lowered speed', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  const o = w.handle.getState().options;
  o.speedMs = 10 * 0.3048; // 10 ft/s = 3.048 m/s, under the camera limit
  await w.handle.replan();
  const plan = w.handle.getResult().plan;
  assert.equal(plan.speedLimitedBy, null, 'nothing limits this speed');
  assert.ok(plan.speedMs < o.speedMs, 'the planner floors it to 0.01 m/s');
  const note = captureRole(w, 'timing-planned');
  assert.equal(note.hidden, true);
  assert.equal(note.textContent, '');
  // The same plan with a speed the camera really limits still says so.
  o.speedMs = mphForTest(16);
  await w.handle.replan();
  assert.ok(w.handle.getResult().plan.speedLimitedBy);
  assert.equal(captureRole(w, 'timing-planned').hidden, false);
  w.handle.destroy();
});

test('timing: the interval field has no floor above zero', async () => {
  const w = await timedWorld({});
  const input = w.control(INTERVAL);
  assert.equal(input.getAttribute('min'), null);
  assert.equal(input.getAttribute('max'), '3600');
  input.value = '0.05';
  input.dispatch('input');
  assert.equal(w.handle.getState().options.timedIntervalS, 0.05);
  w.handle.destroy();
});

test('timing: Plan all rows still show when the single plan has incomplete terrain', async () => {
  let bad = null;
  const w = setup({
    sample: async (cartos) => {
      // The one unreadable point is the single plan's; each PLAN ALL pass samples
      // its own waypoints, so passes elsewhere can still read all of theirs.
      bad ??= `${cartos[3].longitude},${cartos[3].latitude}`;
      return cartos.map((c) => ({
        ...c,
        height: `${c.longitude},${c.latitude}` === bad ? undefined : 100,
      }));
    },
  });
  w.handle.setBox(boxM(300, 200));
  const o = w.handle.getState().options;
  o.captureMode = 'timed';
  o.timedIntervalS = 7;
  await w.handle.replan();
  assert.equal(w.handle.getResult().terrainComplete, false, 'the fixture really is incomplete');
  await w.handle.planSuite();
  const passes = w.handle.getState().suite.passes.filter((p) => p.result?.plan);
  const complete = passes.filter((p) => p.result.terrainComplete !== false);
  assert.ok(complete.length >= 1, 'the fixture leaves a pass with complete terrain');
  assert.equal(captureRole(w, 'timing-terrain').hidden, false, 'the single plan is unknown');
  assert.equal(captureRole(w, 'timing-result').hidden, true);
  const rows = w.find((n) => n.getAttribute('data-role') === 'timing-suite-row');
  assert.equal(rows.length, passes.filter((p) => p.result.plan.options.pattern !== 'orbit').length);
  const known = rows.filter((r) => r.getAttribute('data-unknown') !== 'true');
  assert.ok(known.length >= 1, 'a complete pass keeps its own overlap row');
  for (const r of known) assert.match(r.textContent, /% front/);
  w.handle.destroy();
});

test('timing: Plan all rows still show when the single plan figures cannot be worked out', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  const o = w.handle.getState().options;
  o.captureMode = 'timed';
  o.timedIntervalS = 7;
  await w.handle.replan();
  await w.handle.planSuite();
  // A wanted overlap of 100% leaves no spacing, so the single plan has no figure.
  o.frontOverlap = 100;
  const input = w.control(INTERVAL);
  input.value = '7.5';
  input.dispatch('input');
  assert.match(captureRole(w, 'timing-recommended-note').textContent, /Cannot be calculated/);
  const rows = w.find((n) => n.getAttribute('data-role') === 'timing-suite-row');
  assert.ok(rows.length >= 3, 'each pass keeps its own row');
  w.handle.destroy();
});

test('timing: Plan all rows show when the single pattern is Orbit, and nothing is stale', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  const o = w.handle.getState().options;
  o.captureMode = 'timed';
  o.timedIntervalS = 7;
  o.pattern = 'orbit';
  await w.handle.replan();
  await w.handle.planSuite();
  assert.equal(w.handle.getState().options.pattern, 'orbit');
  assert.equal(captureRole(w, 'timing-recommended').hidden, true, 'the single plan has no survey figure');
  const rows = w.find((n) => n.getAttribute('data-role') === 'timing-suite-row');
  assert.ok(rows.length >= 3, 'the grid and oblique passes keep their rows');
  for (const r of rows) assert.match(r.textContent, /% front/);
  assert.equal(captureRole(w, 'timing-suite-stale'), undefined, 'a fresh PLAN ALL is not stale');
  w.handle.destroy();
});

test('timing: after the interval changes the Plan all rows keep the planned interval and say they are old', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  const o = w.handle.getState().options;
  o.captureMode = 'timed';
  o.timedIntervalS = 7;
  await w.handle.replan();
  await w.handle.planSuite();
  const rowsNow = () => w.find((n) => n.getAttribute('data-role') === 'timing-suite-row');
  const before = rowsNow().map((r) => [r.getAttribute('data-pass'), r.getAttribute('data-front'), r.textContent]);
  assert.ok(before.length >= 3);
  assert.equal(captureRole(w, 'timing-suite-stale'), undefined);
  const planned = w.handle.getState().suite.passes.filter((p) => p.result?.plan && p.result.plan.options.pattern !== 'orbit');
  for (const p of planned) assert.equal(p.result.plan.options.timedIntervalS, 7);
  // The field moves on; the suite (README spacing, station counts) did not.
  const input = w.control(INTERVAL);
  input.value = '11';
  input.dispatch('input');
  assert.equal(w.handle.getState().options.timedIntervalS, 11);
  const after = rowsNow().map((r) => [r.getAttribute('data-pass'), r.getAttribute('data-front'), r.textContent]);
  assert.deepEqual(after, before, 'rows still describe the 7 s plan');
  const stale = captureRole(w, 'timing-suite-stale');
  assert.ok(stale, 'the stale note shows');
  assert.equal(stale.getAttribute('data-tone'), 'warn');
  assert.match(stale.textContent, /PLAN ALL RECOMMENDED PASSES again/);
  // The changed settings drop the old suite when the replan runs; planning
  // all passes again reads the new interval and clears the note.
  await w.handle.replan();
  assert.equal(w.handle.getState().suite, null);
  await w.handle.planSuite();
  const fresh = rowsNow();
  assert.ok(fresh.length >= 3);
  assert.equal(captureRole(w, 'timing-suite-stale'), undefined);
  assert.notDeepEqual(fresh.map((r) => r.getAttribute('data-front')), before.map((b) => b[1]), 'the new interval gives new figures');
  w.handle.destroy();
});

const mphForTest = (mph) => (mph * 1609.344) / 3600;

test('timing: 15 and 16 mph show as that in the speed readout, in feet and in metres', () => {
  for (const [system, unit] of [
    ['ft', /22\.0 ft\/s · 15\.0 mph/],
    ['m', /6\.7 m\/s · 15\.0 mph/],
  ]) {
    const w = setup({ storage: memoryStorage({ 'gev.dronePlan.units': system }) });
    w.handle.applyOptions({ speedMs: mphForTest(15) });
    assert.match(w.control('Speed').parentNode.textContent, unit);
    w.handle.applyOptions({ speedMs: mphForTest(16) });
    assert.match(w.control('Speed').parentNode.textContent, /16\.0 mph/);
    w.handle.destroy();
  }
});

test('timing: the whole wordy readout is folded into Details; important warnings stay outside it', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  pick(w, 'Capture mode', 'distance');
  await w.handle.replan();
  const details = captureRole(w, 'capture-details');
  assert.equal(details.tagName, 'DETAILS');
  for (const role of [
    'capture-footprint',
    'capture-overlap',
    'capture-interval',
    'capture-interval-derived',
    'capture-speed-limit',
    'capture-shutter',
    'capture-light',
    'capture-shutter-table',
    'capture-wind',
    'capture-resume',
    'capture-clearance',
    'capture-overlap-break',
    'capture-waypoints',
  ]) {
    const node = captureRole(w, role);
    assert.ok(node, role);
    assert.ok(insideDetails(node), `${role} is in Details`);
  }
  // Still in the readout text, so nothing is lost.
  assert.match(captureRole(w, 'capture-readout').textContent, /along the track/);
  for (const role of ['capture-unproven', 'capture-interval-warn']) {
    const node = captureRole(w, role);
    assert.ok(node, role);
    assert.equal(insideDetails(node), false, `${role} stays visible`);
  }
  const cautions = captureRole(w, 'capture-cautions');
  assert.ok(cautions);
  assert.equal(insideDetails(cautions), false);
  assert.match(cautions.textContent, /see Details/);
  w.handle.destroy();
});

test('timing: an orbit has its own spacing, so the interval parts stay out of the way', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 300));
  w.handle.getState().options.timedIntervalS = 7;
  pick(w, 'Pattern', 'orbit');
  assert.equal(captureRole(w, 'timing-recommended').hidden, true);
  assert.equal(captureRole(w, 'timing-timed').hidden, true);
  w.handle.destroy();
});

test('timing: a tilt that reaches the horizon gives no interval instead of a made-up one', () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  const o = w.handle.getState().options;
  o.pattern = 'double';
  o.tiltPitchDeg = -5;
  o.captureMode = 'timed';
  o.timedIntervalS = 7;
  w.handle.applyOptions({ pattern: 'double' });
  const rec = captureRole(w, 'timing-recommended');
  assert.equal(rec.getAttribute('data-seconds'), null);
  assert.match(rec.textContent, /annot be calculated/);
  assert.equal(captureRole(w, 'timing-result').hidden, true);
  w.handle.destroy();
});

test('timing: with incomplete terrain the interval and the overlap are unknown, not made up', async () => {
  let complete = false;
  let bad = null;
  const w = setup({
    sample: async (cartos) => {
      // One point stays unreadable until `complete` flips, however it is
      // batched (the fixture of the terrain-lock test above).
      bad ??= `${cartos[3].longitude},${cartos[3].latitude}`;
      return cartos.map((c) => ({
        ...c,
        height:
          !complete && `${c.longitude},${c.latitude}` === bad ? undefined : 100,
      }));
    },
  });
  w.handle.setBox(boxM(300, 200));
  const o = w.handle.getState().options;
  o.aglM = 100;
  o.speedMs = 3.2;
  o.captureMode = 'timed';
  o.timedIntervalS = 7;
  await w.handle.replan();
  assert.equal(w.handle.getResult().terrainComplete, false, 'the fixture really is incomplete');
  const note = captureRole(w, 'timing-terrain');
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /not known/);
  const rec = captureRole(w, 'timing-recommended');
  assert.equal(rec.getAttribute('data-seconds'), null, 'no interval figure');
  assert.equal(captureRole(w, 'timing-recommended-value').textContent, '–');
  assert.equal(captureRole(w, 'timing-result').hidden, true, 'no overlap figure');
  assert.equal(captureRole(w, 'timing-result').getAttribute('data-front'), null);
  assert.equal(captureRole(w, 'timing-fit').hidden, true);
  // Complete terrain brings the figures back.
  complete = true;
  await w.handle.replan();
  assert.equal(w.handle.getResult().terrainComplete, true);
  assert.equal(captureRole(w, 'timing-terrain').hidden, true);
  assert.ok(captureRole(w, 'timing-recommended').getAttribute('data-seconds'));
  assert.equal(captureRole(w, 'timing-result').hidden, false);
  w.handle.destroy();
});

test('timing: a fixed photo spacing that a chosen Timed-shot interval overrides says so', async () => {
  const w = await timedWorld({ photoSpacingM: 25 });
  assert.equal(captureRole(w, 'timing-spacing-ignored').hidden, true, 'no interval yet: the fixed distance is used');
  const input = w.control(INTERVAL);
  input.value = '7';
  input.dispatch('input');
  assert.equal(captureRole(w, 'timing-spacing-ignored').hidden, false);
  assert.match(captureRole(w, 'timing-spacing-ignored').textContent, /not used/);
  w.handle.destroy();
});

test('timing: Plan all passes gives each pass its own overlap for the one interval', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  const o = w.handle.getState().options;
  o.captureMode = 'timed';
  o.timedIntervalS = 7;
  await w.handle.replan();
  await w.handle.planSuite();
  const rows = w.find((n) => n.getAttribute('data-role') === 'timing-suite-row');
  assert.ok(rows.length >= 3, 'nadir and two oblique passes');
  const fronts = rows.map((r) => Number(r.getAttribute('data-front')));
  assert.ok(new Set(fronts.map((f) => Math.round(f))).size > 1, 'the passes differ');
  assert.match(captureRole(w, 'timing-suite').textContent, /own overlap/);
  for (const r of rows) assert.match(r.textContent, /% front/);
  w.handle.destroy();
});

test('timing: Plan all passes shows unknown, not an overlap, for a pass with incomplete terrain', async () => {
  const w = setup();
  w.handle.setBox(boxM(300, 200));
  const o = w.handle.getState().options;
  o.captureMode = 'timed';
  o.timedIntervalS = 7;
  await w.handle.replan();
  await w.handle.planSuite();
  const passes = w.handle.getState().suite.passes.filter((p) => p.result?.plan);
  assert.ok(passes.length >= 3);
  const victim = passes.find((p) => p.result.plan.options.pattern !== 'orbit');
  victim.result.terrainComplete = false;
  // Any control change re-renders the timing section.
  const input = w.control(INTERVAL);
  input.value = '7.5';
  input.dispatch('input');
  const rows = w.find((n) => n.getAttribute('data-role') === 'timing-suite-row');
  const bad = rows.find((r) => r.getAttribute('data-pass') === String(victim.id));
  assert.ok(bad, 'the incomplete pass still has a row');
  assert.equal(bad.getAttribute('data-unknown'), 'true');
  assert.equal(bad.getAttribute('data-front'), null, 'no overlap figure');
  assert.match(bad.textContent, /terrain heights incomplete, overlap not known/);
  assert.doesNotMatch(bad.textContent, /% front/);
  const others = rows.filter((r) => r !== bad);
  assert.ok(others.length >= 2);
  for (const r of others) {
    assert.equal(r.getAttribute('data-unknown'), null);
    assert.match(r.textContent, /% front/);
  }
  w.handle.destroy();
});

test('timing: the chosen interval saves with the plan, an old plan has none, a bad one is dropped', async () => {
  const w = await timedWorld({ timedIntervalS: 7 });
  const doc = serializePlan(w.handle.getState(), {});
  assert.equal(doc.options.timedIntervalS, 7);
  const w2 = setup();
  await w2.handle.loadPlan(JSON.parse(JSON.stringify(doc)));
  assert.equal(w2.handle.getState().options.timedIntervalS, 7);
  assert.equal(w2.control(INTERVAL).value, '7');
  // An older file without the setting clears a previous plan's interval.
  await w2.handle.loadPlan({
    schema: 'gevplan',
    version: 1,
    areas: [],
    options: { speedMs: 4 },
  });
  assert.equal(w2.handle.getState().options.timedIntervalS, null);
  assert.equal(w2.control(INTERVAL).value, '');
  w.handle.destroy();
  w2.handle.destroy();
});

test('timing: voice and AI options set the interval through the same cleaner', async () => {
  const w = setup();
  w.handle.applyOptions({ timedIntervalS: 7 });
  assert.equal(w.handle.getState().options.timedIntervalS, 7);
  assert.equal(w.control(INTERVAL).value, '7');
  w.handle.applyOptions({ timedIntervalS: -2 });
  assert.equal(w.handle.getState().options.timedIntervalS, null);
  w.handle.destroy();
});

test('timing: the capture readout figures follow the interval, not a stale spacing', async () => {
  const w = await timedWorld({ timedIntervalS: 7 });
  const o = w.handle.getState().options;
  const readout = captureRole(w, 'capture-readout');
  const spacing = writtenSpacingM(o.speedMs * 7);
  assert.equal(Number(readout.getAttribute('data-photo-m')), spacing);
  assert.ok(Math.abs(Number(readout.getAttribute('data-seconds')) - spacing / o.speedMs) < 1e-9);
  w.handle.destroy();
});
