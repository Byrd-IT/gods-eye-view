import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HISTORY_FEEDS, HistoryConfigError, loadHistoryConfig } from '../config.js';
import { createHistoryStore } from '../store/index.js';
import {
  LIVE_API_SUPPORT,
  NO_SOURCE_HISTORY,
  buildLiveApiAdapters,
  createLiveApiStore,
  createLiveOnlyStore,
  describeSupport,
  liveApiFeeds,
  liveApiRefusal,
} from './index.js';
import { inBox, splitBox } from './liveApi.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);

/** A fetch that records every request and answers from `respond(url, init)`. */
function fakeFetch(respond) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const answer = await respond(String(url), init, calls.length);
    return new Response(answer.body ?? '', { status: answer.status ?? 200 });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}
const json = (value, status = 200) => ({ status, body: JSON.stringify(value) });

function makeStore(respond, options = {}) {
  const fetchImpl = fakeFetch(respond);
  const clock = { t: NOW };
  const store = createLiveApiStore({
    adapters: buildLiveApiAdapters({ FIRMS_MAP_KEY: 'SECRETKEY123', ...options.env }),
    fetch: fetchImpl,
    now: () => clock.t,
    ...options.store,
  });
  return { store, fetchImpl, clock };
}

async function rejectsWith(promise, code, pattern) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.name, 'HistoryStoreError');
    assert.equal(error.code, code);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

const quake = (id, t, lon, lat, mag = 3) => ({
  id,
  geometry: { coordinates: [lon, lat, 8.5] },
  properties: { mag, time: t, place: 'somewhere', magType: 'ml', status: 'reviewed', tsunami: 0, url: `https://example.test/${id}` },
});

describe('support matrix', () => {
  it('classifies every history feed exactly once', () => {
    for (const feed of HISTORY_FEEDS) {
      const live = Object.hasOwn(LIVE_API_SUPPORT, feed);
      const no = Object.hasOwn(NO_SOURCE_HISTORY, feed);
      assert.ok(live !== no, `${feed} must be in exactly one of the two tables`);
    }
    for (const feed of [...Object.keys(LIVE_API_SUPPORT), ...Object.keys(NO_SOURCE_HISTORY)])
      assert.ok(HISTORY_FEEDS.includes(feed), `${feed} is not a history feed`);
  });

  it('has one adapter per live-api feed, with the matrix limits', () => {
    const adapters = buildLiveApiAdapters({});
    assert.deepEqual(Object.keys(adapters).sort(), liveApiFeeds().sort());
    for (const [feed, adapter] of Object.entries(adapters)) {
      assert.equal(adapter.feed, feed);
      assert.equal(adapter.maxWindowMs, LIVE_API_SUPPORT[feed].maxWindowMs);
      assert.equal(adapter.maxPerHour, LIVE_API_SUPPORT[feed].maxPerHour);
      assert.equal(adapter.source, LIVE_API_SUPPORT[feed].source);
    }
  });

  it('gives a reason for every feed without a source history API', () => {
    for (const feed of Object.keys(NO_SOURCE_HISTORY)) assert.ok(liveApiRefusal(feed).length > 40);
    assert.equal(liveApiRefusal('quakes'), '');
  });

  it('describes each feed under a configuration', () => {
    const config = loadHistoryConfig({
      HISTORY_STORE_QUAKES: 'live-api',
      HISTORY_STORE_VESSELS: 'live-only',
    });
    const rows = Object.fromEntries(describeSupport(config).map((row) => [row.feed, row]));
    assert.deepEqual(
      { mode: rows.quakes.mode, history: rows.quakes.history, slider: rows.quakes.slider },
      { mode: 'live-api', history: 'source', slider: 'available' },
    );
    assert.deepEqual(
      { mode: rows.vessels.mode, history: rows.vessels.history, slider: rows.vessels.slider },
      { mode: 'live-only', history: 'none', slider: 'hidden' },
    );
    assert.equal(rows.aircraft.mode, 'stored');
    assert.equal(rows.firms.liveApiOffer, true);
    assert.equal(rows.vessels.liveApiOffer, false);
    assert.match(rows.vessels.note, /AISStream/);
  });
});

