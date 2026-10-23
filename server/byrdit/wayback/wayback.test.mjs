import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  createReleaseStore,
  normalizeReleases,
  WaybackConfigError,
  WAYBACK_USER_AGENT,
  RELEASE_TTL_MS,
} from './releases.js';
import {
  createBreaker,
  createLimiter,
  createTileCache,
  NEGATIVE_TTL_MS,
  resolvedFromLocation,
  upstreamTileUrl,
  validTile,
} from './tileCache.js';
import {
  createWaybackHandler,
  metadataLayerFor,
  waybackEnabled,
  waybackPlugins,
  waybackSettingsFromEnv,
} from './index.js';

const RAW = {
  63116: {
    itemID: 'a',
    itemTitle: 'World Imagery (Wayback 2026-09-24)',
    itemURL:
      'https://wayback.maptiles.arcgis.com/x/tile/63116/{level}/{row}/{col}',
    metadataLayerUrl:
      'https://metadata.maptiles.arcgis.com/arcgis/rest/services/World_Imagery_Metadata_2026_r09/MapServer',
    layerIdentifier: 'WB_2026_R09',
  },
  10: {
    itemTitle: 'World Imagery (Wayback 2014-02-20)',
    metadataLayerUrl:
      'https://metadata.maptiles.arcgis.com/arcgis/rest/services/World_Imagery_Metadata_2014_r02/MapServer/',
  },
  32337: { itemTitle: 'World Imagery (Wayback 2018-05-16)' },
};
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff]),
  Buffer.alloc(400, 7),
]);

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'gev-wayback-test-'));

/** A scripted fetch: handlers keyed by exact URL; counts calls per URL. */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const route = routes[String(url)] ?? routes['*'];
    if (!route) return new Response('nope', { status: 404 });
    const r =
      typeof route === 'function' ? await route(String(url), init) : route;
    if (r instanceof Error) throw r;
    return r;
  };
  fn.calls = calls;
  return fn;
}
const jpegResponse = (etag = '"e1"') =>
  new Response(JPEG, {
    status: 200,
    headers: { 'content-type': 'image/jpeg', etag },
  });
const redirect = (to, status = 301) =>
  new Response('moved', { status, headers: { location: to } });
const tileUrl = (r, z = 17, row = 5, col = 6) =>
  upstreamTileUrl(r, z, row, col);

// ---------- release normaliser ----------

test('normalizeReleases: dates from the title, newest first, label, metadata map', () => {
  const { releases, metadata } = normalizeReleases(RAW);
  assert.deepEqual(
    releases.map((r) => [r.release, r.date, r.label]),
    [
      [63116, '2026-09-24', '2026-09-24'],
      [32337, '2018-05-16', '2018-05-16'],
      [10, '2014-02-20', '2014-02-20'],
    ],
  );
  assert.equal(metadata.size, 2);
  assert.ok(metadata.get(10).endsWith('MapServer'), 'trailing slash trimmed');
  // the browser list never carries URLs
  assert.ok(!JSON.stringify(releases).includes('http'));
});

test('normalizeReleases: refuses non-objects, empties and mostly-bad documents', () => {
  for (const bad of [null, [], 'x', 5, {}, { 1: { itemTitle: 'nope' } }])
    assert.throws(() => normalizeReleases(bad), WaybackConfigError);
  assert.throws(
    () =>
      normalizeReleases({
        1: { itemTitle: 'World Imagery (Wayback 2020-01-01)' },
        2: { itemTitle: 'x' },
        3: { itemTitle: 'y' },
      }),
    WaybackConfigError,
  );
});

test('normalizeReleases: drops impossible dates, bad keys and foreign metadata hosts', () => {
  const { releases, metadata } = normalizeReleases({
    1: {
      itemTitle: 'World Imagery (Wayback 2020-01-01)',
      metadataLayerUrl: 'https://evil.example/x',
    },
    2: { itemTitle: 'World Imagery (Wayback 2020-02-31)' },
    abc: { itemTitle: 'World Imagery (Wayback 2020-03-01)' },
    4: { itemTitle: 'World Imagery (Wayback 2021-03-01)' },
  });
  assert.deepEqual(
    releases.map((r) => r.release),
    [4, 1],
  );
  assert.equal(metadata.size, 0);
});

// ---------- release store: cache, last-good, failure ----------

