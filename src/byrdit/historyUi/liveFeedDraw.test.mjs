import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CLEARED_HEADER,
  CYCLONE_CLEARED_REASON,
  LIVE_DRAW_FEEDS,
  MODE_CLEARED,
  MODE_GREY,
  MODE_LIVE,
  answerDraws,
  clearedBody,
  createLiveFeedDraw,
  drawModeOf,
  feedOfLayer,
  layerOfFeed,
} from './liveFeedDraw.js';
import {
  BRIDGED_FEEDS,
  FEED_STATE_EVENT,
  createFeedChips,
} from './feedChips.js';
import { ALL_HISTORY_ADAPTERS } from './historyEventAdapters.js';
import { createHistoryRouter } from './historyRouter.js';
import { fakeWindow, flush, jsonResponse } from './fakeDom.mjs';
import {
  openSkySnapshot,
  readsbSnapshot,
} from '../../sources/live/aircraft.js';
import { vesselSnapshot } from '../../sources/live/vessels.js';
import { createFirmsSource } from '../../layers/firms/source.js';
import { createCycloneSource } from '../../layers/cyclones/source.js';
import { createLaunchSource } from '../../layers/launches/source.js';
import { createWfigsPerimeterSource } from '../../layers/perimeters/source.js';
import { createTransitSource } from '../../layers/transit/source.js';
import { createBikeshareSource } from '../../layers/bikeshare/source.js';
import { parseStationStatus } from '../../sources/gbfsStations.js';
import { GBFS_CITY_REGISTRY } from '../../layers/bikeshare/registry.js';

const ORIGIN = 'http://gev.test';
const LAST_OK = Date.parse('2026-10-16T12:00:00Z');
const STALE_SINCE = LAST_OK + 90_000;
const GREY_UNTIL = STALE_SINCE + 3_600_000;
const fixture = (name) =>
  readFileSync(new URL(`../history/fixtures/${name}`, import.meta.url), 'utf8');
const liveFirms = JSON.parse(fixture('b6-collector-firms.body'));
const liveCyclones = JSON.parse(fixture('b6-collector-cyclones.body'));
const liveLaunches = JSON.parse(fixture('b7-collector-launches.body'));

/** Bridge headers: live, grey (server now inside the hour) or cleared. */
function bridge(state) {
  if (state === 'live')
    return { 'X-Feed-Last-OK': String(LAST_OK), 'X-Feed-Age-Ms': '5000' };
  const serverNow = state === 'grey' ? GREY_UNTIL - 60_000 : GREY_UNTIL + 1;
  return {
    'X-Feed-Last-OK': String(LAST_OK),
    'X-Feed-Age-Ms': String(serverNow - LAST_OK),
    'X-Feed-Cache': 'STALE',
    'X-Feed-Stale-Since': String(STALE_SINCE),
    'X-Feed-Grey-Until': String(GREY_UNTIL),
    'X-Feed-Reason': 'collector_down',
    'X-Feed-Source': 'Collector',
  };
}

const flightsBody = {
  time: LAST_OK / 1000,
  states: [['a10001', 'TEST1', 'US', LAST_OK / 1000, LAST_OK / 1000, -97, 30]],
};

/** A browser fetch whose answers the test sets per path. */
function browser() {
  const answers = new Map();
  const calls = [];
  const fetchImpl = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url, ORIGIN);
    calls.push(url.pathname + url.search);
    const a = answers.get(url.pathname) ?? answers.get('*');
    if (!a) return jsonResponse({ error: 'none' }, { status: 404 });
    return jsonResponse(a.body, {
      status: a.status ?? 200,
      headers: a.headers,
    });
  };
  return { answers, calls, fetchImpl };
}

function manager(
  enabled = Object.values(LIVE_DRAW_FEEDS).map((f) => f.layerId),
) {
  const m = {
    refreshed: [],
    seams: [],
    enabled: new Set(enabled),
    getEnabledLayerIds: () => new Set(m.enabled),
    refreshLayer: async (id) => {
      m.refreshed.push(id);
      return true;
    },
    layers: new Map(),
  };
  for (const { layerId } of Object.values(LIVE_DRAW_FEEDS))
    m.layers.set(layerId, {
      module: {
        resetForHistoryFrame: () => m.seams.push(['reset', layerId]),
        reloadForHistoryFrame: () => m.seams.push(['reload', layerId]),
      },
    });
  return m;
}

