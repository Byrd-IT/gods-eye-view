import assert from 'node:assert/strict';
import test from 'node:test';
import { createUsgsEarthquakeSource } from './source.js';

const geojson = () => ({
  type: 'FeatureCollection',
  features: [
    {
      id: 'us7000x',
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [30, 20, 3] },
      properties: { mag: 3, place: 'Fixture', time: 1000 },
    },
  ],
});

const reply = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

const failing = (init = {}, body = { error: 'es_live_unavailable' }) =>
  new Response(JSON.stringify(body), {
    status: 503,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

test('a fresh answer is not marked stale', async () => {
  const source = createUsgsEarthquakeSource({
    fetchImpl: async () => reply(geojson()),
  });
  await assert.doesNotReject(source.getSnapshot());
  const detail = await source.getSnapshotDetail();
  assert.equal(detail.stale, false);
  assert.equal(detail.retryAfterSec, null);
  assert.equal(detail.rows.length, 1);
});

test('the ES-copy stale marker reaches the snapshot detail', async () => {
  const source = createUsgsEarthquakeSource({
    fetchImpl: async () =>
      reply(geojson(), { headers: { 'X-Data-Stale': 'true', 'Retry-After': '75' } }),
  });
  const detail = await source.getSnapshotDetail();
  assert.equal(detail.stale, true);
  assert.equal(detail.retryAfterSec, 75);
  assert.equal(detail.rows.length, 1);
});

test('an ES-live outage is reported neutrally, not as a USGS fault', async () => {
  const source = createUsgsEarthquakeSource({
    fetchImpl: async () => failing(),
  });
  await assert.rejects(source.getSnapshot(), (error) => {
    assert.match(error.message, /unavailable/i);
    assert.doesNotMatch(error.message, /USGS/i);
    return true;
  });
});

test('a 503 that names itself elasticsearch is also neutral', async () => {
  const source = createUsgsEarthquakeSource({
    fetchImpl: async () =>
      failing(
        { headers: { 'X-Feed-Source': 'elasticsearch' } },
        { error: 'anything' },
      ),
  });
  await assert.rejects(source.getSnapshot(), (error) => {
    assert.doesNotMatch(error.message, /USGS/i);
    return true;
  });
});

test('a plain redirected same-origin 404 reported by the bridge stays neutral', async () => {
  // A redirected /api/es-live/* 404 returned with no marker at all: the
  // failure is ours, not USGS's.
  const response = new Response('not found', {
    status: 404,
    headers: { 'content-type': 'text/plain' },
  });
  Object.defineProperty(response, 'url', {
    value: 'https://grid.example/api/es-live/earthquakes',
  });
  const source = createUsgsEarthquakeSource({ fetchImpl: async () => response });
  await assert.rejects(source.getSnapshot(), (error) => {
    assert.match(error.message, /unavailable/i);
    assert.doesNotMatch(error.message, /USGS/i);
    return true;
  });
});

test('a 404 from the provider itself still names the provider', async () => {
  const response = new Response('not found', { status: 404 });
  Object.defineProperty(response, 'url', {
    value: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson',
  });
  const source = createUsgsEarthquakeSource({ fetchImpl: async () => response });
  await assert.rejects(source.getSnapshot(), /USGS HTTP 404/);
});

test('a provider fault of its own still names the provider', async () => {
  const source = createUsgsEarthquakeSource({
    fetchImpl: async () => failing({}, { error: 'upstream' }),
  });
  await assert.rejects(source.getSnapshot(), /USGS HTTP 503/);
});

test('error classification caps oversized error bodies', async () => {
  const huge = JSON.stringify({ error: 'es_live_unavailable', padding: 'x'.repeat(70000) });
  const response = new Response(huge, { status: 503, headers: { 'content-length': String(huge.length) } });
  const source = createUsgsEarthquakeSource({ fetchImpl: async () => response });
  await assert.rejects(source.getSnapshot(), /USGS HTTP 503/);
});

test('error classification stops a chunked oversized response', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(40_000)); },
    cancel() { cancelled = true; },
  });
  const source = createUsgsEarthquakeSource({ fetchImpl: async () => new Response(stream, { status: 503 }) });
  await assert.rejects(source.getSnapshot(), /USGS HTTP 503/);
  assert.equal(cancelled, true);
});
