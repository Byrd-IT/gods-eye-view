import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRecorder } from './index.js';
import { createHistoryTee } from './tee.js';
import { ADAPTERS } from './adapters/index.js';
import { createFeedRoutes } from './routes.js';
import { hazardFixtures } from './feedFixtures/hazards.mjs';
import { request } from './feedFixtures/http.mjs';
import { T0, stubStore } from './fixtures.mjs';
import { MAX_DATA_BYTES } from '../store/common.js';

const byFeed = Object.fromEntries(hazardFixtures.map((f) => [f.feed, f]));

function setup(feed) {
  const store = stubStore();
  const clock = { now: T0 };
  const recorder = createRecorder({
    store,
    config: {
      feeds: { [feed]: { record: true, minIntervalMs: 300_000 } },
      queueRows: 100_000,
      flushMs: 5_000,
    },
    adapters: ADAPTERS,
    clock: () => clock.now,
    warn() {},
  });
  const tee = createHistoryTee({
    recorder,
    routes: createFeedRoutes(),
    clock: () => clock.now,
  });
  return { store, recorder, tee, clock };
}
const send =
  (body, headers = {}, status = 200) =>
  (req, res) => {
    for (const [name, value] of Object.entries(headers))
      res.setHeader(name, value);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
const rows = (store) => store.appended.flatMap((a) => a.rows);

describe('perimeters: size bound', () => {
  it('stores a fire of 200,000 vertices as one small row without its geometry', () => {
    const big = [];
    for (let i = 0; i < 200_000; i++)
      big.push([-120 + (i % 1000) / 1000, 40 + Math.floor(i / 1000) / 1000]);
    big.push(big[0]);
    const records = ADAPTERS.perimeters.toRecords({
      fetchedAt: T0,
      rows: [
        {
          stableId: '2026-CAXXX-000001',
          name: 'Big',
          acres: 500_000,
          updatedTime: T0 - 1000,
          polygons: [[big]],
        },
      ],
    });
    assert.equal(records.length, 1);
    const json = JSON.stringify(records[0].props);
    assert.ok(Buffer.byteLength(json) < MAX_DATA_BYTES / 16);
    assert.equal(records[0].props.vertexCount, 200_001);
    assert.equal(records[0].props.bbox.length, 4);
    // The box centre is inside the box.
    const [w, s, e, n] = records[0].props.bbox;
    assert.ok(records[0].lon >= w && records[0].lon <= e);
    assert.ok(records[0].lat >= s && records[0].lat <= n);
  });

  it('does not store a fire again when the next poll carries the same update time', async () => {
    const { store, recorder, tee, clock } = setup('perimeters');
    const fixture = byFeed.perimeters;
    const first = fixture.build({ clock: T0 });
    await request(tee, fixture.path, send(first));
    await recorder.flush();
    clock.now += 300_000;
    // A new fetch of the same perimeters: new fetchedAt, same agency update times.
    await request(
      tee,
      fixture.path,
      send({ ...first, fetchedAt: T0 + 300_000 }),
    );
    await recorder.flush();
    assert.equal(rows(store).length, 2);
    assert.equal(store.ingests.length, 2);
  });

  it('uses the agency update time as the observation time, never a later one', () => {
    const [record] = ADAPTERS.perimeters.toRecords(
      byFeed.perimeters.build({ clock: T0 }),
    );
    assert.ok(record.t < T0);
  });

  it('ignores a stale answer', async () => {
    const { store, recorder, tee } = setup('perimeters');
    const fixture = byFeed.perimeters;
    await request(
      tee,
      fixture.path,
      send({ ...fixture.build({ clock: T0 }), stale: true }),
    );
    await recorder.flush();
    assert.equal(store.appended.length, 0);
  });
});

describe('cyclones', () => {
  it('keeps the forecast points but not the track or cone', () => {
    const records = ADAPTERS.cyclones.toRecords(
      byFeed.cyclones.build({ clock: T0 }),
    );
    const dump = JSON.stringify(records);
    assert.equal(records[0].props.forecast.length, 2);
    assert.equal(dump.includes('LineString'), false);
    assert.equal(dump.includes('Polygon'), false);
  });

  it('bounds the forecast points', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      position: { latitude: 10, longitude: -50 },
      tauHours: i,
    }));
    const [record] = ADAPTERS.cyclones.toRecords({
      storms: [
        {
          id: 'al012026',
          position: { latitude: 10, longitude: -50 },
          positionAt: new Date(T0).toISOString(),
          forecastPoints: many,
        },
      ],
    });
    assert.ok(record.props.forecast.length <= 12);
  });

  it('notes an unavailable answer as a failed poll and records nothing', async () => {
    const { store, recorder, tee } = setup('cyclones');
    await request(
      tee,
      '/api/cyclones',
      send({ unavailable: true, stale: true, fetchedAt: null, storms: [] }),
    );
    await recorder.flush();
    assert.equal(store.appended.length, 0);
    assert.deepEqual(
      store.ingests.map((i) => i.ok),
      [false],
    );
  });

  it('an empty season is a poll with no rows, not a failure', async () => {
    const { store, recorder, tee } = setup('cyclones');
    await request(
      tee,
      '/api/cyclones',
      send({ fetchedAt: T0, stale: false, unavailable: false, storms: [] }),
    );
    await recorder.flush();
    assert.deepEqual(
      store.ingests.map((i) => [i.ok, i.count]),
      [[true, 0]],
    );
  });
});

describe('launches', () => {
  const fixture = byFeed.launches;

  it('leaves out the description, timeline and trajectory', () => {
    const records = ADAPTERS.launches.toRecords(fixture.build({ clock: T0 }));
    const dump = JSON.stringify(records);
    assert.equal(dump.includes('xxxxxxxx'), false);
    assert.equal(dump.includes('PT3S'), false);
    assert.equal(records[0].lat, 28.56194122);
    assert.equal(records[1].lat, -39.26);
  });

  it('keeps a launch with no usable pad, without a position', () => {
    const [record] = ADAPTERS.launches.toRecords({
      results: [{ id: 'a', last_updated: new Date(T0).toISOString(), pad: {} }],
    });
    assert.equal(record.lat, null);
    assert.equal(record.lon, null);
  });

  it('skips every kind of cache replay, including a stale answer after an error', async () => {
    for (const state of ['HIT', 'INFLIGHT', 'STALE-ERROR']) {
      const { store, recorder, tee } = setup('launches');
      await request(
        tee,
        '/api/launches',
        send(fixture.build({ clock: T0 }), { 'X-GEV-Cache': state }),
      );
      await recorder.flush();
      assert.equal(store.appended.length, 0, state);
    }
    const { store, recorder, tee } = setup('launches');
    await request(
      tee,
      '/api/launches',
      send(fixture.build({ clock: T0 }), { 'X-GEV-Cache': 'MISS' }),
    );
    await recorder.flush();
    assert.equal(rows(store).length, 2);
  });

  it('does not store a launch again when its last_updated did not change', async () => {
    const { store, recorder, tee } = setup('launches');
    const body = fixture.build({ clock: T0 });
    await request(
      tee,
      '/api/launches',
      send(body, {
        'X-GEV-Cache': 'MISS',
        'X-GEV-Cached-At': new Date(T0).toISOString(),
      }),
    );
    await recorder.flush();
    await request(
      tee,
      '/api/launches',
      send(body, {
        'X-GEV-Cache': 'MISS',
        'X-GEV-Cached-At': new Date(T0 + 900_000).toISOString(),
      }),
    );
    await recorder.flush();
    assert.equal(rows(store).length, 2);
    assert.equal(store.ingests.length, 2);
  });
});
