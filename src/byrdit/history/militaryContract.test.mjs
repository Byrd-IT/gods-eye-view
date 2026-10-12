import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCollectorBridge } from './collectorBridge.js';
import { feedDisplayState } from './staleness.js';
import { createMilitarySource } from '../../sources/live/standalone.js';

/**
 * Contract: the bridge answer for /api/military must stay what GEV's live
 * route returns today (readsb JSON from adsb.lol /v2/mil) and what the
 * collector's /v1/latest/military serves. The fixture was captured on S4 on
 * 2026-10-12 14:20 UTC from BOTH endpoints (GEV f9da1d7, collector a23c57a4):
 * same top-level keys, same 55-key row union, 196 aircraft; the committed
 * fixture keeps 4 rows that together cover every row key.
 * Post-merge checklist: "history bridge fixtures still match" = this file.
 */

const FIXTURE = readFileSync(
  new URL('./fixtures/military-latest.json', import.meta.url),
);
const META = JSON.parse(
  readFileSync(
    new URL('./fixtures/military-latest.meta.json', import.meta.url),
    'utf8',
  ),
);

test('fixture is real readsb JSON with the captured shape', () => {
  const body = JSON.parse(FIXTURE);
  assert.deepEqual(Object.keys(body).sort(), META.topLevelKeys);
  assert.deepEqual(META.topLevelKeys, [
    'ac',
    'ctime',
    'msg',
    'now',
    'ptime',
    'total',
  ]);
  const union = new Set(body.ac.flatMap((row) => Object.keys(row)));
  assert.deepEqual([...union].sort(), META.rowKeyUnion);
  for (const key of ['hex', 'lat', 'lon', 'flight', 'lastPosition', 'dbFlags'])
    assert.ok(union.has(key), key);
  assert.equal(META.fullRows, 196);
  assert.equal(META.fixtureRows, body.ac.length);
});

test('live route and collector carried the same headers the bridge relies on', () => {
  assert.equal(META.liveHeaders['X-Feed-Source'], 'adsb.lol');
  assert.equal(META.collectorHeaders['X-Feed-Source'], 'adsb.lol');
  assert.equal(META.collectorHeaders['X-Collector-Role'], 'active');
  assert.equal(META.collectorHeaders['Content-Type'], 'application/json');
  for (const key of ['X-Feed-Cache', 'X-Feed-Age-Ms', 'X-Feed-Last-OK'])
    assert.ok(key in META.collectorHeaders, key);
});

function bridgeFor(answer, clock) {
  return createCollectorBridge({
    name: 'military',
    urls: ['http://collector'],
    fetchImpl: async () => answer(),
    now: () => clock.now,
    log: () => {},
  });
}

/** Run the bridge, then hand its answer to GEV's own military source. */
async function throughGevSource(handler, clock) {
  let done;
  const finished = new Promise((resolve) => (done = resolve));
  const res = {
    headers: {},
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
      done();
    },
  };
  await handler({ url: '/', method: 'GET' }, res, () => {
    throw new Error('bridge fell through');
  });
  await finished;
  const response = new Response(res.body, {
    status: res.status,
    headers: res.headers,
  });
  const source = createMilitarySource({
    fetchImpl: async (url) => {
      assert.equal(url, '/api/military');
      return response.clone();
    },
    now: () => clock.now,
  });
  return { res, response, source };
}

test("GEV's military source reads the bridged answer like the live one", async () => {
  const lastOk = 1_791_814_776_089;
  const clock = { now: lastOk + 5_000 };
  let up = true;
  const handler = bridgeFor(() => {
    if (!up) throw new Error('down');
    return new Response(FIXTURE, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Feed-Source': 'adsb.lol',
        'X-Feed-Cache': 'HIT',
        'X-Feed-Age-Ms': '5000',
        'X-Feed-Last-OK': String(lastOk),
        'X-Collector-Role': 'active',
      },
    });
  }, clock);

  const fresh = await throughGevSource(handler, clock);
  assert.ok(Buffer.from(fresh.res.body).equals(FIXTURE));
  const snap = await fresh.source.getSnapshot();
  assert.equal(snap.status, 200);
  assert.equal(snap.stale, false);
  assert.ok(Array.isArray(snap.records));
  assert.ok(snap.records.length > 0);
  assert.equal(snap.source, 'adsb.lol');
  assert.equal(snap.observedAtMs, lastOk, 'observed = now - X-Feed-Age-Ms');
  assert.equal(feedDisplayState(fresh.response).state, 'live');

  up = false;
  clock.now = lastOk + 200_000;
  const stale = await throughGevSource(handler, clock);
  const staleSnap = await stale.source.getSnapshot();
  assert.equal(staleSnap.stale, true, 'GEV marks the layer stale');
  assert.equal(staleSnap.observedAtMs, lastOk, 'age is the true data age');
  assert.equal(
    staleSnap.records.length,
    snap.records.length,
    'same aircraft drawn (grey) from the last-good body',
  );
  const display = feedDisplayState(stale.response, {
    timeZone: 'America/Chicago',
  });
  assert.equal(display.state, 'grey');
  assert.equal(display.chip, 'No data since 09:19 CDT');

  clock.now = lastOk + 180_000 + 3_600_000;
  const cleared = await throughGevSource(handler, clock);
  assert.equal(feedDisplayState(cleared.response).state, 'cleared');
});