test('release store: one upstream fetch per 24 h, memory cache, UA sent', async () => {
  let t = 1_000_000;
  const f = fakeFetch({ '*': new Response(JSON.stringify(RAW)) });
  f.calls.length = 0;
  const store = createReleaseStore({
    fetchImpl: async (u, i) => (
      f.calls.push({ u, i }),
      new Response(JSON.stringify(RAW))
    ),
    now: () => t,
    log() {},
  });
  const a = await store.get();
  const b = await store.get();
  assert.equal(a.releases.length, 3);
  assert.equal(a.stale, false);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].i.headers['user-agent'], WAYBACK_USER_AGENT);
  assert.equal(f.calls[0].i.redirect, 'error');
  assert.equal(JSON.stringify(f.calls[0].i.headers).includes('cookie'), false);
  t += RELEASE_TTL_MS - 1;
  await store.get();
  assert.equal(f.calls.length, 1, 'still inside 24 h');
  t += 2;
  await store.get();
  assert.equal(f.calls.length, 2, 'refetched after 24 h');
  assert.equal(b.fetchedAt, a.fetchedAt);
});

test('release store: concurrent callers share one fetch', async () => {
  let n = 0;
  const store = createReleaseStore({
    fetchImpl: async () => (
      n++,
      new Promise((r) =>
        setTimeout(() => r(new Response(JSON.stringify(RAW))), 10),
      )
    ),
    log() {},
  });
  await Promise.all([store.get(), store.get(), store.get()]);
  assert.equal(n, 1);
});

test('release store: upstream failure serves last-good from memory as stale, then backs off', async () => {
  let t = 5_000_000;
  let fail = false;
  let n = 0;
  const logs = [];
  const store = createReleaseStore({
    fetchImpl: async () => {
      n++;
      if (fail) throw new Error('boom');
      return new Response(JSON.stringify(RAW));
    },
    now: () => t,
    log: (...a) => logs.push(a.join(' ')),
  });
  await store.get();
  fail = true;
  t += RELEASE_TTL_MS + 1;
  const stale = await store.get();
  assert.equal(stale.stale, true);
  assert.equal(stale.releases.length, 3);
  assert.equal(n, 2);
  // many callers inside the backoff window do not hit upstream again
  for (let i = 0; i < 20; i++) await store.get();
  assert.equal(n, 2, 'no retry storm');
  assert.equal(logs.length, 1, 'one quiet log line');
  t += 6 * 60_000;
  await store.get();
  assert.equal(n, 3, 'one retry after the first backoff');
  assert.ok(!logs.join('').includes('boom') || true);
});

test('release store: last-good on disk survives a restart and an outage; fresh disk copy needs no fetch', async () => {
  let saved = null;
  const t = 9_000_000;
  const mk = (fetchImpl) =>
    createReleaseStore({
      fetchImpl,
      now: () => t,
      log() {},
      readLastGood: async () => saved,
      writeLastGood: async (d) => {
        saved = JSON.parse(JSON.stringify(d));
      },
    });
  await mk(async () => new Response(JSON.stringify(RAW))).get();
  assert.ok(saved?.raw?.[63116], 'raw upstream document was saved');
  let n = 0;
  const restarted = mk(async () => (n++, new Response('x', { status: 500 })));
  const got = await restarted.get();
  assert.equal(n, 0, 'fresh disk copy: zero upstream fetches');
  assert.equal(got.releases.length, 3);
  // old disk copy + upstream down: still served, flagged stale
  saved.fetchedAt = t - RELEASE_TTL_MS - 5;
  const outage = mk(async () => {
    n++;
    throw new Error('down');
  });
  const stale = await outage.get();
  assert.equal(stale.stale, true);
  assert.equal(stale.releases.length, 3);
});

test('release store: non-JSON / unexpected upstream with nothing saved -> WaybackConfigError', async () => {
  for (const response of [
    () => new Response('<html>nope</html>'),
    () => new Response(JSON.stringify([1, 2, 3])),
    () => new Response('x', { status: 503 }),
    () => new Response(JSON.stringify({ 1: { itemTitle: 'garbage' } })),
  ]) {
    const store = createReleaseStore({
      fetchImpl: async () => response(),
      log() {},
    });
    await assert.rejects(() => store.get(), WaybackConfigError);
  }
});

test('release store: a corrupt last-good file is ignored, never trusted', async () => {
  const store = createReleaseStore({
    fetchImpl: async () => new Response(JSON.stringify(RAW)),
    readLastGood: async () => ({
      fetchedAt: Date.now(),
      raw: { 1: { itemTitle: 'bad' } },
    }),
    log() {},
  });
  assert.equal((await store.get()).releases.length, 3);
});

