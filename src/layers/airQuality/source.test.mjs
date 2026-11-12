import assert from 'node:assert/strict';
import test from 'node:test';
import { createEcccAirQualitySource } from './source.js';

const NOW = Date.parse('2026-09-24T18:30:00Z');
const HOUR = 60 * 60 * 1000;
const station = (id) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [-79.38, 43.65] },
  properties: { location_id: id, location_name_en: id },
});
const observation = (id, at = NOW, aqhi = 3) => ({
  type: 'Feature',
  properties: {
    location_id: id,
    aqhi,
    observation_datetime: new Date(at - 10 * 60_000).toISOString(),
  },
});
const json = (body, init) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    ...init,
  });

/** A fetch that serves the station catalog and observations from mutable state. */
function feed() {
  const state = {
    clock: NOW,
    stations: [station('A')],
    stationIds: null,
    urls: [],
  };
  state.source = createEcccAirQualitySource({
    now: () => state.clock,
    fetchImpl: async (url) => {
      state.urls.push(url);
      return json({
        type: 'FeatureCollection',
        // Every known station reports ten minutes before the current clock.
        features: url.includes('aqhi-stations')
          ? state.stations
          : (state.stationIds || ['A']).map((id) =>
              observation(id, state.clock),
            ),
      });
    },
  });
  state.stationRequests = () =>
    state.urls.filter((url) => url.includes('aqhi-stations')).length;
  return state;
}

test('the station catalog is cached for twelve hours, then refetched', async () => {
  const state = feed();
  await state.source.getSnapshot();
  state.clock = NOW + 12 * HOUR;
  await state.source.getSnapshot();
  assert.equal(state.stationRequests(), 1, 'within the TTL the cache serves');
  state.clock = NOW + 12 * HOUR + 1;
  await state.source.getSnapshot();
  assert.equal(
    state.stationRequests(),
    2,
    'past the TTL the catalog refreshes',
  );
});

test('an empty catalog refresh keeps the previous catalog', async () => {
  const state = feed();
  await state.source.getSnapshot();
  state.stations = [];
  state.clock = NOW + 13 * HOUR;
  const readings = await state.source.getSnapshot();
  assert.deepEqual(
    readings.map((reading) => reading.stationId),
    ['A'],
  );
  // The empty refresh did not count as fresh, so the next call retries it.
  await state.source.getSnapshot();
  assert.equal(state.stationRequests(), 3);
});

test('an empty first catalog is an error, not an empty layer', async () => {
  const state = feed();
  state.stations = [];
  await assert.rejects(state.source.getSnapshot(), /No AQHI stations/);
});

test('requests ask for JSON, the latest observations only, and a bounded page', async () => {
  const state = feed();
  await state.source.getSnapshot();
  const [stations, observations] = state.urls.map((url) => new URL(url));
  assert.equal(stations.pathname, '/collections/aqhi-stations/items');
  assert.equal(stations.searchParams.get('f'), 'json');
  assert.equal(stations.searchParams.get('limit'), '500');
  assert.equal(
    observations.pathname,
    '/collections/aqhi-observations-realtime/items',
  );
  // Without latest=true the collection returns the full history (~2,000 rows).
  assert.equal(observations.searchParams.get('latest'), 'true');
  assert.equal(observations.searchParams.get('limit'), '500');
});

test('rows past the requested limit are ignored', async () => {
  const state = feed();
  state.stations = Array.from({ length: 600 }, (_, index) =>
    station(`S${String(index).padStart(3, '0')}`),
  );
  state.stationIds = state.stations.map((row) => row.properties.location_id);
  const readings = await state.source.getSnapshot();
  assert.equal(readings.length, 500);
});

test('a malformed catalog and HTTP errors reject', async () => {
  await assert.rejects(
    createEcccAirQualitySource({
      fetchImpl: async () => json({ features: 'no' }),
    }).getSnapshot(),
    /Malformed AQHI station/,
  );
  await assert.rejects(
    createEcccAirQualitySource({
      fetchImpl: async () => json({}, { status: 503 }),
    }).getSnapshot(),
    /ECCC HTTP 503/,
  );
});

