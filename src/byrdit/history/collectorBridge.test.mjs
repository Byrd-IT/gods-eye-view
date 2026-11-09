import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bridgeConfigFromEnv,
  collectorBridgePlugin,
  createCollectorBridge,
  parseCollectorUrls,
  DEFAULT_COLLECTOR_URLS,
} from './collectorBridge.js';
import { BRIDGE_FEEDS, enabledBridgeFeeds } from './feeds.js';
import { historyPlugins } from './index.js';

const T0 = 1_791_814_776_089;
const BODY =
  '{"ac":[{"hex":"ae1234","lat":30,"lon":-97}],"msg":"No error","now":1791814775501,"total":1,"ctime":1791814775501,"ptime":12}';

/** Minimal Node-style response recorder. */
function recorder() {
  let done;
  const finished = new Promise((resolve) => (done = resolve));
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    headersSent: false,
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headersSent = true;
      for (const [k, v] of Object.entries(headers))
        this.headers[k.toLowerCase()] = v;
    },
    end(body) {
      this.body = body;
      done();
    },
  };
  return { res, finished };
}

function text(body) {
  if (body === undefined) return undefined;
  return Buffer.from(body).toString('utf8');
}

/** Call one bridge handler; resolves with the response or 'next'. */
async function call(handler, url = '/', method = 'GET') {
  const { res, finished } = recorder();
  let nexted = false;
  const p = handler({ url, method }, res, () => {
    nexted = true;
  });
  await p;
  if (nexted) return 'next';
  await finished;
  return res;
}

/** Fake collector: one Response per URL, decided by `answer(url)`. */
function fakeCollectors(answer) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    assert.ok(init.signal, 'every collector read has a timeout signal');
    const r = await answer(url);
    if (r instanceof Error) throw r;
    return r;
  };
  return { calls, fetchImpl };
}

function collectorOk({ lastOk = T0, age = 1_000, extra = {} } = {}) {
  return new Response(BODY, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Feed-Source': 'adsb.lol',
      'X-Collector-Role': 'active',
      'X-Feed-Cache': 'HIT',
      'X-Feed-Age-Ms': String(age),
      'X-Feed-Last-OK': String(lastOk),
      'X-Internal-Thing': 'not relayed',
      ...extra,
    },
  });
}

const standby = () =>
  new Response('{"error":"collector standby"}', {
    status: 503,
    headers: { 'X-Collector-Role': 'standby' },
  });

function bridge(fetchImpl, overrides = {}) {
  const lines = [];
  let now = T0 + 1_000;
  const handler = createCollectorBridge({
    name: 'military',
    urls: ['http://s4:4180', 'http://s5:4180'],
    fetchImpl,
    now: () => now,
    log: (line) => lines.push(line),
    ...overrides,
  });
  return {
    handler,
    lines,
    advance: (ms) => (now += ms),
    now: () => now,
  };
}

test('relays the collector body byte for byte with its X-Feed headers only', async () => {
  const { calls, fetchImpl } = fakeCollectors(() => collectorOk());
  const { handler } = bridge(fetchImpl);
  const res = await call(handler);
  assert.equal(res.statusCode, 200);
  assert.equal(text(res.body), BODY);
  assert.deepEqual(calls, ['http://s4:4180/v1/latest/military']);
  assert.equal(res.headers['x-feed-source'], 'adsb.lol');
  assert.equal(res.headers['x-feed-cache'], 'HIT');
  assert.equal(res.headers['x-feed-age-ms'], '1000');
  assert.equal(res.headers['x-feed-last-ok'], String(T0));
  assert.equal(res.headers['x-collector-role'], 'active');
  assert.equal(res.headers['x-feed-bridge'], 'collector');
  assert.equal(res.headers['content-type'], 'application/json');
  assert.equal(res.headers['x-internal-thing'], undefined);
  assert.equal(res.headers['x-feed-stale-since'], undefined);
  assert.equal(res.headers['x-feed-grey-until'], undefined);
});

