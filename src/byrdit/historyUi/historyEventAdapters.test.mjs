import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ALL_HISTORY_ADAPTERS,
  BIKESHARE_ADAPTER,
  CYCLONE_NONE_REASON,
  EVENT_ADAPTERS,
  GBFS_SYSTEM_BY_URL,
  PERIMETER_UNKNOWN_PREFIX,
  TRANSIT_ADAPTER,
  firmsBboxes,
  gbfsTargetOf,
  perimeterUnknownLine,
  transitFeedOf,
} from './historyEventAdapters.js';
import { adapterForPath, sliceUrl } from './historyAdapters.js';
import { createHistoryRouter } from './historyRouter.js';
import { createRefreshDriver, RELEASE_DEBOUNCE_MS } from './historyRefresh.js';
import { createLayerChips, TRUNCATED_CHIP } from './layerChips.js';
import { createFeedChips } from './feedChips.js';
import { fakeClock, fakeWindow, flush, jsonResponse } from './fakeDom.mjs';
import {
  CYCLONE_ENVELOPE,
  cycloneStorm,
  firmsBody,
  firmsRow,
  gbfsEnvelope,
  gbfsInfoStation,
  gbfsStatusStation,
  launchResult,
  perimeterRow,
  transitVehicle,
} from '../history/historyRows.js';
import { createFirmsSource } from '../../layers/firms/source.js';
import { adaptFirmsRecords } from '../../data/firmsAdapt.js';
import { createWfigsPerimeterSource } from '../../layers/perimeters/source.js';
import { buildIncidentCard } from '../../layers/perimeters/cards.js';
import {
  createCycloneSource,
  validateCycloneSnapshot,
} from '../../layers/cyclones/source.js';
import { createLaunchSource } from '../../layers/launches/source.js';
import { createModel as createLaunchModel } from '../../layers/launches/model.js';
import { createTransitSource } from '../../layers/transit/source.js';
import { createBikeshareSource } from '../../layers/bikeshare/source.js';
import {
  parseStationInformation,
  parseStationStatus,
} from '../../sources/gbfsStations.js';
import { GBFS_CITY_REGISTRY } from '../../layers/bikeshare/registry.js';

const fixture = (name) =>
  readFileSync(new URL(`../history/fixtures/${name}`, import.meta.url), 'utf8');
const docs = JSON.parse(fixture('b9-es-docs.json'));
const liveFirms = JSON.parse(fixture('b6-collector-firms.body'));
const livePerimeters = JSON.parse(fixture('b6-collector-fire-perimeters.body'));
const liveCyclones = JSON.parse(fixture('b6-collector-cyclones.body'));
const liveLaunches = JSON.parse(fixture('b7-collector-launches.body'));
const liveTransit = JSON.parse(
  fixture('b15-collector-transit-translink-seq.body'),
);
const liveGbfsStatus = JSON.parse(fixture('b15-gbfs-madison-status.body'));

const T = Date.parse('2026-10-14T14:00:00Z');
const NOW = Date.parse('2026-10-16T18:00:00.250Z');
const DELTA = NOW - T;
const ORIGIN = 'https://gev.example';
const src = (list) => list.map((h) => h._source);
const answer = (body, headers = {}) => ({
  body,
  headers: Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  ),
});
const byId = (id) => ALL_HISTORY_ADAPTERS.find((a) => a.id === id);
/** The adapted answer as the Response a live source reads. */
const respond = (adapted) =>
  new Response(JSON.stringify(adapted.body), {
    status: 200,
    headers: adapted.headers,
  });
const fetchOf = (adapted) => async () => respond(adapted);
const liveFetch = (body) => async () =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

// ── registry ──────────────────────────────────────────────

