import test from 'node:test';
import assert from 'node:assert/strict';
import {
  basemapFlagOn,
  loadBasemapConfig,
  normalizeBasemapConfig,
  DEFAULT_SWITCH,
  BASEMAP_CONFIG_URL,
} from './config.js';
import { SERVED } from './fixtures/config.mjs';

const metaDoc = (content) => ({
  querySelector: (selector) =>
    selector === 'meta[name="gev-basemap"]' && content !== null
      ? { getAttribute: (name) => (name === 'content' ? content : null) }
      : null,
});

test('the flag is the server-rendered meta tag; absent means OFF', () => {
  assert.equal(basemapFlagOn(metaDoc('1')), true);
  assert.equal(basemapFlagOn(metaDoc('0')), false);
  assert.equal(basemapFlagOn(metaDoc(null)), false);
  assert.equal(basemapFlagOn(undefined), false);
  assert.equal(
    basemapFlagOn({
      querySelector() {
        throw new Error('no DOM');
      },
    }),
    false,
  );
});

test('a served config normalizes to the stack shape', () => {
  const config = normalizeBasemapConfig(SERVED);
  assert.equal(config.available, true);
  assert.equal(config.unavailableReason, null);
  assert.equal(config.terrain.url, SERVED.terrain.url);
  assert.equal(config.terrain.waterMask, true);
  assert.equal(config.imagery.url, SERVED.imagery.url);
  assert.equal(config.imagery.baseMaxzoom, 8);
  assert.equal(config.imagery.maxzoom, 14);
  assert.equal(config.imagery.year, 2025);
  assert.equal(config.imagery.regions.length, 2);
  assert.deepEqual(config.switch, {
    auto: true,
    enterM: 5000,
    leaveM: 8000,
    dwellMs: 5000,
    reRootAgeMs: DEFAULT_SWITCH.reRootAgeMs,
    rootAttemptsPerHour: 3,
  });
  assert.equal(DEFAULT_SWITCH.reRootAgeMs, 9_000_000);
});

test('only same-origin /basemap/ paths are accepted', () => {
  for (const url of [
    'https://evil.example/basemap/x/{z}/{x}/{y}.webp',
    '//evil.example/{z}/{x}/{y}',
    '/api/ion/{z}/{x}/{y}',
    '/basemap/../api/{z}/{x}/{y}',
    '/basemap/imagery/a/{z}/{x}/{y}.webp?key=abc',
  ]) {
    const config = normalizeBasemapConfig({
      ...SERVED,
      imagery: { ...SERVED.imagery, url },
    });
    assert.equal(config.imagery.available, false, url);
    assert.equal(config.available, false, url);
    assert.match(config.unavailableReason, /imagery/);
  }
  const terrain = normalizeBasemapConfig({
    ...SERVED,
    terrain: { ...SERVED.terrain, url: 'http://127.0.0.1:12350/v/x' },
  });
  assert.equal(terrain.available, false);
  assert.match(terrain.unavailableReason, /terrain/);
});

test('bad regions are dropped; bad switch values fall back to the defaults', () => {
  const config = normalizeBasemapConfig({
    ...SERVED,
    imagery: {
      ...SERVED.imagery,
      regions: [
        { bounds: [10, 10, 5, 20], maxzoom: 14 },
        { bounds: [0, 0, 1], maxzoom: 14 },
        { bounds: [0, 0, 1, 1], maxzoom: 99 },
        { bounds: [0, 0, 1, 1], maxzoom: 12 },
      ],
    },
    switch: { enterM: -1, leaveM: 'x', dwellMs: 0, auto: false },
  });
  assert.deepEqual(config.imagery.regions, [
    { bounds: [0, 0, 1, 1], maxzoom: 12 },
  ]);
  assert.equal(config.switch.enterM, 5000);
  assert.equal(config.switch.leaveM, 8000);
  assert.equal(config.switch.dwellMs, 5000);
  assert.equal(config.switch.auto, false);
  const inverted = normalizeBasemapConfig({
    ...SERVED,
    switch: { enterM: 9000, leaveM: 3000 },
  });
  assert.ok(inverted.switch.leaveM > inverted.switch.enterM);
});

test('missing or partial configs are unavailable, never half-used', () => {
  assert.equal(normalizeBasemapConfig(null).available, false);
  const down = normalizeBasemapConfig({
    ...SERVED,
    imagery: { ...SERVED.imagery, available: false },
  });
  assert.equal(down.available, false);
  assert.equal(
    down.unavailableReason,
    'Byrd-IT Open map service is unavailable (imagery)',
  );
});

test('loadBasemapConfig fetches the same-origin config once', async () => {
  const calls = [];
  const config = await loadBasemapConfig({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => SERVED };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, BASEMAP_CONFIG_URL);
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(config.available, true);
});

test('service down: loadBasemapConfig reports unavailable instead of throwing', async () => {
  const http = await loadBasemapConfig({
    fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({}) }),
  });
  assert.equal(http.available, false);
  assert.equal(
    http.unavailableReason,
    'Byrd-IT Open map service is unavailable (HTTP 502)',
  );
  const network = await loadBasemapConfig({
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  assert.equal(network.available, false);
  assert.match(network.unavailableReason, /fetch failed/);
});

test('an aborted scene construction still aborts', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    loadBasemapConfig({
      signal: controller.signal,
      fetchImpl: async () => {
        throw new Error('aborted');
      },
    }),
  );
});