describe('configuration of the live backends', () => {
  it('refuses live-api for a feed whose source has no history API, and says why', () => {
    assert.throws(
      () => loadHistoryConfig({ HISTORY_STORE_AIRCRAFT: 'live-api' }),
      (error) => {
        assert.ok(error instanceof HistoryConfigError);
        assert.equal(error.problems.length, 1);
        assert.match(error.problems[0], /HISTORY_STORE_AIRCRAFT cannot be live-api/);
        assert.match(error.problems[0], /OpenSky/);
        assert.match(error.problems[0], /adsb\.lol/);
        return true;
      },
    );
  });

  it('as the default, live-api drops unsupported feeds to live-only with a warning', () => {
    const config = loadHistoryConfig({ HISTORY_STORE: 'live-api', FIRMS_MAP_KEY: 'k' });
    for (const feed of HISTORY_FEEDS)
      assert.equal(config.feeds[feed].store, Object.hasOwn(LIVE_API_SUPPORT, feed) ? 'live-api' : 'live-only', feed);
    assert.equal(config.warnings.length, Object.keys(NO_SOURCE_HISTORY).length);
    assert.ok(config.warnings.some((warning) => /^vessels has no source history API/.test(warning)));
  });

  it('warns, without the value, when a live-api feed lacks its key', () => {
    const config = loadHistoryConfig({ HISTORY_STORE_FIRMS: 'live-api' });
    assert.deepEqual([...config.warnings], ['firms uses live-api but FIRMS_MAP_KEY is not set, so its history questions will fail.']);
    assert.deepEqual([...loadHistoryConfig({ HISTORY_STORE_FIRMS: 'live-api', FIRMS_MAP_KEY: 'x' }).warnings], []);
  });

  it('accepts live-only for any feed', () => {
    const config = loadHistoryConfig({ HISTORY_STORE: 'live-only' });
    for (const feed of HISTORY_FEEDS) assert.equal(config.feeds[feed].store, 'live-only');
  });
});

describe('live-only store', () => {
  it('keeps nothing and answers every question with an empty past', async () => {
    const store = createLiveOnlyStore();
    assert.deepEqual(await store.append('vessels', [{ t: NOW, key: 'a', lat: 1, lon: 2 }]), { written: 0 });
    assert.deepEqual(await store.slice('vessels', { t: NOW }), { observations: [], truncated: false });
    assert.equal(await store.latestBefore('vessels', { t: NOW, key: 'a' }), null);
    assert.deepEqual(await store.snapshots('vessels', {}), { snapshots: [], truncated: false });
    const coverage = await store.coverage('vessels', {});
    assert.deepEqual({ count: coverage.count, firstT: coverage.firstT, spans: coverage.spans }, { count: 0, firstT: null, spans: [] });
    assert.deepEqual(await store.prune('vessels', { before: NOW }), { deleted: 0 });
    assert.deepEqual(await store.health(), { backend: 'live-only', ok: true, feeds: {}, keepsHistory: false });
  });

  it('still rejects bad arguments and use after close', async () => {
    const store = createLiveOnlyStore();
    await rejectsWith(store.append('vessels', [{ t: -1, key: 'a' }]), 'INVALID_ARGUMENT');
    await rejectsWith(store.slice('Vessels', { t: NOW }), 'INVALID_ARGUMENT');
    await rejectsWith(store.slice('vessels', { t: 'x' }), 'INVALID_ARGUMENT');
    await store.close();
    await rejectsWith(store.slice('vessels', { t: NOW }), 'CLOSED');
    assert.equal((await store.health()).ok, false);
  });
});