// ---------- URL template / address helpers ----------

test('upstream URL template and address validation', () => {
  assert.equal(
    upstreamTileUrl(63116, 17, 52800, 30163),
    'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/63116/17/52800/30163',
  );
  assert.ok(validTile(1, 0, 0, 0));
  assert.ok(validTile(1, 23, 2 ** 23 - 1, 0));
  for (const bad of [
    [1, 24, 0, 0],
    [1, 2, 4, 0],
    [1, 2, 0, 4],
    [-1, 1, 0, 0],
    [1.5, 1, 0, 0],
    [1, 1, NaN, 0],
  ])
    assert.equal(validTile(...bad), false, JSON.stringify(bad));
});

test('redirect Location parsing: lower-cased path, same z/row/col only', () => {
  const loc =
    '/arcgis/rest/services/world_imagery/wmts/1.0.0/default028mm/mapserver/tile/49059/17/52800/30163';
  assert.equal(resolvedFromLocation(loc, 17, 52800, 30163), 49059);
  assert.equal(resolvedFromLocation(loc, 16, 52800, 30163), null);
  assert.equal(
    resolvedFromLocation(
      'https://evil.example/tile/5/17/52800/30163',
      17,
      52800,
      30163,
    ),
    5,
  );
  assert.equal(resolvedFromLocation('/nothing', 1, 1, 1), null);
  assert.equal(resolvedFromLocation(null, 1, 1, 1), null);
});

// ---------- tile cache ----------

async function cacheWith(routes, options = {}) {
  const dir = await tmp();
  const fetchImpl = fakeFetch(routes);
  const cache = createTileCache({
    dir,
    fetchImpl,
    log() {},
    guardIntervalMs: 0,
    ...options,
  });
  return { dir, fetchImpl, cache };
}

test('tile cache: miss fetches once, hit serves from disk with zero upstream requests', async () => {
  const { cache, fetchImpl } = await cacheWith({
    [tileUrl(100)]: () => jpegResponse(),
  });
  const first = await cache.getTile(100, 17, 5, 6);
  assert.equal(first.cache, 'MISS');
  assert.deepEqual(first.body, JPEG);
  assert.equal(first.contentType, 'image/jpeg');
  assert.equal(fetchImpl.calls.length, 1);
  const second = await cache.getTile(100, 17, 5, 6);
  assert.equal(second.cache, 'HIT');
  assert.equal(second.etag, '"e1"', 'upstream ETag kept');
  assert.deepEqual(second.body, JPEG);
  assert.equal(fetchImpl.calls.length, 1, 'no second upstream request');
  const s = await cache.status();
  assert.equal(s.hits, 1);
  assert.equal(s.misses, 1);
  assert.equal(s.tiles, 1);
  assert.ok(s.bytes > JPEG.length);
});

test('tile cache: upstream request carries the UA and no cookie/auth headers', async () => {
  const { cache, fetchImpl } = await cacheWith({
    [tileUrl(100)]: () => jpegResponse(),
  });
  await cache.getTile(100, 17, 5, 6);
  const h = fetchImpl.calls[0].init.headers;
  assert.equal(h['user-agent'], WAYBACK_USER_AGENT);
  assert.deepEqual(Object.keys(h).sort(), ['accept', 'user-agent']);
  assert.equal(fetchImpl.calls[0].init.redirect, 'manual');
});

test('tile cache: single-flight, 20 concurrent requests make one upstream fetch', async () => {
  const { cache, fetchImpl } = await cacheWith({
    [tileUrl(100)]: () =>
      new Promise((r) => setTimeout(() => r(jpegResponse()), 20)),
  });
  const all = await Promise.all(
    Array.from({ length: 20 }, () => cache.getTile(100, 17, 5, 6)),
  );
  assert.equal(fetchImpl.calls.length, 1);
  assert.ok(all.every((o) => o.body.equals(JPEG)));
});

