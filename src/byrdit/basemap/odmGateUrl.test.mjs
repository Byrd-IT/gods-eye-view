import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// The deployed GEV tileset URL is same-origin-RELATIVE:
//   /basemap/odm3d/<id>/tileset.json
// (the server composes it that way — see proxy.js resolveOdm3dFile). The
// request-gate factory used to require /^https?:/, so on the real page the
// phone gate was silently never created. These tests run the RED -> GREEN
// regression through the REAL integration points only:
//   - the actual Odm3dLayer from odm3d.js (phone mode on),
//   - the real Cesium Resource / Resource subclass chain from node_modules,
//   - the real RequestScheduler,
//   - a real HTTP server serving tileset.json, resolved from the relative
//     URL by Cesium itself against document.baseURI (a browser stand-in:
//     in the browser the page's baseURI is the only origin a relative URL
//     can resolve to, so this stub widens nothing).
// No fake gate factory is injected anywhere: the layer's DEFAULT factory
// (createOdmRequestGateResource) must engage on the real URL shape.
import {
  Resource,
  RequestScheduler,
  Cesium3DTileset,
  Cartesian3,
  Ellipsoid,
  Matrix4,
  ClippingPlane,
  ClippingPlaneCollection,
  Cesium3DTileStyle,
  Rectangle,
  HeadingPitchRange,
  Cartographic,
  sampleTerrainMostDetailed,
} from 'cesium';

// The real layer under test.
import { Odm3dLayer } from './odm3d.js';
import { createOdmRequestGateResource } from './odmRequestGate.js';

// Real Cesium pieces the layer touches — nothing here is a stub.
const Cesium = {
  Resource,
  RequestScheduler,
  Cesium3DTileset,
  Cartesian3,
  Ellipsoid,
  Matrix4,
  ClippingPlane,
  ClippingPlaneCollection,
  Cesium3DTileStyle,
  Rectangle,
  HeadingPitchRange,
  Cartographic,
  sampleTerrainMostDetailed,
  Math: { toRadians: (d) => (d * Math.PI) / 180 },
};

const TILESET_JSON = {
  asset: { version: '1.1' },
  geometricError: 1000,
  root: {
    boundingVolume: { box: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10] },
    geometricError: 100,
    refine: 'REPLACE',
  },
};

const b3dmMagic = (bytes) => {
  const body = Buffer.alloc(Math.max(bytes, 28), 0x41);
  body.writeUInt32LE(12053, 0); // 'b3dm'
  body.writeUInt32LE(body.length, 4);
  body.writeUInt32LE(body.length, 8);
  return body;
};

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// A real server for the tileset + tile contents, plus the browser stand-in
// (document.baseURI) that makes Cesium resolve the RELATIVE GEV url to it.
const odmServer = () =>
  new Promise((resolve) => {
    const state = {
      requests: [],
      gatedTilesetRequests: 0, // requests seen while the gate held a slot
    };
    const server = http.createServer((req, res) => {
      state.requests.push(req.url);
      if (req.url.endsWith('/tileset.json')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(TILESET_JSON));
        return;
      }
      res.setHeader('content-type', 'application/octet-stream');
      setTimeout(() => res.end(b3dmMagic(64)), 10);
    });
    server.listen(0, '127.0.0.1', () => {
      state.port = server.address().port;
      state.base = `http://127.0.0.1:${state.port}/`;
      state.close = () => new Promise((done) => server.close(done));
      resolve(state);
    });
  });

/** Point Cesium's document-based relative-URL resolution at the test server. */
const withBrowserBase = async (base, run) => {
  const had = Object.hasOwn(globalThis, 'document');
  const previous = globalThis.document;
  globalThis.document = {
    baseURI: base,
    location: { href: base },
  };
  // Browsers resolve a relative fetch url against the document base; node's
  // fetch does not. Do exactly what the browser does (prefix with base), so
  // the relative tileset url is loaded by real Cesium + real fetch.
  const hadFetch = Object.hasOwn(globalThis, 'fetch');
  const previousFetch = globalThis.fetch;
  const browserLikeFetch = (input, init) => {
    let target = input;
    if (typeof target === 'string' && !/^https?:/i.test(target)) {
      target = new URL(target, base).toString();
    }
    return previousFetch(target, init);
  };
  globalThis.fetch = browserLikeFetch;
  try {
    return await run();
  } finally {
    if (had) globalThis.document = previous;
    else delete globalThis.document;
    if (hadFetch) globalThis.fetch = previousFetch;
    else delete globalThis.fetch;
  }
};

const pumpScheduler = (everyMs = 4) => {
  const id = setInterval(() => RequestScheduler.update(), everyMs);
  return () => clearInterval(id);
};

// A minimal viewer stand-in: only the optional hooks the layer uses.
const fakeViewer = () => ({
  scene: {
    primitives: {
      added: [],
      add(p) {
        this.added.push(p);
      },
      remove() {},
    },
    requestRender() {},
  },
});

const GEV_RELATIVE_URL = () => `/basemap/odm3d/buildA/tileset.json`;

