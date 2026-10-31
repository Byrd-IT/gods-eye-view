import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRecorder } from './index.js';
import { createHistoryTee } from './tee.js';
import { ADAPTERS } from './adapters/index.js';
import { createFeedRoutes } from './routes.js';
import { FIXTURES } from './feedFixtures/index.mjs';
import { adsbLolFallbackBody } from './feedFixtures/aircraft.mjs';
import { answerClockMs } from './adapters/military.js';
import { prime, request } from './feedFixtures/http.mjs';
import { T0, stubStore } from './fixtures.mjs';
import { createStationDirectory } from './adapters/bikeshare.js';
import { informationBody } from './feedFixtures/bikeshare.mjs';

const NOISE = {
  authorization: 'Bearer FAKETOKEN123456SUFFIX99',
  note: 'https://user:pass@example.test/?api_key=FAKEKEY987654',
};
const body = (fixture, options) => {
  const built = fixture.build(options);
  return fixture.kind === 'text' ? built : JSON.stringify(built);
};
const replying =
  (fixture, options, status = 200) =>
  (req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(status === 200 ? body(fixture, options) : '{"error":"x"}');
  };

async function setup(fixture, { feeds = [fixture.feed], clock = { now: T0 } } = {}) {
  const store = stubStore();
  const config = {
    feeds: Object.fromEntries(
      Object.keys(ADAPTERS).map((feed) => [
        feed,
        { record: feeds.includes(feed), minIntervalMs: 60_000 },
      ]),
    ),
    queueRows: 100_000,
    flushMs: 5_000,
  };
  const recorder = createRecorder({
    store,
    config,
    adapters: ADAPTERS,
    clock: () => clock.now,
    warn() {},
  });
  const tee = createHistoryTee({
    recorder,
    routes: createFeedRoutes(),
    clock: () => clock.now,
  });
  await prime(tee, fixture.prime);
  return { store, recorder, tee, clock };
}
const rowsOf = (store, feed) =>
  store.appended.filter((a) => a.feed === feed).flatMap((a) => a.rows);