/** window -> gate -> chips -> browser (the shell order without a router). */
function setup({ router = null, dm = manager() } = {}) {
  const b = browser();
  const win = fakeWindow(`${ORIGIN}/`, b.fetchImpl);
  const chips = createFeedChips({ target: win, timeZone: 'UTC' });
  chips.install();
  const gate = createLiveFeedDraw({
    target: win,
    getRouter: () => router,
    getDataManager: () => dm,
  });
  gate.install();
  return { b, win, chips, gate, dm };
}

const feedEvent = (detail) => ({ type: FEED_STATE_EVENT, detail });

test('every bridged feed has a layer, and the layer is the adapter layer', () => {
  assert.deepEqual(
    Object.keys(LIVE_DRAW_FEEDS).sort(),
    BRIDGED_FEEDS.map((f) => f.id).sort(),
  );
  // every BRIDGED history feed (B12d quakes / wind are not bridged: no
  // collector-bridge headers, so no feed state to draw from)
  const bridged = new Set(BRIDGED_FEEDS.map((f) => f.id));
  for (const a of ALL_HISTORY_ADAPTERS.filter((x) => bridged.has(x.id))) {
    assert.equal(layerOfFeed(a.id), a.layerId, a.id);
    assert.equal(feedOfLayer(a.layerId), a.id);
  }
  assert.equal(layerOfFeed('satellites'), 'satellites');
  assert.equal(layerOfFeed('quakes'), null);
});

test('state -> draw mode, the same for every feed (B11 event detail)', () => {
  const table = [
    [{ state: 'live', draw: true }, MODE_LIVE],
    [{ state: 'grey', draw: true }, MODE_GREY],
    [{ state: 'paused', draw: true }, MODE_GREY],
    [{ state: 'paused', draw: false }, MODE_CLEARED],
    [{ state: 'cleared', draw: false }, MODE_CLEARED],
    [{ state: 'none', draw: false }, MODE_CLEARED],
    [null, MODE_LIVE],
    [{}, MODE_LIVE],
  ];
  for (const feed of Object.keys(LIVE_DRAW_FEEDS))
    for (const [detail, mode] of table)
      assert.equal(
        drawModeOf(detail && { feed, ...detail }),
        mode,
        `${feed} ${JSON.stringify(detail)}`,
      );
});

test('an answer is judged on its server clock headers, never Date.now', () => {
  const real = Date.now;
  try {
    for (const wall of [0, LAST_OK, GREY_UNTIL + 365 * 86_400_000]) {
      Date.now = () => wall;
      const r = (s, status = 200) =>
        new Response('{}', { status, headers: bridge(s) });
      assert.equal(answerDraws(r('live')), true);
      assert.equal(answerDraws(r('grey')), true);
      assert.equal(answerDraws(r('cleared')), false);
      assert.equal(answerDraws(r('grey', 503)), false, '503 = none');
      assert.equal(answerDraws(new Response('{}')), true, 'not a bridge');
    }
    // and no wall clock is read at all on the decision path
    Date.now = () => {
      throw new Error('Date.now read');
    };
    assert.equal(
      answerDraws(new Response('{}', { headers: bridge('cleared') })),
      false,
    );
    assert.equal(drawModeOf({ state: 'grey', draw: true }), MODE_GREY);
  } finally {
    Date.now = real;
  }
  for (const file of ['liveFeedDraw.js', 'greyPainter.js']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/)/.test(l))
      .join('\n');
    assert.doesNotMatch(src, /Date\.now|performance\.now|new Date\(\)/, file);
  }
});

test('cleared: the live request gets the EMPTY live shape + the bridge headers', async () => {
  const { b, win, gate } = setup();
  b.answers.set('/api/flights', {
    body: flightsBody,
    headers: bridge('cleared'),
  });
  const r = await win.fetch('/api/flights?view=-98,29,-96,31');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get(CLEARED_HEADER), '1');
  assert.equal(r.headers.get('x-feed-cache'), 'STALE');
  assert.equal(r.headers.get('x-feed-stale-since'), String(STALE_SINCE));
  const body = await r.json();
  assert.deepEqual(body.states, []);
  // the live parser reads it as an empty (stale) snapshot
  const snap = openSkySnapshot(body, { now: GREY_UNTIL });
  assert.equal(snap.records.length, 0);
  assert.equal(gate.getState().stats.emptied, 1);
  // grey and live answers pass unchanged (the same Response)
  b.answers.set('/api/flights', { body: flightsBody, headers: bridge('grey') });
  const grey = await win.fetch('/api/flights');
  assert.equal(grey.headers.get(CLEARED_HEADER), null);
  assert.equal((await grey.json()).states.length, 1);
});

