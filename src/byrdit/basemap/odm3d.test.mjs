import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { basemapSettingsFromEnv, createBasemapHandler } from './proxy.js';
import {
  composeOverlays,
  odm3dBases,
  resolveOdm3dFile,
} from './overlaysProxy.js';
import { normalizeOverlays } from './overlaysConfig.js';
import { basemapConfigLeakCount } from './configSafety.js';
import { OVERLAYS_PUBLISH } from './fixtures/overlays.mjs';
import { attachOverlays } from './overlays.js';
import { groupOfOverlay, ALL_OVERLAY_GROUPS } from './overlayGroups.js';
import { createOverlaysPanel } from './overlaysPanel.js';
import {
  Odm3dLayer,
  alignmentOffset,
  cutHeightLocal,
  median,
  opacityStyleColor,
  samplePoints,
  terrainSampler,
} from './odm3d.js';
import { BYRDIT_OPEN_STACK_ID } from './stack.js';

const THREE_D = {
  id: 'odm-3d-9be42b4f',
  name: 'Byrd Ranch shop area 3D (2026-10-31)',
  kind: 'overlay-3d',
  format: '3dtiles',
  archive: 'odm3d/odm-3d-9be42b4f',
  bounds: [-95.1545, 32.6896, -95.1511, 32.6918],
  ground_m: 112,
  height_offset_m: 0,
  canopy_default_ft: 90,
  canopy_options_ft: [90, 120],
  default_opacity: 1,
  status: 'live-data',
  credit: 'Byrd-IT ODM drone survey',
  sha256: 'cd'.repeat(32),
  file: 'hires/odm3d/odm-3d-9be42b4f/tileset.json',
};
const publish = (...extra) => ({
  ...OVERLAYS_PUBLISH,
  layers: [...OVERLAYS_PUBLISH.layers, ...extra],
});

test('group: every odm- layer (flat and 3D) is in "Byrd Ranch builds", ids unchanged, others untouched', () => {
  for (const id of [
    'odm-preview-687d2c64',
    'odm-preview-4582cb96',
    'odm-preview-1b9a76bd',
    'odm-3d-9be42b4f',
  ])
    assert.equal(groupOfOverlay(id).id, 'byrd-ranch', id);
  for (const id of [
    'ustopo',
    'hillshade-wu',
    'lake-depth',
    'parcels',
    'my-odm-x',
  ])
    assert.notEqual(groupOfOverlay(id).id, 'byrd-ranch', id);
  const ids = ALL_OVERLAY_GROUPS.map((g) => g.id);
  assert.equal(ids[0], 'lakes');
  assert.equal(ids[1], 'byrd-ranch');
  assert.equal(ids.at(-1), 'other');
});

test('composeOverlays: a 3D build is offered with model facts only; archive and hashes stay server-side', () => {
  const { browser, routes } = composeOverlays(publish(THREE_D));
  const layer = browser.layers.find((l) => l.id === THREE_D.id);
  assert.equal(layer.kind, '3d');
  assert.equal(layer.format, '3dtiles');
  assert.equal(layer.url, '/basemap/odm3d/odm-3d-9be42b4f/tileset.json');
  assert.deepEqual(layer.model, {
    groundM: 112,
    heightOffsetM: 0,
    canopyOptionsFt: [90, 120],
    canopyDefaultFt: 90,
  });
  assert.equal(layer.name, THREE_D.name);
  assert.deepEqual(routes.get(THREE_D.id), {
    archive: 'odm3d/odm-3d-9be42b4f',
    format: '3dtiles',
    port: null,
  });
  assert.equal(basemapConfigLeakCount({ overlays: browser }), 0);
  assert.ok(!JSON.stringify(browser).includes('cdcdcdcd'));
  assert.ok(!JSON.stringify(browser).includes('"archive"'));
  assert.ok(!JSON.stringify(browser).includes('"file"'));
  const round = normalizeOverlays(browser);
  assert.equal(
    round.layers.find((l) => l.id === THREE_D.id).model.groundM,
    112,
  );
});

test('composeOverlays: 3D entries without a usable ground height, with a wrong format or a bad archive are dropped; options are capped at 120 ft', () => {
  const bad = [
    { ...THREE_D, id: 'odm-3d-a', ground_m: 'x' },
    { ...THREE_D, id: 'odm-3d-b', ground_m: undefined },
    { ...THREE_D, id: 'odm-3d-c', format: 'webp' },
    { ...THREE_D, id: 'odm-3d-d', archive: '../etc/passwd' },
    { ...THREE_D, id: 'odm-3d-e', bounds: [1, 2] },
    { ...THREE_D, id: 'odm-3d-f', status: 'staged' },
  ];
  const { browser } = composeOverlays(publish(...bad));
  assert.ok(!browser.layers.some((l) => l.id.startsWith('odm-3d-')));
  const wide = composeOverlays(
    publish({
      ...THREE_D,
      canopy_options_ft: [90, 120, 500, 'x', 0],
      canopy_default_ft: 500,
    }),
  ).browser.layers.find((l) => l.id === THREE_D.id);
  assert.deepEqual(wide.model.canopyOptionsFt, [90, 120]);
  assert.equal(
    wide.model.canopyDefaultFt,
    null,
    'default must be one of the options',
  );
});