for (const fixture of FIXTURES) {
  describe(`${fixture.feed} adapter and tee`, () => {
    const adapter = ADAPTERS[fixture.feed];

    it('declares what the recorder needs', () => {
      assert.equal(adapter.feed, fixture.feed);
      assert.ok(adapter.cadenceMs > 0);
      assert.ok(['server-polled', 'view-driven'].includes(adapter.mode));
      assert.ok(adapter.fields.length > 0);
    });

    it('keeps only whitelisted fields and never a noise value', () => {
      const input = fixture.build({ clock: T0, noise: NOISE });
      const records = adapter.toRecords(
        fixture.adapterInput ? fixture.adapterInput(input, T0) : input,
      );
      assert.equal(records.length, fixture.expectedRows);
      for (const record of records) {
        assert.ok(record.id && Number.isSafeInteger(record.t) && record.t > 0);
        assert.ok(
          Object.keys(record.props).every((name) =>
            adapter.fields.includes(name),
          ),
        );
      }
      const dump = JSON.stringify(records);
      for (const value of Object.values(NOISE))
        assert.equal(dump.includes(value), false);
    });

    it('survives garbage without throwing', () => {
      for (const junk of [
        null,
        undefined,
        {},
        [],
        'x',
        5,
        { states: 5, ac: 'x', rows: 7, vehicles: 'x', stations: 5 },
      ])
        assert.ok(Array.isArray(adapter.toRecords(junk)));
    });

    it('skips an answer the proxy marks as a cache replay', async (t) => {
      if (!fixture.replay) return t.skip('this proxy route never replays an answer');
      const { store, recorder, tee } = await setup(fixture);
      const { header, options = {} } = fixture.replay;
      const replay = (req, res) => {
        if (header) res.setHeader(header[0], header[1]);
        replying(fixture, { clock: T0, ...options })(req, res);
      };
      await request(tee, fixture.path, replay);
      await recorder.flush();
      assert.equal(store.appended.length, 0);
    });

    it('records an answer through the tee and leaves the response alone', async () => {
      const { store, recorder, tee } = await setup(fixture);
      const plain = await request(
        (req, res, next) => next(),
        fixture.path,
        replying(fixture, { clock: T0 }),
      );
      const res = await request(
        tee,
        fixture.path,
        replying(fixture, { clock: T0 }),
      );
      await recorder.flush();
      assert.equal(res.body, plain.body);
      assert.equal(res.statusCode, 200);
      assert.equal(rowsOf(store, fixture.feed).length, fixture.expectedRows);
      assert.equal(store.ingests.length, 1);
      assert.equal(store.ingests[0].ok, true);
    });

    it('ignores the same answer served again, and records a later one', async () => {
      const { store, recorder, tee } = await setup(fixture);
      await request(tee, fixture.path, replying(fixture, { clock: T0 }));
      await request(tee, fixture.path, replying(fixture, { clock: T0 }));
      await recorder.flush();
      assert.equal(rowsOf(store, fixture.feed).length, fixture.expectedRows);
      assert.equal(store.ingests.length, 1);
      await request(
        tee,
        fixture.path,
        replying(fixture, { clock: T0, variant: 1 }),
      );
      await recorder.flush();
      assert.equal(
        rowsOf(store, fixture.feed).length,
        fixture.expectedRows * 2,
      );
      assert.equal(store.ingests.length, 2);
    });

    it('notes a failed answer once a minute', async () => {
      const { store, recorder, tee, clock } = await setup(fixture);
      await request(tee, fixture.path, replying(fixture, {}, 503));
      await request(tee, fixture.path, replying(fixture, {}, 503));
      clock.now += 61_000;
      await request(tee, fixture.path, replying(fixture, {}, 502));
      await recorder.flush();
      assert.deepEqual(
        store.ingests.map((i) => i.ok),
        [false, false],
      );
    });

    it('does nothing for a feed that is not recording', async () => {
      const { store, recorder, tee } = await setup(fixture, { feeds: [] });
      let wrapped = false;
      await request(tee, fixture.path, (req, res) => {
        const end = res.end;
        replying(fixture, { clock: T0 })(req, res);
        wrapped = res.end !== end;
      });
      await recorder.flush();
      assert.equal(store.appended.length, 0);
      assert.equal(store.ingests.length, 0);
      assert.equal(wrapped, false);
    });

    it('ignores other methods, other paths and unreadable bodies', async () => {
      const { store, recorder, tee } = await setup(fixture);
      await request(
        tee,
        fixture.path,
        replying(fixture, { clock: T0 }),
        'POST',
      );
      await request(
        tee,
        `${fixture.path}/nope`,
        replying(fixture, { clock: T0 }),
      );
      await request(tee, fixture.path, (req, res) => {
        res.writeHead(200);
        res.end('<html>not json</html>');
      });
      await recorder.flush();
      assert.equal(store.appended.length, 0);
    });
  });
}

const flights = FIXTURES.find((fixture) => fixture.path === '/api/flights');