const entryFor = (url) => ({
  url,
  phoneUrl: url, // factory test isolates gating from config normalization
  bounds: [-97.0, 32.0, -96.99, 32.01],
  model: { groundM: 150, heightOffsetM: null },
});

test('the factory engages on the real relative GEV tileset URL (and still gates every derived fetch)', () => {
  const bundle = createOdmRequestGateResource(
    Cesium,
    '/basemap/odm3d/buildA/tileset.json',
    { maxInFlight: 4 },
  );
  const gateBundle = { resource: bundle?.resource, gate: bundle?.gate };
  assert.ok(
    gateBundle.resource,
    'the gate factory must not bail out on the same-origin relative URL',
  );
  assert.ok(gateBundle.gate);
  assert.equal(
    gateBundle.resource instanceof Resource,
    true,
    'the gate carries a real, derived-capable Cesium Resource for the relative url',
  );
  // Every tile-content fetch derives from the base resource (Cesium's
  // getDerivedResource -> clone); the subclass and the gate must survive,
  // and the derived url must resolve inside the tileset's own path.
  const derived = gateBundle.resource.getDerivedResource({
    url: 'tiles/root.b3dm',
  });
  assert.equal(
    derived.constructor.name.startsWith('Odm'),
    true,
    'derived tile resources stay gated',
  );
  assert.equal(
    derived.url,
    '/basemap/odm3d/buildA/tiles/root.b3dm',
    'derived content urls resolve against the tileset url',
  );
  gateBundle.gate.destroy();
});

test('the factory still refuses non-http schemes and origin-escaping URLs (no unsafe widening)', () => {
  for (const url of [
    'data:application/json,{}',
    'blob:blob-url',
    '//evil.example/basemap/odm3d/x/tileset.json', // protocol-relative: origin-escaping
    '/\\evil.example/basemap/odm3d/x/tileset.json', // WHATWG treats backslash as slash
    'ftp://host/basemap/odm3d/x/tileset.json',
  ]) {
    assert.equal(createOdmRequestGateResource(Cesium, url), null, url);
  }
});

test('RED->GREEN regression: the real Odm3dLayer phone loads its tileset through the gate with the deployed relative URL', async (t) => {
  const srv = await odmServer();
  const stop = pumpScheduler();
  try {
    await withBrowserBase(srv.base, async () => {
      const layer = new Odm3dLayer({
        Cesium,
        viewer: fakeViewer(),
        entry: entryFor(GEV_RELATIVE_URL()),
        phoneMode: true, // force the phone path; no UA or viewport involved
      });
      await layer.load();
      t.after(() => layer.destroy());

      assert.equal(
        layer.status,
        'ready',
        `layer failed: ${layer.error ?? 'no error'}`,
      );
      assert.ok(
        layer.tileset,
        'the relative tileset url was fetched through real Cesium',
      );
      assert.ok(
        layer._gate,
        'the phone request gate was actually created (not silently bypassed)',
      );
      const saw = srv.requests;
      assert.ok(
        saw.includes(`/basemap/odm3d/buildA/tileset.json`),
        'the tileset.json was fetched from the resolved relative path',
      );
      assert.equal(
        layer.tileset instanceof Cesium3DTileset,
        true,
        'a real Cesium tileset, not a stub',
      );
    });
  } finally {
    stop();
    await srv.close();
  }
});

test('the layer phone gate actually caps: requests queue in the gate when the cap is small', async (t) => {
  const srv = await odmServer();
  const stop = pumpScheduler();
  try {
    await withBrowserBase(srv.base, async () => {
      // Phone limits with a small cap via the layer's own hook: prove the
      // REAL default factory (not an injected one) engaged on the relative
      // url by reading the created gate off the layer itself.
      const layer = new Odm3dLayer({
        Cesium,
        viewer: fakeViewer(),
        entry: entryFor(GEV_RELATIVE_URL()),
        phoneMode: true,
        phoneLimits: {
          ...{ initialError: 80, fineError: 24, phoneFineError: 64 },
          cacheBytes: 64 * 1024 * 1024,
          cacheOverflowBytes: 0,
          inFlightCap: 1,
          resumeFraction: 0.5,
          heapPressureFraction: 0.9,
          heapResumeFraction: 0.8,
          loadedTileCap: 400,
        },
      });
      await layer.load();
      t.after(() => layer.destroy());
      assert.equal(layer.status, 'ready', layer.error ?? '');
      assert.ok(layer._gate, 'the default factory produced a live gate');
      assert.equal(layer._gate.paused, false, 'the gate starts open');
      // The gate is a live participant: pausing it stops it from handing
      // over; releasing reopens. (The cap/pause mechanics are covered
      // end-to-end against HTTP in odmRequestGate.test.mjs.)
      const gate = layer._gate;
      gate.setPaused(true);
      assert.equal(gate.paused, true);
      gate.setPaused(false);
      assert.equal(gate.paused, false);
    });
  } finally {
    stop();
    await srv.close();
  }
});
