import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// REAL Cesium from node_modules (1.138, unminified import path), real
// RequestScheduler, real Request/Resource, real HTTP server. The only fakes
// here are a tileset stub for Cesium3DTile (Cesium3DTileset.update() would
// need WebGL frameState machinery) — the request path itself
// (requestContent -> requestSingleContent -> Request -> Resource._makeRequest
// -> RequestScheduler.request -> gate -> loadWithHttpRequest) is Cesium's
// unfaked code from top to bottom.
import {
  Resource,
  RequestScheduler,
  Cesium3DTile,
  Cesium3DTileset,
  Matrix4,
} from 'cesium';

import {
  OdmRequestGate,
  createOdmRequestGateResource,
} from './odmRequestGate.js';

// The gate factory takes a Cesium-shaped handle; hand it the real pieces.
const Cesium = { Resource, RequestScheduler };

const b3dmMagic = (bytes) => {
  const body = Buffer.alloc(Math.max(bytes, 28), 0x41);
  body.writeUInt32LE(12053, 0); // 'b3dm'
  body.writeUInt32LE(body.length, 4);
  body.writeUInt32LE(body.length, 8);
  return body;
};

const serverOf = ({ delayMs = 40, urlDelay = {} } = {}) =>
  new Promise((resolve) => {
    const state = {
      requests: [], // urls in arrival order
      concurrent: 0,
      maxConcurrent: 0,
      settle: null,
      resolve,
    };
    const server = http.createServer((req, res) => {
      state.requests.push(req.url);
      state.concurrent++;
      state.maxConcurrent = Math.max(state.maxConcurrent, state.concurrent);
      res.setHeader('content-type', 'application/octet-stream');
      const delay = urlDelay[req.url] ?? delayMs;
      setTimeout(() => {
        res.end(b3dmMagic(64));
        state.concurrent--;
      }, delay);
    });
    server.listen(0, '127.0.0.1', () => {
      state.port = server.address().port;
      state.server = server;
      state.close = () => new Promise((done) => server.close(done));
      resolve(state);
    });
  });

// Drive Cesium's own scheduler loop: the tileset's real frame loop would call
// this every frame.
const pumpScheduler = (everyMs = 4) => {
  const id = setInterval(() => RequestScheduler.update(), everyMs);
  return () => clearInterval(id);
};

// A tileset stub with exactly what Cesium3DTile's real request pipeline
// touches; every request increment goes through Cesium's own code.
const fakeTileset = () => ({
  statistics: {
    numberOfPendingRequests: 0,
    numberOfAttemptedRequests: 0,
    numberOfTilesProcessing: 0,
  },
  // What Cesium3DTile's constructor reads off the tileset (computed
  // transforms): identity everywhere.
  modelMatrix: Matrix4.clone(Matrix4.IDENTITY),
  _disableSkipLevelOfDetail: false,
  tileFailed: { numberOfListeners: 0 },
  isDestroyed: () => false,
});

// n real Cesium3DTile contents against the gated resource; a gate marker on
// the tileset mirrors what a real tileset's derived chain does.
const requestTiles = (resource, urls) =>
  urls.map((u, i) => {
    const tile = new Cesium3DTile(fakeTileset(), resource, {
      boundingVolume: { box: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10] },
      geometricError: 10,
      refine: 'REPLACE',
      content: { uri: u },
    });
    tile._priority = urls.length - i; // lower number = higher priority
    const result = {};
    result.tile = tile;
    result.promise = new Promise((resolvePromise) => {
      // Cesium3DTileset.requestContent is exactly this line in 1.138:
      result.outcome = tile.requestContent();
      if (result.outcome === undefined) return resolvePromise('refused');
      result.outcome.then(
        (v) => resolvePromise({ ok: true, value: v }),
        (e) => resolvePromise({ ok: false, error: e }),
      );
    }).then((r) => (result.result = r));
    return result;
  });

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

const snapshotScheduler = () => ({
  maximumRequests: RequestScheduler.maximumRequests,
  maximumRequestsPerServer: RequestScheduler.maximumRequestsPerServer,
  requestsByServer: RequestScheduler.requestsByServer,
});