test('cleared body per feed is the live shape the layer parsers read as nothing', async () => {
  const { b, win } = setup();
  const ask = async (path, feedBody) => {
    b.answers.set(new URL(path, ORIGIN).pathname, {
      body: feedBody,
      headers: bridge('cleared'),
    });
    return win.fetch(path);
  };
  // military / vessels: the live source parsers
  const mil = await (
    await ask('/api/military', { ac: [{ hex: 'ae0001' }] })
  ).json();
  assert.equal(
    readsbSnapshot(mil, { observedAtMs: LAST_OK }).records.length,
    0,
  );
  assert.equal(mil.now, LAST_OK, 'server time of the last good data');
  const ves = await (
    await ask('/api/vessels?maxRows=100', {
      rows: [{ mmsi: 1 }],
      status: 'live',
    })
  ).json();
  assert.equal(ves.status, 'live', 'an empty live feed clears the layer');
  assert.equal(vesselSnapshot(ves).records.length, 0);
  // event feeds through the real layer sources
  const fetchVia = (...a) => win.fetch(...a);
  b.answers.set('/api/firms', { body: liveFirms, headers: bridge('cleared') });
  const firms = await createFirmsSource({ fetchImpl: fetchVia }).getSnapshot();
  assert.equal(firms.fires.length, 0);
  assert.equal(firms.stale, true);
  assert.equal(firms.fetchedAt, LAST_OK);
  b.answers.set('/api/cyclones', {
    body: liveCyclones,
    headers: bridge('cleared'),
  });
  const cyc = await createCycloneSource({ fetchImpl: fetchVia }).getSnapshot();
  assert.equal(cyc.unavailable, true);
  assert.equal(cyc.reason, CYCLONE_CLEARED_REASON);
  assert.deepEqual(cyc.storms, []);
  b.answers.set('/api/launches', {
    body: liveLaunches,
    headers: bridge('cleared'),
  });
  const launches = await createLaunchSource({
    fetchImpl: fetchVia,
  }).getLaunches();
  assert.deepEqual(launches.results, []);
  assert.equal('gevAsOf' in launches, false, 'live: the browser 30-day window');
  b.answers.set('/api/fire-perimeters', {
    body: { fetchedAt: LAST_OK, rows: [{ id: 'x' }] },
    headers: bridge('cleared'),
  });
  const per = await createWfigsPerimeterSource({
    fetchImpl: fetchVia,
  }).getSnapshot();
  assert.deepEqual(per, []);
  b.answers.set('/api/transit/vehicles/capmetro-austin', {
    body: { feedId: 'capmetro-austin', vehicles: [{ id: 'v1' }], count: 1 },
    headers: bridge('cleared'),
  });
  const tr = await (
    await createTransitSource({ fetchImpl: fetchVia }).requestSnapshot(
      'capmetro-austin',
    )
  ).json();
  assert.equal(tr.feedId, 'capmetro-austin');
  assert.deepEqual(tr.vehicles, []);
  const madison = GBFS_CITY_REGISTRY.find((e) => e.id === 'madison-bcycle');
  const gbfsPath = `/api/gbfs/${encodeURIComponent(madison.stationStatusUrl)}`;
  b.answers.set(gbfsPath, {
    body: {
      last_updated: 1,
      ttl: 0,
      data: { stations: [{ station_id: 's' }] },
    },
    headers: bridge('cleared'),
  });
  const st = await createBikeshareSource({ fetchImpl: fetchVia }).getStations(
    madison.stationStatusUrl,
  );
  assert.equal(parseStationStatus(st).size, 0);
  // every adapter feed has a body; satellites is chip only
  for (const a of ALL_HISTORY_ADAPTERS)
    assert.ok(clearedBody(a.id, new URL('/x', ORIGIN), LAST_OK), a.id);
  assert.equal(clearedBody('satellites', new URL('/x', ORIGIN)), null);
});

