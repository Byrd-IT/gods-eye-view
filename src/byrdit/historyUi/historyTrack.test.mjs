/**
 * B12e: the selected aircraft's RECORDED track [t-6h, t] in history mode.
 *
 * The B10 answers here are made by the REAL server track service
 * (src/byrdit/history/historyTrack.js createTrackService) over docs shaped
 * like the B9 fixture docs (b9-es-docs.json), through a small fake ES. The
 * live parsers (src/sources/live/standalone.js getTrack) read the adapted
 * answers through the router unchanged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTrackService } from '../history/historyTrack.js';
import { HISTORY_INDICES as IDX } from '../history/historyEs.js';
import { createHistoryRouter } from './historyRouter.js';
import {
  createLayerChips,
  TRACK_STATE,
  TRACK_WARN_STATE,
} from './layerChips.js';
import {
  TRACK_GAP_MS,
  TRACK_WINDOW_MS,
  adaptAircraftTrack,
  adaptMilitaryTrack,
  historyTrackUrl,
  trackChipText,
  trackGaps,
  trackSummary,
} from './historyTrackAdapters.js';
import { fakeClock, fakeWindow, jsonResponse } from './fakeDom.mjs';
import {
  createFlightSource,
  createMilitarySource,
} from '../../sources/live/standalone.js';
import { normalizeAircraftTrack } from '../../sources/live/aircraft.js';

const fixtures = JSON.parse(
  readFileSync(
    new URL('../history/fixtures/b9-es-docs.json', import.meta.url),
    'utf8',
  ),
);
const NOW = Date.parse('2026-10-14T18:00:00Z');
const T = Date.parse('2026-10-13T19:46:40Z');
const MIN = 60_000;
const ORIGIN = 'https://gev.example';
const HEX = 'a1b472';
const MIL = '3b7f58';

// ── docs shaped like the B9 fixtures, one aircraft over [T-6h, T] ──
const adsTemplate = fixtures.adsblol[0]._source;
const oskTemplate = fixtures.opensky[0]._source;
const milTemplate = fixtures.military[0]._source;

/** adsb.lol every 2 min from T-5h, with a recorded gap T-3h..T-2h40. */
function aircraftDocs() {
  const ads = [];
  for (let t = T - 5 * 60 * MIN; t <= T - MIN; t += 2 * MIN) {
    if (t > T - 180 * MIN && t < T - 160 * MIN) continue; // the gap
    ads.push({
      ...adsTemplate,
      '@timestamp': t,
      snap: t / 1000,
      icao24: HEX,
      location: { lat: 30 + (t - T) / 3.6e7, lon: -97 },
      baro_alt_m: 3000,
      track_deg: 0,
      on_ground: false,
      source: 'adsblol',
    });
  }
  // OpenSky only where an area was polled: two points, one 3 s after an
  // adsb.lol point (collapses into OpenSky), one on its own
  const osk = [
    {
      ...oskTemplate,
      '@timestamp': new Date(T - 61 * MIN + 3_000).toISOString(),
      icao24: HEX,
      location: { lat: 29.9, lon: -97.001 },
      baro_alt_m: 3010,
      track_deg: 1,
      on_ground: false,
      source: 'opensky',
    },
    {
      ...oskTemplate,
      '@timestamp': new Date(T - 30_000).toISOString(),
      icao24: HEX,
      location: { lat: 29.99, lon: -97.002 },
      baro_alt_m: 3020,
      track_deg: 2,
      on_ground: false,
      source: 'opensky',
    },
  ];
  // another aircraft and an older point (outside [T-6h, T]) are not asked
  ads.push({ ...adsTemplate, '@timestamp': T - 13 * 60 * MIN, icao24: HEX });
  ads.push({ ...adsTemplate, '@timestamp': T - MIN, icao24: 'ffffff' });
  return { ads, osk };
}

function militaryDocs() {
  const out = [];
  for (let t = T - 90 * MIN; t <= T; t += 5 * MIN)
    out.push({
      ...milTemplate,
      '@timestamp': new Date(t).toISOString(),
      hex: MIL,
      location: { lat: 44 + (T - t) / 3.6e8, lon: -1.97 },
      baro_alt_m: t === T ? 0 : 6096,
      on_ground: t === T,
      track_deg: 8,
      source: 'adsb.lol',
    });
  return out;
}