test('registry: B12a feeds + FIRMS/perimeters/cyclones/launches + transit/bike share (owner decision option A)', () => {
  assert.deepEqual(
    ALL_HISTORY_ADAPTERS.map((a) => [a.id, a.layerId, a.sliceFeed, a.rebased]),
    [
      ['flights', 'flights', 'aircraft', true],
      ['military', 'military', 'military', true],
      ['vessels', 'ais-live-vessels', 'vessels', true],
      ['firms', 'local-firms', 'firms', false],
      ['fire-perimeters', 'fire-perimeters', 'fire-perimeters', false],
      ['cyclones', 'weather-cyclones', 'cyclones', false],
      ['launches', 'rocket-launches', 'launches', false],
      ['transit', 'transit', 'transit', true],
      ['bikeshare', 'bikeshare', 'bikeshare', false],
      ['quakes', 'earthquakes', 'quakes', false],
      ['wind', 'wind', 'wind', false],
    ],
  );
  const find = (p) => adapterForPath(p, ALL_HISTORY_ADAPTERS)?.id ?? null;
  assert.equal(find('/api/firms'), 'firms');
  assert.equal(find('/api/fire-perimeters'), 'fire-perimeters');
  assert.equal(find('/api/cyclones'), 'cyclones');
  assert.equal(find('/api/launches'), 'launches');
  assert.equal(find('/api/launches/'), 'launches');
  assert.equal(find('/api/transit/vehicles/translink-seq'), 'transit');
  assert.equal(find('/api/transit/feeds'), null);
  assert.equal(find('/api/transit/trail/a/b'), null);
  assert.equal(find('/api/gbfs/x'), 'bikeshare');
  assert.equal(find('/api/celestrak/active'), null);
  assert.equal(EVENT_ADAPTERS.length, 6);
  // per-time station information: reload once per frame (historyRefresh)
  assert.equal(BIKESHARE_ADAPTER.reloadOnFrame, true);
  assert.equal(
    ALL_HISTORY_ADAPTERS.filter((a) => a.reloadOnFrame)
      .map((a) => a.id)
      .join(),
    'bikeshare',
  );
  assert.equal(TRANSIT_ADAPTER.match.test('/api/transit/vehicles/a%2Fb'), true);
  assert.equal(TRANSIT_ADAPTER.rebased, true);
  assert.equal(BIKESHARE_ADAPTER.match.test('/api/gbfs/https%3A%2F%2Fx'), true);
});

// ── FIRMS ─────────────────────────────────────────────────

test('D7 FIRMS: the camera box is always sent, whole degrees outward; crossing = two boxes; no view = whole globe', () => {
  assert.deepEqual(firmsBboxes([-106.62, 25.81, -93.47, 36.5]), [
    '-107,25,-93,37',
  ]);
  assert.deepEqual(firmsBboxes([170.4, -10.2, -170.6, 10.1]), [
    '170,-11,180,11',
    '-180,-11,-170,11',
  ]);
  assert.deepEqual(firmsBboxes(null), ['-180,-90,180,90']);
  assert.deepEqual(firmsBboxes([1, 2, 3]), ['-180,-90,180,90']);
  assert.deepEqual(firmsBboxes([-180, -90, 180, 90]), ['-180,-90,180,90']);
  const firms = byId('firms');
  const url = new URL(`${ORIGIN}/api/firms`);
  assert.deepEqual(
    firms.sliceParams(url, { viewBox: () => [10.5, 20, 11, 21] }),
    [{ bbox: '10,20,11,21' }],
  );
  // a throwing camera never breaks the request: whole globe
  assert.deepEqual(
    firms.sliceParams(url, {
      viewBox: () => {
        throw new Error('no camera');
      },
    }),
    [{ bbox: '-180,-90,180,90' }],
  );
  assert.equal(
    sliceUrl(firms, { bbox: '10,20,11,21' }, T),
    '/api/history/slice?feed=firms&t=2026-10-14T14%3A00%3A00.000Z&bbox=10%2C20%2C11%2C21',
  );
});

