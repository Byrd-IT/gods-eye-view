import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLayerChips,
  LIVE_CHIP,
  LIVE_CHIP_UNAVAILABLE,
  UNSWAPPED_STATE,
} from './layerChips.js';
import { createFeedChips } from './feedChips.js';
import { createHistoryRouter } from './historyRouter.js';
import { mountHistoryControl } from './historyControl.js';
import { mountHistoryForShell } from './historyShell.js';
import { fixtureFetch, fixtureWorld } from './fixtures/b11Coverage.mjs';
import {
  fakeClock,
  fakeDocument,
  fakeWindow,
  flush,
  jsonResponse,
} from './fakeDom.mjs';

const NOW = Date.parse('2026-10-14T16:00:00Z');
const T = NOW - 3 * 3_600_000;

const LAYERS = [
  { id: 'flights', name: 'Live Flights' },
  { id: 'military', name: 'Military Flights' },
  { id: 'ais-live-vessels', name: 'Live AIS Vessels' },
  { id: 'earthquakes', name: 'Earthquakes' },
  { id: 'weather-cyclones', name: 'Tropical Cyclones' },
  { id: 'wind', name: 'Wind' },
  { id: 'satellites', name: 'Satellites' },
];

function manager(enabled) {
  const listeners = new Set();
  const m = {
    enabled: new Set(enabled),
    getAll: () => LAYERS,
    getEnabledLayerIds: () => new Set(m.enabled),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    set(ids) {
      m.enabled = new Set(ids);
      for (const fn of [...listeners]) fn({ type: 'enabled' });
    },
    refreshLayer: async () => true,
  };
  return m;
}

function setup(enabled = ['flights', 'earthquakes', 'wind', 'military']) {
  const win = fakeWindow('https://gev.example/', async (input) => {
    const url = new URL(String(input), 'https://gev.example');
    if (url.pathname === '/api/history/slice')
      return url.searchParams.get('feed') === 'military'
        ? jsonResponse({}, { status: 503 })
        : jsonResponse({ time: 1, states: [] });
    return jsonResponse({ ok: true });
  });
  const router = createHistoryRouter({ target: win });
  const dm = manager(enabled);
  const chips = createLayerChips({
    feedChips: createFeedChips({ target: win, monotonic: () => 0 }),
    getRouter: () => router,
    getDataManager: () => dm,
  });
  chips.install();
  router.install();
  return { win, router, dm, chips };
}

const live = (list) =>
  list
    .filter((c) => c.state === UNSWAPPED_STATE)
    .map((c) => [c.layerId, c.chip]);

test('D5: enabled non-history layers get a LIVE chip, swapped ones do not; LIVE removes them', () => {
  const { router, chips } = setup();
  assert.deepEqual(live(chips.states()), [], 'no chips while live');
  router.setHistory({ active: true, timeMs: T });
  assert.deepEqual(live(chips.states()), [
    ['earthquakes', LIVE_CHIP],
    ['wind', LIVE_CHIP],
  ]);
  const quake = chips.states().find((c) => c.layerId === 'earthquakes');
  assert.equal(quake.label, 'Earthquakes');
  assert.equal(quake.draw, true);
  router.setHistory({ active: false });
  assert.deepEqual(live(chips.states()), []);
});

test('D5: enabled set changes are followed (data manager subscribe)', () => {
  const { router, chips, dm } = setup(['flights']);
  const seen = [];
  chips.subscribe((list) => seen.push(live(list).map(([id]) => id)));
  router.setHistory({ active: true, timeMs: T });
  chips.refresh();
  assert.deepEqual(seen.at(-1), []);
  dm.set(['flights', 'satellites']); // not swapped (satellites: B12d)
  assert.deepEqual(seen.at(-1), ['satellites']);
  dm.set(['ais-live-vessels']);
  assert.deepEqual(seen.at(-1), []);
});

test('D3 + D5: a feed whose history failed passes through to live and gets a LIVE (history unavailable) chip', async () => {
  const { router, chips, win } = setup(['flights', 'military']);
  await win.fetch('/api/military'); // live: no bridge headers here
  router.setHistory({ active: true, timeMs: T });
  assert.deepEqual(live(chips.states()), []);
  await win.fetch('/api/military'); // slice 503 -> pass-through
  assert.deepEqual(live(chips.states()), [['military', LIVE_CHIP_UNAVAILABLE]]);
});

test('in history a green live feed chip is replaced by the layer LIVE chip (no duplicate)', async () => {
  const win = fakeWindow('https://gev.example/', async () =>
    jsonResponse(
      {},
      {
        headers: {
          'X-Feed-Last-OK': String(NOW - 5_000),
          'X-Feed-Age-Ms': '5000',
          'X-Feed-Cache': 'HIT',
        },
      },
    ),
  );
  const router = createHistoryRouter({ target: win });
  const dm = manager(['satellites']);
  const chips = createLayerChips({
    feedChips: createFeedChips({ target: win, monotonic: () => 0 }),
    getRouter: () => router,
    getDataManager: () => dm,
  });
  chips.install();
  router.install();
  chips.connect();
  await win.fetch('/api/celestrak/active');
  await flush();
  assert.deepEqual(
    chips.states().map((c) => [c.feed, c.state]),
    [['satellites', 'live']],
  );
  router.setHistory({ active: true, timeMs: T });
  assert.deepEqual(
    chips.states().map((c) => [c.feed, c.state]),
    [['layer:satellites', UNSWAPPED_STATE]],
  );
});