test('tries the collectors in order: S4 down or standby -> S5', async () => {
  for (const first of [() => new Error('ECONNREFUSED'), standby]) {
    const { calls, fetchImpl } = fakeCollectors((url) =>
      url.startsWith('http://s4') ? first() : collectorOk(),
    );
    const { handler } = bridge(fetchImpl);
    const res = await call(handler);
    assert.equal(res.statusCode, 200);
    assert.equal(text(res.body), BODY);
    assert.deepEqual(calls, [
      'http://s4:4180/v1/latest/military',
      'http://s5:4180/v1/latest/military',
    ]);
  }
});

test('collector STALE answers pass through and gain X-Feed-Grey-Until', async () => {
  const since = T0 + 180_000;
  const { fetchImpl } = fakeCollectors(() =>
    collectorOk({
      age: 200_000,
      extra: {
        'X-Feed-Cache': 'STALE',
        'X-Feed-Stale-Since': String(since),
        'X-Feed-Reason': 'upstream_error',
      },
    }),
  );
  const { handler } = bridge(fetchImpl, { greyMs: 3_600_000 });
  const res = await call(handler);
  assert.equal(res.statusCode, 200);
  assert.equal(text(res.body), BODY);
  assert.equal(res.headers['x-feed-cache'], 'STALE');
  assert.equal(res.headers['x-feed-stale-since'], String(since));
  assert.equal(res.headers['x-feed-reason'], 'upstream_error');
  assert.equal(res.headers['x-feed-grey-until'], String(since + 3_600_000));
});

test('no collector: last-good copy, HIT inside the threshold, STALE after it (3 x 300 s)', async () => {
  // military polls every 300 s (t_5ad2b9a4): 3 x cadence = 900 s, the same
  // stale threshold the collector's own X-Feed-* headers use
  assert.equal(BRIDGE_FEEDS.military.cadenceMs, 300_000);
  let up = true;
  const { fetchImpl } = fakeCollectors(() =>
    up ? collectorOk({ lastOk: T0 }) : new Error('ECONNREFUSED'),
  );
  const b = bridge(fetchImpl, { greyMs: 600_000 });
  await call(b.handler);
  up = false;
  b.advance(60_000); // age 61 s
  const fresh = await call(b.handler);
  assert.equal(fresh.statusCode, 200);
  assert.equal(text(fresh.body), BODY);
  assert.equal(fresh.headers['x-feed-cache'], 'HIT');
  assert.equal(fresh.headers['x-feed-bridge'], 'cache');
  assert.equal(fresh.headers['x-feed-age-ms'], '61000');
  assert.equal(fresh.headers['x-feed-stale-since'], undefined);
  // one missed 300 s poll (and the old 60 s rule's 180 s) is not stale yet
  b.advance(839_000); // age exactly 900 s: still HIT (stale is age > 900 s)
  const edge = await call(b.handler);
  assert.equal(edge.headers['x-feed-cache'], 'HIT');
  assert.equal(edge.headers['x-feed-age-ms'], '900000');
  assert.equal(edge.headers['x-feed-stale-since'], undefined);
  b.advance(1_000); // age 901 s > 900 s
  const stale = await call(b.handler);
  assert.equal(stale.statusCode, 200);
  assert.equal(
    text(stale.body),
    BODY,
    'the layer is never cleared by the server',
  );
  assert.equal(stale.headers['x-feed-cache'], 'STALE');
  assert.equal(stale.headers['x-feed-last-ok'], String(T0));
  assert.equal(stale.headers['x-feed-age-ms'], '901000');
  assert.equal(stale.headers['x-feed-stale-since'], String(T0 + 900_000));
  assert.equal(stale.headers['x-feed-reason'], 'collector_down');
  assert.equal(stale.headers['x-feed-grey-until'], String(T0 + 1_500_000));
  b.advance(48 * 3_600_000);
  const later = await call(b.handler);
  assert.equal(later.statusCode, 200, 'still the last-good body days later');
  assert.equal(text(later.body), BODY);
});