test('FIRMS: the history answer parses exactly like the equivalent live payload; acquisition times are not rebased', async () => {
  const rows = [...src(docs.fires), ...src(docs.fires_hist)]
    .map(firmsRow)
    .filter(Boolean);
  const counts = new Map([['VIIRS_NOAA21_NRT', rows.length]]);
  const slice = firmsBody(rows, counts, T);
  // the B9 row keys are the live /api/firms row keys
  assert.deepEqual(
    Object.keys(rows[0]).sort(),
    Object.keys(liveFirms.fires[0]).sort(),
  );
  const adapted = byId('firms').adapt(
    [
      answer(slice, {
        'X-History-Rows': String(rows.length),
        'X-History-Truncated': '1',
      }),
    ],
    { t: T, nowMs: NOW },
  );
  const live = { ...slice }; // the same detections as a live answer
  const fromHistory = await createFirmsSource({
    fetchImpl: fetchOf(adapted),
  }).getSnapshot();
  const fromLive = await createFirmsSource({
    fetchImpl: liveFetch(live),
  }).getSnapshot();
  assert.deepEqual(
    adaptFirmsRecords(fromHistory.fires),
    adaptFirmsRecords(fromLive.fires),
  );
  assert.equal(fromHistory.fetchedAt, T, 'event feed: the slice time, not now');
  assert.equal(fromHistory.stale, false);
  assert.equal(adapted.headers['X-History-Truncated'], '1');
  assert.equal(adapted.headers['X-History-Gap'], undefined);
  // the live fixture still parses (shape unchanged)
  assert.equal(
    adaptFirmsRecords(liveFirms.fires).length,
    liveFirms.fires.length,
  );
});

test('FIRMS: two boxes of a crossing view merge without duplicates; gap -> nothing', () => {
  const f = (lon) => ({
    lat: 1,
    lon,
    acqDate: '2026-10-14',
    acqTime: '1200',
    satellite: 'N',
    instrument: 'VIIRS',
  });
  const a = answer({
    fetchedAt: T,
    fires: [f(179.5), f(180)],
    sources: [{ source: 'A', count: 2 }],
  });
  const b = answer({
    fetchedAt: T,
    fires: [f(180), f(-179.5)],
    sources: [{ source: 'A', count: 2 }],
  });
  const out = byId('firms').adapt([a, b], { t: T, nowMs: NOW });
  assert.deepEqual(
    out.body.fires.map((x) => x.lon),
    [179.5, 180, -179.5],
  );
  assert.equal(out.body.count, 3);
  const gap = byId('firms').adapt(
    [answer({ fetchedAt: T, fires: [] }, { 'X-History-Gap': '1' })],
    { t: T, nowMs: NOW },
  );
  assert.deepEqual(gap.body.fires, []);
  assert.equal(gap.headers['X-History-Gap'], '1');
});

// ── perimeters ────────────────────────────────────────────

test('perimeters: live keys; parsed like live; the unrecorded fields stay null and the card says unknown, never 0', async () => {
  const rows = src(docs.perimeters).map(perimeterRow).filter(Boolean);
  assert.ok(rows.length > 0);
  assert.deepEqual(
    Object.keys(rows[0]).sort(),
    Object.keys(livePerimeters.rows[0]).sort(),
  );
  const adapted = byId('fire-perimeters').adapt(
    [answer({ fetchedAt: T, rows }, { 'X-History-Rows': String(rows.length) })],
    { t: T, nowMs: NOW },
  );
  const fromHistory = await createWfigsPerimeterSource({
    fetchImpl: fetchOf(adapted),
  }).getSnapshot();
  const fromLive = await createWfigsPerimeterSource({
    fetchImpl: liveFetch({ fetchedAt: T, rows }),
  }).getSnapshot();
  assert.deepEqual(
    fromHistory.map(({ historyUnknown, ...r }) => r),
    fromLive,
    'every live key and value unchanged',
  );
  for (const row of fromHistory) {
    for (const k of [
      'category',
      'discoveredTime',
      'cause',
      'behavior',
      'personnel',
      'costToDate',
      'complexity',
      'complexName',
    ])
      assert.equal(row[k], null, k);
    assert.equal(
      row.historyUnknown,
      `${PERIMETER_UNKNOWN_PREFIX}category, discovery time, cause, behavior, personnel, cost, complexity, complex`,
    );
    const card = buildIncidentCard(row, NOW);
    const text = card.details.join('\n');
    assert.ok(text.includes(row.historyUnknown), 'unknown fields are named');
    assert.doesNotMatch(text, /\b0 personnel|\$0|discovered|cause ·|part of /);
    assert.match(text, /updated \d+[mhd] ago/, 'the recorded update time');
  }
  // a live row with every field gives no unknown line
  assert.equal(
    perimeterUnknownLine(livePerimeters.rows[0]),
    `${PERIMETER_UNKNOWN_PREFIX}complex`,
  );
  assert.equal(
    perimeterUnknownLine({ ...livePerimeters.rows[0], complexName: 'X' }),
    null,
  );
  assert.equal(
    buildIncidentCard(livePerimeters.rows[0], NOW).details.some((d) =>
      d.startsWith(PERIMETER_UNKNOWN_PREFIX),
    ),
    false,
  );
});