/** The fake ES the B10 service reads (PIT pages / one sampling request). */
function fakeEs(byIndex, { dense = false } = {}) {
  const docsOf = (index) => byIndex[index] ?? [];
  const pick = (index, query) => {
    const [term, range] = query.bool.filter;
    const [[tf, tv]] = Object.entries(term.term);
    const [[, r]] = Object.entries(range.range);
    return docsOf(index)
      .filter((d) => d[tf] === tv)
      .map((d) => ({
        d,
        ms:
          typeof d['@timestamp'] === 'number'
            ? d['@timestamp']
            : Date.parse(d['@timestamp']),
      }))
      .filter(({ ms }) => ms >= r.gte && ms <= r.lte)
      .sort((a, b) => a.ms - b.ms);
  };
  return {
    calls: [],
    async searchAll(index, { query, maxRows }) {
      const hits = pick(index, query).map(({ d }) => ({ _source: d }));
      if (dense && hits.length)
        return { hits: [], total: maxRows + 1, truncated: true };
      return { hits, total: hits.length, truncated: false };
    },
    async search(index, { query }) {
      // the sampling request: first doc per bucket + the newest doc
      const all = pick(index, query);
      const buckets = all
        .filter((_, i) => i % 2 === 0)
        .map(({ d }) => ({ first: { hits: { hits: [{ _source: d }] } } }));
      return {
        hits: {
          total: { value: all.length },
          hits: all.length ? [{ _source: all.at(-1).d }] : [],
        },
        aggregations: { t: { buckets } },
      };
    },
  };
}

/** A B10 answer {body, headers} of the real service for [from, to]. */
async function b10Track(
  feed,
  id,
  from,
  to,
  { dense = false, minGapSec = 0 } = {},
) {
  const { ads, osk } = aircraftDocs();
  const es = fakeEs(
    {
      [IDX.adsblol]: ads,
      [IDX.opensky]: osk,
      [IDX.military]: militaryDocs(),
    },
    { dense },
  );
  return createTrackService({ es }).track({
    feed,
    id,
    from,
    to,
    minGapSec,
  });
}

/** Fake server: slices, /api/history/track from the B10 service, live. */
function setup({ trackFails = false, dense = false, truncated = false } = {}) {
  const clock = fakeClock(NOW);
  const calls = [];
  const fetch = async (input) => {
    const url = new URL(String(input?.url ?? input), ORIGIN);
    calls.push(url.pathname + url.search);
    const q = Object.fromEntries(url.searchParams);
    if (url.pathname === '/api/history/slice') {
      const t = Date.parse(q.t);
      if (q.feed === 'military')
        return jsonResponse(
          { ac: [], now: t, msg: 'No error' },
          { headers: { 'X-History-Source': 'adsb.lol' } },
        );
      return jsonResponse(
        { time: Math.round(t / 1000), states: [] },
        { headers: { 'X-History-Source': 'opensky' } },
      );
    }
    if (url.pathname === '/api/history/track') {
      if (trackFails) return jsonResponse({}, { status: 503 });
      const r = await b10Track(
        q.feed,
        q.id,
        Date.parse(q.from),
        Date.parse(q.to),
        { dense, minGapSec: Number(q.minGapSec ?? 0) },
      );
      return jsonResponse(r.body, {
        headers: {
          ...r.headers,
          ...(truncated ? { 'X-History-Truncated': '1' } : {}),
        },
      });
    }
    return jsonResponse({
      path: [[Math.round(NOW / 1000), 1, 1, 1, 1, false]],
    });
  };
  const win = fakeWindow(`${ORIGIN}/`, fetch);
  const router = createHistoryRouter({
    target: win,
    now: clock.now,
    timers: clock.timers,
    monotonic: clock.monotonic,
  });
  router.install();
  const flights = createFlightSource({
    fetchImpl: (...a) => win.fetch(...a),
    now: clock.now,
  });
  const military = createMilitarySource({
    fetchImpl: (...a) => win.fetch(...a),
    now: clock.now,
  });
  return { clock, calls, win, router, flights, military };
}
const trackCalls = (calls) =>
  calls
    .filter((c) => c.startsWith('/api/history/track'))
    .map((c) => Object.fromEntries(new URL(c, ORIGIN).searchParams));

// ── adapters against B10 answers ─────────────────────────