describe('aircraft: the adsb.lol regional fallback behind /api/flights', () => {
  const fallbackReply = (hexes, lat) => (req, res) => {
    res.setHeader('X-OpenSky-Auth', 'adsblol-regional');
    res.setHeader('X-OpenSky-Cache', 'MISS');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(adsbLolFallbackBody({ nowMs: T0, hexes, lat })));
  };

  it('records the fallback shape, timed by each aircraft\'s own position time', async () => {
    const { store, recorder, tee } = await setup(flights);
    await request(tee, '/api/flights?lat=30.1&lon=-97.7', fallbackReply(['a1b2c3', 'a1b2c4']));
    await recorder.flush();
    const rows = rowsOf(store, 'aircraft');
    assert.deepEqual(rows.map((row) => row.key).sort(), ['a1b2c3', 'a1b2c4']);
    assert.ok(rows.every((row) => row.t < T0 && row.t > T0 - 5_000));
  });

  it('keeps answers for different view anchors that carry the same time apart', async () => {
    const { store, recorder, tee } = await setup(flights);
    await request(tee, '/api/flights?lat=30.1&lon=-97.7', fallbackReply(['a1b2c3']));
    await request(tee, '/api/flights?lat=48.9&lon=2.3', fallbackReply(['ffee01'], 48.9));
    await recorder.flush();
    assert.deepEqual(
      rowsOf(store, 'aircraft').map((row) => row.key).sort(),
      ['a1b2c3', 'ffee01'],
    );
    assert.equal(store.ingests.length, 2);
    // The same anchor again, in the same second, is still the same answer.
    await request(tee, '/api/flights?lat=30.12&lon=-97.68', fallbackReply(['a1b2c3']));
    await recorder.flush();
    assert.equal(store.ingests.length, 2);
  });

  it('does not split a world-wide OpenSky answer by the view that asked', async () => {
    const { store, recorder, tee } = await setup(flights);
    const reply = replying(flights, { clock: T0 });
    await request(tee, '/api/flights?lat=30.1&lon=-97.7', reply);
    await request(tee, '/api/flights?lat=48.9&lon=2.3', reply);
    await recorder.flush();
    assert.equal(store.ingests.length, 1);
  });
});

describe('a failed answer is a failed poll even when the proxy calls it a replay', () => {
  for (const [path, header, status] of [
    ['/api/flights', 'X-OpenSky-Cache', 429],
    ['/api/military', 'X-Feed-Cache', 503],
  ]) {
    it(`${path} ${status} with ${header}: STALE`, async () => {
      const fixture = FIXTURES.find((candidate) => candidate.path === path);
      const { store, recorder, tee } = await setup(fixture);
      await request(tee, path, (req, res) => {
        res.setHeader(header, 'STALE');
        res.writeHead(status);
        res.end('{}');
      });
      await recorder.flush();
      assert.deepEqual(store.ingests.map((i) => i.ok), [false]);
    });
  }
});

describe('military: the answer clock', () => {
  it('reads milliseconds as they are and seconds as seconds', () => {
    assert.equal(answerClockMs({ now: T0 }), T0);
    assert.equal(answerClockMs({ now: Math.floor(T0 / 1000) }), Math.floor(T0 / 1000) * 1000);
    assert.equal(answerClockMs({ now: 0 }), null);
    assert.equal(answerClockMs({}), null);
  });

  it('times a record from a seconds clock the same as from a milliseconds one', () => {
    const body = (now) => ({
      now,
      ac: [{ hex: 'ae1234', lat: 38.9, lon: -77, seen_pos: 2 }],
    });
    const military = ADAPTERS.military;
    const [fromMs] = military.toRecords(body(T0));
    const [fromS] = military.toRecords(body(T0 / 1000));
    assert.equal(fromS.t, fromMs.t);
    assert.equal(fromMs.t, T0 - 2_000);
  });
});