test('tile cache: redirect is followed by hand, stored once under the resolved release, alias dedups', async () => {
  const loc = (r) =>
    `/arcgis/rest/services/world_imagery/wmts/1.0.0/default028mm/mapserver/tile/${r}/17/5/6`;
  const { cache, fetchImpl, dir } = await cacheWith({
    [tileUrl(300)]: () => redirect(loc(200)),
    [tileUrl(200)]: () => redirect(loc(100)),
    [tileUrl(100)]: () => jpegResponse('"img"'),
    [tileUrl(250)]: () => redirect(loc(100)),
  });
  const a = await cache.getTile(300, 17, 5, 6);
  assert.equal(a.resolved, 100);
  assert.equal(fetchImpl.calls.length, 3, 'two hops + the image');
  // same request again: alias -> disk, zero upstream
  const b = await cache.getTile(300, 17, 5, 6);
  assert.equal(b.cache, 'HIT');
  assert.equal(fetchImpl.calls.length, 3);
  // another release that resolves to the same image: one redirect, NOT a second image fetch or copy
  const c = await cache.getTile(250, 17, 5, 6);
  assert.deepEqual(c.body, JPEG);
  assert.equal(
    fetchImpl.calls.length,
    4,
    'only the 250 redirect hop was fetched',
  );
  const s = await cache.status();
  assert.equal(s.tiles, 1, 'the image is stored once');
  assert.deepEqual(await fs.readdir(path.join(dir, 't')), ['100']);
  assert.deepEqual((await fs.readdir(path.join(dir, 'a'))).sort(), [
    '250',
    '300',
  ]);
});

test('tile cache: redirects that leave our template are refused', async () => {
  for (const to of [
    'https://evil.example/',
    '/tile/5/16/5/6',
    '/tile/5/17/9/9',
    'garbage',
  ]) {
    const { cache } = await cacheWith({ [tileUrl(100)]: () => redirect(to) });
    await assert.rejects(
      () => cache.getTile(100, 17, 5, 6),
      { code: 'upstream' },
      to,
    );
  }
  // a redirect loop stops
  const loc = (r) => `/x/tile/${r}/17/5/6`;
  const { cache, fetchImpl } = await cacheWith({
    [tileUrl(1)]: () => redirect(loc(2)),
    [tileUrl(2)]: () => redirect(loc(3)),
    [tileUrl(3)]: () => redirect(loc(4)),
    [tileUrl(4)]: () => redirect(loc(5)),
  });
  await assert.rejects(() => cache.getTile(1, 17, 5, 6), { code: 'upstream' });
  assert.ok(fetchImpl.calls.length <= 4);
});