test('perimeters: gap -> nothing', async () => {
  const adapted = byId('fire-perimeters').adapt(
    [answer({ fetchedAt: T, rows: [] })],
    { t: T, nowMs: NOW },
  );
  assert.deepEqual(
    await createWfigsPerimeterSource({
      fetchImpl: fetchOf(adapted),
    }).getSnapshot(),
    [],
  );
  assert.equal(adapted.headers['X-History-Gap'], '1');
});

// ── cyclones ──────────────────────────────────────────────

const cycloneSlice = (storms, bestTrackStorms = []) => ({
  ...CYCLONE_ENVELOPE,
  fetchedAt: T,
  stale: false,
  unavailable: false,
  reason: null,
  storms,
  bestTrackStorms,
});

test('cyclones: the envelope validates like live; positions only (recorded track/cone are not drawable); times not rebased', async () => {
  // the slice keeps the newest advisory per storm (the fixture holds two)
  const newest = new Map();
  for (const s of src(docs.cyclones_nhc).map(cycloneStorm))
    if (
      s?.advisoryNumber !== null &&
      !(newest.get(s.id)?.issuedAt > s.issuedAt)
    )
      newest.set(s.id, s);
  const storms = [...newest.values()];
  const best = src(docs.cyclones_atcf).map(cycloneStorm).filter(Boolean);
  assert.ok(storms.length > 0 && best.length > 0);
  const adapted = byId('cyclones').adapt([answer(cycloneSlice(storms, best))], {
    t: T,
    nowMs: NOW,
  });
  const fromHistory = await createCycloneSource({
    fetchImpl: fetchOf(adapted),
  }).getSnapshot();
  const fromLive = await createCycloneSource({
    fetchImpl: liveFetch(cycloneSlice(storms)),
  }).getSnapshot();
  assert.deepEqual(
    fromHistory,
    fromLive,
    'the validator output equals the live parse',
  );
  for (const s of fromHistory.storms) {
    assert.equal(s.geometryStatus, 'unavailable');
    assert.equal(s.track, null);
    assert.equal(s.cone, null);
    assert.deepEqual(s.forecastPoints, []);
    assert.equal(s.issuedAt, s.positionAt, 'advisory time, not rebased');
    assert.ok(Date.parse(s.issuedAt) <= T);
  }
  assert.equal(
    fromHistory.storms.length,
    storms.length,
    'ATCF best track is not drawn',
  );
  assert.equal(fromHistory.fetchedAt, T);
  // the live fixture still validates
  assert.equal(
    validateCycloneSnapshot(liveCyclones).storms.length,
    liveCyclones.storms.length,
  );
});

test('cyclones gap: no advisory recorded -> unavailable + reason (draws nothing; never "no active storms")', async () => {
  const adapted = byId('cyclones').adapt([answer(cycloneSlice([]))], {
    t: T,
    nowMs: NOW,
  });
  const snap = await createCycloneSource({
    fetchImpl: fetchOf(adapted),
  }).getSnapshot();
  assert.equal(snap.unavailable, true);
  assert.equal(snap.reason, CYCLONE_NONE_REASON);
  assert.deepEqual(snap.storms, []);
  assert.equal(adapted.headers['X-History-Gap'], '1');
});

// ── launches ──────────────────────────────────────────────

const launchModel = () =>
  createLaunchModel({
    state: {},
    services: {},
    parts: { policyHelpers: { parseMissionDurationSeconds: () => null } },
  });