test('no snapshot at all: 503 {noDataSince:null}, with the collector reason when it gave one', async () => {
  const { fetchImpl } = fakeCollectors(
    () =>
      new Response('{"error":"no snapshot yet","noDataSince":null}', {
        status: 503,
        headers: {
          'X-Collector-Role': 'active',
          'X-Feed-Reason': 'no_snapshot',
        },
      }),
  );
  const res = await call(bridge(fetchImpl).handler);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(JSON.parse(res.body), {
    error: 'no snapshot',
    noDataSince: null,
  });
  assert.equal(res.headers['x-feed-reason'], 'no_snapshot');
  assert.equal(res.headers['x-feed-source'], 'adsb.lol');
  const down = await call(
    bridge(fakeCollectors(() => new Error('down')).fetchImpl).handler,
  );
  assert.equal(down.statusCode, 503);
  assert.equal(down.headers['x-feed-reason'], 'collector_down');
});

test('an unsafe collector reason is not relayed', async () => {
  const { fetchImpl } = fakeCollectors(
    () =>
      new Response('{}', {
        status: 503,
        headers: { 'X-Feed-Reason': 'x'.repeat(200) },
      }),
  );
  const res = await call(bridge(fetchImpl).handler);
  assert.equal(res.headers['x-feed-reason'], 'collector_down');
});

test('sub-routes go to the next handler; other methods get 405, never the upstream', async () => {
  const { calls, fetchImpl } = fakeCollectors(() => collectorOk());
  const { handler } = bridge(fetchImpl);
  assert.equal(await call(handler, '/track?hex=ae1234'), 'next');
  const post = await call(handler, '/', 'POST');
  assert.equal(post.statusCode, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');
  assert.equal(calls.length, 0);
});

test('HEAD sends headers without a body; the query string is not forwarded for military', async () => {
  const { calls, fetchImpl } = fakeCollectors(() => collectorOk());
  const { handler } = bridge(fetchImpl);
  const head = await call(handler, '/?x=1', 'HEAD');
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, undefined);
  assert.equal(head.headers['x-feed-source'], 'adsb.lol');
  assert.deepEqual(calls, ['http://s4:4180/v1/latest/military']);
});

test('concurrent requests share one collector read', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { calls, fetchImpl } = fakeCollectors(async () => {
    await gate;
    return collectorOk();
  });
  const { handler } = bridge(fetchImpl);
  const all = Promise.all([call(handler), call(handler), call(handler)]);
  release();
  const answers = await all;
  assert.equal(calls.length, 1);
  for (const res of answers) assert.equal(text(res.body), BODY);
  await call(handler);
  assert.equal(calls.length, 2, 'the next request reads again');
});

test('quiet failure: one log line per state transition, none per request', async () => {
  let up = true;
  const { fetchImpl } = fakeCollectors(() =>
    up ? collectorOk() : new Error('down'),
  );
  const b = bridge(fetchImpl);
  for (let i = 0; i < 5; i++) await call(b.handler);
  up = false;
  for (let i = 0; i < 5; i++) await call(b.handler);
  up = true;
  for (let i = 0; i < 5; i++) await call(b.handler);
  assert.deepEqual(b.lines, [
    '[gev-history bridge] military: start -> collector',
    '[gev-history bridge] military: collector -> cache (collector_down)',
    '[gev-history bridge] military: cache -> collector',
  ]);
});

test('a throwing collector client never falls through', async () => {
  const b = bridge(() => {
    throw new Error('sync boom');
  });
  const res = await call(b.handler);
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers['x-feed-reason'], 'collector_down');
});

test('flags: every feed is off unless GEV_BRIDGE_<FEED> is exactly 1', () => {
  assert.deepEqual(enabledBridgeFeeds({}), []);
  for (const v of ['0', 'true', 'yes', '', ' 2 '])
    assert.deepEqual(enabledBridgeFeeds({ GEV_BRIDGE_MILITARY: v }), []);
  assert.deepEqual(enabledBridgeFeeds({ GEV_BRIDGE_MILITARY: '1' }), [
    'military',
  ]);
  assert.equal(BRIDGE_FEEDS.military.flag, 'GEV_BRIDGE_MILITARY');
  assert.equal(BRIDGE_FEEDS.military.route, '/api/military');
  // B20 (t_1f5bcfa6) registered flights behind its own flag
  assert.equal(BRIDGE_FEEDS.flights.flag, 'GEV_BRIDGE_FLIGHTS');
  assert.deepEqual(enabledBridgeFeeds({ GEV_BRIDGE_FLIGHTS: ' 1 ' }), [
    'flights',
  ]);
});