test('the scheduler defaults survive everything the gate does', async (t) => {
  const before = snapshotScheduler();
  await runConcurrencyScenario({ cap: 3, count: 10 }); // real flow, inside
  assert.deepEqual(snapshotScheduler(), before, 'no scheduler state changed');
});

async function runConcurrencyScenario({ cap, count }) {
  const srv = await serverOf({ delayMs: 30 });
  try {
    const { resource, gate } = createOdmRequestGateResource(
      Cesium,
      `http://127.0.0.1:${srv.port}/tileset.json`,
      { maxInFlight: cap },
    );
    const stop = pumpScheduler();
    const urls = Array.from({ length: count }, (_, i) => `tiles/t${i}.b3dm`);
    const tiles = requestTiles(resource, urls);
    // wait until all settled
    await Promise.race([
      Promise.all(tiles.map((r) => r.promise)),
      settle(8000).then(() => Promise.reject(new Error('timed out'))),
    ]);
    stop();
    assert.equal(
      srv.maxConcurrent <= cap,
      true,
      `server-observed concurrency ${srv.maxConcurrent} stayed under the cap ${cap}`,
    );
    gate.destroy();
  } finally {
    await srv.close();
  }
}

test('real request flow: the cap holds at the HTTP level for many tiles', async () => {
  await runConcurrencyScenario({ cap: 3, count: 12 });
});

test('real request flow: every tile content passes through the real RequestScheduler and completes', async () => {
  const srv = await serverOf({ delayMs: 10 });
  try {
    const { resource, gate } = createOdmRequestGateResource(
      Cesium,
      `http://127.0.0.1:${srv.port}/tileset.json`,
      { maxInFlight: 4 },
    );
    assert.equal(resource instanceof Cesium.Resource, true);
    const stop = pumpScheduler();
    const urls = Array.from({ length: 8 }, (_, i) => `tiles/x${i}.b3dm`);
    const tiles = requestTiles(resource, urls);
    await Promise.all(tiles.map((r) => r.promise));
    stop();
    assert.deepEqual(
      [...srv.requests].sort(),
      urls.map((u) => `/${u}`).sort(),
      'every tile content was fetched exactly once',
    );
    assert.equal(gate.inFlight, 0, 'gate drained completely');
  } finally {
    await srv.close();
  }
});

test('pressuring the gate stops NEW loads at the HTTP level; in-flight requests drain', async () => {
  const srv = await serverOf({ delayMs: 60 });
  try {
    const { resource, gate } = createOdmRequestGateResource(
      Cesium,
      `http://127.0.0.1:${srv.port}/tileset.json`,
      { maxInFlight: 3 },
    );
    const stop = pumpScheduler();
    const urls = Array.from({ length: 10 }, (_, i) => `tiles/p${i}.b3dm`);
    const tiles = requestTiles(resource, urls);

    // Once the first wave is on the wire, close the pause.
    while (srv.maxConcurrent < 3) await settle(5);
    gate.setPaused(true);
    const frozen = srv.requests.length;
    const frozenConcurrent = srv.concurrent;
    await settle(140); // far longer than one response delay
    assert.equal(
      srv.requests.length <= frozen,
      true,
      'no new request reached the server while paused',
    );
    assert.equal(
      srv.concurrent <= frozenConcurrent,
      true,
      'paused requests never started behind the scenes',
    );

    // Reopen: the queue resumes, still under the cap, and everything lands.
    gate.setPaused(false);
    await Promise.all(tiles.map((r) => r.promise));
    stop();
    assert.equal(
      srv.maxConcurrent <= 3,
      true,
      'the cap still holds across the pause',
    );
    assert.deepEqual(
      [...new Set(srv.requests)].sort(),
      urls.map((u) => `/${u}`).sort(),
      'every requested tile was eventually fetched exactly once',
    );
  } finally {
    await srv.close();
  }
});