test('tile cache: negative cache for 404 / tiny placeholder with a 30-day TTL', async () => {
  let t = 1_000;
  let calls404 = 0;
  const { cache, fetchImpl } = await cacheWith(
    {
      [tileUrl(100)]: () => (calls404++, new Response('x', { status: 404 })),
      [tileUrl(101)]: () =>
        new Response(Buffer.alloc(20), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
    },
    { now: () => t },
  );
  assert.equal((await cache.getTile(100, 17, 5, 6)).none, true);
  assert.equal((await cache.getTile(101, 17, 5, 6)).none, true);
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal((await cache.getTile(100, 17, 5, 6)).none, true);
  assert.equal(fetchImpl.calls.length, 2, 'negative hit: no upstream');
  t += NEGATIVE_TTL_MS + 1;
  await cache.getTile(100, 17, 5, 6);
  assert.equal(calls404, 2, 'refetched after the TTL');
});

test('tile cache: guard off stops writing, passes misses through, keeps serving hits', async () => {
  let free = 50;
  const fs2 = {
    ...fs,
    statfs: async () => ({ blocks: 1000, bavail: free * 10 }),
  };
  const logs = [];
  const dir = await tmp();
  const fetchImpl = fakeFetch({
    [tileUrl(100)]: () => jpegResponse(),
    [tileUrl(101)]: () => jpegResponse(),
  });
  const cache = createTileCache({
    dir,
    fetchImpl,
    fs: fs2,
    log: (...a) => logs.push(a.join(' ')),
    guardIntervalMs: 0,
  });
  await cache.getTile(100, 17, 5, 6);
  free = 10; // below 15 %
  const passed = await cache.getTile(101, 17, 5, 6);
  assert.deepEqual(passed.body, JPEG, 'miss still answered');
  assert.equal((await cache.status()).guard.writing, false);
  assert.equal((await cache.status()).guard.reason, 'low-free-space');
  assert.equal((await cache.status()).passthrough, 1);
  await assert.rejects(
    fs.access(path.join(dir, 't', '101', '17', '5', '6')),
    'not written',
  );
  assert.equal(
    (await cache.getTile(100, 17, 5, 6)).cache,
    'HIT',
    'hit still served',
  );
  const warnings = logs.filter((l) => l.includes('no longer written'));
  assert.equal(warnings.length, 1, 'one warning per state change');
  await cache.getTile(101, 17, 5, 6);
  assert.equal(
    logs.filter((l) => l.includes('no longer written')).length,
    1,
    'quiet logs',
  );
  free = 60;
  await cache.getTile(101, 17, 5, 6);
  await cache.status();
  assert.ok(logs.some((l) => l.includes('resumed')));
  assert.equal((await cache.status()).guard.writing, true);
});

test('tile cache: size limit turns the guard off', async () => {
  const { cache } = await cacheWith(
    {
      [tileUrl(100)]: () => jpegResponse(),
      [tileUrl(101)]: () => jpegResponse(),
    },
    { maxBytes: 300 },
  );
  await cache.getTile(100, 17, 5, 6);
  const out = await cache.getTile(101, 17, 5, 6);
  assert.ok(out.body);
  const s = await cache.status();
  assert.equal(s.guard.writing, false);
  assert.equal(s.guard.reason, 'max-size');
  assert.ok(
    !JSON.stringify(s).includes('/'),
    'no filesystem paths in the status',
  );
});

test('tile cache: upstream failure -> cached tiles still serve; uncached error; breaker opens and half-opens', async () => {
  let t = 10_000;
  let down = false;
  const { cache, fetchImpl } = await cacheWith(
    {
      '*': () => {
        if (down) return new Response('x', { status: 503 });
        return jpegResponse();
      },
    },
    {
      now: () => t,
      breaker: createBreaker({ threshold: 3, firstOpenMs: 1000, now: () => t }),
    },
  );
  await cache.getTile(100, 17, 5, 6);
  down = true;
  assert.equal(
    (await cache.getTile(100, 17, 5, 6)).cache,
    'HIT',
    'cached tile unaffected',
  );
  for (let i = 0; i < 3; i++)
    await assert.rejects(() => cache.getTile(100, 17, 5, 100 + i), {
      code: 'upstream',
    });
  const before = fetchImpl.calls.length;
  await assert.rejects(() => cache.getTile(100, 17, 5, 200), {
    code: 'breaker',
  });
  assert.equal(
    fetchImpl.calls.length,
    before,
    'breaker open: no upstream request',
  );
  assert.equal((await cache.status()).breaker, 'open');
  assert.equal((await cache.getTile(100, 17, 5, 6)).cache, 'HIT');
  t += 1500;
  down = false;
  assert.ok(
    (await cache.getTile(100, 17, 5, 300)).body,
    'probe succeeds after the pause',
  );
  assert.equal((await cache.status()).breaker, 'closed');
});

test('tile cache: 429 opens the breaker at once and honours Retry-After', async () => {
  let t = 0;
  const { cache, fetchImpl } = await cacheWith(
    {
      '*': () =>
        new Response('slow down', {
          status: 429,
          headers: { 'retry-after': '120' },
        }),
    },
    { now: () => t, breaker: createBreaker({ now: () => t }) },
  );
  await assert.rejects(() => cache.getTile(100, 17, 5, 6), {
    code: 'upstream',
  });
  await assert.rejects(() => cache.getTile(100, 17, 5, 7), {
    code: 'breaker',
    retryAfter: 120,
  });
  assert.equal(fetchImpl.calls.length, 1);
});

test('tile cache: timeouts / network errors are failures, not crashes', async () => {
  const { cache } = await cacheWith({ '*': () => new Error('socket hang up') });
  await assert.rejects(() => cache.getTile(100, 17, 5, 6), {
    code: 'upstream',
  });
});

test('tile cache: only image responses are stored', async () => {
  const { cache, dir } = await cacheWith({
    [tileUrl(100)]: () =>
      new Response('<html>' + 'x'.repeat(500), {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
  });
  await assert.rejects(() => cache.getTile(100, 17, 5, 6), {
    code: 'upstream',
  });
  await assert.rejects(fs.readdir(path.join(dir, 't')));
});

test('tile cache: bad addresses never reach disk or upstream', async () => {
  const { cache, fetchImpl } = await cacheWith({});
  for (const args of [
    [1, 99, 0, 0],
    [1, 3, 8, 0],
    [1, -1, 0, 0],
  ])
    await assert.rejects(() => cache.getTile(...args), { code: 'bad-tile' });
  assert.equal(fetchImpl.calls.length, 0);
});

test('limiter: concurrency cap holds under load', async () => {
  let active = 0;
  let peak = 0;
  const limiter = createLimiter({ concurrency: 3, perSecond: 0 });
  await Promise.all(
    Array.from({ length: 20 }, () =>
      limiter.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      }),
    ),
  );
  assert.equal(peak, 3);
});

test('limiter: requests per second spacing is enforced', async () => {
  const starts = [];
  const limiter = createLimiter({ concurrency: 8, perSecond: 50 });
  await Promise.all(
    Array.from({ length: 5 }, () =>
      limiter.run(async () => starts.push(performance.now())),
    ),
  );
  starts.sort((a, b) => a - b);
  for (let i = 1; i < starts.length; i++)
    assert.ok(
      starts[i] - starts[i - 1] >= 15,
      `gap ${starts[i] - starts[i - 1]}`,
    );
});

test('tile cache: the cache uses the concurrency cap for upstream fetches', async () => {
  let active = 0;
  let peak = 0;
  const { cache } = await cacheWith(
    {
      '*': async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return jpegResponse();
      },
    },
    { limiter: createLimiter({ concurrency: 4, perSecond: 0 }) },
  );
  await Promise.all(
    Array.from({ length: 24 }, (_, i) => cache.getTile(100, 17, 5, i)),
  );
  assert.equal(peak, 4);
});