test('bridge OFF installs no middleware at all (dev and preview)', () => {
  const plugin = collectorBridgePlugin({ env: {} });
  let uses = 0;
  const server = { middlewares: { use: () => uses++ } };
  plugin.configureServer(server);
  plugin.configurePreviewServer(server);
  assert.equal(uses, 0);
  assert.deepEqual(historyPlugins({ env: {} }), []);
  assert.deepEqual(historyPlugins({ env: { GEV_BRIDGE_MILITARY: '0' } }), []);
  assert.equal(
    historyPlugins({ env: { GEV_BRIDGE_MILITARY: '1' } })[0].name,
    'byrdit-history-bridge',
  );
});

test('bridge ON mounts /api/military in dev and preview', () => {
  const routes = [];
  const server = { middlewares: { use: (route) => routes.push(route) } };
  const plugin = collectorBridgePlugin({ env: { GEV_BRIDGE_MILITARY: '1' } });
  assert.equal(plugin.name, 'byrdit-history-bridge');
  plugin.configureServer(server);
  plugin.configurePreviewServer(server);
  assert.deepEqual(routes, ['/api/military', '/api/military']);
});

test('environment parsing', () => {
  assert.deepEqual(parseCollectorUrls(undefined), [...DEFAULT_COLLECTOR_URLS]);
  assert.deepEqual(
    parseCollectorUrls(' http://127.0.0.1:4180/ , http://10.0.0.5:4180 '),
    ['http://127.0.0.1:4180', 'http://10.0.0.5:4180'],
  );
  assert.throws(() => parseCollectorUrls('ftp://x'), /http\(s\)/);
  assert.throws(() => parseCollectorUrls('http://u:p@x'), /http\(s\)/);
  assert.throws(() => parseCollectorUrls('not a url'), /invalid URL/);
  const c = bridgeConfigFromEnv({
    GEV_BRIDGE_MILITARY: '1',
    GEV_COLLECTOR_TIMEOUT_MS: '500',
    GEV_STALE_GREY_MS: '120000',
  });
  assert.deepEqual(c, {
    feeds: ['military'],
    urls: ['http://127.0.0.1:4180'],
    timeoutMs: 500,
    greyMs: 120_000,
  });
  const d = bridgeConfigFromEnv({
    GEV_COLLECTOR_TIMEOUT_MS: '0',
    GEV_STALE_GREY_MS: '-5',
  });
  assert.equal(d.timeoutMs, 2_000);
  assert.equal(d.greyMs, 3_600_000);
});

// ---- review: a paused collector's empty 200 must not shadow the ES fallback ----

const FLIGHTS_VIEW = '-100,29,-95,33';
const FLIGHTS_GOOD =
  '{"time":1000,"states":[["a1b2c3",-97.5,30.2,1,null,0,0,0,false,0,null,0,null,null,null,"1200",false,0,null]]}';
const FLIGHTS_EMPTY_PAUSED = '{"time":1000,"states":[]}';
const FLIGHTS_ES =
  '{"time":900,"states":[["def456",-96,30.5,0,null,0,0,0,false,0,null,0,null,null,null,"1200",false,0,null]]}';

/** A flights feed bridge with a fake collector and an injected ES reader. */
function flightsBridge({
  fetchImpl,
  esRead = async () => null,
  startAt = T0 + 1_000,
} = {}) {
  let now = startAt;
  const handler = createCollectorBridge({
    name: 'flights',
    urls: ['http://s4:4180'],
    fetchImpl,
    now: () => now,
    log: () => {},
    esFallback: { read: esRead },
  });
  return { handler, advance: (ms) => (now += ms) };
}

const pausedEmpty = () =>
  new Response(FLIGHTS_EMPTY_PAUSED, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'X-Feed-Source': 'OpenSky Network',
      'X-Feed-Cache': 'STALE',
      'X-Feed-Stale-Since': String(T0 - 10_000),
      'X-Feed-Reason': 'opensky_paused_until=01:23',
      'X-Flight-Coverage': 'OpenSky viewport tiles (0)',
    },
  });