test('normalizeOverlays: a 3D layer needs its exact tileset url and a model block', () => {
  const good = composeOverlays(publish(THREE_D)).browser;
  const mutate = (fn) => {
    const copy = JSON.parse(JSON.stringify(good));
    fn(copy.layers.find((l) => l.id === THREE_D.id));
    return normalizeOverlays(copy).layers.some((l) => l.id === THREE_D.id);
  };
  assert.equal(
    mutate(() => {}),
    true,
  );
  assert.equal(
    mutate((l) => (l.url = '/basemap/odm3d/other/tileset.json')),
    false,
  );
  assert.equal(
    mutate((l) => (l.url = 'https://evil.example/tileset.json')),
    false,
  );
  assert.equal(
    mutate((l) => delete l.model),
    false,
  );
  assert.equal(
    mutate((l) => (l.model.groundM = 'x')),
    false,
  );
});

test('resolveOdm3dFile: only plain files inside an offered build; no traversal, no other ids', () => {
  const { routes } = composeOverlays(publish(THREE_D));
  const s = { odm3dUrls: ['http://origin:8480/hires'] };
  const ok = resolveOdm3dFile(
    '/basemap/odm3d/odm-3d-9be42b4f/tileset.json',
    routes,
    s,
  );
  assert.deepEqual(ok, {
    bases: ['http://origin:8480/hires'],
    path: '/odm3d/odm-3d-9be42b4f/tileset.json',
  });
  assert.equal(
    resolveOdm3dFile(
      '/basemap/odm3d/odm-3d-9be42b4f/model/LOD-0/Mesh-XL-YL.b3dm',
      routes,
      s,
    ).path,
    '/odm3d/odm-3d-9be42b4f/model/LOD-0/Mesh-XL-YL.b3dm',
  );
  for (const bad of [
    '/basemap/odm3d/odm-3d-9be42b4f/../../m2/overlays.json',
    '/basemap/odm3d/odm-3d-9be42b4f/%2e%2e/x.json',
    '/basemap/odm3d/odm-3d-9be42b4f/./tileset.json',
    '/basemap/odm3d/odm-3d-9be42b4f/a/b/c/d.b3dm',
    '/basemap/odm3d/odm-3d-9be42b4f/tileset.sh',
    '/basemap/odm3d/odm-3d-9be42b4f/',
    '/basemap/odm3d/unknown/tileset.json',
    '/basemap/odm3d/hillshade/tileset.json',
    '/basemap/odm3d/odm-3d-9be42b4f/tileset.json?x=1',
  ])
    assert.equal(resolveOdm3dFile(bad, routes, s), null, bad);
  assert.equal(
    resolveOdm3dFile('/basemap/odm3d/odm-3d-9be42b4f/tileset.json', routes, {
      odm3dUrls: [],
    }),
    null,
    'no origin configured = nothing served',
  );
});

test('odm3dBases: derived from the overlays.json folder, explicit wins, file paths ignored', () => {
  assert.deepEqual(
    odm3dBases(['http://10.10.99.101:8480/hires/m2/overlays.json']),
    ['http://10.10.99.101:8480/hires'],
  );
  assert.deepEqual(odm3dBases(['/var/lib/x/overlays.json']), []);
  assert.deepEqual(
    odm3dBases(['http://a/hires/m2/overlays.json'], ['http://b/hires']),
    ['http://b/hires'],
  );
  assert.deepEqual(
    basemapSettingsFromEnv({
      GEV_BASEMAP: '1',
      GEV_BASEMAP_OVERLAYS_CONFIG:
        'http://s1:8480/hires/m2/overlays.json,/tmp/o.json',
    }).odm3dUrls,
    ['http://s1:8480/hires'],
  );
});

const listen = (handler) =>
  new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(r);
          }),
      });
    });
  });