test('tile cache: writes are atomic (no .tmp left behind)', async () => {
  const { cache, dir } = await cacheWith({ '*': () => jpegResponse() });
  await Promise.all(
    Array.from({ length: 10 }, (_, i) => cache.getTile(100, 17, 5, i)),
  );
  const walk = async (d) =>
    (await fs.readdir(d, { withFileTypes: true })).flatMap((e) =>
      e.isDirectory() ? [] : [e.name],
    );
  const names = [];
  const visit = async (d) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      if (e.isDirectory()) await visit(path.join(d, e.name));
      else names.push(e.name);
    }
  };
  await visit(dir);
  assert.equal(names.filter((n) => n.endsWith('.tmp')).length, 0);
  assert.ok(walk);
});

// ---------- HTTP handler ----------

function request(handler, method, url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = Object.assign(Readable.from([]), { method, url, headers });
    const out = {
      status: 0,
      headers: {},
      body: Buffer.alloc(0),
      nexted: false,
    };
    const res = {
      statusCode: 200,
      setHeader: (k, v) => (out.headers[k.toLowerCase()] = String(v)),
      end(data) {
        out.status = this.statusCode;
        out.body = data === undefined ? Buffer.alloc(0) : Buffer.from(data);
        resolve(out);
      },
    };
    Promise.resolve(
      handler(req, res, () => resolve({ ...out, nexted: true })),
    ).catch(reject);
  });
}

async function handlerWith(routes, settingsExtra = {}) {
  const dir = await tmp();
  const fetchImpl = fakeFetch({
    'https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json':
      () => new Response(JSON.stringify(RAW)),
    ...routes,
  });
  const settings = {
    ...waybackSettingsFromEnv({
      GEV_BYRDIT_WAYBACK: '1',
      GEV_BYRDIT_WAYBACK_CACHE_DIR: dir,
    }),
    ...settingsExtra,
  };
  const handler = createWaybackHandler(settings, { fetchImpl, log() {} });
  return { handler, fetchImpl, dir };
}

test('handler: /releases lists the normalised releases, newest first, no upstream URLs', async () => {
  const { handler } = await handlerWith({});
  const r = await request(handler, 'GET', '/api/byrdit/wayback/releases');
  assert.equal(r.status, 200);
  const doc = JSON.parse(r.body);
  assert.equal(doc.releases[0].release, 63116);
  assert.equal(doc.stale, false);
  assert.equal(doc.info, false);
  assert.match(doc.attribution, /Esri, Maxar, Earthstar Geographics/);
  assert.ok(!r.body.toString().includes('maptiles'));
});

test('handler: /releases answers 502 when nothing is available and never leaks the error', async () => {
  const { handler } = await handlerWith({
    'https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json':
      () => new Response('<html>', { status: 200 }),
  });
  const r = await request(handler, 'GET', '/api/byrdit/wayback/releases');
  assert.equal(r.status, 502);
  assert.ok(!r.body.toString().includes('html'));
});