test('an oversized response is refused before it is parsed', async () => {
  const big = 'x'.repeat(4 * 1024 * 1024 + 1);
  await assert.rejects(
    createEcccAirQualitySource({
      fetchImpl: async () =>
        new Response(new Blob([big]).stream(), {
          headers: { 'content-type': 'application/json' },
        }),
    }).getSnapshot(),
    (error) => error.code === 'RESPONSE_TOO_LARGE',
  );
  await assert.rejects(
    createEcccAirQualitySource({
      fetchImpl: async () =>
        json({}, { headers: { 'content-length': String(5 * 1024 * 1024) } }),
    }).getSnapshot(),
    (error) => error.code === 'RESPONSE_TOO_LARGE',
  );
});

test('a caller abort cancels the request and detaches its listener', async () => {
  const caller = new AbortController();
  let requestSignal = null;
  const source = createEcccAirQualitySource({
    fetchImpl: (_url, { signal }) => {
      requestSignal = signal;
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  });
  const pending = source.getSnapshot({ signal: caller.signal });
  caller.abort(new Error('layer disabled'));
  await assert.rejects(pending, /layer disabled/);
  assert.equal(requestSignal.aborted, true);
  const already = new AbortController();
  already.abort(new Error('before start'));
  let calls = 0;
  await assert.rejects(
    createEcccAirQualitySource({
      fetchImpl: async () => {
        calls += 1;
        return json({ features: [] });
      },
    }).getSnapshot({ signal: already.signal }),
    /before start/,
  );
  assert.equal(calls, 0);
});

test('a request that outlives its deadline is aborted', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = createEcccAirQualitySource({
    timeoutMs: 1_000,
    fetchImpl: (_url, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      ),
  });
  const pending = source.getSnapshot();
  t.mock.timers.tick(1_000);
  await assert.rejects(pending, /ECCC request timed out/);
});

// t_a1a1cca6 item 1: the ES-live bridge answers AQHI from our Elasticsearch
// copy; its stale marker and its errors must look neutral to the layer.

const esLiveSource = (overrides = {}, body = null) =>
  createEcccAirQualitySource({
    // Fixed clock: the fixtures carry NOW-anchored observation times.
    now: () => NOW,
    fetchImpl: async (url) =>
      json(
        body ?? {
          type: 'FeatureCollection',
          features: url.includes('aqhi-stations')
            ? [station('A')]
            : [observation('A', NOW - 60_000)],
        },
        overrides,
      ),
  });

test('a stale ES-copy answer reaches the snapshot detail', async () => {
  const source = esLiveSource({
    headers: { 'X-Data-Stale': 'true', 'Retry-After': '75' },
  });
  await assert.doesNotReject(source.getSnapshot());
  const detail = await source.getSnapshotDetail();
  assert.equal(detail.stale, true);
  assert.equal(detail.retryAfterSec, 75);
  assert.equal(detail.readings.length, 1);
});

test('a fresh ES-copy answer is not marked stale', async () => {
  const source = esLiveSource();
  const detail = await source.getSnapshotDetail();
  assert.equal(detail.stale, false);
  assert.equal(detail.retryAfterSec, null);
});

test('an ES-live outage is reported neutrally, not as an ECCC fault', async () => {
  const source = esLiveSource(
    { status: 503 },
    { error: 'es_live_unavailable' },
  );
  await assert.rejects(source.getSnapshot(), (error) => {
    assert.match(error.message, /unavailable/i);
    assert.doesNotMatch(error.message, /ECCC/i);
    return true;
  });
});

test('a 503 that names itself elasticsearch is also neutral', async () => {
  const source = esLiveSource(
    { status: 503, headers: { 'X-Feed-Source': 'elasticsearch' } },
    { error: 'not_ours' },
  );
  // Only the header carries the marker; the error body names something else.
  await assert.rejects(source.getSnapshot(), (error) => {
    assert.doesNotMatch(error.message, /ECCC/i);
    return true;
  });
});

test('a plain redirected same-origin 404 reported by the bridge stays neutral', async () => {
  // A redirected /api/es-live/* 404 returned with no marker at all: the
  // failure is ours, not ECCC's.
  const response = new Response('not found', { status: 404 });
  Object.defineProperty(response, 'url', {
    value: 'https://grid.example/api/es-live/aqhi-stations',
  });
  const source = createEcccAirQualitySource({
    now: () => NOW,
    fetchImpl: async () => response,
  });
  await assert.rejects(source.getSnapshot(), (error) => {
    assert.match(error.message, /unavailable/i);
    assert.doesNotMatch(error.message, /ECCC/i);
    return true;
  });
});

test('a 404 from the provider itself still names the provider', async () => {
  const response = new Response('not found', { status: 404 });
  Object.defineProperty(response, 'url', {
    value: 'https://api.weather.gc.ca/collections/aqhi-stations/items',
  });
  const source = createEcccAirQualitySource({
    now: () => NOW,
    fetchImpl: async () => response,
  });
  await assert.rejects(source.getSnapshot(), /ECCC HTTP 404/);
});