test('launches: LL2 subset parses like live; the 30-day NET window ends at t (touch point), NET not rebased', async () => {
  const results = src(docs.launches).map(launchResult).filter(Boolean);
  assert.ok(results.length > 0);
  for (const k of Object.keys(results[0]))
    assert.ok(k in liveLaunches.results[0], `live LL2 key ${k}`);
  // a t whose launches are all more than 30 days before the browser now
  const t = Math.max(...results.map((r) => Date.parse(r.net))) + 3_600_000;
  const now = t + 45 * 86_400_000;
  const adapted = byId('launches').adapt(
    [answer({ count: results.length, next: null, previous: null, results })],
    { t, nowMs: now },
  );
  const fromHistory = await createLaunchSource({
    fetchImpl: fetchOf(adapted),
  }).getLaunches();
  const fromLive = await createLaunchSource({
    fetchImpl: liveFetch({
      count: results.length,
      next: null,
      previous: null,
      results,
    }),
  }).getLaunches();
  assert.equal(fromHistory.gevAsOf, t);
  const model = launchModel();
  const asOf = (p) => p?.gevAsOf && new Date(p.gevAsOf); // the ingestion.js touch point
  const shown = model.normalizeRocketLaunches(fromHistory, asOf(fromHistory));
  const liveAtT = model.normalizeRocketLaunches(fromLive, new Date(t));
  assert.deepEqual(shown, liveAtT, 'same records as the live parser at t');
  const inWindow = results.filter(
    (r) =>
      Date.parse(r.net) <= t &&
      Date.parse(r.net) >= t - 30 * 86_400_000 &&
      Number.isFinite(r.pad.latitude),
  );
  assert.equal(shown.length, inWindow.length);
  for (const l of shown)
    assert.equal(
      l.launchTime,
      new Date(
        Date.parse(results.find((r) => r.id === l.id).net),
      ).toISOString(),
    );
  // without the touch point the browser clock would drop them all
  const realNow = Date.now;
  Date.now = () => now;
  try {
    assert.equal(
      model.normalizeRocketLaunches(fromHistory, new Date(now)).length,
      0,
    );
  } finally {
    Date.now = realNow;
  }
  // a live payload has no gevAsOf: the default (browser clock) applies
  assert.equal(asOf(liveLaunches), undefined);
});

test('launches gap -> nothing', async () => {
  const adapted = byId('launches').adapt(
    [answer({ count: 0, next: null, previous: null, results: [] })],
    { t: T, nowMs: NOW },
  );
  const p = await createLaunchSource({
    fetchImpl: fetchOf(adapted),
  }).getLaunches();
  assert.deepEqual(p.results, []);
  assert.equal(adapted.headers['X-History-Gap'], '1');
});

// ── transit ───────────────────────────────────────────────

const transitSlice = () => {
  const vehicles = (feedId, n) =>
    Array.from({ length: n }, (_, i) =>
      transitVehicle({
        feed_id: feedId,
        vehicle_id: `${feedId}-v${i}`,
        '@timestamp': new Date(T - (i + 1) * 15_000).toISOString(),
        location: { lat: -27.4 + i / 100, lon: 153 + i / 100 },
        bearing_deg: 90,
        speed_ms: 5,
        route_id: 'R1',
      }),
    );
  const feed = (feedId, n) => ({
    feedId,
    name: feedId,
    fetchedAt: T,
    feedTimestamp: null,
    version: null,
    entityCount: n,
    truncated: false,
    count: n,
    vehicles: vehicles(feedId, n),
  });
  return {
    fetchedAt: T,
    feeds: [feed('a/b feed', 2), feed('translink-seq', 3)],
  };
};