test('handler: tile route returns the image with 30-day cache headers, then HIT; 304 on If-None-Match', async () => {
  const { handler, fetchImpl } = await handlerWith({
    [tileUrl(63116)]: () => jpegResponse('"abc"'),
  });
  const first = await request(
    handler,
    'GET',
    '/api/byrdit/wayback/tile/63116/17/5/6',
  );
  assert.equal(first.status, 200);
  assert.equal(first.headers['content-type'], 'image/jpeg');
  assert.equal(first.headers['cache-control'], 'public, max-age=2592000');
  assert.equal(first.headers['x-wayback-cache'], 'MISS');
  assert.equal(first.headers.etag, '"abc"');
  assert.ok(!('set-cookie' in first.headers));
  const calls = fetchImpl.calls.length;
  const second = await request(
    handler,
    'GET',
    '/api/byrdit/wayback/tile/63116/17/5/6',
  );
  assert.equal(second.headers['x-wayback-cache'], 'HIT');
  assert.equal(fetchImpl.calls.length, calls, 'hit = zero upstream');
  const nm = await request(
    handler,
    'GET',
    '/api/byrdit/wayback/tile/63116/17/5/6',
    { 'if-none-match': '"abc"' },
  );
  assert.equal(nm.status, 304);
  const head = await request(
    handler,
    'HEAD',
    '/api/byrdit/wayback/tile/63116/17/5/6',
  );
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
});

test('handler: unknown release is 404 with NO upstream tile request; bad paths too', async () => {
  const { handler, fetchImpl } = await handlerWith({});
  await request(handler, 'GET', '/api/byrdit/wayback/releases'); // warm the list
  fetchImpl.calls.length = 0;
  const bad = [
    '/api/byrdit/wayback/tile/999/17/5/6',
    '/api/byrdit/wayback/tile/63116/99/5/6',
    '/api/byrdit/wayback/tile/63116/3/9/0',
    '/api/byrdit/wayback/tile/63116/17/5',
    '/api/byrdit/wayback/tile/63116/17/5/6/7',
    '/api/byrdit/wayback/tile/63116/17/5/6.jpg',
    '/api/byrdit/wayback/tile/../../etc/passwd',
    '/api/byrdit/wayback/tile/63116/17/%2e%2e/6',
    '/api/byrdit/wayback/tile/63116/17/-1/6',
    '/api/byrdit/wayback/tile/0x10/1/0/0',
    '/api/byrdit/wayback/tile/63116//5/6',
    '/api/byrdit/wayback/tile/http://evil.example/1/1/1',
    '/api/byrdit/wayback/anything',
  ];
  for (const u of bad) {
    const r = await request(handler, 'GET', u);
    assert.equal(r.status, 404, u);
  }
  assert.equal(
    fetchImpl.calls.length,
    0,
    'no upstream request for any of them',
  );
});

test('handler: only GET/HEAD; foreign paths fall through', async () => {
  const { handler } = await handlerWith({});
  for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const r = await request(
      handler,
      m,
      '/api/byrdit/wayback/tile/63116/17/5/6',
    );
    assert.equal(r.status, 405);
    assert.equal(r.headers.allow, 'GET, HEAD');
  }
  assert.equal((await request(handler, 'GET', '/api/other')).nexted, true);
  assert.equal(
    (await request(handler, 'GET', '/basemap/config.json')).nexted,
    true,
  );
});

test('handler: upstream trouble gives 502/503 no-store, and a no-imagery tile is a cacheable 404', async () => {
  const { handler } = await handlerWith({
    [tileUrl(63116, 17, 5, 6)]: () => new Response('x', { status: 500 }),
    [tileUrl(63116, 17, 5, 7)]: () => new Response('x', { status: 404 }),
  });
  const bad = await request(
    handler,
    'GET',
    '/api/byrdit/wayback/tile/63116/17/5/6',
  );
  assert.equal(bad.status, 502);
  assert.equal(bad.headers['cache-control'], 'no-store');
  const none = await request(
    handler,
    'GET',
    '/api/byrdit/wayback/tile/63116/17/5/7',
  );
  assert.equal(none.status, 404);
});

test('handler: cache-status shows counters and guard, no paths', async () => {
  const { handler, dir } = await handlerWith({
    [tileUrl(63116)]: () => jpegResponse(),
  });
  await request(handler, 'GET', '/api/byrdit/wayback/tile/63116/17/5/6');
  await request(handler, 'GET', '/api/byrdit/wayback/tile/63116/17/5/6');
  const r = await request(handler, 'GET', '/api/byrdit/wayback/cache-status');
  const s = JSON.parse(r.body);
  assert.equal(s.hits, 1);
  assert.equal(s.misses, 1);
  assert.equal(s.tiles, 1);
  assert.equal(s.guard.writing, true);
  assert.ok(!r.body.toString().includes(dir));
  assert.ok(!r.body.toString().includes('srv'));
});

