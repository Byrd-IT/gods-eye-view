import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHistoryRouter, LIVE_ONLY_FLAG } from './historyRouter.js';
import { createFeedChips } from './feedChips.js';
import { fakeClock, fakeWindow, flush, jsonResponse } from './fakeDom.mjs';
import { openSkyState, readsbBody, readsbRow } from '../history/historyRows.js';
import {
  createFlightSource,
  createMilitarySource,
  createVesselSource,
} from '../../sources/live/standalone.js';

const docs = JSON.parse(
  readFileSync(
    new URL('../history/fixtures/b9-es-docs.json', import.meta.url),
    'utf8',
  ),
);
const NOW = Date.parse('2026-10-14T18:00:00Z');
const T = Date.parse('2026-10-13T19:46:40Z');
const MIN = 60_000;
const ORIGIN = 'https://gev.example';

const states = docs.opensky
  .map((h) => openSkyState({ ...h._source, source: 'opensky' }))
  .filter(Boolean);
const milRows = docs.military
  .map((h) => readsbRow(h._source, T))
  .filter(Boolean);

/** A fake server: /api/history/slice from fixtures, everything else live. */
function server({ slice, live } = {}) {
  const calls = [];
  const pending = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input?.url ?? input), ORIGIN);
    calls.push({ path: url.pathname + url.search, init });
    if (url.pathname === '/api/history/slice') {
      const q = Object.fromEntries(url.searchParams);
      if (slice) return slice(q, init, url);
      return defaultSlice(q);
    }
    if (live) return live(url, init);
    return jsonResponse(
      url.pathname === '/api/military'
        ? { ac: [], now: NOW, msg: 'No error' }
        : url.pathname === '/api/vessels'
          ? { rows: [], status: 'live' }
          : { time: Math.round(NOW / 1000), states: [] },
      {
        headers: {
          'X-Feed-Source': 'live',
          'X-Feed-Last-OK': String(NOW - 5_000),
          'X-Feed-Age-Ms': '5000',
          'X-Feed-Cache': 'HIT',
        },
      },
    );
  };
  return { fetch, calls, pending };
}

function defaultSlice(q) {
  const t = Date.parse(q.t);
  if (q.feed === 'aircraft')
    return jsonResponse(
      { time: Math.round(t / 1000), states },
      {
        headers: {
          'X-History-Source': 'opensky',
          'X-History-Rows': String(states.length),
        },
      },
    );
  if (q.feed === 'military')
    return jsonResponse(readsbBody(milRows, t), {
      headers: { 'X-History-Source': 'adsb.lol' },
    });
  return jsonResponse({ rows: [], source: 'history', status: 'history' });
}

function setup(opts = {}) {
  const clock = fakeClock(NOW);
  const srv = server(opts);
  const win = fakeWindow(`${ORIGIN}/`, srv.fetch);
  const router = createHistoryRouter({
    target: win,
    now: clock.now,
    timers: clock.timers,
    monotonic: clock.monotonic,
    ...opts.router,
  });
  const sources = {
    flights: createFlightSource({
      fetchImpl: (...a) => win.fetch(...a),
      now: clock.now,
    }),
    military: createMilitarySource({
      fetchImpl: (...a) => win.fetch(...a),
      now: clock.now,
    }),
    vessels: createVesselSource({
      fetchImpl: (...a) => win.fetch(...a),
      origin: () => ORIGIN,
    }),
  };
  return { clock, srv, win, router, sources };
}

const sliceCalls = (srv) =>
  srv.calls.filter((c) => c.path.startsWith('/api/history/slice'));

test('LIVE: every request passes straight through (same promise)', async () => {
  const srv = server();
  let seen = null;
  const spy = (input, init) => {
    seen = srv.fetch(input, init);
    return seen;
  };
  const win = fakeWindow(`${ORIGIN}/`, spy);
  const router = createHistoryRouter({ target: win });
  router.install();
  assert.notEqual(win.fetch, spy);
  const got = win.fetch('/api/flights?view=1,2,3,4');
  assert.equal(got, seen); // the inner fetch's own promise
  await got;
  assert.equal(srv.calls.at(-1).path, '/api/flights?view=1,2,3,4');
  assert.equal(sliceCalls(srv).length, 0);
});

