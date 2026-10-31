import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRecorder } from './index.js';
import { createHistoryTee } from './tee.js';
import { ADAPTERS } from './adapters/index.js';
import { createFeedRoutes } from './routes.js';
import { FIXTURES } from './feedFixtures/index.mjs';
import { adsbLolFallbackBody } from './feedFixtures/aircraft.mjs';
import { answerClockMs } from './adapters/military.js';
import { request } from './feedFixtures/http.mjs';
import { T0, stubStore } from './fixtures.mjs';

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

function setup(fixture, { feeds = [fixture.feed], clock = { now: T0 } } = {}) {
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
        { states: 5, ac: 'x', rows: 7 },
      ])
        assert.ok(Array.isArray(adapter.toRecords(junk)));
    });

    it('skips an answer the proxy marks as a cache replay', async (t) => {
      if (!fixture.replay) return t.skip('this proxy route never replays an answer');
      const { store, recorder, tee } = setup(fixture);
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
      const { store, recorder, tee } = setup(fixture);
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
      const { store, recorder, tee } = setup(fixture);
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
      const { store, recorder, tee, clock } = setup(fixture);
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
      const { store, recorder, tee } = setup(fixture, { feeds: [] });
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
      const { store, recorder, tee } = setup(fixture);
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
    const { store, recorder, tee } = setup(flights);
    await request(tee, '/api/flights?lat=30.1&lon=-97.7', fallbackReply(['a1b2c3', 'a1b2c4']));
    await recorder.flush();
    const rows = rowsOf(store, 'aircraft');
    assert.deepEqual(rows.map((row) => row.key).sort(), ['a1b2c3', 'a1b2c4']);
    assert.ok(rows.every((row) => row.t < T0 && row.t > T0 - 5_000));
  });

  it('keeps answers for different view anchors that carry the same time apart', async () => {
    const { store, recorder, tee } = setup(flights);
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
    const { store, recorder, tee } = setup(flights);
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
      const { store, recorder, tee } = setup(fixture);
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
      const { store, recorder, tee, clock } = setup(fixture);
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
    const { store, recorder, tee, clock } = setup(fixture);
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
    const { store, recorder, tee } = setup(fixture);
    await request(tee, '/api/vessels/track?mmsi=366999001', snapshotReply({}));
    await request(tee, '/api/vessels?mmsi=1', snapshotReply({}));
    await recorder.flush();
    assert.equal(store.appended.length, 1);
    await request(tee, '/api/vessels?maxRows=2', snapshotReply({}));
    await recorder.flush();
    assert.equal(store.ingests.length, 2);
  });

  it('a vessel that has not reported again writes nothing on the next snapshot', async () => {
    const { store, recorder, tee } = setup(fixture);
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
