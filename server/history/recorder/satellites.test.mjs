import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fsp } from 'node:fs';
import { celestrakProxy } from '../../providers/space/celestrak.js';
import { createRecorder } from './index.js';
import { createHistoryTee } from './tee.js';
import { ADAPTERS } from './adapters/index.js';
import {
  GROUPS,
  MAX_SETS,
  fromText,
  tleChecksumOk,
  tleEpochMs,
  toRecords,
} from './adapters/satellites.js';
import { createFeedRoutes } from './routes.js';
import { request } from './feedFixtures/http.mjs';
import { tle } from './feedFixtures/satellites.mjs';
import { T0, stubStore } from './fixtures.mjs';

// The textbook ISS element set (checksums 7 and 7), epoch 2008-09-20 12:25:40.104 UTC.
const ISS = {
  name: 'ISS (ZARYA)',
  line1:
    '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927',
  line2:
    '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537',
};

describe('satellites adapter', () => {
  it('turns a real element set into one epoch row with no position', () => {
    const [row, ...rest] = toRecords({ sets: [ISS] });
    assert.equal(rest.length, 0);
    assert.equal(row.id, '25544');
    assert.equal(row.t, Date.UTC(2008, 8, 20, 12, 25, 40, 104));
    assert.equal(row.lat, null);
    assert.equal(row.lon, null);
    assert.equal(row.props.line1, ISS.line1);
    assert.equal(row.props.inclinationDeg, 51.6416);
    assert.equal(row.props.meanMotionRevDay, 15.72125391);
    assert.ok(Math.abs(row.props.bstar + 0.000011606) < 1e-12);
  });

  it('refuses a bad checksum, a mismatched pair, a malformed line and a pre-1970 epoch', () => {
    const flip = (line) => `${line.slice(0, 68)}${(Number(line[68]) + 1) % 10}`;
    assert.equal(tleChecksumOk(ISS.line1), true);
    assert.equal(tleChecksumOk(flip(ISS.line1)), false);
    const other = tle({ name: 'X', satnum: '25545', epochMs: T0 });
    const old = tle({ name: 'OLD', satnum: '11111', epochMs: T0 });
    const pre1970 = old.line1.replace(/ 26\d{3}\./, ' 65001.');
    const resealed = `${pre1970.slice(0, 68)}0`;
    assert.equal(tleEpochMs(resealed), null);
    assert.ok(tleEpochMs(old.line1) > 0);
    const bad = [
      { ...ISS, line1: flip(ISS.line1) },
      { ...ISS, line2: other.line2 },
      { ...ISS, line1: `${ISS.line1.slice(0, 20)}x${ISS.line1.slice(21)}` },
      { ...ISS, line1: ISS.line1.slice(0, 60) },
      { ...ISS, line1: resealed },
    ];
    assert.deepEqual(toRecords({ sets: bad }), []);
  });

  it('keeps no name that is not a TLE name', () => {
    const long = { ...ISS, name: 'x'.repeat(25) };
    const control = { ...ISS, name: 'bad\u0000name' };
    for (const set of [long, control])
      assert.equal('name' in toRecords({ sets: [set] })[0].props, false);
  });

  it('bounds one answer to MAX_SETS and never throws on text', () => {
    const text = Array.from(
      { length: 10 },
      (_, i) => tle({ name: `S${i}`, satnum: String(40000 + i), epochMs: T0 }).text,
    ).join('');
    assert.equal(fromText(text).sets.length, 10);
    assert.ok(MAX_SETS >= 1000);
    for (const junk of [undefined, null, 5, {}, '', 'ISS\n1 x\n2 y\n'])
      assert.deepEqual(fromText(junk).sets, []);
  });
});

function pipeline(feeds = ['satellites']) {
  const store = stubStore();
  const config = {
    feeds: Object.fromEntries(
      Object.keys(ADAPTERS).map((feed) => [
        feed,
        { record: feeds.includes(feed), minIntervalMs: 6 * 3_600_000 },
      ]),
    ),
    queueRows: 100_000,
    flushMs: 5_000,
  };
  const recorder = createRecorder({
    store,
    config,
    adapters: ADAPTERS,
    clock: () => T0,
    warn() {},
  });
  const tee = createHistoryTee({
    recorder,
    routes: createFeedRoutes(),
    clock: () => T0,
  });
  return { store, recorder, tee };
}
const answer = (text) => (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(text);
};

describe('satellites route', () => {
  const set = tle({ name: 'ISS (ZARYA)', satnum: '25544', epochMs: T0 - 3_600_000 });

  it('records only the small groups', async () => {
    const { store, recorder, tee } = pipeline();
    for (const group of [...GROUPS, 'starlink', 'active', 'nope']) {
      await request(tee, `/api/celestrak/${group}`, answer(set.text));
      await recorder.flush();
    }
    // Same set in every recorded group: stored once, polled once per group.
    assert.equal(store.appended.flatMap((a) => a.rows).length, 1);
    assert.equal(store.ingests.length, GROUPS.length);
    assert.deepEqual(GROUPS.includes('starlink') || GROUPS.includes('active'), false);
  });

  it('logs a 200 that holds no element set as a failed poll', async () => {
    const { store, recorder, tee } = pipeline();
    await request(tee, '/api/celestrak/stations', answer('<html>sorry</html>'));
    await recorder.flush();
    assert.deepEqual(store.ingests.map((i) => i.ok), [false]);
    assert.equal(store.appended.length, 0);
  });

  it('works against the real proxy over a real HTTP server (headers readable)', async (t) => {
    t.mock.method(fsp, 'readFile', async () => {
      throw Error('no cache');
    });
    t.mock.method(fsp, 'mkdir', async () => {});
    t.mock.method(fsp, 'writeFile', async () => {});
    t.mock.method(console, 'warn', () => {});
    let fetched = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      fetched += 1;
      return new Response(set.text);
    });
    let proxy;
    celestrakProxy().configureServer({
      middlewares: { use: (_mount, handler) => (proxy = handler) },
    });
    const { store, recorder, tee } = pipeline();
    const server = http.createServer((req, res) => {
      tee(req, res, () => {
        req.url = req.url.replace('/api/celestrak', '');
        proxy(req, res);
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const get = () =>
      new Promise((resolve, reject) => {
        http
          .get(
            {
              host: '127.0.0.1',
              port: server.address().port,
              path: '/api/celestrak/stations',
            },
            (res) => {
              let body = '';
              res.on('data', (c) => (body += c));
              res.on('end', () =>
                setImmediate(() => setImmediate(() => resolve({ res, body }))),
              );
            },
          )
          .on('error', reject);
      });
    try {
      const first = await get();
      const second = await get();
      await recorder.flush();
      assert.equal(first.res.headers['x-tle-cache'], 'MISS');
      assert.equal(second.res.headers['x-tle-cache'], 'HIT');
      assert.equal(first.body, set.text);
      assert.equal(second.body, set.text);
      assert.equal(fetched, 1);
      // The fresh fetch is one poll with one row; the replay adds nothing.
      assert.equal(store.appended.flatMap((a) => a.rows).length, 1);
      assert.equal(store.ingests.length, 1);
      assert.equal(
        store.ingests[0].t,
        Date.parse(first.res.headers['x-tle-cached-at']),
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