// t_a1a1cca6 item 2: the station catalog can be served stale too. Its stale
// marker must reach the snapshot detail, and a cached catalog must keep its
// recorded freshness until a refresh actually replaces it.

/** A two-collection feed whose headers can be changed between requests. */
function staleableFeed() {
  const state = {
    clock: NOW,
    stationHeaders: {},
    observationHeaders: {},
    stations: [station('A')],
  };
  state.source = createEcccAirQualitySource({
    now: () => state.clock,
    fetchImpl: async (url) =>
      json(
        {
          type: 'FeatureCollection',
          features: url.includes('aqhi-stations')
            ? state.stations
            : [observation('A', state.clock)],
        },
        {
          headers: url.includes('aqhi-stations')
            ? state.stationHeaders
            : state.observationHeaders,
        },
      ),
  });
  return state;
}

test('a stale station refresh marks the snapshot stale', async () => {
  const state = staleableFeed();
  state.stationHeaders = { 'X-Data-Stale': 'true' };
  const detail = await state.source.getSnapshotDetail();
  assert.equal(detail.stale, true);
});

test('a stale catalog keeps the snapshot stale past the observation marker', async () => {
  const state = staleableFeed();
  state.stationHeaders = { 'X-Data-Stale': 'true' };
  assert.equal((await state.source.getSnapshotDetail()).stale, true);
  // The catalog is cached; its staleness must persist even though every
  // later observation answer is fresh, because the coordinates are aged.
  state.clock += HOUR;
  state.observationHeaders = { 'X-Data-Stale': 'false' };
  assert.equal(
    (await state.source.getSnapshotDetail()).stale,
    true,
    'the cached catalog was served stale and stays stale until replaced',
  );
  // Once the catalog actually refreshes fresh, the staleness clears.
  state.clock += 12 * HOUR;
  state.stationHeaders = {};
  assert.equal((await state.source.getSnapshotDetail()).stale, false);
});

test('an empty stale refresh keeps the cached catalog fresh', async () => {
  const state = staleableFeed();
  assert.equal((await state.source.getSnapshotDetail()).stale, false);
  // The refresh is stale but empty: nothing is adopted, so the cached
  // catalog keeps the freshness it was fetched with.
  state.stations = [];
  state.stationHeaders = { 'X-Data-Stale': 'true' };
  state.clock += 13 * HOUR;
  assert.equal((await state.source.getSnapshotDetail()).stale, false);
});

test('a stale station catalog plus stale observations is stale', async () => {
  const state = staleableFeed();
  state.stationHeaders = { 'X-Data-Stale': 'true' };
  state.observationHeaders = { 'X-Data-Stale': 'true' };
  assert.equal((await state.source.getSnapshotDetail()).stale, true);
});

test('a superseded station refresh cannot replace newer cached freshness', async () => {
  let resolveOld;
  let stationCalls = 0;
  const source = createEcccAirQualitySource({
    now: () => NOW,
    fetchImpl: async (url) => {
      if (url.includes('aqhi-stations')) {
        stationCalls++;
        if (stationCalls === 1) return new Promise((resolve) => { resolveOld = resolve; });
        return json({ type: 'FeatureCollection', features: [station('A')] });
      }
      return json({ type: 'FeatureCollection', features: [observation('A')] });
    },
  });
  const old = source.getSnapshotDetail();
  const fresh = await source.getSnapshotDetail();
  assert.equal(fresh.stale, false);
  resolveOld(json({ type: 'FeatureCollection', features: [station('A')] }, { headers: { 'X-Data-Stale': 'true' } }));
  await old;
  assert.equal((await source.getSnapshotDetail()).stale, false);
});

test('error classification does not consume oversized response bodies', async () => {
  let pulled = 0;
  const huge = JSON.stringify({ error: 'es_live_unavailable', padding: 'x'.repeat(70000) });
  const response = new Response(new ReadableStream({
    pull(controller) { pulled++; controller.enqueue(new TextEncoder().encode(huge)); controller.close(); },
  }), { status: 503, headers: { 'content-length': String(huge.length) } });
  const source = createEcccAirQualitySource({ fetchImpl: async () => response });
  await assert.rejects(source.getSnapshot(), /ECCC HTTP 503/);
  assert.ok(pulled <= 1);
});