test('B10 fixture answer: merged two-source track keeps its per-point source; a 20-min recorded gap is found', async () => {
  const r = await b10Track('aircraft', HEX, T - TRACK_WINDOW_MS, T);
  const path = r.body.path;
  assert.ok(path.length > 100);
  assert.deepEqual(r.body.sources, ['adsblol', 'opensky']);
  assert.equal(path.at(-1)[6], 'opensky', 'newest point is the OpenSky one');
  assert.ok(
    !path.some((p) => p[0] * 1000 === T - 61 * MIN && p[6] === 'adsblol'),
    'the adsb.lol point 3 s from an OpenSky point collapsed into it',
  );
  assert.ok(
    path.every((p) => p[0] * 1000 >= T - TRACK_WINDOW_MS && p[0] * 1000 <= T),
  );
  const gaps = trackGaps(r.body);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].from, T - 180 * MIN);
  assert.equal(gaps[0].to, T - 160 * MIN);
  assert.ok(gaps[0].to - gaps[0].from > TRACK_GAP_MS);
});

test('aircraft adapter: OpenSky /tracks shape, rebased by the frame delta, source kept, parser reads it unchanged', async () => {
  const r = await b10Track('aircraft', HEX, T - TRACK_WINDOW_MS, T);
  const delta = NOW - T + 123.456;
  const out = adaptAircraftTrack(r.body, { deltaMs: delta });
  assert.equal(out.icao24, HEX);
  assert.equal(out.path.length, r.body.path.length);
  for (let i = 0; i < out.path.length; i++) {
    const raw = r.body.path[i];
    const got = out.path[i];
    assert.equal(Math.round(got[0] * 1000), Math.round(raw[0] * 1000 + delta));
    assert.deepEqual(got.slice(1), raw.slice(1), 'lat..source unchanged');
  }
  assert.equal(out.startTime, out.path[0][0]);
  assert.equal(out.endTime, out.path.at(-1)[0]);
  const parsed = normalizeAircraftTrack(out.path);
  assert.equal(parsed.length, out.path.length);
  assert.equal(
    Math.round(parsed.at(-1).observedAtMs),
    Math.round(T - 30_000 + delta),
  );
  assert.equal(parsed.at(-1).baroAltitudeM, 3020);
  // nothing added: no interpolated point inside the recorded gap
  const gapPts = parsed.filter(
    (p) =>
      p.observedAtMs - delta > T - 180 * MIN + 1000 &&
      p.observedAtMs - delta < T - 160 * MIN - 1000,
  );
  assert.equal(gapPts.length, 0);
});

test('military adapter: readsb trace shape (base + offsets, feet, ground), rebased; the military parser reads it', async () => {
  const r = await b10Track('military', MIL, T - TRACK_WINDOW_MS, T);
  assert.ok(r.body.path.length >= 19);
  const delta = NOW - T;
  const out = adaptMilitaryTrack(r.body, { deltaMs: delta });
  assert.equal(out.icao, MIL);
  assert.equal(out.timestamp, r.body.path[0][0] + delta / 1000);
  assert.equal(out.trace[0][0], 0);
  assert.equal(out.trace.at(-1)[3], 'ground');
  const parsed = normalizeAircraftTrack(out.trace, {
    baseTimeMs: out.timestamp * 1000,
    readsb: true,
  });
  assert.equal(parsed.length, r.body.path.length);
  for (let i = 0; i < parsed.length; i++) {
    const raw = r.body.path[i];
    assert.equal(Math.round(parsed[i].observedAtMs - delta), raw[0] * 1000);
    assert.equal(parsed[i].latitude, raw[1]);
    if (!raw[5])
      assert.ok(Math.abs(parsed[i].baroAltitudeM - raw[3]) < 0.01, 'm->ft->m');
  }
  assert.equal(parsed.at(-1).onGround, true);
  const empty = adaptMilitaryTrack({ path: [] }, { deltaMs: delta });
  assert.deepEqual(empty, { icao: null, timestamp: null, trace: [] });
});