test('history: /api/flights is answered from the slice at t with the view bbox; the live source parses it', async () => {
  const { router, srv, sources } = setup();
  router.install();
  router.setHistory({ active: true, timeMs: T, playing: false });
  const snap = await sources.flights.getSnapshot({
    latitude: 30,
    longitude: -97,
    view: '-106.6,25.8,-93.5,36.5',
    vsid: 'vABCDEFGHIJKLMNOP',
  });
  const calls = sliceCalls(srv);
  assert.equal(calls.length, 1);
  const q = new URL(calls[0].path, ORIGIN).searchParams;
  assert.equal(q.get('feed'), 'aircraft');
  assert.equal(q.get('t'), new Date(T).toISOString());
  assert.equal(q.get('bbox'), '-106.6,25.8,-93.5,36.5');
  assert.equal(
    srv.calls.some((c) => c.path.startsWith('/api/flights')),
    false,
    'no live flights request',
  );
  assert.equal(snap.records.length, states.length);
  assert.equal(snap.source, 'History: OpenSky');
  assert.equal(snap.freshness, 'current'); // rebased (D2)
  assert.equal(
    snap.observedAtMs,
    Math.round(T / 1000) * 1000 + Math.round((NOW - T) / 1000) * 1000,
  );
  assert.deepEqual(router.getState().swapped, [
    'flights',
    'military',
    'vessels',
    'firms',
    'fire-perimeters',
    'cyclones',
    'launches',
    'transit',
    'bikeshare',
    'quakes',
    'wind',
  ]);
  assert.equal(router.getState().served.flights.rows, states.length);
});

test('history: military and vessels are answered from their slices', async () => {
  const { router, srv, sources } = setup();
  router.install();
  router.setHistory({ active: true, timeMs: T });
  const m = await sources.military.getSnapshot();
  assert.equal(m.records.length, milRows.length);
  assert.equal(m.source, 'History: adsb.lol');
  const v = await sources.vessels.getSnapshot({ maxRows: 500 });
  assert.equal(v.records.length, 0);
  const paths = sliceCalls(srv).map(
    (c) => new URL(c.path, ORIGIN).searchParams,
  );
  assert.deepEqual(
    paths.map((p) => [p.get('feed'), p.get('maxRows')]),
    [
      ['military', null],
      ['vessels', '500'],
    ],
  );
});

test('pass-through in history: non-GET, other routes and gevLive requests', async () => {
  const { router, srv, win } = setup();
  router.install();
  router.setHistory({ active: true, timeMs: T });
  await win.fetch('/api/military', { method: 'POST' });
  await win.fetch('/api/earthquakes');
  await win.fetch('/api/flights?lat=1&lon=2', { [LIVE_ONLY_FLAG]: true });
  assert.equal(sliceCalls(srv).length, 0);
  assert.deepEqual(
    srv.calls.map((c) => c.path),
    ['/api/military', '/api/earthquakes', '/api/flights?lat=1&lon=2'],
  );
});

test('D3 tracks: no live track of a feed shown from history (vessels 404, flights recorded track B12e); LIVE and failed feeds pass through', async () => {
  const { router, srv, win } = setup({
    slice: (q) =>
      q.feed === 'military'
        ? jsonResponse({}, { status: 500 })
        : defaultSlice(q),
  });
  router.install();
  router.setHistory({ active: true, timeMs: T });
  const res = await win.fetch('/api/vessels/track?mmsi=123456789');
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /history/);
  assert.equal(srv.calls.length, 0, 'no live track was asked');
  // B12e: the flights track is the recorded one (historyTrack.test.mjs)
  await win.fetch('/api/flights/track?icao24=abc123');
  assert.deepEqual(
    srv.calls.map((c) => c.path.split('?')[0]),
    ['/api/history/track'],
    'no live track was asked',
  );
  // military failed -> its feed is live, so is its track
  await win.fetch('/api/military');
  await win.fetch('/api/military/track?hex=ae0001');
  assert.equal(srv.calls.at(-1).path, '/api/military/track?hex=ae0001');
  router.setHistory({ active: false });
  await win.fetch('/api/flights/track?icao24=abc123');
  assert.equal(srv.calls.at(-1).path, '/api/flights/track?icao24=abc123');
});