test('transit: the one feed of the request is selected (encoded id); times rebased by now - t (D2)', async () => {
  assert.equal(
    transitFeedOf('/api/transit/vehicles/translink-seq'),
    'translink-seq',
  );
  assert.equal(transitFeedOf('/api/transit/vehicles/a%2Fb%20feed'), 'a/b feed');
  assert.equal(transitFeedOf('/api/transit/vehicles/%E0%A4'), null);
  assert.equal(transitFeedOf('/api/transit/feeds'), null);
  const slice = transitSlice();
  const url = new URL(`${ORIGIN}/api/transit/vehicles/translink-seq`);
  const out = TRANSIT_ADAPTER.adapt(
    [answer(slice, { 'X-History-Rows': '5' })],
    { t: T, nowMs: NOW, url },
  );
  assert.equal(out.body.feedId, 'translink-seq');
  assert.equal(out.body.count, 3);
  assert.deepEqual(
    Object.keys(out.body).sort(),
    Object.keys(liveTransit).sort(),
    'live snapshot keys',
  );
  assert.deepEqual(
    Object.keys(out.body.vehicles[0]).sort(),
    Object.keys(liveTransit.vehicles[0]).sort(),
  );
  assert.equal(out.body.fetchedAt, NOW, 'poll time t shown as now');
  const recorded = slice.feeds[1].vehicles;
  out.body.vehicles.forEach((v, i) => {
    assert.equal(v.timestamp * 1000 - recorded[i].timestamp * 1000, DELTA);
    assert.equal(
      NOW - v.timestamp * 1000,
      T - recorded[i].timestamp * 1000,
      'age at t kept',
    );
    assert.equal(v.timestampSource, 'recorded');
  });
  const other = TRANSIT_ADAPTER.adapt([answer(slice)], {
    t: T,
    nowMs: NOW,
    url: new URL(`${ORIGIN}/api/transit/vehicles/a%2Fb%20feed`),
  });
  assert.equal(other.body.feedId, 'a/b feed');
  assert.equal(other.body.count, 2);
  // the live transit source reads it unchanged
  const snap = await (
    await createTransitSource({ fetchImpl: fetchOf(out) }).requestSnapshot(
      'translink-seq',
    )
  ).json();
  assert.deepEqual(snap, out.body);
});

test('transit gap: a feed absent from the slice -> an empty snapshot (nothing), never another feed', () => {
  const url = new URL(`${ORIGIN}/api/transit/vehicles/nope`);
  const out = TRANSIT_ADAPTER.adapt([answer(transitSlice())], {
    t: T,
    nowMs: NOW,
    url,
  });
  assert.deepEqual(out.body.vehicles, []);
  assert.equal(out.body.count, 0);
  assert.equal(out.body.feedId, 'nope');
  assert.equal(out.headers['X-History-Gap'], '1');
  const empty = TRANSIT_ADAPTER.adapt([answer({ fetchedAt: T, feeds: [] })], {
    t: T,
    nowMs: NOW,
    url,
  });
  assert.deepEqual(empty.body.vehicles, []);
});

// ── bike share ─────────────────────────────────────────────

test('bike share: the upstream GBFS URL maps to its registry systemId (the recorder system_id) and file', () => {
  const madison = GBFS_CITY_REGISTRY.find((e) => e.id === 'madison-bcycle');
  assert.ok(madison, 'madison-bcycle is a registry system');
  const path = (u) => `/api/gbfs/${encodeURIComponent(u)}`;
  assert.deepEqual(gbfsTargetOf(path(madison.stationStatusUrl)), {
    systemId: 'madison-bcycle',
    kind: 'status',
  });
  assert.deepEqual(gbfsTargetOf(path(madison.stationInformationUrl)), {
    systemId: 'madison-bcycle',
    kind: 'info',
  });
  const nyc = GBFS_CITY_REGISTRY.find((e) => e.id === 'nyc-citibike');
  assert.deepEqual(gbfsTargetOf(path(nyc.stationStatusUrl)), {
    systemId: 'nyc-citibike',
    kind: 'status',
  });
  assert.equal(
    gbfsTargetOf(path('https://example.com/gbfs/station_status.json')),
    null,
  );
  assert.equal(
    gbfsTargetOf(path(madison.stationStatusUrl.replace('https:', 'http:'))),
    null,
  );
  assert.equal(gbfsTargetOf('/api/gbfs/%E0%A4'), null);
  assert.equal(GBFS_SYSTEM_BY_URL.size, GBFS_CITY_REGISTRY.length * 2);
});