test('satellites: a cleared answer passes (its layer keeps the catalog on empty)', async () => {
  const { b, win } = setup();
  b.answers.set('/api/celestrak/stations', {
    body: { csv: 1 },
    headers: bridge('cleared'),
  });
  const r = await win.fetch('/api/celestrak/stations');
  assert.equal(r.headers.get(CLEARED_HEADER), null);
});

test('refreshLayer runs once per drawn <-> cleared transition, never on grey', async () => {
  const { win, dm, gate } = setup();
  const send = (feed, state, draw) =>
    win.dispatchEvent(feedEvent({ feed, state, draw }));
  send('flights', 'live', true);
  send('flights', 'grey', true); // live -> grey: repaint only
  assert.deepEqual(dm.refreshed, []);
  send('flights', 'cleared', false); // grey -> cleared
  send('flights', 'cleared', false); // the same state again
  assert.deepEqual(dm.refreshed, ['flights']);
  send('flights', 'live', true); // resumed
  assert.deepEqual(dm.refreshed, ['flights', 'flights']);
  // paused keeps state 'paused' while draw flips (B11 R2)
  send('firms', 'paused', true);
  send('firms', 'paused', false);
  send('firms', 'paused', false);
  assert.deepEqual(dm.refreshed.slice(2), ['local-firms']);
  assert.equal(gate.modeOf('firms'), MODE_CLEARED);
  // a disabled layer is not asked
  dm.enabled.delete('military');
  send('military', 'cleared', false);
  assert.equal(dm.refreshed.includes('military'), false);
  // satellites: its answer is never emptied, so no re-ask on either edge
  dm.enabled.add('satellites');
  send('satellites', 'cleared', false);
  send('satellites', 'live', true);
  assert.equal(dm.refreshed.includes('satellites'), false);
  assert.equal(gate.paintModeOf('satellites'), MODE_LIVE);
  send('satellites', 'paused', false);
  assert.equal(gate.paintModeOf('satellites'), MODE_CLEARED);
  await flush();
});

test('frame seams: reset once on clearing; bike share reloads on clear and resume', async () => {
  const { b, win, dm } = setup();
  b.answers.set('/api/flights', {
    body: flightsBody,
    headers: bridge('cleared'),
  });
  await win.fetch('/api/flights');
  await win.fetch('/api/flights');
  assert.deepEqual(dm.seams, [['reset', 'flights']]);
  b.answers.set('/api/flights', { body: flightsBody, headers: bridge('live') });
  const live = await win.fetch('/api/flights');
  assert.equal((await live.json()).states.length, 1, 'the real answer passes');
  dm.seams.length = 0;
  const madison = GBFS_CITY_REGISTRY.find((e) => e.id === 'madison-bcycle');
  const info = `/api/gbfs/${encodeURIComponent(madison.stationInformationUrl)}`;
  const status = `/api/gbfs/${encodeURIComponent(madison.stationStatusUrl)}`;
  for (const p of [info, status])
    b.answers.set(p, {
      body: { data: { stations: [] } },
      headers: bridge('cleared'),
    });
  await win.fetch(info);
  await win.fetch(status);
  assert.deepEqual(dm.seams, [['reload', 'bikeshare']], 'once per feed edge');
  for (const p of [info, status])
    b.answers.set(p, {
      body: { data: { stations: [] } },
      headers: bridge('live'),
    });
  await win.fetch(info);
  await win.fetch(status);
  assert.deepEqual(dm.seams, [
    ['reload', 'bikeshare'],
    ['reload', 'bikeshare'],
  ]);
});

test('the chips below still see the real answer (state and resume)', async () => {
  const { b, win, chips } = setup();
  b.answers.set('/api/launches', {
    body: liveLaunches,
    headers: bridge('cleared'),
  });
  await win.fetch('/api/launches');
  await flush();
  const s = chips.states().find((c) => c.feed === 'launches');
  assert.equal(s.state, 'cleared');
  assert.equal(s.draw, false);
  const events = win.events.filter((e) => e.type === FEED_STATE_EVENT);
  assert.equal(events.at(-1).detail.draw, false);
  b.answers.set('/api/launches', {
    body: liveLaunches,
    headers: bridge('live'),
  });
  const r = await win.fetch('/api/launches');
  assert.equal((await r.json()).results.length, liveLaunches.results.length);
  await flush();
  assert.equal(chips.states().find((c) => c.feed === 'launches').state, 'live');
});

