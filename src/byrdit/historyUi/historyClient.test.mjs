import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HISTORY_UNAVAILABLE,
  HistoryUnavailableError,
  createHistoryClient,
} from './historyClient.js';
import { fixtureFetch, fixtureWorld } from './fixtures/b11Coverage.mjs';

const NOW = Date.parse('2026-10-14T16:00:00Z');
const Q = {
  feed: 'military',
  from: NOW - 3_600_000,
  to: NOW - 1_800_000,
  bucket: '1m',
};

test('coverage + snapshots against the B9 answer shapes', async () => {
  const calls = [];
  const client = createHistoryClient({
    fetchImpl: fixtureFetch(fixtureWorld(NOW), { calls }),
    now: () => NOW,
  });
  const cov = await client.coverage(Q);
  assert.equal(cov.lanes[0].source, 'collector');
  assert.equal(cov.lanes[0].buckets.length, 30);
  assert.match(
    calls[0],
    /^\/api\/history\/coverage\?feed=military&from=2026-10-14T15%3A00%3A00\.000Z&to=.*&bucket=1m$/,
  );
  const snaps = await client.snapshots({
    feed: 'aircraft',
    around: NOW - 600_000,
    n: 5,
  });
  assert.equal(snaps.length, 5);
  assert.deepEqual(
    snaps,
    [...snaps].sort((a, b) => a - b),
  );
  assert.ok(snaps.includes(NOW - 600_000));
});

test('coverage is cached per exact question and shared while in flight', async () => {
  const calls = [];
  const client = createHistoryClient({
    fetchImpl: fixtureFetch(fixtureWorld(NOW), { calls }),
    now: () => NOW,
  });
  const [a, b] = await Promise.all([client.coverage(Q), client.coverage(Q)]);
  assert.equal(a, b);
  await client.coverage(Q);
  assert.equal(calls.length, 1);
  await client.coverage({ ...Q, feed: 'aircraft' });
  assert.equal(calls.length, 2);
});

test('coverage at the live edge is asked again after a minute', async () => {
  let now = NOW;
  const calls = [];
  const client = createHistoryClient({
    fetchImpl: fixtureFetch(fixtureWorld(NOW), { calls }),
    now: () => now,
  });
  const live = { ...Q, to: NOW };
  await client.coverage(live);
  await client.coverage(live);
  assert.equal(calls.length, 1);
  now += 61_000;
  await client.coverage(live);
  assert.equal(calls.length, 2);
});

test('quiet failure: every failure is HistoryUnavailableError("history unavailable")', async () => {
  const cases = {
    network: async () => {
      throw new TypeError('Failed to fetch');
    },
    status: async () =>
      new Response('{"error":"history_unavailable"}', {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    rate: async () =>
      new Response('{"error":"rate_limited"}', {
        status: 429,
        headers: { 'content-type': 'application/json' },
      }),
    // plugin off: the SPA fallback answers index.html with 200
    not_json: async () =>
      new Response('<!doctype html><html></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    bad_body: async () =>
      new Response('{"lanes":', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    shape: async () =>
      new Response('{"nope":1}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  };
  for (const [name, fetchImpl] of Object.entries(cases)) {
    const client = createHistoryClient({ fetchImpl, now: () => NOW });
    await assert.rejects(
      client.coverage(Q),
      (e) =>
        e instanceof HistoryUnavailableError &&
        e.message === HISTORY_UNAVAILABLE,
      name,
    );
    await assert.rejects(
      client.snapshots({ feed: 'military', around: NOW }),
      HistoryUnavailableError,
      name,
    );
  }
});

test('an aborted snapshot request stays an AbortError (not "unavailable")', async () => {
  const client = createHistoryClient({
    fetchImpl: async (_url, { signal }) => {
      signal.throwIfAborted();
      return new Response('{}');
    },
  });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    client.snapshots({ feed: 'aircraft', around: NOW }, { signal: ac.signal }),
    (e) => e.name === 'AbortError',
  );
});

test('snapshots: duplicate epochs from two sources come back once (review R1)', async () => {
  const client = createHistoryClient({
    fetchImpl: fixtureFetch(fixtureWorld(NOW, { mixedSources: true })),
    now: () => NOW,
  });
  const around = NOW - 600_000;
  const snaps = await client.snapshots({ feed: 'aircraft', around, n: 6 });
  // 6 entries = 3 distinct minutes, each as adsblol + opensky
  assert.deepEqual(snaps, [around - 60_000, around, around + 60_000]);
});