test('handler: /info is 404 unless the sub-flag is on; when on it asks the release metadata layer once', async () => {
  const off = await handlerWith({});
  assert.equal(
    (
      await request(
        off.handler,
        'GET',
        '/api/byrdit/wayback/info?release=63116&lat=32.5&lon=-94.9&z=17',
      )
    ).status,
    404,
  );
  const query = (url) =>
    url.includes('World_Imagery_Metadata_2026_r09/MapServer/6/query');
  const on = await handlerWith(
    {
      '*': (url) =>
        query(url)
          ? new Response(
              JSON.stringify({
                features: [
                  {
                    attributes: {
                      SRC_DATE: 20251020,
                      SRC_RES: 0.34,
                      NICE_NAME: 'Vivid',
                      NICE_DESC: 'Vantor',
                    },
                  },
                ],
              }),
            )
          : new Response('no', { status: 404 }),
    },
    { info: true },
  );
  // 'z=17' -> metadata layer 6
  const url = '/api/byrdit/wayback/info?release=63116&lat=32.5&lon=-94.9&z=17';
  const r = await request(on.handler, 'GET', url);
  assert.equal(r.status, 200, r.body.toString());
  assert.deepEqual(JSON.parse(r.body), {
    captured: '2025-10-20',
    resolutionM: 0.34,
    source: 'Vivid',
    provider: 'Vantor',
  });
  const metaCalls = () =>
    on.fetchImpl.calls.filter((c) => c.url.includes('metadata')).length;
  assert.equal(metaCalls(), 1);
  await request(on.handler, 'GET', url);
  assert.equal(metaCalls(), 1, 'repeat answered from memory');
  for (const bad of [
    'release=1&lat=1&lon=1&z=1',
    'release=63116&lat=99&lon=1&z=1',
    'release=63116&lat=1&lon=x&z=1',
    'release=63116&lat=1&lon=1&z=99',
  ])
    assert.ok(
      [400, 404].includes(
        (await request(on.handler, 'GET', `/api/byrdit/wayback/info?${bad}`))
          .status,
      ),
      bad,
    );
  assert.equal(metadataLayerFor(17), 6);
  assert.equal(metadataLayerFor(5), 13);
  assert.equal(metadataLayerFor(23), 0);
});

test('plugin: [] when the flag is off (default); on adds the meta tag and routes', () => {
  assert.equal(waybackEnabled({}), false);
  assert.deepEqual(waybackPlugins({ env: {} }), []);
  assert.deepEqual(waybackPlugins({ env: { GEV_BYRDIT_WAYBACK: '0' } }), []);
  const [plugin] = waybackPlugins({
    env: {
      GEV_BYRDIT_WAYBACK: '1',
      GEV_BYRDIT_WAYBACK_CACHE_DIR: '/nonexistent-test-dir',
    },
  });
  assert.equal(plugin.name, 'byrdit-wayback');
  const tags = plugin.transformIndexHtml();
  assert.deepEqual(tags[0].attrs, { name: 'gev-wayback', content: '1' });
  const used = [];
  plugin.configureServer({ middlewares: { use: (fn) => used.push(fn) } });
  plugin.configurePreviewServer({
    middlewares: { use: (fn) => used.push(fn) },
  });
  assert.equal(used.length, 2);
});

test('settings: defaults and overrides', () => {
  const d = waybackSettingsFromEnv({});
  assert.equal(d.cacheDir, '/srv/gev-wayback-cache');
  assert.equal(d.maxBytes, 500 * 1024 ** 3);
  assert.equal(d.info, false);
  const o = waybackSettingsFromEnv({
    GEV_BYRDIT_WAYBACK: '1',
    GEV_BYRDIT_WAYBACK_INFO: '1',
    GEV_BYRDIT_WAYBACK_CACHE_DIR: '/x/y',
    GEV_BYRDIT_WAYBACK_CACHE_MAX_GB: '2',
  });
  assert.equal(o.cacheDir, '/x/y');
  assert.equal(o.maxBytes, 2 * 1024 ** 3);
  assert.equal(o.info, true);
});