const flightsGood = () =>
  new Response(FLIGHTS_GOOD, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'X-Feed-Source': 'OpenSky Network',
      'X-Feed-Cache': 'HIT',
      'X-Feed-Age-Ms': '1000',
      'X-Feed-Last-OK': String(T0),
    },
  });

function flightsCollector(state) {
  return () => {
    if (state.phase === 'good') return flightsGood();
    if (state.phase === 'paused') return pausedEmpty();
    return new Error('down');
  };
}

const flightsUrl = (tab) => `/?view=${FLIGHTS_VIEW}&vsid=${tab}`;

test('paused collector 200 (empty states): the ES fallback answers, the paused reason is preserved, last-ok is clamped, and the empty body is not served', async () => {
  const { fetchImpl, calls } = fakeCollectors(
    flightsCollector({ phase: 'paused' }),
  );
  const esReads = [];
  const { handler } = flightsBridge({
    fetchImpl,
    esRead: async (url) => {
      esReads.push(String(url));
      return {
        body: FLIGHTS_ES,
        // future timestamp: the bridge must not report a future last-ok
        lastOkAt: T0 + 5_000_000,
        coverage: 'recorded history ES fallback (15 min)',
        truncated: false,
      };
    },
  });
  const res = await call(handler, flightsUrl('tab-paused1'));
  assert.equal(res.statusCode, 200);
  assert.ok(esReads.length >= 1, 'the ES reader was asked');
  assert.equal(text(res.body), FLIGHTS_ES);
  assert.equal(res.headers['x-feed-bridge'], 'es-fallback');
  assert.equal(
    res.headers['x-feed-reason'],
    'opensky_paused_until=01:23',
    'the actual paused reason is shown',
  );
  assert.equal(
    res.headers['x-feed-last-ok'],
    String(T0 + 1_000),
    'last-ok is clamped to the server clock',
  );
  assert.equal(
    res.headers['x-feed-stale-since'],
    String(T0 + 1_000),
    'stale-since is clamped with it',
  );
  assert.equal(
    res.headers['x-flight-coverage'],
    'recorded history ES fallback (15 min)',
  );
  assert.ok(
    Number(res.headers['x-feed-grey-until']) >
      Number(res.headers['x-feed-stale-since']),
  );
});

// ---- fix t_9e0ff678: paused empty is never cached; a useful per-view copy
// marked STALE with the paused reason wins, then ES, else the paused 200
// unchanged ----

test('paused 200 empty, useful per-view copy exists, ES unavailable: the cached copy is served STALE with the paused reason', async () => {
  const state = { phase: 'good' };
  const { fetchImpl } = fakeCollectors(flightsCollector(state));
  const esReads = [];
  const { handler, advance } = flightsBridge({
    fetchImpl,
    esRead: async (url) => {
      esReads.push(String(url));
      throw new Error('es down');
    },
  });
  const good = await call(handler, flightsUrl('tab-paused2'));
  assert.equal(good.statusCode, 200);
  assert.equal(text(good.body), FLIGHTS_GOOD, 'the good copy primes the view');
  advance(1_000);

  state.phase = 'paused';
  const paused = await call(handler, flightsUrl('tab-paused2'));
  assert.equal(paused.statusCode, 200);
  assert.equal(
    text(paused.body),
    FLIGHTS_GOOD,
    'the useful cached copy is served, not the empty paused envelope',
  );
  assert.equal(paused.headers['x-feed-bridge'], 'cache');
  assert.equal(
    paused.headers['x-feed-cache'],
    'STALE',
    'the degraded layer is marked STALE even on a fresh copy',
  );
  assert.equal(
    paused.headers['x-feed-reason'],
    'opensky_paused_until=01:23',
    'the paused reason is preserved',
  );
  assert.equal(
    paused.headers['x-feed-stale-since'],
    String(T0 + 2_000),
    'stale-since never points into the future (a fresh copy clamps to the clock)',
  );
  assert.ok(
    Number(paused.headers['x-feed-grey-until']) >
      Number(paused.headers['x-feed-stale-since']),
  );
  assert.equal(esReads.length, 0, 'ES is not asked when a useful copy exists');
  advance(1_000);

  state.phase = 'down';
  advance(200_000);
  const down = await call(handler, flightsUrl('tab-paused2'));
  assert.equal(down.statusCode, 200);
  assert.equal(
    text(down.body),
    FLIGHTS_GOOD,
    'the last-good copy is still the GOOD body',
  );
  assert.equal(down.headers['x-feed-reason'], 'collector_down');
});