test('onServe: a history answer is announced before the layer reads it; a failure pass-through as live', async () => {
  let fail = false;
  const { router, win, clock } = setup({
    slice: (q) => (fail ? jsonResponse({}, { status: 500 }) : defaultSlice(q)),
  });
  router.install();
  const events = [];
  const off = router.onServe((e) => events.push(e));
  await win.fetch('/api/military'); // LIVE: nothing announced
  router.setHistory({ active: true, timeMs: T });
  const res = win.fetch('/api/military');
  await res;
  assert.deepEqual(events, [
    { adapterId: 'military', mode: 'history', t: T, nowMs: clock.now() },
  ]);
  fail = true;
  router.setHistory({ active: true, timeMs: T + MIN });
  await win.fetch('/api/military'); // fails -> live
  await win.fetch('/api/military'); // failed, retry not due -> live
  assert.deepEqual(
    events.slice(1).map((e) => e.mode),
    ['live', 'live'],
  );
  off();
  await win.fetch('/api/military');
  assert.equal(events.length, 3, 'unsubscribed');
});

test('chain: the B11 chip observer still sees live answers, never the history answers', async () => {
  const { router, win } = setup();
  const chips = createFeedChips({ target: win, monotonic: () => 0 });
  chips.install(); // B11 first
  router.install(); // then the router (outermost)
  await win.fetch('/api/military');
  await flush();
  assert.deepEqual(
    chips.states().map((c) => [c.feed, c.state]),
    [['military', 'live']],
  );
  router.setHistory({ active: true, timeMs: T });
  const r = await win.fetch('/api/flights?view=1,2,3,4');
  assert.equal(r.status, 200);
  await flush();
  // the history answer has no bridge headers and is not a bridged route
  assert.deepEqual(
    chips.states().map((c) => c.feed),
    ['military'],
  );
  assert.equal(r.headers.get('x-feed-last-ok'), null);
  assert.equal(r.headers.get('x-feed-age-ms'), null);
  router.setHistory({ active: false });
  await win.fetch('/api/flights?view=1,2,3,4');
  await flush();
  assert.deepEqual(
    chips
      .states()
      .map((c) => c.feed)
      .sort(),
    ['flights', 'military'],
  );
});