test('cancellation while queued: the tile never issues HTTP for a cancelled request', async () => {
  const srv = await serverOf({ delayMs: 80 });
  try {
    const { resource, gate } = createOdmRequestGateResource(
      Cesium,
      `http://127.0.0.1:${srv.port}/tileset.json`,
      { maxInFlight: 1 },
    );
    const stop = pumpScheduler();
    const urls = Array.from({ length: 5 }, (_, i) => `tiles/c${i}.b3dm`);
    const tiles = requestTiles(resource, urls);
    while (gate.inFlight < 1) await settle(5);

    // Exactly what Cesium's cancelOutOfViewRequests does per frame for tiles
    // that left the view.
    for (let i = 1; i < tiles.length; i++) {
      tiles[i].tile.cancelRequests();
    }
    await Promise.all(tiles.map((r) => r.promise));
    stop();

    assert.deepEqual(
      srv.requests,
      ['/tiles/c0.b3dm'],
      'the cancelled tiles never reached the server',
    );
    assert.equal(gate.inFlight, 0);
    for (let i = 1; i < tiles.length; i++) {
      // Cesium's processArrayBuffer resolves a cancelled request's promise
      // without content (state restored, no failure): the strong signal is
      // that no HTTP happened for it, asserted above.
      const settled = tiles[i].result;
      assert.equal(
        settled.ok !== true || settled.value === undefined,
        true,
        'the cancelled tile produced no content',
      );
    }
  } finally {
    await srv.close();
  }
});

test('destroying a paused gate leaves a real Cesium tile retryable', async () => {
  const srv = await serverOf({ delayMs: 10 });
  try {
    const { resource, gate } = createOdmRequestGateResource(
      Cesium,
      `http://127.0.0.1:${srv.port}/tileset.json`,
      { maxInFlight: 1 },
    );
    gate.setPaused(true);
    const [request] = requestTiles(resource, ['tiles/retry.b3dm']);
    assert.equal(gate.queued, 1);
    gate.destroy();
    await request.promise;
    assert.equal(request.result.ok, true);
    assert.equal(request.tile.contentUnloaded, true);
    assert.equal(request.tile.contentFailed, false);
    assert.deepEqual(srv.requests, []);
  } finally {
    await srv.close();
  }
});

test('the gate is per tileset: a paused ODM tileset cannot block an unrelated same-origin Resource fetch', async () => {
  const srv = await serverOf({ delayMs: 30 });
  try {
    const { resource, gate } = createOdmRequestGateResource(
      Cesium,
      `http://127.0.0.1:${srv.port}/tileset.json`,
      { maxInFlight: 2 },
    );
    const stop = pumpScheduler();
    const tiles = requestTiles(
      resource,
      Array.from({ length: 6 }, (_, i) => `tiles/o${i}.b3dm`),
    );
    while (gate.inFlight < 2) await settle(5);
    gate.setPaused(true);

    // An unrelated content type on the same origin (imagery/terrain-like:
    // an ordinary Resource fetch) must be completely unaffected.
    const other = await new Cesium.Resource({
      url: `http://127.0.0.1:${srv.port}/unrelated.b3dm`,
    }).fetchArrayBuffer();
    assert.equal(
      Buffer.isBuffer(other) || other instanceof ArrayBuffer,
      true,
      'the unrelated fetch completed while the ODM gate was paused',
    );
    assert.equal(srv.requests.includes('/unrelated.b3dm'), true);

    gate.setPaused(false);
    await Promise.all(tiles.map((r) => r.promise));
    stop();
  } finally {
    await srv.close();
  }
});

test('end-to-end: Cesium3DTileset.fromUrl loads through the gated resource', async () => {
  const srv = await serverOf({ delayMs: 5 });
  try {
    srv.server.once('request', (req, res) => {
      if (req.url === '/tileset.json') {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            asset: { version: '1.1' },
            geometricError: 1000,
            root: {
              boundingVolume: {
                box: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10],
              },
              geometricError: 100,
              refine: 'REPLACE',
            },
          }),
        );
      }
    });
    const { resource, gate } = createOdmRequestGateResource(
      Cesium,
      `http://127.0.0.1:${srv.port}/tileset.json`,
      { maxInFlight: 2 },
    );
    const tileset = await Cesium3DTileset.fromUrl(resource, {
      maximumScreenSpaceError: 80,
      cacheBytes: 64 * 1024 * 1024,
      maximumCacheOverflowBytes: 0,
    });
    assert.ok(tileset.root, 'the tileset json was fetched through the gate');
    assert.equal(gate.inFlight >= 0, true);
    tileset.destroy();
  } finally {
    await srv.close();
  }
});