describe('live-api store: shared behaviour (quakes)', () => {
  const answer = (features) => () => json({ type: 'FeatureCollection', features });

  it('asks the USGS event query for the window and returns the newest event per id', async () => {
    const { store, fetchImpl } = makeStore(answer([quake('us1', NOW - 10 * MIN, -120, 35), quake('us2', NOW - 5 * MIN, 150, -10, 4.5)]));
    const result = await store.slice('quakes', { t: NOW, windowMs: HOUR });
    assert.equal(fetchImpl.calls.length, 1);
    const url = new URL(fetchImpl.calls[0].url);
    assert.equal(url.origin + url.pathname, 'https://earthquake.usgs.gov/fdsnws/event/1/query');
    assert.equal(url.searchParams.get('starttime'), new Date(NOW - HOUR).toISOString());
    assert.equal(url.searchParams.get('endtime'), new Date(NOW).toISOString());
    assert.equal(url.searchParams.get('format'), 'geojson');
    assert.equal(url.searchParams.get('minlatitude'), null);
    assert.equal(fetchImpl.calls[0].init.redirect, 'error');
    assert.ok(fetchImpl.calls[0].init.signal instanceof AbortSignal);
    assert.deepEqual(result.observations.map((row) => row.key), ['us1', 'us2']);
    assert.deepEqual(result.observations[1], {
      t: NOW - 5 * MIN,
      key: 'us2',
      lat: -10,
      lon: 150,
      data: { mag: 4.5, magType: 'ml', place: 'somewhere', depthKm: 8.5, status: 'reviewed', tsunami: 0, url: 'https://example.test/us2' },
    });
    assert.equal(result.truncated, false);
  });

  it('drops events outside the window or the box, and records without a usable time', async () => {
    const features = [
      quake('in', NOW - MIN, 10, 10),
      quake('old', NOW - 3 * HOUR, 10, 10),
      quake('outside', NOW - MIN, 100, 10),
      { id: 'notime', geometry: { coordinates: [10, 10, 1] }, properties: {} },
      { geometry: { coordinates: [10, 10, 1] }, properties: { time: NOW - MIN } },
      quake('badlat', NOW - MIN, 10, 99),
    ];
    const { store, fetchImpl } = makeStore(answer(features));
    const result = await store.slice('quakes', { t: NOW, windowMs: HOUR, bbox: { west: 0, south: 0, east: 20, north: 20 } });
    assert.deepEqual(result.observations.map((row) => row.key), ['in']);
    const url = new URL(fetchImpl.calls[0].url);
    assert.deepEqual(['minlatitude', 'maxlatitude', 'minlongitude', 'maxlongitude'].map((k) => url.searchParams.get(k)), ['0', '20', '0', '20']);
  });

  it('asks twice, once per side, for a box across the antimeridian', async () => {
    const { store, fetchImpl } = makeStore(() => json({ features: [] }));
    await store.slice('quakes', { t: NOW, bbox: { west: 170, south: -10, east: -170, north: 10 } });
    const ranges = fetchImpl.calls.map((call) => {
      const p = new URL(call.url).searchParams;
      return [p.get('minlongitude'), p.get('maxlongitude')];
    });
    assert.deepEqual(ranges, [['170', '180'], ['-180', '-170']]);
  });

  it('reports truncation when the limit is filled, and honours the caller limit', async () => {
    const features = [1, 2, 3].map((n) => quake(`e${n}`, NOW - n * MIN, 1, 1));
    const { store, fetchImpl } = makeStore(answer(features));
    const result = await store.slice('quakes', { t: NOW, windowMs: HOUR, limit: 3 });
    assert.equal(result.truncated, true);
    assert.equal(new URL(fetchImpl.calls[0].url).searchParams.get('limit'), '3');
    const capped = await store.slice('quakes', { t: NOW, windowMs: HOUR, limit: 2 });
    assert.equal(capped.observations.length, 2);
    assert.equal(capped.truncated, true);
  });

  it('answers an identical question from the cache, and joins one in flight', async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const { store, fetchImpl, clock } = makeStore(async () => {
      await gate;
      return json({ features: [quake('a', NOW - MIN, 1, 1)] });
    });
    const first = store.slice('quakes', { t: NOW, windowMs: HOUR });
    const second = store.slice('quakes', { t: NOW, windowMs: HOUR });
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(fetchImpl.calls.length, 1);
    a.observations[0].data.mag = 99; // a caller mutating its copy changes nothing for the next
    const third = await store.slice('quakes', { t: NOW, windowMs: HOUR });
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(third.observations[0].data.mag, 3);
    assert.equal(b.observations.length, 1);
    clock.t += 6 * MIN; // past the cache lifetime
    await store.slice('quakes', { t: NOW, windowMs: HOUR });
    assert.equal(fetchImpl.calls.length, 2);
  });

  it('stops asking once the hourly budget is used, and recovers an hour later', async () => {
    const { store, fetchImpl, clock } = makeStore(() => json({ features: [] }));
    const budget = LIVE_API_SUPPORT.quakes.maxPerHour;
    for (let n = 0; n < budget; n += 1) await store.slice('quakes', { t: NOW - n * MIN, windowMs: MIN });
    assert.equal(fetchImpl.calls.length, budget);
    await rejectsWith(store.slice('quakes', { t: NOW - 999 * MIN, windowMs: MIN }), 'BACKEND', /budget/);
    assert.equal(fetchImpl.calls.length, budget);
    const health = await store.health();
    assert.equal(health.feeds.quakes.requestsLastHour, budget);
    assert.match(health.feeds.quakes.lastError, /budget/);
    clock.t += HOUR + 1;
    await store.slice('quakes', { t: clock.t, windowMs: MIN });
    assert.equal(fetchImpl.calls.length, budget + 1);
    assert.equal((await store.health()).feeds.quakes.lastError, null);
  });

  it('turns every failure into a message that names the feed and never the URL', async () => {
    const cases = [
      [() => { throw new TypeError('fetch failed https://user:pw@earthquake.usgs.gov/?key=ABCSECRET'); }, /could not be reached/],
      [() => { throw Object.assign(new Error('x https://leak.example/?token=T0K3N'), { name: 'TimeoutError' }); }, /timed out/],
      [() => ({ status: 500, body: 'oops <script> https://leak.example/?k=1' }), /answered HTTP 500/],
      [() => ({ status: 429, body: 'slow down' }), /rate limiting/],
      [() => ({ status: 200, body: 'not json https://leak.example/?k=2' }), /not JSON/],
      [() => json({ nofeatures: true }), /no features/],
    ];
    for (const [respond, pattern] of cases) {
      const { store } = makeStore(respond);
      await assert.rejects(store.slice('quakes', { t: NOW, windowMs: HOUR }), (error) => {
        assert.equal(error.code, 'BACKEND');
        assert.match(error.message, /^quakes history source: /);
        assert.match(error.message, pattern);
        for (const leak of ['https://', 'user:pw', 'ABCSECRET', 'T0K3N', 'leak.example', 'script', 'slow down'])
          assert.ok(!error.message.includes(leak), `message leaked ${leak}`);
        assert.equal(error.cause, undefined);
        return true;
      });
    }
  });

  it('refuses a response over the size cap', async () => {
    const { store } = makeStore(() => ({ status: 200, body: 'x'.repeat(2000) }), { store: { maxResponseBytes: 1000 } });
    await rejectsWith(store.slice('quakes', { t: NOW, windowMs: HOUR }), 'BACKEND', /too large/);
  });

  it('rejects a window wider than the source allows, a future time and an unknown feed', async () => {
    const { store, fetchImpl } = makeStore(() => json({ features: [] }));
    await rejectsWith(store.slice('quakes', { t: NOW, windowMs: 32 * DAY }), 'INVALID_ARGUMENT', /at most/);
    await rejectsWith(store.slice('quakes', { t: NOW + HOUR }), 'INVALID_ARGUMENT', /future/);
    await rejectsWith(store.slice('vessels', { t: NOW }), 'INVALID_ARGUMENT', /no live history source/);
    assert.equal(fetchImpl.calls.length, 0);
    await store.slice('quakes', { t: NOW + MIN, windowMs: HOUR }); // inside the clock slack
    assert.equal(new URL(fetchImpl.calls[0].url).searchParams.get('endtime'), new Date(NOW).toISOString());
  });

  it('stores nothing: append reports 0 written and prune deletes 0', async () => {
    const { store, fetchImpl } = makeStore(() => json({ features: [] }));
    assert.deepEqual(await store.append('quakes', [{ t: NOW, key: 'a', lat: 1, lon: 1 }]), { written: 0 });
    await rejectsWith(store.append('quakes', [{ t: NOW }]), 'INVALID_ARGUMENT');
    assert.deepEqual(await store.prune('quakes', { before: NOW }), { deleted: 0 });
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('reports one continuous span for coverage, and no snapshot times', async () => {
    const { store, fetchImpl } = makeStore(() => json({ features: [] }));
    const coverage = await store.coverage('quakes', { from: NOW - DAY, to: NOW + DAY });
    assert.deepEqual(
      { continuous: coverage.continuous, count: coverage.count, lastT: coverage.lastT, spans: coverage.spans },
      { continuous: true, count: 0, lastT: NOW, spans: [{ from: NOW - DAY, to: NOW, snapshots: 0 }] },
    );
    assert.deepEqual(await store.snapshots('quakes', {}), { snapshots: [], truncated: false, continuous: true });
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('finds one key with latestBefore, looking back a day', async () => {
    const { store, fetchImpl } = makeStore(answer([quake('a', NOW - 20 * HOUR, 1, 1), quake('b', NOW - HOUR, 2, 2)]));
    assert.equal((await store.latestBefore('quakes', { t: NOW, key: 'a' })).key, 'a');
    assert.equal(await store.latestBefore('quakes', { t: NOW, key: 'zzz' }), null);
    const url = new URL(fetchImpl.calls[0].url);
    assert.equal(url.searchParams.get('starttime'), new Date(NOW - DAY).toISOString());
  });

  it('reports health without calling the source, and refuses use once closed', async () => {
    const { store, fetchImpl } = makeStore(() => json({ features: [] }));
    const health = await store.health();
    assert.equal(health.ok, true);
    assert.equal(health.keepsHistory, false);
    assert.deepEqual(Object.keys(health.feeds).sort(), liveApiFeeds().sort());
    assert.equal(fetchImpl.calls.length, 0);
    await store.close();
    await rejectsWith(store.slice('quakes', { t: NOW }), 'CLOSED');
    assert.equal((await store.health()).ok, false);
  });
});

describe('live-api store: NASA FIRMS', () => {
  const header = 'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight';
  const row = (lat, lon, date, time, extra = {}) =>
    [lat, lon, extra.bright ?? 330.1, 0.4, 0.4, date, time, 'N', 'VIIRS', extra.conf ?? 'n', '2.0NRT', 290.2, extra.frp ?? 5.5, 'D'].join(',');
  const csv = (...rows) => [header, ...rows].join('\n') + '\n';

  it('asks for the day range from the start date and maps detections like the recorder', async () => {
    const { store, fetchImpl } = makeStore(() => ({ body: csv(row(34.1, -118.2, '2026-10-31', '1005'), row(34.1, -118.2, '2026-10-30', '2330')) }));
    const result = await store.slice('firms', { t: NOW, windowMs: 2 * DAY });
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].url, 'https://firms.modaps.eosdis.nasa.gov/api/area/csv/SECRETKEY123/VIIRS_SNPP_NRT/world/3/2026-10-29');
    assert.deepEqual(result.observations.map((o) => [o.key, o.t]), [
      ['VIIRS:N:34.1000:-118.2000', Date.UTC(2026, 9, 31, 10, 5)],
    ]);
    assert.deepEqual(result.observations[0].data, {
      frp: 5.5, confidence: 'n', brightness: 330.1, brightnessTi5: 290.2, daynight: 'D', satellite: 'N', instrument: 'VIIRS',
    });
  });

  it('keeps only detections between the window start and t', async () => {
    const { store } = makeStore(() => ({ body: csv(row(1, 1, '2026-10-31', '1100'), row(2, 2, '2026-10-31', '1300'), row(3, 3, '2026-10-30', '0100')) }));
    const result = await store.slice('firms', { t: NOW, windowMs: 2 * HOUR });
    assert.deepEqual(result.observations.map((o) => o.lat), [1]);
  });

  it('splits a long window into requests of at most 5 days, and boxes at the antimeridian', async () => {
    const { store, fetchImpl } = makeStore(() => ({ body: csv() }));
    await store.slice('firms', { t: NOW, windowMs: 8 * DAY, bbox: { west: 170, south: 0, east: -170, north: 10 } });
    assert.deepEqual(
      fetchImpl.calls.map((call) => call.url.split('/').slice(-3).join('/')),
      ['170,0,180,10/5/2026-10-23', '170,0,180,10/4/2026-10-28', '-180,0,-170,10/5/2026-10-23', '-180,0,-170,10/4/2026-10-28'],
    );
  });

  it('never lets the key into an error, health, cache key or thrown cause', async () => {
    const key = 'SECRETKEY123';
    const failures = [
      () => { throw new TypeError(`fetch failed for https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/x`); },
      () => ({ status: 403, body: `Invalid MAP_KEY ${key}` }),
      () => ({ status: 500, body: key }),
      () => ({ status: 200, body: `<html>${key}</html>` }),
    ];
    for (const respond of failures) {
      const { store } = makeStore(respond);
      await assert.rejects(store.slice('firms', { t: NOW, windowMs: HOUR }), (error) => {
        const seen = [error.message, String(error.cause), JSON.stringify(error), error.stack.split('\n')[0]].join('\n');
        for (const form of [key, encodeURIComponent(key), Buffer.from(key).toString('base64'), key.slice(-6), key.slice(0, 6)])
          assert.ok(!seen.includes(form), `leaked ${form}`);
        return true;
      });
      const health = JSON.stringify(await store.health());
      assert.ok(!health.includes(key));
    }
  });

  it('says so when the key is missing or rejected', async () => {
    const { store, fetchImpl } = makeStore(() => ({ body: csv() }), { env: { FIRMS_MAP_KEY: '  ' } });
    await rejectsWith(store.slice('firms', { t: NOW }), 'BACKEND', /FIRMS_MAP_KEY is not set/);
    assert.equal(fetchImpl.calls.length, 0);
    const rejected = makeStore(() => ({ status: 403, body: 'Invalid MAP_KEY' }));
    await rejectsWith(rejected.store.slice('firms', { t: NOW }), 'BACKEND', /rejected the key/);
  });

  it('answers empty for a time before the product reaches', async () => {
    const { store, fetchImpl } = makeStore(() => ({ body: csv() }));
    assert.deepEqual(await store.slice('firms', { t: NOW - 61 * DAY }), { observations: [], truncated: false });
    assert.equal(fetchImpl.calls.length, 0);
    assert.equal((await store.coverage('firms', {})).firstT, NOW - 60 * DAY);
  });
});

describe('live-api store: USGS water', () => {
  const series = (code, variable, points, lat = 38.9, lon = -77.1) => ({
    sourceInfo: { siteName: `Gauge ${code}`, siteCode: [{ value: code }], geoLocation: { geogLocation: { latitude: lat, longitude: lon } } },
    variable: { variableCode: [{ value: variable }] },
    values: [{ value: points.map(([iso, value]) => ({ dateTime: iso, value: String(value) })) }],
  });
  const body = (...timeSeries) => json({ value: { timeSeries } });
  const box = { west: -77.2, south: 38.8, east: -77, north: 39 };

  it('needs a small bounding box and says what to do', async () => {
    const { store, fetchImpl } = makeStore(() => body());
    await rejectsWith(store.slice('water', { t: NOW }), 'INVALID_ARGUMENT', /needs a bounding box/);
    await rejectsWith(store.slice('water', { t: NOW, bbox: { west: -100, south: 30, east: -90, north: 40 } }), 'INVALID_ARGUMENT', /25 square degrees/);
    await rejectsWith(store.slice('water', { t: NOW, bbox: { west: 170, south: 0, east: -170, north: 1 } }), 'INVALID_ARGUMENT', /antimeridian/);
    await rejectsWith(store.slice('water', { t: NOW, windowMs: 7 * HOUR, bbox: box }), 'INVALID_ARGUMENT', /at most/);
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('reports each gauge at its newest reading at or before t, joining both parameters', async () => {
    const { store, fetchImpl } = makeStore(() =>
      body(
        series('01646305', '00060', [['2026-10-31T11:40:00.000-00:00', 12.5], ['2026-10-31T11:55:00.000-00:00', 13.5], ['2026-10-31T12:05:00.000-00:00', 99]]),
        series('01646305', '00065', [['2026-10-31T11:50:00.000-00:00', 2.25]]),
        series('0164', '00060', [['2026-10-31T11:50:00.000-00:00', -999999]]),
        series('0165', '00010', [['2026-10-31T11:50:00.000-00:00', 7]]),
      ),
    );
    const result = await store.slice('water', { t: NOW, windowMs: HOUR, bbox: box });
    assert.deepEqual(result.observations, [
      { t: Date.UTC(2026, 9, 31, 11, 55), key: '01646305', lat: 38.9, lon: -77.1, data: { name: 'Gauge 01646305', dischargeCfs: 13.5, gageHeightFt: 2.25 } },
    ]);
    const url = new URL(fetchImpl.calls[0].url);
    assert.equal(url.origin + url.pathname, 'https://waterservices.usgs.gov/nwis/iv/');
    assert.equal(url.searchParams.get('bBox'), '-77.200000,38.800000,-77.000000,39.000000');
    assert.equal(url.searchParams.get('startDT'), '2026-10-31T11:00Z');
    assert.equal(url.searchParams.get('endDT'), '2026-10-31T12:00Z');
  });

  it('treats 404 as no gauges and refuses a time older than the service holds', async () => {
    const { store, fetchImpl } = makeStore(() => ({ status: 404, body: 'No sites found' }));
    assert.deepEqual(await store.slice('water', { t: NOW, bbox: box }), { observations: [], truncated: false });
    assert.deepEqual(await store.slice('water', { t: NOW - 121 * DAY, bbox: box }), { observations: [], truncated: false });
    assert.equal(fetchImpl.calls.length, 1);
  });
});

describe('live-api store: launches', () => {
  it('maps launches with the pad position, and reports a short page as truncated', async () => {
    const launch = (id, net, lat, lon) => ({
      id, name: `L ${id}`, net, status: { abbrev: 'Success' }, window_start: net, window_end: net,
      pad: { name: 'Pad 1', latitude: lat, longitude: lon }, launch_service_provider: { name: 'Rocket Lab' },
      rocket: { configuration: { name: 'Electron' } },
    });
    const { store, fetchImpl } = makeStore(() =>
      json({ count: 5, results: [launch('a', '2026-10-30T12:00:00Z', -39.26, 177.86), { id: 'nopad', net: '2026-10-30T13:00:00Z' }, { id: 'badnet', net: 'nope' }] }),
    );
    const result = await store.slice('launches', { t: NOW, windowMs: 7 * DAY });
    assert.deepEqual(result.observations.map((o) => [o.key, o.lat, o.lon]), [['a', -39.26, 177.86], ['nopad', null, null]]);
    assert.equal(result.observations[0].data.provider, 'Rocket Lab');
    assert.equal(result.truncated, true);
    const url = new URL(fetchImpl.calls[0].url);
    assert.equal(url.origin + url.pathname, 'https://ll.thespacedevs.com/2.3.0/launches/');
    assert.equal(url.searchParams.get('mode'), 'normal');
    assert.equal(url.searchParams.get('net__lte'), new Date(NOW).toISOString());
  });

  it('keeps to 10 questions an hour', async () => {
    const { store } = makeStore(() => json({ count: 0, results: [] }));
    for (let n = 0; n < 10; n += 1) await store.slice('launches', { t: NOW - n * MIN, windowMs: DAY });
    await rejectsWith(store.slice('launches', { t: NOW - 99 * MIN, windowMs: DAY }), 'BACKEND', /budget/);
  });
});

describe('geometry helpers', () => {
  it('tests boxes across the antimeridian and splits them', () => {
    const across = { west: 170, south: -10, east: -170, north: 10 };
    assert.equal(inBox(across, 0, 175), true);
    assert.equal(inBox(across, 0, -175), true);
    assert.equal(inBox(across, 0, 0), false);
    assert.equal(inBox(across, 20, 175), false);
    assert.equal(inBox(across, null, null), false);
    assert.deepEqual(splitBox(across).map((b) => [b.west, b.east]), [[170, 180], [-180, -170]]);
    assert.deepEqual(splitBox(null), [{ west: -180, south: -90, east: 180, north: 90 }]);
  });
});

describe('the store router with the live backends', () => {
  it('routes each feed by its setting and publishes the support table', async () => {
    const fetchImpl = fakeFetch(() => json({ features: [quake('a', NOW - MIN, 1, 1)] }));
    const store = createHistoryStore(
      { HISTORY_STORE: 'live-only', HISTORY_STORE_QUAKES: 'live-api', HISTORY_SQLITE_PATH: ':memory:', HISTORY_STORE_AIRCRAFT: 'sqlite' },
      {
        backends: {
          sqlite: () => createLiveOnlyStore(),
          'live-only': () => createLiveOnlyStore(),
          'live-api': () => createLiveApiStore({ adapters: buildLiveApiAdapters({}), fetch: fetchImpl, now: () => NOW }),
        },
      },
    );
    const quakes = await store.slice('quakes', { t: NOW, windowMs: HOUR });
    assert.equal(quakes.observations.length, 1);
    assert.deepEqual(await store.slice('vessels', { t: NOW }), { observations: [], truncated: false });
    const modes = Object.fromEntries(store.support().map((row) => [row.feed, `${row.mode}/${row.slider}`]));
    assert.equal(modes.quakes, 'live-api/available');
    assert.equal(modes.vessels, 'live-only/hidden');
    assert.equal(modes.aircraft, 'stored/available');
    const health = await store.health();
    assert.equal(health.ok, true);
    assert.deepEqual(Object.keys(health.backends).sort(), ['live-api', 'live-only', 'sqlite']);
    await store.close();
  });

  it('builds the real live backends from the environment with no network use', async () => {
    const store = createHistoryStore({ HISTORY_STORE: 'live-api', HISTORY_SQLITE_PATH: '/nonexistent/never-created/h.sqlite' });
    assert.equal(store.config.feeds.quakes.store, 'live-api');
    assert.equal(store.config.feeds.aircraft.store, 'live-only');
    assert.deepEqual(await store.append('aircraft', [{ t: NOW, key: 'a', lat: 1, lon: 1 }]), { written: 0 });
    assert.equal((await store.health()).ok, true);
    await store.close();
  });
});
