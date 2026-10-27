import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  openSkySnapshot,
  readsbSnapshot,
} from '../../sources/live/aircraft.js';
import { validateCycloneSnapshot } from '../../layers/cyclones/source.js';
import {
  CYCLONE_ENVELOPE,
  cycloneStorm,
  firmsBody,
  firmsRow,
  launchResult,
  openSkyCategory,
  openSkyState,
  perimeterRow,
  readsbBody,
  readsbRow,
} from './historyRows.js';

/**
 * B9 contract: a history slice has the LIVE row shape, so the existing
 * layer parsers read it unchanged (DESIGN 4.3). Input = real ES hits captured
 * with the reader key on 2026-10-14 (fixtures/b9-es-docs.json); reference =
 * the live /api/<feed> fixtures captured by B4/B6/B7.
 */

const fx = (name) => new URL(`./fixtures/${name}`, import.meta.url);
const json = (name) => JSON.parse(readFileSync(fx(name), 'utf8'));
const es = json('b9-es-docs.json');
const src = (list) => list.map((h) => h._source);

test('military: readsb rows use only live row keys (+source), envelope keys equal live', () => {
  const live = json('military-latest.json');
  const meta = json('military-latest.meta.json');
  const snap = 1791987668500;
  const rows = src([...es.military, ...es.military_ground]).map((d) =>
    readsbRow(d, snap),
  );
  assert.ok(rows.every(Boolean));
  const allowed = new Set([...meta.rowKeyUnion, 'source']);
  for (const row of rows)
    for (const key of Object.keys(row)) assert.ok(allowed.has(key), key);
  const body = readsbBody(rows, snap);
  assert.deepEqual(Object.keys(body).sort(), Object.keys(live).sort());
  assert.deepEqual(Object.keys(body).sort(), meta.topLevelKeys);
  // GEV's own parser admits every row
  const parsed = readsbSnapshot(body, { observedAtMs: snap, now: snap });
  assert.equal(parsed.records.length, rows.length);
  assert.equal(parsed.rejectedCount, 0);
  const ground = parsed.records.filter((r) => r.onGround);
  assert.equal(ground.length, es.military_ground.length);
});

test('military: units invert the collector transforms (ft, kn, ft/min)', () => {
  const doc = {
    '@timestamp': '2026-10-14T14:17:48.000Z',
    hex: '3b7f58',
    location: { lat: 44.4, lon: -2 },
    baro_alt_m: 12207.2,
    geo_alt_m: 12733,
    velocity_ms: 209.07,
    track_deg: 355.2,
    vert_rate_ms: 4.23,
    on_ground: false,
    callsign: 'MEDOC05',
    db_flags: 1,
    source: 'adsb.lol',
  };
  const row = readsbRow(doc, Date.parse('2026-10-14T14:17:50.500Z'));
  assert.equal(row.alt_baro, 40050); // 12207.2 m / 0.3048
  assert.equal(row.alt_geom, 41775);
  assert.equal(row.gs, 406.4); // 209.07 / 0.514444
  assert.equal(row.baro_rate, 833); // 4.23 / 0.00508
  assert.equal(row.seen_pos, 2.5);
  assert.equal(row.flight, 'MEDOC05');
  assert.equal(row.dbFlags, 1);
  const parsed = readsbSnapshot(readsbBody([row], 0), { observedAtMs: 0 });
  assert.ok(Math.abs(parsed.records[0].baroAltitudeM - 12207.2) < 0.2);
  assert.ok(Math.abs(parsed.records[0].speedMps - 209.07) < 0.05);
});

test('aircraft: OpenSky state vectors (18 fields + source) admitted by GEV', () => {
  const docs = [
    ...src(es.adsblol).map((d) => ({ ...d, source: 'adsblol' })),
    ...src(es.opensky),
  ];
  const states = docs.map(openSkyState);
  assert.ok(states.every((s) => Array.isArray(s) && s.length === 19));
  assert.deepEqual([...new Set(states.map((s) => s[18]))].sort(), [
    'adsblol',
    'opensky',
  ]);
  for (const s of states) {
    assert.equal(typeof s[0], 'string');
    assert.equal(typeof s[3], 'number');
    assert.equal(typeof s[8], 'boolean');
    assert.equal(typeof s[17], 'number');
  }
  const time = 1791920800;
  const parsed = openSkySnapshot({ time, states }, { now: time * 1000 });
  assert.equal(parsed.records.length, new Set(docs.map((d) => d.icao24)).size);
  assert.equal(parsed.observedAtMs, time * 1000);
});

