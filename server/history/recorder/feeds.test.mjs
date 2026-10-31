import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRecorder } from './index.js';
import { createHistoryTee } from './tee.js';
import { ADAPTERS } from './adapters/index.js';
import { createFeedRoutes } from './routes.js';
import { FIXTURES } from './feedFixtures/index.mjs';
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
      const payload = fixture.kind === 'text' ? input : input;
      const records = adapter.toRecords(
        fixture.adapterInput ? fixture.adapterInput(payload, T0) : payload,
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
        { states: 5, ac: 'x' },
      ])
        assert.ok(Array.isArray(adapter.toRecords(junk)));
    });

    it('skips an answer the proxy marks as a cache replay', async () => {
      const { store, recorder, tee } = setup(fixture);
      const header = fixture.feed === 'aircraft' ? 'X-OpenSky-Cache' : 'X-Feed-Cache';
      const replay = (req, res) => {
        res.setHeader(header, 'HIT');
        replying(fixture, { clock: T0 })(req, res);
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