test('no effect while the feed is swapped to history', async () => {
  const swapped = new Set(['flights']);
  const router = { isSwapped: (id) => swapped.has(id) };
  const { win, dm, gate } = setup({ router });
  win.dispatchEvent(
    feedEvent({ feed: 'flights', state: 'cleared', draw: false }),
  );
  assert.deepEqual(dm.refreshed, [], 'only remembered while swapped');
  assert.equal(gate.paintModeOf('flights'), MODE_LIVE, 'painter keeps off');
  assert.equal(gate.modeOf('flights'), MODE_CLEARED);
  win.dispatchEvent(feedEvent({ feed: 'military', state: 'grey', draw: true }));
  assert.equal(gate.paintModeOf('military'), MODE_GREY, 'unswapped layer');
  swapped.clear(); // LIVE: the painter takes the remembered state
  assert.equal(gate.paintModeOf('flights'), MODE_CLEARED);
});

test('with the real router in history the slice answer is served, never emptied', async () => {
  const T = LAST_OK - 3 * 86_400_000;
  const b = browser();
  const win = fakeWindow(`${ORIGIN}/`, b.fetchImpl);
  const chips = createFeedChips({ target: win });
  chips.install();
  let router = null;
  const dm = manager();
  const gate = createLiveFeedDraw({
    target: win,
    getRouter: () => router,
    getDataManager: () => dm,
  });
  gate.install();
  router = createHistoryRouter({ target: win, now: () => LAST_OK });
  router.install();
  b.answers.set('/api/history/slice', {
    body: { time: T / 1000, states: flightsBody.states },
    headers: { 'X-History-Rows': '1', 'X-History-Source': 'adsblol' },
  });
  b.answers.set('/api/flights', {
    body: flightsBody,
    headers: bridge('cleared'),
  });
  win.dispatchEvent(
    feedEvent({ feed: 'flights', state: 'cleared', draw: false }),
  );
  dm.refreshed.length = 0;
  router.setHistory({ active: true, timeMs: T, playing: false });
  const r = await win.fetch('/api/flights?view=-98,29,-96,31');
  assert.equal(r.headers.get(CLEARED_HEADER), null);
  assert.equal((await r.json()).states.length, 1, 'the recording at t');
  assert.equal(
    b.calls.some((c) => c.startsWith('/api/flights')),
    false,
  );
  win.dispatchEvent(feedEvent({ feed: 'flights', state: 'live', draw: true }));
  assert.deepEqual(dm.refreshed, [], 'no refresh of a swapped layer');
  assert.equal(gate.paintModeOf('flights'), MODE_LIVE);
  // LIVE: the D4 refresh asks live through the gate, which empties it
  router.setHistory({ active: false });
  const back = await win.fetch('/api/flights');
  assert.equal(back.headers.get(CLEARED_HEADER), '1');
});

// ── review R1: the FEED's draw is authoritative over every member url ──