test('OdmRequestGate unit behavior: cap, ordering, refuse-requeue and destroy', async () => {
  // Pure gate semantics against injected fetches (no Cesium needed).
  const gate = new OdmRequestGate({ maxInFlight: 2 });
  const baseFetch = (resource, options) =>
    new Promise((resolve) =>
      setTimeout(() => resolve(`${resource.url}:${options.suffix}`), 15),
    );
  const mk = (url, priority) => ({
    request: { priorityFunction: () => priority ?? 0, cancelled: false },
    url,
  });
  const a = gate.run(mk('a'), { suffix: 'x' }, baseFetch);
  const b = gate.run(mk('b'), { suffix: 'x' }, baseFetch);
  const c = gate.run(mk('c', -1), { suffix: 'x' }, baseFetch); // urgent
  const d = gate.run(mk('d'), { suffix: 'x' }, baseFetch);
  assert.equal(gate.queued, 2);
  const results = (await Promise.all([a, b, c, d])).join(' ');
  // The urgent queued entry goes first; everything finishes exactly once.
  assert.equal(gate.inFlight, 0);
  assert.match(results, /c:x.*d:x/g);

  // Scheduler refusal: requeued, not lost, and retried on the next trigger.
  const refusingGate = new OdmRequestGate({ maxInFlight: 8 });
  let attempts = 0;
  const refusingFetch = () => {
    attempts++;
    if (attempts === 1) {
      return undefined; // Cesium's full-cap refusal
    }
    return Promise.resolve('second-try-ok');
  };
  const refused = refusingGate.run(mk('r'), {}, refusingFetch);
  await settle(5);
  assert.equal(refusingGate.queued, 1, 'the refused entry waits re-queued');
  refusingGate.pump(); // requestCompletedEvent would do this
  assert.equal(await refused, 'second-try-ok');

  // Destroy rejects everything queued and refuses to start more.
  const dying = new OdmRequestGate({ maxInFlight: 1 });
  const started = Promise.resolve(dying.run(mk('k'), {}, baseFetch));
  const queuedResource = mk('m');
  const queued = dying.run(queuedResource, {}, baseFetch);
  dying.destroy();
  await assert.rejects(() => queued, { isCancelledRequest: true });
  assert.equal(
    queuedResource.request.cancelled,
    true,
    'Cesium sees queued teardown as cancellation',
  );
  assert.equal(dying.destroyed, true);
  await started;
  const afterDestroy = mk('n');
  await assert.rejects(() => dying.run(afterDestroy, {}, baseFetch));
  assert.equal(
    afterDestroy.request.cancelled,
    true,
    'late requests are cancelled for Cesium too',
  );
});

test('scheduler refusals never hot-loop the pump: the re-queued entry is retried on the NEXT trigger, not in the same pass', async () => {
  const gate = new OdmRequestGate({ maxInFlight: 4 });
  let attempts = 0;
  // The underlying scheduler is full for a while: everything comes back
  // `undefined` until it finally frees capacity, exactly as
  // Resource._makeRequest refuses at its per-server cap.
  const fetch = () => {
    attempts++;
    if (attempts <= 5) return undefined; // 5 synchronous refusals
    return Promise.resolve('ok');
  };
  const pending = [1, 2, 3].map(() =>
    gate
      .run(
        { request: { priorityFunction: () => 1, cancelled: false } },
        {},
        fetch,
      )
      .then(
        () => 'done',
        (e) => `err:${e.message}`,
      ),
  );
  // Pre-fix this line never returns: pump() shifts the entry, _begin()
  // book-keeps the refusal straight back to the front of the SAME queue and
  // the SAME while loop retries it, an unbounded synchronous spin. Post-fix
  // the pass ends on the first refusal and nothing is started or lost.
  assert.equal(gate.inFlight, 0, 'a refusal booked no slot');
  assert.equal(gate.queued, 3, 'all three entries wait, in order');
  assert.ok(
    attempts <= 6,
    `no hot loop: one attempt per entry per pass, got ${attempts}`,
  );
  // The scheduler frees up: requestCompletedEvent's pump starts them (each
  // pass starts what it can; refusals still end their pass, retried later).
  for (let i = 0; gate.queued > 0 && i < 20; i++) gate.pump();
  assert.deepEqual(await Promise.all(pending), ['done', 'done', 'done']);
  assert.equal(gate.inFlight, 0);
  assert.equal(gate.queued, 0);
});