test('D3 failure: a failing slice passes through to live, the feed is not swapped, retried later', async () => {
  let failing = true;
  const { router, srv, sources, clock } = setup({
    slice: (q) =>
      failing
        ? new Response('<html>spa</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          })
        : defaultSlice(q),
    router: { retryMs: 10_000 },
  });
  const seen = [];
  router.subscribe((st) => seen.push(st.swapped.join(',')));
  router.install();
  router.setHistory({ active: true, timeMs: T });
  const a = await sources.military.getSnapshot();
  assert.equal(a.source, 'live'); // the live answer
  assert.equal(router.isSwapped('military'), false);
  assert.equal(router.isFailed('military'), true);
  assert.equal(router.isSwapped('flights'), true);
  const n = sliceCalls(srv).length;
  await sources.military.getSnapshot(); // still inside retryMs: no slice asked
  assert.equal(sliceCalls(srv).length, n);
  assert.equal(srv.calls.at(-1).path, '/api/military');
  failing = false;
  await clock.run(10_001);
  const b = await sources.military.getSnapshot();
  assert.equal(b.source, 'History: adsb.lol');
  assert.equal(router.isSwapped('military'), true);
  assert.ok(seen.some((s) => !s.includes('military')));
  // a network error and a 5xx fail the same way
  for (const bad of [
    () => {
      throw new TypeError('network');
    },
    () => jsonResponse({ error: 'history_unavailable' }, { status: 503 }),
  ]) {
    const s2 = setup({ slice: bad });
    s2.router.install();
    s2.router.setHistory({ active: true, timeMs: T });
    const r = await s2.sources.flights.getSnapshot({});
    assert.equal(r.source, 'live');
    assert.equal(s2.router.isFailed('flights'), true);
  }
});

test('D3: the control reporting history back makes failed feeds retry at once; they stay failed until served', async () => {
  let ok = false;
  const { router, sources, srv } = setup({
    slice: (q) => (ok ? defaultSlice(q) : jsonResponse({}, { status: 500 })),
  });
  router.install();
  router.setHistory({ active: true, timeMs: T, error: 'history unavailable' });
  await sources.flights.getSnapshot({});
  assert.equal(router.isFailed('flights'), true);
  router.setHistory({ active: true, timeMs: T });
  // still failed (LIVE chip) until a history answer is actually served
  assert.equal(router.isFailed('flights'), true);
  assert.equal(router.isSwapped('flights'), false);
  ok = true;
  const n = sliceCalls(srv).length;
  const snap = await sources.flights.getSnapshot({});
  assert.equal(sliceCalls(srv).length, n + 1); // retried without waiting
  assert.equal(snap.source, 'History: OpenSky');
  assert.equal(router.isFailed('flights'), false);
  assert.equal(router.isSwapped('flights'), true);
});

test('R4 latch: retry expiry alone never flips a failed feed back to swapped', async () => {
  let ok = false;
  const { router, sources, clock, srv } = setup({
    slice: (q) => (ok ? defaultSlice(q) : jsonResponse({}, { status: 503 })),
    router: { retryMs: 15_000 },
  });
  router.install();
  router.setHistory({ active: true, timeMs: T });
  await sources.military.getSnapshot();
  assert.equal(router.isFailed('military'), true);
  await clock.run(15_001); // retry is due, but nothing was served
  assert.equal(router.isFailed('military'), true);
  assert.equal(router.isSwapped('military'), false);
  assert.ok(!router.getState().swapped.includes('military'));
  // the due retry fails again: live answer, still failed, new retry window
  const before = sliceCalls(srv).length;
  const r = await sources.military.getSnapshot();
  assert.equal(r.source, 'live');
  assert.equal(sliceCalls(srv).length, before + 1);
  assert.equal(router.isFailed('military'), true);
  await sources.military.getSnapshot(); // inside the new window: no slice
  assert.equal(sliceCalls(srv).length, before + 1);
  ok = true;
  await clock.run(15_001);
  const h = await sources.military.getSnapshot();
  assert.equal(h.source, 'History: adsb.lol');
  assert.equal(router.isFailed('military'), false);
  assert.equal(router.isSwapped('military'), true);
});

test('D3 gap: an empty slice is served as an empty answer (never live)', async () => {
  const { router, srv, sources } = setup({
    slice: (q) =>
      jsonResponse(
        { time: Math.round(Date.parse(q.t) / 1000), states: [] },
        { headers: { 'X-History-Gap': '1', 'X-History-Source': 'none' } },
      ),
  });
  router.install();
  router.setHistory({ active: true, timeMs: T });
  const snap = await sources.flights.getSnapshot({ view: '1,2,3,4' });
  assert.equal(snap.records.length, 0);
  assert.equal(
    srv.calls.some((c) => c.path.startsWith('/api/flights')),
    false,
  );
  assert.equal(router.getState().served.flights.gap, true);
});

test('R4 busy (429): one retry, then D3 -> live pass-through + failed (no 503 to the layer)', async () => {
  let n = 0;
  const { router, srv, win, clock, sources } = setup({
    slice: () => {
      n++;
      return jsonResponse({ error: 'rate_limited' }, { status: 429 });
    },
  });
  router.install();
  router.setHistory({ active: true, timeMs: T });
  const p = win.fetch('/api/military');
  await flush();
  await clock.run(1_600);
  const r = await p;
  assert.equal(r.status, 200); // the live answer, so no layer backoff
  assert.equal(r.headers.get('x-feed-source'), 'live');
  assert.equal(n, 2);
  assert.equal(srv.calls.filter((c) => c.path === '/api/military').length, 1);
  assert.equal(router.isFailed('military'), true);
  assert.equal(router.isSwapped('military'), false);
  assert.ok(router.getState().failed.includes('military'));
  // the next polls (e.g. settle refreshes) are answered live at once
  const s2 = await sources.military.getSnapshot();
  assert.equal(s2.source, 'live');
  assert.equal(n, 2);
});

test('R4 busy (429) once, then ok: served from history, never failed', async () => {
  let n = 0;
  const { router, win, clock } = setup({
    slice: (q) =>
      ++n === 1
        ? jsonResponse({ error: 'rate_limited' }, { status: 429 })
        : defaultSlice(q),
  });
  router.install();
  router.setHistory({ active: true, timeMs: T });
  const p = win.fetch('/api/military');
  await flush();
  await clock.run(1_600);
  const r = await p;
  assert.equal(r.status, 200);
  assert.match(r.headers.get('x-feed-source'), /^History/);
  assert.equal(router.isFailed('military'), false);
});

test('cache: an identical request is served from memory; the rebase is applied at serve time', async () => {
  const { router, srv, win, clock } = setup();
  router.install();
  router.setHistory({ active: true, timeMs: T });
  const a = await (await win.fetch('/api/flights?view=1,2,3,4')).json();
  await clock.run(5_000);
  const b = await (await win.fetch('/api/flights?view=1,2,3,4')).json();
  assert.equal(sliceCalls(srv).length, 1);
  assert.equal(b.time - a.time, 5); // rebased against the later now
  assert.equal(router.getState().stats.cacheHits, 1);
  // a seek drops it
  router.setHistory({ active: true, timeMs: T - 30 * MIN });
  await win.fetch('/api/flights?view=1,2,3,4');
  assert.equal(sliceCalls(srv).length, 2);
});

test('D6: a new bbox drops the cache; LIVE drops it too', async () => {
  const { router, srv, win } = setup();
  router.install();
  router.setHistory({ active: true, timeMs: T });
  await win.fetch('/api/flights?view=1,2,3,4');
  assert.equal(router.getState().cacheSize, 1);
  await win.fetch('/api/flights?view=1,2,3,5');
  assert.equal(router.getState().cacheSize, 1); // old box dropped
  router.setHistory({ active: false });
  assert.equal(router.getState().cacheSize, 0);
  assert.equal(sliceCalls(srv).length, 2);
});

test('D6 prefetch: next frames, at most 2 in flight in total, cancelled on seek', async () => {
  const gates = [];
  const { router, srv, win } = setup({
    slice: (q, init) =>
      new Promise((resolve, reject) => {
        gates.push({ q, resolve: () => resolve(defaultSlice(q)) });
        init?.signal?.addEventListener?.('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      }),
  });
  router.install();
  router.setHistory({ active: true, timeMs: T, playing: true });
  router.setSnaps('aircraft', [T - MIN, T, T + MIN, T + 2 * MIN, T + 3 * MIN]);
  router.setSnaps('military', [T, T + MIN, T + 2 * MIN]);
  // the layers asked once (their params are what is prefetched)
  const f = win.fetch('/api/flights?view=1,2,3,4');
  const m = win.fetch('/api/military');
  await flush();
  gates.splice(0).forEach((g) => g.resolve());
  await Promise.all([f, m]);
  const flights = router.adapters[0];
  const military = router.adapters[1];
  assert.equal(router.frameTime(flights, T + 30_000), T);
  assert.deepEqual(router.nextFrames(flights, T, 2), [T + MIN, T + 2 * MIN]);
  router.prefetch('flights', router.nextFrames(flights, T, 2));
  router.prefetch('military', router.nextFrames(military, T, 2));
  await flush();
  const st = router.getState();
  assert.equal(st.prefetchInFlight, 2);
  assert.equal(st.prefetchQueued, 2);
  assert.equal(gates.length, 2);
  assert.deepEqual(
    gates.map((g) => [g.q.feed, g.q.t]),
    [
      ['aircraft', new Date(T + MIN).toISOString()],
      ['aircraft', new Date(T + 2 * MIN).toISOString()],
    ],
  );
  gates.shift().resolve();
  await flush();
  assert.equal(router.getState().prefetchInFlight, 2); // the next one started
  assert.equal(router.getState().stats.maxInFlight, 2);
  // seek: everything queued / in flight is cancelled and the cache dropped
  router.setHistory({ active: true, timeMs: T - 60 * MIN, playing: false });
  await flush();
  assert.equal(router.getState().prefetchInFlight, 0);
  assert.equal(router.getState().prefetchQueued, 0);
  assert.equal(router.getState().cacheSize, 0);
  // a prefetched frame is a cache hit for the layer's request
  router.setHistory({ active: true, timeMs: T, playing: true });
  router.prefetch('military', [T + MIN]);
  await flush();
  gates.splice(0).forEach((g) => g.resolve());
  await flush();
  const before = sliceCalls(srv).length;
  router.setHistory({ active: true, timeMs: T + MIN + 10_000, playing: true });
  await win.fetch('/api/military');
  assert.equal(sliceCalls(srv).length, before);
  assert.ok(router.getState().stats.cacheHits >= 1);
});

test('frames: paused = t exactly; playing = recorded snapshot at or before t, else the quantum', () => {
  const { router } = setup();
  const [flights, , vessels] = router.adapters;
  router.setHistory({ active: true, timeMs: T + 25_000, playing: false });
  assert.equal(router.frameTime(flights), T + 25_000);
  router.setHistory({ active: true, timeMs: T + 25_000, playing: true });
  assert.equal(router.frameTime(flights), Math.floor((T + 25_000) / MIN) * MIN);
  router.setSnaps('aircraft', [T + 10_000, T + 70_000]);
  assert.equal(router.frameTime(flights), T + 10_000);
  // a snapshot too far back is not the frame
  assert.equal(
    router.frameTime(flights, T + 70_000 + 11 * MIN),
    Math.floor((T + 70_000 + 11 * MIN) / MIN) * MIN,
  );
  assert.equal(router.frameTime(vessels), Math.floor((T + 25_000) / MIN) * MIN);
  assert.deepEqual(router.nextFrames(vessels, T, 2), [T + MIN, T + 2 * MIN]);
  // never beyond now
  assert.deepEqual(router.nextFrames(vessels, NOW - 30_000, 2), []);
});

test('LIVE while a slice is pending: the request is answered live, not with history', async () => {
  let release;
  const { router, srv, win } = setup({
    slice: (q) =>
      new Promise((r) => {
        release = () => r(defaultSlice(q));
      }),
  });
  router.install();
  router.setHistory({ active: true, timeMs: T });
  const p = win.fetch('/api/military');
  await flush();
  router.setHistory({ active: false });
  release();
  const r = await p;
  assert.equal(r.headers.get('x-feed-source'), 'live');
  assert.equal(srv.calls.at(-1).path, '/api/military');
});

test('a seek while a slice is pending answers the NEW time', async () => {
  const releases = [];
  const { router, win } = setup({
    slice: (q) =>
      new Promise((r) => {
        releases.push(() => r(defaultSlice(q)));
      }),
  });
  router.install();
  router.setHistory({ active: true, timeMs: T });
  const p = win.fetch('/api/military');
  await flush();
  router.setHistory({ active: true, timeMs: T - 60 * MIN });
  releases.shift()();
  await flush();
  releases.shift()();
  const r = await p;
  assert.equal(
    r.headers.get('x-history-t'),
    new Date(T - 60 * MIN).toISOString(),
  );
});

test('the layer signal aborts its history request', async () => {
  const { router, win } = setup({ slice: () => new Promise(() => {}) });
  router.install();
  router.setHistory({ active: true, timeMs: T });
  const c = new AbortController();
  const p = win.fetch('/api/military', { signal: c.signal });
  c.abort();
  await assert.rejects(p, { name: 'AbortError' });
});

test('destroy restores the inner fetch', () => {
  const { router, win, srv } = setup();
  router.install();
  router.destroy();
  assert.equal(win.fetch, srv.fetch);
});

test('budget: a prefetch never spends the last reserved slice requests of the minute', async () => {
  const { router, srv, win, clock } = setup({
    router: { budgetPerMin: 10, prefetchReserve: 3 },
  });
  router.install();
  router.setHistory({ active: true, timeMs: T, playing: true });
  await win.fetch('/api/military');
  assert.equal(router.budgetLeft(), 9);
  const times = Array.from({ length: 10 }, (_, i) => T + (i + 1) * MIN);
  router.prefetch('military', times);
  await flush();
  await flush();
  assert.equal(sliceCalls(srv).length, 7); // 1 layer + 6 prefetches
  assert.equal(router.budgetLeft(), 3);
  assert.equal(router.getState().prefetchQueued, 0);
  // the layer's own request is never held back
  router.setHistory({ active: true, timeMs: T - 2 * 60 * MIN, playing: false });
  const r = await win.fetch('/api/military');
  assert.equal(r.status, 200);
  assert.equal(router.budgetLeft(), 2);
  await clock.run(60_001);
  assert.equal(router.budgetLeft(), 10);
});