test('proxy: 3D files are relayed from the origin; unknown ids, traversal and flag off = 404 and no upstream request', async () => {
  const seen = [];
  const origin = await listen((req, res) => {
    seen.push(req.url);
    if (req.url === '/hires/m2/overlays.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(publish(THREE_D)));
    }
    if (req.url.endsWith('/tileset.json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"asset":{"version":"1.0"}}');
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.from('B3DM'));
  });
  const env = (extra = {}) => ({
    GEV_BASEMAP: '1',
    GEV_BASEMAP_TERRAIN_URLS: origin.url,
    GEV_BASEMAP_IMAGERY_URLS: origin.url,
    GEV_BASEMAP_IMAGERY_CONFIG: `${origin.url}/imagery/config.json`,
    GEV_BASEMAP_OVERLAYS: '1',
    GEV_BASEMAP_OVERLAYS_CONFIG: `${origin.url}/hires/m2/overlays.json`,
    GEV_BASEMAP_HIRES_URLS: origin.url,
    ...extra,
  });
  const make = async (e) => {
    const handler = createBasemapHandler(basemapSettingsFromEnv(e), {
      log: () => {},
    });
    return listen((req, res) =>
      handler(req, res, () => (res.writeHead(299), res.end('next'))),
    );
  };
  const on = await make(env());
  const off = await make(env({ GEV_BASEMAP_OVERLAYS: '' }));
  try {
    const config = await (await fetch(`${on.url}/basemap/config.json`)).json();
    assert.ok(
      config.overlays.layers.some(
        (l) => l.id === THREE_D.id && l.kind === '3d',
      ),
    );
    const tileset = await fetch(
      `${on.url}/basemap/odm3d/${THREE_D.id}/tileset.json`,
    );
    assert.equal(tileset.status, 200);
    assert.match(tileset.headers.get('cache-control'), /max-age=60/);
    const file = await fetch(
      `${on.url}/basemap/odm3d/${THREE_D.id}/model/LOD-0/Mesh-XL.b3dm`,
    );
    assert.equal(file.status, 200);
    assert.match(file.headers.get('cache-control'), /max-age=2592000/);
    assert.equal(Buffer.from(await file.arrayBuffer()).toString(), 'B3DM');
    assert.ok(
      seen.includes('/hires/odm3d/odm-3d-9be42b4f/model/LOD-0/Mesh-XL.b3dm'),
    );
    const before = seen.length;
    for (const path of [
      '/basemap/odm3d/nope/tileset.json',
      `/basemap/odm3d/${THREE_D.id}/../m2/overlays.json`,
      `/basemap/odm3d/${THREE_D.id}/tileset.exe`,
    ])
      assert.equal((await fetch(on.url + path)).status, 404, path);
    assert.equal(seen.length, before, 'no upstream request for refused paths');
    assert.equal(
      (await fetch(`${off.url}/basemap/odm3d/${THREE_D.id}/tileset.json`))
        .status,
      404,
    );
  } finally {
    await Promise.all([on.close(), off.close(), origin.close()]);
  }
});

test('odm3d helpers: median, alignment, cut height, opacity colour, sample grid', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([null, undefined, NaN]), null);
  // terrain 94 m under a model whose ground is 112 m -> lower by 18 m
  assert.equal(alignmentOffset(112, [94, 94.5, 93.5, null]), -18);
  assert.equal(
    alignmentOffset(112, [0, 0, 0, 0, 0, 0, 0, 0, 0]),
    null,
    'flat ellipsoid is no terrain',
  );
  assert.equal(alignmentOffset(112, [94, 94]), null, 'too few samples');
  assert.equal(
    alignmentOffset(112, [0, 94, 94.5, 93.5]),
    -18.25,
    'one real zero among real samples is fine',
  );
  assert.equal(alignmentOffset(112, []), null);
  assert.equal(alignmentOffset(112, [9000]), null, 'absurd lift is refused');
  assert.ok(Math.abs(cutHeightLocal(112, 90) - (112 + 27.432)) < 1e-9);
  assert.ok(Math.abs(cutHeightLocal(112, 120) - (112 + 36.576)) < 1e-9);
  assert.equal(cutHeightLocal(112, null), null);
  assert.equal(cutHeightLocal(112, 0), null);
  assert.equal(opacityStyleColor(1), null);
  assert.equal(opacityStyleColor(0.5), "color('white', 0.50)");
  assert.equal(opacityStyleColor(-3), "color('white', 0.00)");
  assert.equal(samplePoints([0, 0, 4, 4]).length, 9);
});