test('paused 200 empty with no useful copy (paused->down then ES): the paused empty body is never cached, ES answers afterwards', async () => {
  const state = { phase: 'paused' };
  let esPhase = 'down';
  const { fetchImpl } = fakeCollectors(flightsCollector(state));
  const { handler, advance } = flightsBridge({
    fetchImpl,
    esRead: async () => {
      if (esPhase === 'down') throw new Error('es down');
      return {
        body: FLIGHTS_ES,
        lastOkAt: T0,
        coverage: 'recorded history ES fallback (15 min)',
        truncated: false,
      };
    },
  });
  const paused = await call(handler, flightsUrl('tab-paused4'));
  assert.equal(paused.statusCode, 200);
  assert.equal(
    text(paused.body),
    FLIGHTS_EMPTY_PAUSED,
    'the paused 200 itself is relayed when there is neither a copy nor ES',
  );
  assert.equal(paused.headers['x-feed-bridge'], 'collector');
  advance(1_000);

  state.phase = 'down';
  esPhase = 'up';
  advance(200_000);
  const down = await call(handler, flightsUrl('tab-paused4'));
  assert.equal(down.statusCode, 200);
  assert.equal(
    text(down.body),
    FLIGHTS_ES,
    'the ES fallback answers once the collector is down: the paused empty body was never cached',
  );
  assert.equal(down.headers['x-feed-bridge'], 'es-fallback');
  assert.equal(down.headers['x-feed-cache'], 'STALE');
  assert.equal(
    down.headers['x-feed-last-ok'],
    String(T0),
    'the ES answer never advertises a future last-ok',
  );
});

test('no false live: a paused empty body is never served from the cache as HIT after the collector stops', async () => {
  const state = { phase: 'paused' };
  const { fetchImpl } = fakeCollectors(flightsCollector(state));
  const { handler, advance } = flightsBridge({
    fetchImpl,
    esRead: async () => {
      throw new Error('es down');
    },
  });
  const paused = await call(handler, flightsUrl('tab-paused5'));
  assert.equal(paused.statusCode, 200);
  advance(1_000);

  state.phase = 'down';
  advance(200_000);
  const down = await call(handler, flightsUrl('tab-paused5'));
  assert.equal(down.statusCode, 503, 'no snapshot: the empty envelope is not data');
  assert.notEqual(text(down.body), FLIGHTS_EMPTY_PAUSED);
  assert.equal(down.headers['x-feed-bridge'], 'none');
  assert.equal(down.headers['x-feed-reason'], 'collector_down');
});

// ---- review: a paused collector's empty 200 must not shadow the ES fallback ----

test('a paused 200 WITH states is a real snapshot: relayed and cached as before', async () => {
  const pausedWithStates = () =>
    new Response(FLIGHTS_GOOD, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Feed-Source': 'OpenSky Network',
        'X-Feed-Cache': 'STALE',
        'X-Feed-Stale-Since': String(T0 - 10_000),
        'X-Feed-Reason': 'opensky_paused_until=01:23',
        'X-Feed-Last-OK': String(T0),
        'X-Feed-Age-Ms': '1000',
      },
    });
  const { fetchImpl } = fakeCollectors(pausedWithStates);
  const esReads = [];
  const { handler } = flightsBridge({
    fetchImpl,
    esRead: async (url) => {
      esReads.push(String(url));
      return null;
    },
  });
  const res = await call(handler, flightsUrl('tab-paused3'));
  assert.equal(res.statusCode, 200);
  assert.equal(esReads.length, 0, 'a real snapshot is served, ES not asked');
  assert.equal(text(res.body), FLIGHTS_GOOD);
  assert.equal(res.headers['x-feed-bridge'], 'collector');
  assert.equal(
    res.headers['x-feed-reason'],
    'opensky_paused_until=01:23',
  );
});