describe('vessels: the AISStream snapshot behind /api/vessels', () => {
  const fixture = FIXTURES.find((candidate) => candidate.feed === 'vessels');
  const snapshotReply =
    (options, status = 200) =>
    (req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fixture.build({ clock: T0, ...options })));
    };

  it('keeps the whitelisted fields, drops the placeholder name and empty codes', () => {
    const records = ADAPTERS.vessels.toRecords(fixture.build({ clock: T0 }));
    const byId = Object.fromEntries(records.map((record) => [record.id, record]));
    assert.deepEqual(Object.keys(byId).sort(), ['244123456', '366999001', '538005000']);
    assert.deepEqual(byId['244123456'].props, {});
    assert.equal(byId['366999001'].props.imo, '9811000');
    assert.equal(byId['366999001'].props.shipType, '70');
    assert.equal(byId['366999001'].t % 1000, 0);
  });

  it('is a heavy feed: named, not part of HISTORY_RECORD=1', () => {
    assert.equal(ADAPTERS.vessels.defaultOn, false);
  });

  it('notes a poll while the feed is not live as a failed poll, once a minute, and records nothing', async () => {
    for (const status of ['down', 'auth-failed', 'missing-key', 'stale', 'reconnecting']) {
      const { store, recorder, tee, clock } = await setup(fixture);
      await request(tee, '/api/vessels', snapshotReply({ status }));
      await request(tee, '/api/vessels', snapshotReply({ status, variant: 1 }));
      clock.now += 61_000;
      await request(tee, '/api/vessels', snapshotReply({ status, variant: 2 }));
      await recorder.flush();
      assert.equal(rowsOf(store, 'vessels').length, 0, status);
      assert.deepEqual(store.ingests.map((i) => i.ok), [false, false], status);
    }
  });

  it('notes the 503 the route answers without a key, and a 502, as failed polls', async () => {
    const { store, recorder, tee, clock } = await setup(fixture);
    await request(tee, '/api/vessels', (req, res) => {
      res.writeHead(503);
      res.end('{"rows":[],"status":"missing-key"}');
    });
    clock.now += 61_000;
    await request(tee, '/api/vessels', (req, res) => {
      res.writeHead(502);
      res.end('{"rows":[]}');
    });
    await recorder.flush();
    assert.deepEqual(store.ingests.map((i) => i.ok), [false, false]);
  });

  it('does not watch the track sub-route, and compares snapshots per maxRows', async () => {
    const { store, recorder, tee } = await setup(fixture);
    await request(tee, '/api/vessels/track?mmsi=366999001', snapshotReply({}));
    await request(tee, '/api/vessels?mmsi=1', snapshotReply({}));
    await recorder.flush();
    assert.equal(store.appended.length, 1);
    await request(tee, '/api/vessels?maxRows=2', snapshotReply({}));
    await recorder.flush();
    assert.equal(store.ingests.length, 2);
  });

  it('a vessel that has not reported again writes nothing on the next snapshot', async () => {
    const { store, recorder, tee } = await setup(fixture);
    await request(tee, '/api/vessels', snapshotReply({}));
    await recorder.flush();
    // Later snapshot, but the same cached fixes (same report times and places).
    const again = fixture.build({ clock: T0 });
    again.lastMessageAt += 5_000;
    await request(tee, '/api/vessels', (req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify(again));
    });
    await recorder.flush();
    assert.equal(rowsOf(store, 'vessels').length, fixture.expectedRows);
    assert.equal(store.ingests.length, 2);
  });
});