test('chip text: sources, SAMPLED / TRUNCATED, gaps with RECORDED UTC times, none, unavailable', () => {
  const body = {
    path: [
      [Date.parse('2026-10-13T14:00:00Z') / 1000, 1, 1, 1, 1, false, 'adsblol'],
      [Date.parse('2026-10-13T14:02:00Z') / 1000, 1, 1, 1, 1, false, 'adsblol'],
      [Date.parse('2026-10-13T14:30:00Z') / 1000, 1, 1, 1, 1, false, 'opensky'],
    ],
    sources: ['adsblol', 'opensky'],
  };
  const sum = trackSummary({
    adapterId: 'flights',
    layerId: 'flights',
    id: HEX,
    from: 0,
    to: 1,
    body,
    headers: { 'x-history-sampled': '1', 'x-history-truncated': '1' },
  });
  const text = trackChipText(sum);
  assert.match(
    text,
    /^TRACK A1B472, last 6 h: 3 points \(adsb\.lol \+ OpenSky\)/,
  );
  assert.match(text, /SAMPLED/);
  assert.match(text, /TRUNCATED/);
  assert.match(
    text,
    /GAP 14:02Z-14:30Z \(not recorded; the line joins across\)/,
  );
  const none = trackSummary({ id: HEX, body: { path: [] }, headers: {} });
  assert.match(trackChipText(none), /NO RECORDING/);
  const down = trackSummary({ id: HEX, status: 'unavailable' });
  assert.match(trackChipText(down), /HISTORY TRACK UNAVAILABLE/);
});

// ── through the router (the live parsers read it) ────────

test('request: [t-6h, t] of the shown frame, only when the layer asks; follows t; rebased with the frame delta', async () => {
  const { router, flights, win, calls, clock } = setup();
  router.setHistory({ active: true, timeMs: T });
  // nothing asked before the layer asks (no prefetch, no polling)
  await win.fetch('/api/flights?view=-98,29,-96,31');
  assert.equal(trackCalls(calls).length, 0);
  const servedAt = clock.now();
  await clock.run(700); // the track is asked after the frame was served
  const track = await flights.getTrack(HEX);
  const asked = trackCalls(calls);
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0], {
    feed: 'aircraft',
    id: HEX,
    from: new Date(T - 6 * 3_600_000).toISOString(),
    to: new Date(T).toISOString(),
    minGapSec: '60',
  });
  // the frame's delta (served time - t), not the time of the track request
  const raw = await b10Track('aircraft', HEX, T - TRACK_WINDOW_MS, T, {
    minGapSec: 60,
  });
  assert.equal(track.records.length, raw.body.path.length);
  assert.equal(
    Math.round(track.records.at(-1).observedAtMs),
    raw.body.path.at(-1)[0] * 1000 + (servedAt - T),
  );
  // the same frame asks the same window again: answered from the cache
  await flights.getTrack(HEX);
  assert.equal(trackCalls(calls).length, 1);
  assert.equal(router.getState().stats.trackCacheHits, 1);
  // t moves (step 10 min, paused): the next frame's track ends at the new t
  const T2 = T + 10 * MIN;
  router.setHistory({ active: true, timeMs: T2 });
  await win.fetch('/api/flights?view=-98,29,-96,31');
  await flights.getTrack(HEX);
  const last = trackCalls(calls).at(-1);
  assert.equal(last.to, new Date(T2).toISOString());
  assert.equal(last.from, new Date(T2 - 6 * 3_600_000).toISOString());
  assert.ok(!calls.some((c) => c.startsWith('/api/flights/track')), 'no live');
});

test('military track route -> feed=military, readsb trace parsed by the military source', async () => {
  const { router, military, win, calls } = setup();
  router.setHistory({ active: true, timeMs: T });
  await win.fetch('/api/military');
  const track = await military.getTrack(MIL);
  const asked = trackCalls(calls);
  assert.equal(asked[0].feed, 'military');
  assert.equal(asked[0].id, MIL);
  assert.equal(asked[0].to, new Date(T).toISOString());
  assert.equal(track.records.length, 19);
  assert.equal(track.records.at(-1).onGround, true);
  assert.equal(router.getState().track.sources.join(), 'adsb.lol');
  assert.ok(!calls.some((c) => c.startsWith('/api/military/track')));
});