function fake3dCesium({ terrain = [94, 94, 94] } = {}) {
  const calls = { added: [], removed: [], flown: [] };
  class Cartesian3 {
    constructor(x = 0, y = 0, z = 0) {
      Object.assign(this, { x, y, z });
    }
    static fromDegrees(lon, lat, h) {
      return new Cartesian3(lon, lat, h);
    }
    static multiplyByScalar(v, k, out) {
      return Object.assign(out, { x: v.x * k, y: v.y * k, z: v.z * k });
    }
  }
  class ClippingPlane {
    constructor(normal, distance) {
      Object.assign(this, { normal, distance });
    }
  }
  class ClippingPlaneCollection {
    constructor({ planes = [], edgeWidth = 0 } = {}) {
      this.planes = [...planes];
      this.edgeWidth = edgeWidth;
      this.enabled = true;
    }
    removeAll() {
      this.planes = [];
    }
    add(p) {
      this.planes.push(p);
    }
  }
  class Cesium3DTileStyle {
    constructor(spec) {
      this.spec = spec;
    }
  }
  const Cesium = {
    Cartesian3,
    ClippingPlane,
    ClippingPlaneCollection,
    Cesium3DTileStyle,
    Ellipsoid: {
      WGS84: {
        geodeticSurfaceNormal: (c, out) =>
          Object.assign(out, { x: 0, y: 0, z: 1 }),
      },
    },
    Matrix4: { fromTranslation: (v) => ({ translation: v }) },
    Rectangle: { fromDegrees: (w, s, e, n) => ({ w, s, e, n }) },
    Cartographic: { fromDegrees: (lon, lat) => ({ lon, lat, height: 0 }) },
    sampleTerrainMostDetailed: async (provider, pts) => {
      if (provider.fail) throw new Error('terrain down');
      return pts.map((p, i) => ({ ...p, height: terrain[i % terrain.length] }));
    },
    Cesium3DTileset: {
      async fromUrl(url, options) {
        if (url.includes('broken')) throw new Error('boom');
        const tileset = {
          url,
          options,
          show: options.show,
          destroyed: false,
          destroy() {
            this.destroyed = true;
          },
          isDestroyed() {
            return this.destroyed;
          },
        };
        calls.tilesets = [...(calls.tilesets ?? []), tileset];
        return tileset;
      },
    },
  };
  const viewer = {
    terrainProvider: {},
    scene: {
      primitives: {
        add: (t) => calls.added.push(t),
        remove: (t) => calls.removed.push(t),
      },
      requestRender() {},
    },
    camera: { flyTo: (o) => calls.flown.push(o) },
  };
  return { Cesium, viewer, calls };
}

const entry3d = () => ({
  ...composeOverlays(publish(THREE_D)).browser.layers.find(
    (l) => l.id === THREE_D.id,
  ),
});

test('Odm3dLayer: loads, lifts the model onto the terrain, cuts the canopy at ground + 90 ft, opacity via style, Off restores all', async () => {
  const { Cesium, viewer, calls } = fake3dCesium({ terrain: [94] });
  const layer = new Odm3dLayer({
    Cesium,
    viewer,
    entry: entry3d(),
    sampleTerrain: terrainSampler(Cesium, viewer),
  });
  layer.setCut(90);
  layer.setOpacity(0.5);
  await layer.load();
  assert.equal(layer.status, 'ready');
  const tileset = calls.added[0];
  assert.equal(tileset.url, '/basemap/odm3d/odm-3d-9be42b4f/tileset.json');
  assert.equal(tileset.show, true);
  assert.equal(layer.alignedM, -18, 'ground 112 m lifted to terrain 94 m');
  assert.equal(tileset.modelMatrix.translation.z, -18);
  const plane = tileset.clippingPlanes.planes[0];
  assert.deepEqual(
    [plane.normal.x, plane.normal.y, plane.normal.z],
    [0, 0, -1],
  );
  assert.ok(Math.abs(plane.distance - (112 + 27.432)) < 1e-9);
  assert.equal(tileset.clippingPlanes.enabled, true);
  assert.equal(tileset.style.spec.color, "color('white', 0.50)");
  layer.setCut(120);
  assert.equal(tileset.clippingPlanes.planes.length, 1);
  assert.ok(
    Math.abs(tileset.clippingPlanes.planes[0].distance - (112 + 36.576)) < 1e-9,
  );
  layer.setCut(null);
  assert.equal(
    tileset.clippingPlanes.enabled,
    false,
    'Off = full model, nothing stored changes',
  );
  layer.setOpacity(1);
  assert.equal(tileset.style, undefined);
  layer.flyTo();
  assert.deepEqual(calls.flown[0].destination, {
    w: -95.1545,
    s: 32.6896,
    e: -95.1511,
    n: 32.6918,
  });
  layer.destroy();
  assert.deepEqual(calls.removed, [tileset]);
  assert.equal(tileset.destroyed, true);
  layer.destroy();
  assert.equal(calls.removed.length, 1, 'destroy is idempotent');
});