describe('transit: one poll per operator behind /api/transit/vehicles', () => {
  const fixture = FIXTURES.find((candidate) => candidate.feed === 'transit');
  const path = (id) => `/api/transit/vehicles/${id}`;
  const answer = (options, header = 'MISS') => (req, res) => {
    res.setHeader('X-GEV-Cache', header);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(fixture.build({ clock: T0, ...options })));
  };

  it('is a heavy feed: named, not part of HISTORY_RECORD=1', () => {
    assert.equal(ADAPTERS.transit.defaultOn, false);
  });

  it('keys a vehicle by operator and times it by the best clock the proxy had', () => {
    const records = ADAPTERS.transit.toRecords(fixture.build({ clock: T0 }));
    const byId = Object.fromEntries(records.map((record) => [record.id, record]));
    assert.deepEqual(Object.keys(byId).sort(), [
      'ttc-toronto:1001',
      'ttc-toronto:1002',
      'ttc-toronto:1003',
    ]);
    assert.equal(byId['ttc-toronto:1001'].t, T0 - 3_000);
    assert.equal(byId['ttc-toronto:1002'].t, T0 - 4_000);
    // No operator clock at all: the proxy's own fetch time, labelled as such.
    assert.equal(byId['ttc-toronto:1003'].t, T0);
    assert.equal(byId['ttc-toronto:1003'].props.timeSource, 'fetch');
    assert.equal('speedMps' in byId['ttc-toronto:1002'].props, false);
  });

  it('refuses a snapshot whose operator id is not a plain id', () => {
    for (const feedId of ['', 'a/b', '../x', 'x'.repeat(60), 7, null])
      assert.deepEqual(
        ADAPTERS.transit.toRecords({ ...fixture.build({ clock: T0 }), feedId }),
        [],
      );
  });

  it('keeps two operators that use the same vehicle id apart, each with its own poll', async () => {
    const { store, recorder, tee } = await setup(fixture);
    const other = (req, res) => {
      res.setHeader('X-GEV-Cache', 'MISS');
      res.writeHead(200);
      res.end(JSON.stringify({ ...fixture.build({ clock: T0 }), feedId: 'mbta' }));
    };
    await request(tee, path('ttc-toronto'), answer({}));
    await request(tee, path('mbta'), other);
    await recorder.flush();
    const keys = rowsOf(store, 'transit').map((row) => row.key);
    assert.equal(keys.length, 6);
    assert.equal(new Set(keys).size, 6);
    assert.equal(store.ingests.length, 2);
  });

  it('records only a fresh fetch: HIT, INFLIGHT and STALE-ERROR are the same data again', async () => {
    for (const header of ['HIT', 'INFLIGHT', 'STALE-ERROR']) {
      const { store, recorder, tee } = await setup(fixture);
      await request(tee, fixture.path, answer({}, header));
      await recorder.flush();
      assert.equal(store.appended.length, 0, header);
    }
    const { store, recorder, tee } = await setup(fixture);
    await request(tee, fixture.path, answer({}, 'MISS'));
    await recorder.flush();
    assert.equal(rowsOf(store, 'transit').length, 3);
  });

  it('notes the proxy\'s 503 and 504 as failed polls', async () => {
    const { store, recorder, tee, clock } = await setup(fixture);
    await request(tee, fixture.path, (req, res) => {
      res.setHeader('X-GEV-Cache', 'NONE');
      res.writeHead(503);
      res.end('{"error":"Transit feed unavailable"}');
    });
    clock.now += 61_000;
    await request(tee, fixture.path, (req, res) => {
      res.writeHead(504);
      res.end('{}');
    });
    await recorder.flush();
    assert.deepEqual(store.ingests.map((i) => i.ok), [false, false]);
  });

  it('watches the vehicles route only, not the catalogue or the MBTA trail', async () => {
    const { store, recorder, tee } = await setup(fixture);
    await request(tee, '/api/transit/feeds', answer({}));
    await request(tee, '/api/transit/trail/mbta/y1234', answer({}));
    await request(tee, '/api/transit/vehicles/bad%2Fid', answer({}));
    await request(tee, '/api/transit/vehicles/%E0%A4%A', answer({}));
    await recorder.flush();
    assert.equal(store.appended.length, 0);
  });
});