test('bike share: station_status / station_information in GBFS 2.x parse like the live files; last_reported not rebased', async () => {
  const madison = GBFS_CITY_REGISTRY.find((e) => e.id === 'madison-bcycle');
  const live = liveGbfsStatus.data.stations.slice(0, 5);
  const status = live
    .map((s) => {
      // the recorder stores last_reported as ISO (collector src/feeds/gbfs.js)
      const iso = new Date(s.last_reported * 1000).toISOString();
      return gbfsStatusStation({ ...s, '@timestamp': iso, last_reported: iso });
    })
    .filter(Boolean);
  const info = live.map((s, i) =>
    gbfsInfoStation({
      station_id: s.station_id,
      name: `S${i}`,
      location: { lat: 43 + i / 100, lon: -89.4 },
      capacity: 10,
    }),
  );
  const slice = {
    fetchedAt: T,
    systems: [
      {
        systemId: 'nyc-citibike',
        station_information: gbfsEnvelope([], T),
        station_status: gbfsEnvelope([], T),
      },
      {
        systemId: 'madison-bcycle',
        station_information: gbfsEnvelope(info, T),
        station_status: gbfsEnvelope(status, T),
      },
    ],
  };
  const ask = (u) => new URL(`${ORIGIN}/api/gbfs/${encodeURIComponent(u)}`);
  const st = BIKESHARE_ADAPTER.adapt([answer(slice)], {
    t: T,
    nowMs: NOW,
    url: ask(madison.stationStatusUrl),
  });
  const viaSource = await createBikeshareSource({
    fetchImpl: fetchOf(st),
  }).getStations(madison.stationStatusUrl);
  const fromHistory = parseStationStatus(viaSource);
  const fromLive = parseStationStatus({
    ...liveGbfsStatus,
    data: { stations: live },
  });
  assert.deepEqual(
    fromHistory,
    fromLive,
    'the live status parser sees the same stations',
  );
  assert.equal(viaSource.last_updated, Math.floor(T / 1000));
  const inf = BIKESHARE_ADAPTER.adapt([answer(slice)], {
    t: T,
    nowMs: NOW,
    url: ask(madison.stationInformationUrl),
  });
  const infoMap = parseStationInformation(inf.body);
  assert.deepEqual(
    [...infoMap.keys()],
    info.map((s) => s.station_id),
  );
  // gap: a system without recorded stations -> nothing
  const nyc = GBFS_CITY_REGISTRY.find((e) => e.id === 'nyc-citibike');
  const gap = BIKESHARE_ADAPTER.adapt([answer(slice)], {
    t: T,
    nowMs: NOW,
    url: ask(nyc.stationStatusUrl),
  });
  assert.deepEqual(gap.body.data.stations, []);
  assert.equal(gap.headers['X-History-Gap'], '1');
  const unknown = BIKESHARE_ADAPTER.adapt([answer(slice)], {
    t: T,
    nowMs: NOW,
    url: ask('https://example.com/station_status.json'),
  });
  assert.deepEqual(unknown.body.data.stations, []);
});

// ── router + driver + chips ───────────────────────────────

function routerSetup({ view, truncated = false } = {}) {
  const clock = fakeClock(NOW);
  const slices = [];
  const fetch = async (input) => {
    const url = new URL(String(input?.url ?? input), ORIGIN);
    if (url.pathname === '/api/history/slice') {
      const q = Object.fromEntries(url.searchParams);
      slices.push(q);
      const rows = src(docs.fires).map(firmsRow).filter(Boolean);
      return jsonResponse(
        firmsBody(rows, new Map([['X', rows.length]]), Date.parse(q.t)),
        {
          headers: {
            'X-History-Rows': String(rows.length),
            ...(truncated ? { 'X-History-Truncated': '1' } : {}),
          },
        },
      );
    }
    return jsonResponse({ fetchedAt: NOW, stale: false, fires: [] });
  };
  const win = fakeWindow(`${ORIGIN}/`, fetch);
  const box = { value: view };
  const router = createHistoryRouter({
    target: win,
    now: clock.now,
    timers: clock.timers,
    monotonic: clock.monotonic,
    getViewBox: () => box.value,
  });
  router.install();
  return { clock, win, router, slices, box };
}