test('R1 transit: one cleared system clears EVERY system until all resume', async () => {
  const { b, win, chips, gate, dm } = setup();
  const capmetro = '/api/transit/vehicles/capmetro-austin';
  const mbta = '/api/transit/vehicles/mbta';
  const vehicles = (feedId) => ({
    feedId,
    vehicles: [{ id: `${feedId}-v1` }],
    count: 1,
  });
  b.answers.set(capmetro, {
    body: vehicles('capmetro-austin'),
    headers: bridge('cleared'),
  });
  b.answers.set(mbta, { body: vehicles('mbta'), headers: bridge('live') });
  const source = createTransitSource({ fetchImpl: (...a) => win.fetch(...a) });
  const ask = async (id) => (await source.requestSnapshot(id)).json();
  assert.deepEqual((await ask('capmetro-austin')).vehicles, []);
  const chip = chips.states().find((c) => c.feed === 'transit');
  assert.equal(chip.draw, false, 'the chip shows the worst member');
  assert.equal(gate.modeOf('transit'), MODE_CLEARED);
  assert.deepEqual(dm.refreshed, ['transit'], 'one re-ask on the feed edge');
  // the LIVE system is emptied too: nothing drawn under feed draw:false
  const r = await win.fetch(mbta);
  assert.equal(r.headers.get(CLEARED_HEADER), '1');
  const body = await r.json();
  assert.equal(body.feedId, 'mbta', 'the live shape of that system');
  assert.deepEqual(body.vehicles, []);
  assert.deepEqual((await ask('mbta')).vehicles, []);
  assert.ok(
    gate.getState().blanked.includes(`transit ${mbta}`),
    'the live member is blanked as well',
  );
  // the chips below still saw MBTA's REAL (live) answer
  await flush();
  assert.equal(chips.states().find((c) => c.feed === 'transit').draw, false);
  // all members resume: the resuming answer passes, the feed refreshes once
  b.answers.set(capmetro, {
    body: vehicles('capmetro-austin'),
    headers: bridge('live'),
  });
  const back = await ask('capmetro-austin');
  assert.equal(back.vehicles.length, 1, 'the resuming answer is drawn');
  assert.equal(gate.modeOf('transit'), MODE_LIVE);
  assert.deepEqual(dm.refreshed, ['transit', 'transit']);
  assert.equal((await ask('mbta')).vehicles.length, 1, 'every member back');
  assert.deepEqual(gate.getState().blanked, [], 'nothing left blanked');
  await flush();
});

test('R1 bike share: one cleared member url clears the feed; recovery releases all', async () => {
  const { b, win, chips, gate, dm } = setup();
  const madison = GBFS_CITY_REGISTRY.find((e) => e.id === 'madison-bcycle');
  const info = `/api/gbfs/${encodeURIComponent(madison.stationInformationUrl)}`;
  const status = `/api/gbfs/${encodeURIComponent(madison.stationStatusUrl)}`;
  const stations = {
    last_updated: 1,
    ttl: 0,
    data: { stations: [{ station_id: 's', num_bikes_available: 3 }] },
  };
  b.answers.set(info, { body: stations, headers: bridge('cleared') });
  b.answers.set(status, { body: stations, headers: bridge('live') });
  const src = createBikeshareSource({ fetchImpl: (...a) => win.fetch(...a) });
  await win.fetch(info);
  assert.equal(chips.states().find((c) => c.feed === 'bikeshare').draw, false);
  assert.deepEqual(dm.seams, [['reload', 'bikeshare']], 'cleared edge');
  const st = await src.getStations(madison.stationStatusUrl);
  assert.equal(parseStationStatus(st).size, 0, 'live status url emptied too');
  // an emptied station information is not cached by the layer (it throws
  // "No station information"), so the layer asks it again: the chips see
  // its REAL answer and the feed resumes - the resuming answer passes
  b.answers.set(info, { body: stations, headers: bridge('live') });
  const infoBack = await win.fetch(info);
  assert.equal(infoBack.headers.get(CLEARED_HEADER), null, 'not hidden');
  assert.equal(chips.states().find((c) => c.feed === 'bikeshare').draw, true);
  assert.equal(gate.modeOf('bikeshare'), MODE_LIVE);
  assert.deepEqual(dm.refreshed, ['bikeshare', 'bikeshare'], 'clear + resume');
  const st2 = await src.getStations(madison.stationStatusUrl);
  assert.equal(parseStationStatus(st2).size, 1, 'drawn again');
  assert.deepEqual(gate.getState().blanked, []);
  assert.deepEqual(
    dm.seams,
    [
      ['reload', 'bikeshare'],
      ['reload', 'bikeshare'],
    ],
    'one reload on resume drops the emptied station cache',
  );
});

test('R1 a plain (non-bridge) data answer under a cleared feed is emptied; errors pass', async () => {
  const { b, win } = setup();
  win.dispatchEvent(
    feedEvent({ feed: 'launches', state: 'cleared', draw: false }),
  );
  b.answers.set('/api/launches', { body: liveLaunches });
  const r = await win.fetch('/api/launches');
  assert.equal(r.headers.get(CLEARED_HEADER), '1');
  assert.deepEqual((await r.json()).results, []);
  b.answers.set('/api/launches', { body: { error: 'x' }, status: 503 });
  const e = await win.fetch('/api/launches');
  assert.equal(e.status, 503, "the layer's own error path");
  assert.equal(e.headers.get(CLEARED_HEADER), null);
});

// ── review R2: authority is judged when the answer SETTLES ──