describe('bikeshare: station_status joined with station_information behind /api/gbfs', () => {
  const fixture = FIXTURES.find((candidate) => candidate.feed === 'bikeshare');
  const [information] = fixture.prime;
  const gbfs = (url) => `/api/gbfs/${encodeURIComponent(url)}`;
  const reply = (body, status = 200) => (req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const status = () => fixture.build({ clock: T0 });

  it('is a heavy feed: named, not part of HISTORY_RECORD=1', () => {
    assert.equal(ADAPTERS.bikeshare.defaultOn, false);
  });

  it('records availability at the learned positions, and the unlocated station without one', async () => {
    const { store, recorder, tee } = await setup(fixture);
    await request(tee, fixture.path, reply(status()));
    await recorder.flush();
    const rows = Object.fromEntries(
      rowsOf(store, 'bikeshare').map((row) => [row.key.split('#')[1], row]),
    );
    assert.deepEqual(Object.keys(rows).sort(), ['S1', 'S2', 'S3', 'S99']);
    assert.ok(Number.isFinite(rows.S1.lat) && Number.isFinite(rows.S1.lon));
    assert.equal(rows.S1.data.name, 'Station 1');
    assert.equal(rows.S1.data.bikesAvailable, 8);
    assert.equal(rows.S2.data.renting, false);
    assert.equal(rows.S2.data.installed, true);
    assert.equal(rows.S99.lat ?? null, null);
    assert.equal(rows.S1.t, T0 - 20_000);
  });

  it('station_information records nothing itself and does not move any poll log', async () => {
    const { store, recorder, tee } = await setup(fixture);
    await recorder.flush();
    assert.equal(store.appended.length, 0);
    assert.equal(store.ingests.length, 0);
  });

  it('a status answer seen before any station_information has no positions, a later one does', async () => {
    const { store, recorder, tee } = await setup(fixture, {});
    // setup() primed; use a second system that was never primed.
    const other = gbfs('https://gbfs.bluebikes.com/gbfs/en/station_status.json');
    await request(tee, other, reply(status()));
    await request(
      tee,
      gbfs('https://gbfs.bluebikes.com/gbfs/en/station_information.json'),
      reply(information.body),
    );
    await request(tee, other, reply(fixture.build({ clock: T0, variant: 1 })));
    await recorder.flush();
    const rows = rowsOf(store, 'bikeshare').filter((row) =>
      row.key.startsWith('gbfs.bluebikes.com/gbfs/en#'),
    );
    const s1 = rows.filter((row) => row.key.endsWith('#S1'));
    assert.equal(s1.length, 2);
    assert.equal(s1[0].lat ?? null, null);
    assert.ok(Number.isFinite(s1[1].lat));
  });

  it('keeps each system apart, in its keys and in its comparison with the last answer', async () => {
    const { store, recorder, tee } = await setup(fixture);
    await request(
      tee,
      gbfs('https://gbfs.bluebikes.com/gbfs/en/station_status.json'),
      reply(status()),
    );
    await recorder.flush();
    const systems = new Set(
      rowsOf(store, 'bikeshare').map((row) => row.key.split('#')[0]),
    );
    assert.deepEqual([...systems], ['gbfs.bluebikes.com/gbfs/en']);
    await request(tee, fixture.path, reply(status()));
    await recorder.flush();
    assert.equal(store.ingests.length, 2);
  });

  it('ignores a URL the proxy itself would refuse, and never puts a query in a key', async () => {
    const { store, recorder, tee } = await setup(fixture);
    for (const url of [
      'http://gbfs.lyft.com/gbfs/2.3/bkn/en/station_status.json',
      'https://evil.example/gbfs/station_status.json',
      'https://gbfs.lyft.com/gbfs/2.3/bkn/en/system_alerts.json',
    ])
      await request(tee, gbfs(url), reply(status()));
    await request(tee, '/api/gbfs/%E0%A4%A', reply(status()));
    await recorder.flush();
    assert.equal(store.appended.length, 0);
    await request(
      tee,
      gbfs(`${'https://gbfs.lyft.com/gbfs/2.3/bkn/en'}/station_status.json?token=QUERYSECRET1`),
      reply(status()),
    );
    await recorder.flush();
    const keys = rowsOf(store, 'bikeshare').map((row) => row.key);
    assert.ok(keys.length > 0);
    assert.ok(keys.every((key) => !key.includes('QUERYSECRET1') && !key.includes('?')));
  });

  it('station directory is bounded in systems and in stations per system', () => {
    const directory = createStationDirectory({ maxSystems: 2, maxStations: 2 });
    const info = informationBody({ count: 5 });
    directory.learn('a', info);
    directory.learn('b', info);
    directory.learn('c', info);
    assert.equal(directory.size, 2);
    assert.equal(directory.locate('a'), null);
    assert.equal(directory.locate('c').size, 2);
    directory.learn('c', { data: { stations: 'x' } });
    directory.learn('c', { data: { stations: [{ station_id: 'Z', lat: 0, lon: 0 }] } });
    assert.equal(directory.locate('c').size, 2);
  });
});