test('Odm3dLayer: terrain failure keeps the manifest offset; load failure is an error state, not a throw; destroyed while loading leaves nothing behind', async () => {
  const a = fake3dCesium();
  a.viewer.terrainProvider.fail = true;
  const e = entry3d();
  e.model.heightOffsetM = 3;
  const layer = new Odm3dLayer({
    Cesium: a.Cesium,
    viewer: a.viewer,
    entry: e,
    sampleTerrain: terrainSampler(a.Cesium, a.viewer),
  });
  await layer.load();
  assert.equal(layer.status, 'ready');
  assert.equal(layer.alignedM, 3);

  const b = fake3dCesium();
  const broken = new Odm3dLayer({
    Cesium: b.Cesium,
    viewer: b.viewer,
    entry: { ...entry3d(), url: '/basemap/odm3d/broken/tileset.json' },
  });
  await broken.load();
  assert.equal(broken.status, 'failed');
  assert.equal(b.calls.added.length, 0);

  const c = fake3dCesium();
  const early = new Odm3dLayer({
    Cesium: c.Cesium,
    viewer: c.viewer,
    entry: entry3d(),
  });
  const pending = early.load();
  early.destroy();
  await pending;
  assert.equal(c.calls.added.length, 0);
  assert.ok(
    c.calls.tilesets[0].destroyed,
    'a tileset finishing after destroy is destroyed',
  );
});