test('router: /api/firms in history asks the firms slice at t with the camera bbox; LIVE passes through', async () => {
  const { win, router, slices } = routerSetup({
    view: [-100.2, 30.1, -95.5, 33.3],
  });
  const source = createFirmsSource({ fetchImpl: (...a) => win.fetch(...a) });
  await source.getSnapshot();
  assert.equal(slices.length, 0, 'live: no slice');
  router.setHistory({ active: true, timeMs: T });
  const snap = await source.getSnapshot();
  assert.deepEqual(slices.at(-1), {
    feed: 'firms',
    t: new Date(T).toISOString(),
    bbox: '-101,30,-95,34',
  });
  assert.equal(snap.fetchedAt, T);
  assert.ok(snap.fires.length > 0);
  assert.ok(router.isSwapped('firms'));
  router.setHistory({ active: false });
  const live = await source.getSnapshot();
  assert.equal(live.fetchedAt, NOW);
});

test('FIRMS: a camera move past the whole-degree box refreshes the layer once (debounced); a small move does not', async () => {
  const { clock, win, router, slices, box } = routerSetup({
    view: [-100.2, 30.1, -95.5, 33.3],
  });
  const calls = [];
  const dm = {
    getEnabledLayerIds: () => new Set(['local-firms']),
    async refreshLayer(id) {
      calls.push(id);
      await win.fetch('/api/firms');
      return true;
    },
  };
  const driver = createRefreshDriver({
    router,
    getDataManager: () => dm,
    timers: clock.timers,
    monotonic: clock.monotonic,
    now: clock.now,
  });
  driver.onHistory({ active: true, timeMs: T, playing: false });
  await clock.run(RELEASE_DEBOUNCE_MS + 10);
  assert.deepEqual(calls, ['local-firms']);
  box.value = [-100.1, 30.2, -95.6, 33.2]; // same whole-degree box
  driver.viewChanged();
  await clock.run(RELEASE_DEBOUNCE_MS + 10);
  assert.deepEqual(calls, ['local-firms'], 'no refresh');
  box.value = [-90.2, 30.1, -85.5, 33.3];
  driver.viewChanged();
  driver.viewChanged(); // debounced
  await clock.run(RELEASE_DEBOUNCE_MS + 10);
  assert.deepEqual(calls, ['local-firms', 'local-firms']);
  assert.equal(slices.at(-1).bbox, '-91,30,-85,34');
  driver.onHistory({ active: false });
  await clock.run(10);
  box.value = [0, 0, 1, 1];
  driver.viewChanged();
  await clock.run(RELEASE_DEBOUNCE_MS + 10);
  assert.equal(
    calls.filter((c) => c === 'local-firms').length,
    3,
    'LIVE refresh only (D4)',
  );
  await flush();
  driver.destroy();
});

test('chips: a truncated FIRMS history answer shows in the layer chip; a non-truncated one does not', async () => {
  for (const truncated of [true, false]) {
    const { win, router } = routerSetup({
      view: [-100, 30, -95, 33],
      truncated,
    });
    const dm = {
      getEnabledLayerIds: () => new Set(['local-firms', 'satellites']),
      getAll: () => [
        { id: 'local-firms', name: 'FIRMS Active Fires' },
        { id: 'satellites', name: 'Satellites' },
      ],
      subscribe: () => () => {},
    };
    const chips = createLayerChips({
      feedChips: createFeedChips({ target: win, monotonic: () => 0 }),
      getRouter: () => router,
      getDataManager: () => dm,
    });
    router.setHistory({ active: true, timeMs: T });
    await win.fetch('/api/firms');
    const list = chips.states().map((c) => [c.feed, c.label, c.chip]);
    assert.deepEqual(
      list,
      [
        ...(truncated
          ? [['history:firms', 'FIRMS Active Fires', TRUNCATED_CHIP]]
          : []),
        ['layer:satellites', 'Satellites', 'LIVE'],
      ],
      `truncated=${truncated}`,
    );
  }
});