/** window -> gate -> chips -> a browser whose answers the test releases. */
function deferredSetup({ router, dm = manager() } = {}) {
  const pending = [];
  const win = fakeWindow(
    `${ORIGIN}/`,
    () => new Promise((resolve) => pending.push(resolve)),
  );
  const chips = createFeedChips({ target: win, timeZone: 'UTC' });
  chips.install();
  const gate = createLiveFeedDraw({
    target: win,
    getRouter: () => router,
    getDataManager: () => dm,
  });
  gate.install();
  return { win, chips, gate, dm, pending };
}

test('R2 a live answer that settles after history took the layer moves nothing', async () => {
  const swapped = new Set();
  const router = { isSwapped: (id) => swapped.has(id) };
  const { win, gate, dm, pending } = deferredSetup({ router });
  const asked = win.fetch('/api/flights');
  swapped.add('flights'); // history entered while the live ask was out
  pending.shift()(jsonResponse(flightsBody, { headers: bridge('cleared') }));
  const r = await asked;
  assert.deepEqual(dm.seams, [], 'no frame reset on the history layer');
  assert.deepEqual(dm.refreshed, []);
  assert.equal(r.headers.get(CLEARED_HEADER), null, 'passed untouched');
  assert.deepEqual(gate.getState().blanked, []);
  assert.equal(gate.getState().stats.emptied, 0);
  // bike share: a late RESUMING answer must not reload the history layer
  const madison = GBFS_CITY_REGISTRY.find((e) => e.id === 'madison-bcycle');
  const status = `/api/gbfs/${encodeURIComponent(madison.stationStatusUrl)}`;
  const clearing = win.fetch(status);
  pending.shift()(
    jsonResponse({ data: { stations: [] } }, { headers: bridge('cleared') }),
  );
  await clearing;
  assert.deepEqual(dm.seams, [['reload', 'bikeshare']], 'live: normal clear');
  const late = win.fetch(status);
  swapped.add('bikeshare');
  pending.shift()(
    jsonResponse({ data: { stations: [] } }, { headers: bridge('live') }),
  );
  await late;
  assert.deepEqual(dm.seams, [['reload', 'bikeshare']], 'no reload in history');
  assert.ok(gate.getState().blanked.length === 1, 'live bookkeeping kept');
  // back to LIVE: the normal clear/resume behaviour is unchanged
  swapped.clear();
  const again = win.fetch('/api/flights');
  pending.shift()(jsonResponse(flightsBody, { headers: bridge('cleared') }));
  assert.equal((await again).headers.get(CLEARED_HEADER), '1');
  assert.deepEqual(dm.seams.at(-1), ['reset', 'flights']);
  const resumed = win.fetch(status);
  pending.shift()(
    jsonResponse({ data: { stations: [] } }, { headers: bridge('live') }),
  );
  await resumed;
  assert.deepEqual(dm.seams.at(-1), ['reload', 'bikeshare'], 'resume reload');
  await flush();
});

test('R2 a live answer that settles after destroy passes and moves nothing', async () => {
  const { win, gate, dm, pending } = deferredSetup();
  const inner = win.fetch;
  const asked = win.fetch('/api/flights');
  const askedBike = win.fetch(
    `/api/gbfs/${encodeURIComponent('https://x.test/station_status.json')}`,
  );
  let ticks = 0;
  gate.subscribe(() => ticks++);
  gate.destroy();
  assert.notEqual(win.fetch, inner, 'the gate is unwrapped');
  pending.shift()(jsonResponse(flightsBody, { headers: bridge('cleared') }));
  pending.shift()(
    jsonResponse({ data: { stations: [] } }, { headers: bridge('cleared') }),
  );
  const r = await asked;
  await askedBike;
  assert.equal(r.headers.get(CLEARED_HEADER), null);
  assert.equal((await r.json()).states.length, 1);
  assert.deepEqual(dm.seams, []);
  assert.deepEqual(dm.refreshed, []);
  assert.equal(ticks, 0, 'no notify after teardown');
  assert.deepEqual(gate.getState().blanked, []);
  // a feed-state event after teardown is ignored
  win.dispatchEvent(
    feedEvent({ feed: 'flights', state: 'cleared', draw: false }),
  );
  assert.deepEqual(dm.refreshed, [], 'no event handling after destroy');
});