function event() {
  const listeners = new Set();
  return {
    addEventListener(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    raise() {
      for (const fn of [...listeners]) fn({});
    },
  };
}

function setup3d({ session = { tileset: null } } = {}) {
  const made = [];
  const { Cesium, viewer } = fake3dCesium();
  viewer.imageryLayers = {
    add() {},
    remove() {},
    raiseToTop() {},
  };
  viewer.container = null;
  viewer.camera.moveEnd = event();
  viewer.scene.preUpdate = event();
  let active = BYRDIT_OPEN_STACK_ID;
  const subs = new Set();
  const stackCalls = [];
  const controller = {
    setStack: async (id, options) => {
      stackCalls.push([id, options]);
    },
    getActiveId: () => active,
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    switchTo(id) {
      active = id;
      subs.forEach((fn) => fn());
    },
  };
  const panel = { updates: [] };
  const detach = attachOverlays({
    Cesium,
    viewer,
    controller,
    overlays: normalizeOverlays(composeOverlays(publish(THREE_D)).browser),
    session,
    heightOf: () => 3000,
    viewOf: () => ({ viewBounds: [-95.2, 32.6, -95.1, 32.7], lat: 32.69 }),
    createProvider: (entry) => ({ entry }),
    create3d: (entry) => {
      const calls = [];
      const layer = {
        status: 'ready',
        alignedM: 0,
        load: async () => calls.push('load'),
        setOpacity: (v) => calls.push(['opacity', v]),
        setCut: (v) => calls.push(['cut', v]),
        flyTo: () => calls.push('fly'),
        destroy: () => calls.push('destroy'),
        calls,
        entry,
      };
      made.push(layer);
      return layer;
    },
    createPanel: () => ({
      update: (state) => panel.updates.push(state),
      setVisible() {},
      destroy() {},
    }),
  });
  return { detach, controller, made, panel, session, stackCalls };
}

test('attachOverlays: a 3D build is OFF until toggled, then loads once with the default 90 ft cut and the chosen opacity', async () => {
  const { detach, made } = setup3d();
  assert.equal(made.length, 0);
  const row = () => detach.state().layers.find((l) => l.id === THREE_D.id);
  assert.equal(row().kind, '3d');
  assert.equal(row().canopyFt, 90);
  assert.deepEqual(row().canopyOptionsFt, [90, 120]);
  detach.setEnabled(THREE_D.id, true);
  assert.equal(made.length, 1);
  assert.deepEqual(
    made[0].calls.filter((c) => c !== 'load'),
    [
      ['opacity', 1],
      ['cut', 90],
      ['opacity', 1],
      ['cut', 90],
    ],
  );
  detach.setOpacity(THREE_D.id, 0.4);
  assert.deepEqual(made[0].calls.at(-2), ['opacity', 0.4]);
  detach.evaluate();
  detach.evaluate();
  assert.equal(made.length, 1, 'one model per build, not one per refresh');
  assert.equal(made[0].calls.filter((c) => c === 'load').length, 1);
});

test('attachOverlays: canopy cut accepts only Off or the offered heights; Off/120 are applied; fly-to reaches the model', async () => {
  const { detach, made } = setup3d();
  detach.setEnabled(THREE_D.id, true);
  assert.equal(detach.setCanopy(THREE_D.id, 120), true);
  assert.deepEqual(made[0].calls.at(-1), ['cut', 120]);
  assert.equal(detach.setCanopy(THREE_D.id, null), true);
  assert.deepEqual(made[0].calls.at(-1), ['cut', null]);
  assert.equal(
    detach.setCanopy(THREE_D.id, 500),
    false,
    'never above the 120 ft limit',
  );
  assert.equal(detach.setCanopy(THREE_D.id, 75), false);
  assert.equal(detach.setCanopy('ustopo', 90), false, 'not a 3D build');
  assert.equal(detach.setCanopy('nope', 90), false);
  assert.equal(detach.flyTo(THREE_D.id), true);
  await new Promise((r) => setImmediate(r));
  assert.equal(made[0].calls.at(-1), 'fly');
  assert.equal(detach.flyTo('nope'), false);
});

test('attachOverlays: 3D build is removed when the Open map is not shown or Google 3D is drawn, and comes back when it is', () => {
  const session = { tileset: { show: false } };
  const { detach, controller, made } = setup3d({ session });
  detach.setEnabled(THREE_D.id, true);
  assert.deepEqual(detach.state().active, [THREE_D.id]);
  controller.switchTo('google-3d');
  assert.equal(made[0].calls.at(-1), 'destroy');
  assert.deepEqual(detach.state().active, []);
  assert.equal(
    detach.state().layers.find((l) => l.id === THREE_D.id).enabled,
    true,
    'the user choice is kept',
  );
  controller.switchTo(BYRDIT_OPEN_STACK_ID);
  assert.equal(made.length, 2);
  session.tileset.show = true;
  detach.evaluate();
  assert.equal(made[1].calls.at(-1), 'destroy');
  detach();
  assert.deepEqual(detach.state().active, []);
});

class Node {
  constructor(tag) {
    Object.assign(this, {
      tag,
      children: [],
      attrs: {},
      style: { setProperty() {}, removeProperty() {} },
      listeners: {},
      textContent: '',
      checked: false,
      value: '',
      dataset: {},
      className: '',
      hidden: false,
      disabled: false,
    });
  }
  set type(v) {
    this.attrs.type = v;
  }
  get type() {
    return this.attrs.type;
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  removeAttribute(k) {
    delete this.attrs[k];
  }
  insertBefore(n, ref) {
    const at = ref ? this.children.indexOf(ref) : -1;
    this.children.splice(at < 0 ? this.children.length : at, 0, n);
  }
  get ownerDocument() {
    return { createElement: (tag) => new Node(tag) };
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  prepend(n) {
    this.children.unshift(n);
  }
  remove() {}
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  click() {
    for (const fn of this.listeners.click ?? []) fn({});
  }
  find(pred, out = []) {
    for (const c of this.children) {
      if (pred(c)) out.push(c);
      c.find(pred, out);
    }
    return out;
  }
}

test('panel: a 3D row has Full model / Cut above 90 ft / Cut above 120 ft / Fly to; flat rows do not; raise/lower hidden for 3D', () => {
  const calls = [];
  const doc = { createElement: (tag) => new Node(tag) };
  const layers = [
    {
      id: 'odm-preview-687d2c64',
      name: 'Flat build',
      kind: 'raster',
      enabled: false,
      opacity: 1,
    },
    {
      id: THREE_D.id,
      name: THREE_D.name,
      kind: '3d',
      enabled: true,
      opacity: 1,
      canopyFt: 90,
      canopyOptionsFt: [90, 120],
      status: 'loading',
    },
  ];
  const panel = createOverlaysPanel({
    container: new Node('div'),
    doc,
    state: { layers },
    grouped: true,
    embedded: true,
    onEnabled: (id, on) => calls.push(['on', id, on]),
    onOpacity: (id, v) => calls.push(['op', id, v]),
    onCanopy: (id, ft) => calls.push(['cut', id, ft]),
    onFlyTo: (id) => calls.push(['fly', id]),
  });
  const group = panel.element.find(
    (n) => n.attrs['data-group'] === 'byrd-ranch',
  )[0];
  assert.ok(group, 'the Byrd Ranch builds section exists');
  assert.equal(group.hidden, false);
  const rows = group
    .find((n) => n.attrs['data-overlay'])
    .map((n) => n.attrs['data-overlay']);
  assert.deepEqual(rows.sort(), ['odm-preview-687d2c64', THREE_D.id].sort());
  assert.equal(
    panel.element.find((n) => n.attrs['data-group'] === 'other')[0].hidden,
    true,
  );
  const cuts = panel.element.find((n) => /gev-ov-cut/.test(n.className));
  assert.equal(cuts.length, 1, 'only the 3D row has the cut control');
  const chips = cuts[0].children;
  assert.deepEqual(
    chips.map((c) => c.dataset.chipId),
    ['off', '90', '120', 'fly'],
  );
  assert.deepEqual(
    chips.map((c) => c.attrs['aria-pressed']),
    ['false', 'true', 'false', undefined],
  );
  assert.match(chips[1].textContent, /90 ft/);
  const note = panel.element.find((n) => /gev-ov-3d-note/.test(n.className))[0];
  assert.match(note.textContent, /Loading/);
  chips[2].click();
  chips[0].click();
  chips[3].click();
  assert.deepEqual(calls, [
    ['cut', THREE_D.id, 120],
    ['cut', THREE_D.id, null],
    ['fly', THREE_D.id],
  ]);
  panel.update({
    layers: [layers[0], { ...layers[1], canopyFt: 120, status: 'ready' }],
  });
  assert.deepEqual(
    cuts[0].children.map((c) => c.attrs['aria-pressed']),
    ['false', 'false', 'true', undefined],
  );
  assert.equal(note.textContent, '');
  panel.update({
    layers: [layers[0], { ...layers[1], canopyFt: 120, status: 'failed' }],
  });
  assert.match(note.textContent, /could not be loaded/);
  panel.update({
    layers: [layers[0], { ...layers[1], enabled: false, status: 'idle' }],
  });
  assert.equal(
    cuts[0].children[3].disabled,
    true,
    'Fly to waits for the layer to be on',
  );
  panel.update({ layers });
  assert.equal(cuts[0].children[3].disabled, false);
  chips[2].click();
  assert.equal(calls.length, 4, 'chips are bound once, not once per update');
});

test('Odm3dLayer: frames are requested while tiles load and stop once the tileset has settled; camera moves restart it; destroy stops it', async () => {
  const { Cesium, viewer } = fake3dCesium();
  let renders = 0;
  viewer.scene.requestRender = () => {
    renders += 1;
  };
  const camListeners = [];
  viewer.camera.moveEnd = {
    addEventListener(fn) {
      camListeners.push(fn);
      return () => camListeners.splice(camListeners.indexOf(fn), 1);
    },
  };
  const intervals = new Map();
  let nextId = 1;
  const timers = {
    setInterval: (fn) => (intervals.set(nextId, fn), nextId++),
    clearInterval: (id) => intervals.delete(id),
  };
  const progress = [];
  const orig = Cesium.Cesium3DTileset.fromUrl;
  Cesium.Cesium3DTileset.fromUrl = async (url, options) => {
    const tileset = await orig(url, options);
    tileset.tilesLoaded = false;
    tileset.loadProgress = {
      addEventListener(fn) {
        progress.push(fn);
        return () => progress.splice(progress.indexOf(fn), 1);
      },
    };
    return tileset;
  };
  const layer = new Odm3dLayer({ Cesium, viewer, entry: entry3d(), timers });
  await layer.load();
  assert.equal(intervals.size, 1, 'pump runs after the tileset is added');
  const tick = () => [...intervals.values()].forEach((fn) => fn());
  const before = renders;
  tick();
  assert.equal(renders, before + 1, 'a frame per tick while loading');
  layer.tileset.tilesLoaded = true;
  tick();
  tick();
  tick();
  assert.equal(intervals.size, 0, 'quiet after 3 loaded ticks');
  camListeners.forEach((fn) => fn());
  assert.equal(intervals.size, 1, 'a camera move starts it again');
  layer.tileset.tilesLoaded = false;
  progress.forEach((fn) => fn(3, 1));
  assert.equal(intervals.size, 1, 'no second timer');
  layer.destroy();
  assert.equal(intervals.size, 0);
  assert.equal(camListeners.length, 0);
  assert.equal(progress.length, 0);
});

test('Odm3dLayer: destroyed while the terrain is being sampled never shows the tileset', async () => {
  const { Cesium, viewer, calls } = fake3dCesium();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const layer = new Odm3dLayer({
    Cesium,
    viewer,
    entry: entry3d(),
    sampleTerrain: async () => {
      await gate;
      return [94, 94, 94];
    },
  });
  const pending = layer.load();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.added.length, 1, 'tileset added, still hidden');
  assert.equal(calls.added[0].show, false);
  layer.destroy();
  release();
  await pending;
  assert.equal(
    calls.added[0].show,
    false,
    'a destroyed tileset is never shown',
  );
  assert.equal(calls.added[0].destroyed, true);
  assert.deepEqual(calls.removed, [calls.added[0]]);
});

test('attachOverlays: Fly to selects Byrd-IT Open (user intent) BEFORE the camera moves, so Auto cannot swap the model for Google 3D', async () => {
  const { detach, made, stackCalls } = setup3d();
  detach.setEnabled(THREE_D.id, true);
  detach.flyTo(THREE_D.id);
  assert.equal(
    made[0].calls.includes('fly'),
    false,
    'not before the map is pinned',
  );
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(stackCalls, [['byrdit-open', { intent: 'user' }]]);
  assert.equal(made[0].calls.at(-1), 'fly');
});

test('attachOverlays: Fly to still flies when the map switch fails, and not at all if the layer was switched off meanwhile', async () => {
  const a = setup3d();
  a.controller.setStack = async () => {
    throw new Error('switch failed');
  };
  a.detach.setEnabled(THREE_D.id, true);
  a.detach.flyTo(THREE_D.id);
  await new Promise((r) => setImmediate(r));
  assert.equal(a.made[0].calls.at(-1), 'fly');

  const b = setup3d();
  b.detach.setEnabled(THREE_D.id, true);
  b.detach.flyTo(THREE_D.id);
  b.detach.setEnabled(THREE_D.id, false);
  await new Promise((r) => setImmediate(r));
  assert.equal(b.made[0].calls.includes('fly'), false);
});

test("Odm3dLayer.flyTo: uses the drawn model's bounding sphere (terrain lift included), falls back to the footprint rectangle", async () => {
  const { Cesium, viewer, calls } = fake3dCesium();
  Cesium.HeadingPitchRange = class {
    constructor(heading, pitch, range) {
      Object.assign(this, { heading, pitch, range });
    }
  };
  Cesium.Math = { toRadians: (d) => (d * Math.PI) / 180 };
  const sphereCalls = [];
  viewer.camera.flyToBoundingSphere = (sphere, options) =>
    sphereCalls.push([sphere, options]);
  const layer = new Odm3dLayer({ Cesium, viewer, entry: entry3d() });
  await layer.load();
  calls.added[0].boundingSphere = { center: { x: 1 }, radius: 200 };
  layer.flyTo();
  assert.equal(sphereCalls.length, 1);
  assert.equal(
    calls.flown.length,
    0,
    'no rectangle flight when the sphere is known',
  );
  assert.ok(Math.abs(sphereCalls[0][1].offset.range - 440) < 1e-6);
  assert.ok(sphereCalls[0][1].offset.pitch < 0, 'looking down');
  layer.destroy();
});

test('Odm3dLayer: a load that throws after the pump started stops the pump and removes the tileset', async () => {
  const { Cesium, viewer, calls } = fake3dCesium();
  const intervals = new Map();
  let nextId = 1;
  const timers = {
    setInterval: (fn) => (intervals.set(nextId, fn), nextId++),
    clearInterval: (id) => intervals.delete(id),
  };
  const layer = new Odm3dLayer({
    Cesium,
    viewer,
    entry: entry3d(),
    timers,
    sampleTerrain: async () => [94, 94, 94],
  });
  // a failure late in the load: the style cannot be built
  Cesium.Cesium3DTileStyle = class {
    constructor() {
      throw new Error('style failed');
    }
  };
  layer.setOpacity(0.5);
  await layer.load();
  assert.equal(layer.status, 'failed');
  assert.equal(intervals.size, 0, 'no frame pump left running');
  assert.equal(calls.removed.length, 1);
  assert.equal(calls.added[0].destroyed, true);
  assert.equal(layer.tileset, null);
});

test('attachOverlays: raise/lower never swaps a flat layer with a 3D build and never moves a 3D build', () => {
  const { detach } = setup3d();
  const before = detach.state().stack;
  assert.equal(detach.moveLayer(THREE_D.id, 'up'), false);
  assert.equal(detach.moveLayer(THREE_D.id, 'down'), false);
  assert.deepEqual(detach.state().stack, before);
  // the flat layers still move, past the 3D entry when it is in the way
  const flat = before.filter((id) => id !== THREE_D.id);
  const top = flat[flat.length - 1];
  assert.equal(
    detach.moveLayer(flat[0], 'down'),
    false,
    'already at the bottom',
  );
  assert.equal(detach.moveLayer(top, 'up'), false, 'already at the top');
  assert.equal(detach.moveLayer(flat[0], 'up'), true);
  const after = detach.state().stack;
  assert.deepEqual(after.filter((id) => id !== THREE_D.id).slice(0, 2), [
    flat[1],
    flat[0],
  ]);
});

test('attachOverlays: Fly to on a layer that is switched on but has no model yet builds it first; with Open not shown it does nothing', async () => {
  const { detach, controller, made, stackCalls } = setup3d();
  detach.setEnabled(THREE_D.id, true);
  controller.switchTo('esri-imagery'); // another map: the model is taken away, the choice is kept
  assert.deepEqual(detach.state().active, []);
  assert.equal(
    detach.flyTo(THREE_D.id),
    false,
    'Open is not shown: nothing to fly to',
  );
  assert.deepEqual(stackCalls, []);
  controller.switchTo(BYRDIT_OPEN_STACK_ID);
  assert.equal(made.length, 2, 'rebuilt when Open came back');
  assert.equal(detach.flyTo(THREE_D.id), true);
  await new Promise((r) => setImmediate(r));
  assert.equal(made[1].calls.at(-1), 'fly');
});