test('in history the live staleness chip of a swapped feed is dropped; others stay', async () => {
  const win = fakeWindow('https://gev.example/', async (input) => {
    const path = new URL(String(input), 'https://gev.example').pathname;
    return jsonResponse(
      {},
      {
        headers: {
          'X-Feed-Last-OK': String(NOW - 2 * 3_600_000),
          'X-Feed-Age-Ms': String(2 * 3_600_000),
          'X-Feed-Cache': 'STALE',
          'X-Feed-Stale-Since': String(NOW - 2 * 3_600_000),
          'X-Feed-Grey-Until': String(NOW + 3_600_000),
          'X-Path': path,
        },
      },
    );
  });
  const router = createHistoryRouter({ target: win });
  const dm = manager(['flights', 'satellites']);
  const chips = createLayerChips({
    feedChips: createFeedChips({ target: win, monotonic: () => 0 }),
    getRouter: () => router,
    getDataManager: () => dm,
  });
  chips.install();
  router.install();
  await win.fetch('/api/flights');
  await win.fetch('/api/celestrak/active');
  await flush();
  assert.deepEqual(
    chips.states().map((c) => [c.feed, c.state]),
    [
      ['flights', 'grey'],
      ['satellites', 'grey'],
    ],
  );
  router.setHistory({ active: true, timeMs: T });
  // flights is swapped: its live grey chip is not about what it shows now
  assert.deepEqual(
    chips.states().map((c) => [c.feed, c.state]),
    [
      ['satellites', 'grey'],
      ['layer:satellites', UNSWAPPED_STATE],
    ],
  );
});

test('the control renders the LIVE chips, visible even collapsed, and clears them on LIVE', async () => {
  const clock = fakeClock(NOW);
  const world = fixtureWorld(NOW);
  const doc = fakeDocument();
  const win = fakeWindow('https://gev.example/', fixtureFetch(world));
  const dm = manager(['flights', 'earthquakes']);
  let router = null;
  const chips = createLayerChips({
    feedChips: createFeedChips({ target: win, monotonic: clock.monotonic }),
    getRouter: () => router,
    getDataManager: () => dm,
  });
  const control = mountHistoryControl({
    document: doc,
    window: win,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    chips,
  });
  router = createHistoryRouter({
    target: win,
    now: clock.now,
    timers: clock.timers,
  });
  router.install();
  chips.connect();
  control.subscribe((d) => router.setHistory(d));
  const chipTexts = () =>
    control.root
      .findAll((n) => n.className?.includes?.('gev-hist-chip '))
      .map((n) => [n.getAttribute('data-state'), n.textContent]);
  assert.deepEqual(chipTexts(), []);
  control.seek(T);
  await flush();
  assert.equal(control.getState().expanded, false);
  assert.deepEqual(chipTexts(), [[UNSWAPPED_STATE, 'Earthquakes: LIVE']]);
  control.leave();
  await flush();
  assert.deepEqual(chipTexts(), []);
  control.destroy();
});

test('mountHistoryForShell wires router + chips + driver: a seek refreshes the swapped layers and LIVE restores', async () => {
  const world = fixtureWorld(Date.now());
  const fixture = fixtureFetch(world);
  const asked = [];
  const doc = fakeDocument();
  const win = fakeWindow('https://gev.example/', async (input, init) => {
    const url = new URL(String(input), 'https://gev.example');
    asked.push(url.pathname);
    if (url.pathname === '/api/history/slice')
      return jsonResponse({
        ac: [],
        now: Date.parse(url.searchParams.get('t')),
      });
    if (url.pathname.startsWith('/api/history/')) return fixture(input, init);
    return jsonResponse({ ac: [], now: Date.now() });
  });
  const dm = manager(['military', 'earthquakes']);
  dm.refreshLayer = async (id) => {
    if (id === 'military') await win.fetch('/api/military');
    return true;
  };
  const removers = new Set();
  const shell = { _dataManager: dm, _lifetime: { removers } };
  const handle = mountHistoryForShell(shell, { window: win, document: doc });
  try {
    assert.equal(removers.size, 1);
    assert.ok(handle.router && handle.driver);
    handle.seek(Date.now() - 2 * 3_600_000);
    await new Promise((r) => setTimeout(r, 400));
    await handle.driver.settle();
    assert.ok(asked.includes('/api/history/slice'));
    assert.ok(handle.router.isSwapped('military'));
    const chip = handle.root.find(
      (n) => n.getAttribute?.('data-feed') === 'layer:earthquakes',
    );
    assert.ok(chip, 'earthquakes LIVE chip');
    asked.length = 0;
    handle.leave();
    await handle.driver.settle();
    assert.ok(asked.includes('/api/military'), 'LIVE refresh asks live');
    assert.equal(asked.includes('/api/history/slice'), false);
  } finally {
    for (const fn of removers) fn();
  }
  assert.equal(handle.destroyed, true);
  assert.equal(win.__gevHistorySwap, undefined);
});