test('sampled / truncated / gap reach the router state and the chip; deselect, seek and LIVE remove it', async () => {
  const { router, flights, win } = setup({ dense: true, truncated: true });
  const dm = {
    getEnabledLayerIds: () => new Set(['flights']),
    getAll: () => [{ id: 'flights', name: 'Live Flights' }],
    subscribe: () => () => {},
  };
  const chips = createLayerChips({
    feedChips: { states: () => [] },
    getRouter: () => router,
    getDataManager: () => dm,
  });
  router.setHistory({ active: true, timeMs: T });
  await win.fetch('/api/flights');
  await flights.getTrack(HEX);
  const tr = router.getState().track;
  assert.equal(tr.sampled, true);
  assert.equal(tr.truncated, true);
  let chip = chips.states().find((c) => c.feed === 'history-track:flights');
  assert.equal(chip.state, TRACK_WARN_STATE);
  assert.match(chip.chip, /SAMPLED/);
  assert.match(chip.chip, /TRUNCATED/);
  assert.equal(chip.label, 'Live Flights');
  // deselecting the aircraft removes the chip
  win.dispatchEvent({
    type: 'gev:awareness-subject-cleared',
    detail: { layerId: 'flights', id: HEX },
  });
  assert.equal(router.getState().track, null);
  await flights.getTrack(HEX);
  assert.ok(router.getState().track);
  // a seek removes it until the new frame asks again
  router.setHistory({ active: true, timeMs: T - 60 * MIN });
  assert.equal(router.getState().track, null);
  await win.fetch('/api/flights');
  await flights.getTrack(HEX);
  chip = chips.states().find((c) => c.feed === 'history-track:flights');
  assert.ok(chip);
  router.setHistory({ active: false });
  assert.equal(router.getState().track, null);
  assert.equal(
    chips.states().some((c) => c.feed === 'history-track:flights'),
    false,
  );
});

test('a clean track is a plain TRACK chip; the gap case names the gap', async () => {
  const { router, flights, win } = setup();
  const dm = {
    getEnabledLayerIds: () => new Set(['flights']),
    getAll: () => [{ id: 'flights', name: 'Live Flights' }],
    subscribe: () => () => {},
  };
  const chips = createLayerChips({
    feedChips: { states: () => [] },
    getRouter: () => router,
    getDataManager: () => dm,
  });
  router.setHistory({ active: true, timeMs: T });
  await win.fetch('/api/flights');
  await flights.getTrack(HEX);
  let chip = chips.states().find((c) => c.feed === 'history-track:flights');
  assert.equal(chip.state, TRACK_WARN_STATE, 'the 6 h window holds the gap');
  assert.match(chip.chip, /GAP \d\d:\d\dZ-\d\d:\d\dZ/);
  // t before the aircraft was recorded: an empty track, said so
  router.setHistory({ active: true, timeMs: T - 5 * 60 * MIN - 2 * MIN });
  await win.fetch('/api/flights');
  const before = await flights.getTrack(HEX);
  assert.equal(before.records.length, 0, 'nothing is drawn, nothing invented');
  chip = chips.states().find((c) => c.feed === 'history-track:flights');
  assert.match(chip.chip, /NO RECORDING/);
  // a window that holds the recording but no gap: plain chip
  router.setHistory({ active: true, timeMs: T - 5 * 60 * MIN + 30 * MIN });
  await win.fetch('/api/flights');
  await flights.getTrack(HEX);
  chip = chips.states().find((c) => c.feed === 'history-track:flights');
  assert.equal(chip.state, TRACK_STATE);
  assert.doesNotMatch(chip.chip, /GAP|SAMPLED|TRUNCATED/);
});

test('D3: a failed history track is a 404 (frame trail kept), never the live track; vessels stay refused', async () => {
  const { router, flights, win, calls } = setup({ trackFails: true });
  router.setHistory({ active: true, timeMs: T });
  await win.fetch('/api/flights');
  await assert.rejects(flights.getTrack(HEX), (e) => e.status === 404);
  assert.equal(router.getState().track.status, 'unavailable');
  assert.match(trackChipText(router.getState().track), /UNAVAILABLE/);
  assert.ok(!calls.some((c) => c.startsWith('/api/flights/track')));
  const v = await win.fetch('/api/vessels/track?mmsi=123456789');
  assert.equal(v.status, 404);
  // a bad hex is refused without a request
  const bad = await win.fetch('/api/flights/track?icao24=zz');
  assert.equal(bad.status, 404);
  assert.equal(trackCalls(calls).length, 1);
});

test('URL helper: ISO from/to, feed and id', () => {
  assert.equal(
    historyTrackUrl('aircraft', HEX, { from: 0, to: 1000 }),
    '/api/history/track?feed=aircraft&id=a1b472&from=1970-01-01T00%3A00%3A00.000Z&to=1970-01-01T00%3A00%3A01.000Z&minGapSec=60',
  );
});