test('aircraft: emitter category maps to the OpenSky numeric table', () => {
  assert.equal(openSkyCategory('A3'), 4);
  assert.equal(openSkyCategory('A0'), 1);
  assert.equal(openSkyCategory('B1'), 9);
  assert.equal(openSkyCategory('C5'), 20);
  assert.equal(openSkyCategory('C7'), 0);
  assert.equal(openSkyCategory('6'), 6); // OpenSky docs store the number
  assert.equal(openSkyCategory(undefined), 0);
  assert.equal(openSkyCategory('zz'), 0);
});

test('firms: rows and envelope have exactly the live keys', () => {
  const live = json('b6-collector-firms.body');
  const rows = src([...es.fires, ...es.fires_hist]).map(firmsRow);
  assert.ok(rows.every(Boolean));
  for (const row of rows)
    assert.deepEqual(
      Object.keys(row).sort(),
      Object.keys(live.fires[0]).sort(),
    );
  const body = firmsBody(rows, new Map([['VIIRS_SNPP_NRT', rows.length]]), 1);
  assert.deepEqual(Object.keys(body).sort(), Object.keys(live).sort());
  assert.deepEqual(Object.keys(body.sources[0]).sort(), [
    'count',
    'ok',
    'source',
  ]);
  assert.equal(body.count, rows.length);
});

test('fire-perimeters: rows have exactly the live keys; polygons nest like live', () => {
  const live = json('b6-collector-fire-perimeters.body');
  const rows = src(es.perimeters).map(perimeterRow);
  assert.ok(rows.every(Boolean));
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), Object.keys(live.rows[0]).sort());
    // polygons: [polygon][ring][point][lon,lat], same depth as live
    assert.equal(typeof row.polygons[0][0][0][0], 'number');
    assert.equal(typeof live.rows[0].polygons[0][0][0][0], 'number');
  }
});

test('cyclones: the history answer passes GEV validateCycloneSnapshot', () => {
  const live = json('b6-collector-cyclones-020A.body');
  const storms = src(es.cyclones_nhc).map(cycloneStorm);
  const unique = [...new Map(storms.map((s) => [s.id, s])).values()];
  const body = {
    ...CYCLONE_ENVELOPE,
    fetchedAt: 1,
    stale: false,
    unavailable: false,
    reason: null,
    storms: unique,
    bestTrackStorms: src(es.cyclones_atcf).map(cycloneStorm),
  };
  const valid = validateCycloneSnapshot(body);
  assert.equal(valid.storms.length, unique.length);
  for (const key of Object.keys(live))
    assert.ok(Object.hasOwn(body, key), `envelope ${key}`);
  for (const key of Object.keys(live.storms[0]))
    assert.ok(Object.hasOwn(unique[0], key), `storm ${key}`);
  assert.equal(body.source, live.source);
  assert.equal(body.attribution, live.attribution);
  assert.equal(body.coverage, live.coverage);
});

test('cyclones: ATCF best-track fixes never pose as advisories', () => {
  const fix = cycloneStorm(es.cyclones_atcf[0]._source);
  assert.equal(fix.advisoryNumber, null);
  assert.equal(fix.issuedAt, null);
  assert.equal(fix.positionAtRecorded, true);
  assert.match(fix.id, /^(?:al|ep|cp)\d{6}$/);
  const adv = cycloneStorm(es.cyclones_nhc[0]._source);
  assert.match(adv.advisoryNumber, /^\d/);
  assert.equal(adv.positionAtRecorded, false);
  assert.equal(adv.geometryStatus, 'unavailable');
  assert.equal(adv.track, null);
});

test('launches: results use only Launch Library 2 keys; envelope equals live', () => {
  const live = json('b7-collector-launches.body');
  const results = src(es.launches).map(launchResult);
  assert.ok(results.every(Boolean));
  const allowed = new Set(Object.keys(live.results[0]));
  for (const r of results) {
    for (const key of Object.keys(r)) assert.ok(allowed.has(key), key);
    assert.equal(typeof r.status.name, 'string');
    assert.ok(Number.isFinite(Date.parse(r.net)));
  }
  const body = { count: results.length, next: null, previous: null, results };
  assert.deepEqual(Object.keys(body).sort(), Object.keys(live).sort());
});

test('mappers drop rows they cannot place (never invent a position)', () => {
  assert.equal(readsbRow({ hex: 'a', '@timestamp': 1 }, 1), null);
  assert.equal(
    openSkyState({ icao24: 'a', location: { lat: 1, lon: 2 } }),
    null,
  );
  assert.equal(firmsRow({}), null);
  assert.equal(perimeterRow({ fire_id: 'x' }), null);
  assert.equal(cycloneStorm({ storm_id: 'xx1', '@timestamp': 1 }), null);
  assert.equal(launchResult({}), null);
});
