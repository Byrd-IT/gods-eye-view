/**
 * The behaviour every history store backend must show. A backend's test file
 * calls defineHistoryStoreContract() with a factory; the suite lives here once
 * so the SQLite and Elasticsearch backends are held to the same answers.
 */
import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 1);

const obs = (t, key, lat = null, lon = null, data = {}) => ({
  t,
  key,
  lat,
  lon,
  data,
});

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.name, 'HistoryStoreError');
    assert.equal(error.code, code);
    return true;
  });
}

/**
 * @param {string} label backend name for the report
 * @param {() => Promise<object>|object} makeStore returns a fresh, empty store
 */
export function defineHistoryStoreContract(label, makeStore) {
  describe(`history store contract: ${label}`, () => {
    let store;
    beforeEach(async () => {
      store = await makeStore();
    });
    afterEach(async () => {
      await store.close();
    });

    describe('append', () => {
      it('stores observations and reports the count', async () => {
        const result = await store.append('aircraft', [
          obs(T0, 'a', 10, 20),
          obs(T0, 'b', 11, 21),
        ]);
        assert.deepEqual(result, { written: 2 });
      });

      it('accepts an empty batch', async () => {
        assert.deepEqual(await store.append('aircraft', []), { written: 0 });
      });

      it('replaces a row with the same feed, time and key', async () => {
        await store.append('aircraft', [obs(T0, 'a', 10, 20, { v: 1 })]);
        await store.append('aircraft', [obs(T0, 'a', 12, 22, { v: 2 })]);
        const { observations } = await store.slice('aircraft', { t: T0 });
        assert.equal(observations.length, 1);
        assert.deepEqual(observations[0], {
          t: T0,
          key: 'a',
          lat: 12,
          lon: 22,
          data: { v: 2 },
        });
        assert.equal((await store.coverage('aircraft')).count, 1);
      });

      it('is all-or-nothing: one bad row stores none', async () => {
        await rejectsWith(
          store.append('aircraft', [obs(T0, 'a', 10, 20), { t: T0, key: '' }]),
          'INVALID_ARGUMENT',
        );
        assert.equal((await store.coverage('aircraft')).count, 0);
      });

      it('round-trips nested and non-ASCII data', async () => {
        const data = {
          name: 'Zürich → 東京',
          nested: { list: [1, 2, { x: null }] },
          flag: true,
        };
        await store.append('transit', [obs(T0, 'k', 47.4, 8.5, data)]);
        const row = await store.latestBefore('transit', { t: T0, key: 'k' });
        assert.deepEqual(row.data, data);
      });

      it('keeps rows without a position', async () => {
        await store.append('launches', [obs(T0, 'l1')]);
        const { observations } = await store.slice('launches', { t: T0 });
        assert.equal(observations[0].lat, null);
        assert.equal(observations[0].lon, null);
      });
    });

    describe('input validation', () => {
      const bad = [
        ['feed that is not an identifier', () => store.append('Air Craft', [])],
        ['non-array observations', () => store.append('aircraft', 'nope')],
        ['non-integer time', () => store.append('aircraft', [obs(1.5, 'a')])],
        ['negative time', () => store.append('aircraft', [obs(-1, 'a')])],
        ['empty key', () => store.append('aircraft', [obs(T0, '')])],
        [
          'over-long key',
          () => store.append('aircraft', [obs(T0, 'k'.repeat(257))]),
        ],
        [
          'lat without lon',
          () => store.append('aircraft', [{ t: T0, key: 'a', lat: 1 }]),
        ],
        [
          'latitude out of range',
          () => store.append('aircraft', [obs(T0, 'a', 91, 0)]),
        ],
        [
          'longitude out of range',
          () => store.append('aircraft', [obs(T0, 'a', 0, 181)]),
        ],
        [
          'non-object data',
          () => store.append('aircraft', [{ t: T0, key: 'a', data: [] }]),
        ],
        [
          'oversized data',
          () =>
            store.append('aircraft', [
              obs(T0, 'a', 0, 0, { blob: 'x'.repeat(70_000) }),
            ]),
        ],
        ['slice without t', () => store.slice('aircraft', {})],
        [
          'slice limit of zero',
          () => store.slice('aircraft', { t: T0, limit: 0 }),
        ],
        [
          'bbox with south above north',
          () =>
            store.slice('aircraft', {
              t: T0,
              bbox: { west: 0, east: 1, south: 5, north: 1 },
            }),
        ],
        [
          'bbox latitude out of range',
          () =>
            store.slice('aircraft', {
              t: T0,
              bbox: { west: 0, east: 1, south: -95, north: 1 },
            }),
        ],
        [
          'latestBefore without key',
          () => store.latestBefore('aircraft', { t: T0 }),
        ],
        [
          'snapshots with from after to',
          () => store.snapshots('aircraft', { from: 5, to: 1 }),
        ],
        ['prune without before', () => store.prune('aircraft', {})],
      ];
      for (const [name, call] of bad) {
        it(`rejects ${name}`, async () =>
          rejectsWith(call(), 'INVALID_ARGUMENT'));
      }

      it('never quotes a payload or key in an error message', async () => {
        const secret = 'Bearer synthetic-token-0123456789abcdef';
        const error = await store
          .append('aircraft', [
            { t: T0, key: secret, lat: 99, lon: 0, data: { auth: secret } },
          ])
          .catch((caught) => caught);
        assert.equal(error.code, 'INVALID_ARGUMENT');
        assert.ok(!error.message.includes('synthetic-token'), error.message);
        assert.ok(!String(error.stack).includes('synthetic-token'));
      });
    });

    describe('slice', () => {
      it('returns the newest observation per key inside the window', async () => {
        await store.append('vessels', [
          obs(T0, 'a', 1, 1, { n: 'old' }),
          obs(T0 + 5 * MIN, 'a', 2, 2, { n: 'new' }),
          obs(T0 + 2 * MIN, 'b', 3, 3, { n: 'b' }),
        ]);
        const { observations, truncated } = await store.slice('vessels', {
          t: T0 + 6 * MIN,
          windowMs: 10 * MIN,
        });
        assert.equal(truncated, false);
        assert.deepEqual(
          observations.map((o) => [o.key, o.data.n]),
          [
            ['a', 'new'],
            ['b', 'b'],
          ],
        );
      });

      it('excludes observations after t and before the window', async () => {
        await store.append('vessels', [
          obs(T0 - 20 * MIN, 'early', 0, 0),
          obs(T0, 'inside', 0, 0),
          obs(T0 + MIN, 'future', 0, 0),
        ]);
        const { observations } = await store.slice('vessels', {
          t: T0,
          windowMs: 10 * MIN,
        });
        assert.deepEqual(
          observations.map((o) => o.key),
          ['inside'],
        );
      });

      it('treats both ends of the window as inclusive', async () => {
        await store.append('vessels', [
          obs(T0 - 10 * MIN, 'edge', 0, 0),
          obs(T0, 'now', 0, 0),
        ]);
        const { observations } = await store.slice('vessels', {
          t: T0,
          windowMs: 10 * MIN,
        });
        assert.deepEqual(
          observations.map((o) => o.key),
          ['edge', 'now'],
        );
      });

      it('filters by bounding box', async () => {
        await store.append('aircraft', [
          obs(T0, 'in', 10, 10),
          obs(T0, 'north', 50, 10),
          obs(T0, 'east', 10, 50),
        ]);
        const { observations } = await store.slice('aircraft', {
          t: T0,
          bbox: { west: 0, south: 0, east: 20, north: 20 },
        });
        assert.deepEqual(
          observations.map((o) => o.key),
          ['in'],
        );
      });

      it('handles a bounding box that crosses the antimeridian', async () => {
        await store.append('aircraft', [
          obs(T0, 'fiji', -17, 178),
          obs(T0, 'samoa', -14, -172),
          obs(T0, 'peru', -12, -77),
        ]);
        const { observations } = await store.slice('aircraft', {
          t: T0,
          bbox: { west: 170, south: -30, east: -160, north: 0 },
        });
        assert.deepEqual(
          observations.map((o) => o.key),
          ['fiji', 'samoa'],
        );
      });

      it('judges a key by its newest position, so a box never shows where it used to be', async () => {
        await store.append('aircraft', [
          obs(T0, 'a', 10, 10, { at: 'inside' }),
          obs(T0 + MIN, 'a', 50, 50, { at: 'outside' }),
          obs(T0, 'b', 11, 11, { at: 'stays' }),
        ]);
        const box = { west: 0, south: 0, east: 20, north: 20 };
        const boxed = await store.slice('aircraft', {
          t: T0 + MIN,
          windowMs: 10 * MIN,
          bbox: box,
        });
        assert.deepEqual(
          boxed.observations.map((o) => o.key),
          ['b'],
        );
        const open = await store.slice('aircraft', {
          t: T0 + MIN,
          windowMs: 10 * MIN,
        });
        assert.deepEqual(
          open.observations.map((o) => [o.key, o.data.at]),
          [
            ['a', 'outside'],
            ['b', 'stays'],
          ],
        );
        const earlier = await store.slice('aircraft', {
          t: T0,
          windowMs: 10 * MIN,
          bbox: box,
        });
        assert.deepEqual(
          earlier.observations.map((o) => o.key),
          ['a', 'b'],
        );
      });

      it('leaves position-less rows out of a bbox query only', async () => {
        await store.append('launches', [
          obs(T0, 'nowhere'),
          obs(T0, 'pad', 28.5, -80.6),
        ]);
        const boxed = await store.slice('launches', {
          t: T0,
          bbox: { west: -90, south: 20, east: -70, north: 40 },
        });
        assert.deepEqual(
          boxed.observations.map((o) => o.key),
          ['pad'],
        );
        const all = await store.slice('launches', { t: T0 });
        assert.deepEqual(
          all.observations.map((o) => o.key),
          ['nowhere', 'pad'],
        );
      });

      it('caps the rows and says so', async () => {
        await store.append(
          'transit',
          Array.from({ length: 5 }, (_, i) => obs(T0, `k${i}`, 0, 0)),
        );
        const capped = await store.slice('transit', { t: T0, limit: 3 });
        assert.equal(capped.observations.length, 3);
        assert.equal(capped.truncated, true);
        const exact = await store.slice('transit', { t: T0, limit: 5 });
        assert.equal(exact.truncated, false);
      });

      it('answers an empty feed with no rows', async () => {
        assert.deepEqual(await store.slice('water', { t: T0 }), {
          observations: [],
          truncated: false,
        });
      });

      it('keeps feeds apart', async () => {
        await store.append('aircraft', [
          obs(T0, 'same', 1, 1, { feed: 'aircraft' }),
        ]);
        await store.append('military', [
          obs(T0, 'same', 1, 1, { feed: 'military' }),
        ]);
        const { observations } = await store.slice('military', { t: T0 });
        assert.deepEqual(
          observations.map((o) => o.data.feed),
          ['military'],
        );
      });
    });

    describe('latestBefore', () => {
      it('returns the newest observation of the key at or before t', async () => {
        await store.append('aircraft', [
          obs(T0, 'a', 1, 1, { n: 1 }),
          obs(T0 + MIN, 'a', 2, 2, { n: 2 }),
          obs(T0 + 2 * MIN, 'a', 3, 3, { n: 3 }),
        ]);
        assert.equal(
          (await store.latestBefore('aircraft', { t: T0 + 90_000, key: 'a' }))
            .data.n,
          2,
        );
        assert.equal(
          (await store.latestBefore('aircraft', { t: T0 + MIN, key: 'a' })).data
            .n,
          2,
        );
      });

      it('returns null when nothing qualifies', async () => {
        await store.append('aircraft', [obs(T0 + MIN, 'a', 1, 1)]);
        assert.equal(
          await store.latestBefore('aircraft', { t: T0, key: 'a' }),
          null,
        );
        assert.equal(
          await store.latestBefore('aircraft', { t: T0 + MIN, key: 'zzz' }),
          null,
        );
      });
    });

    describe('snapshots', () => {
      beforeEach(async () => {
        await store.append('transit', [
          obs(T0, 'a', 0, 0),
          obs(T0, 'b', 0, 0),
          obs(T0 + MIN, 'a', 0, 0),
          obs(T0 + 2 * MIN, 'a', 0, 0),
          obs(T0 + 2 * MIN, 'b', 0, 0),
          obs(T0 + 2 * MIN, 'c', 0, 0),
        ]);
      });

      it('lists distinct times ascending with their row counts', async () => {
        const { snapshots, truncated } = await store.snapshots('transit');
        assert.deepEqual(snapshots, [
          { t: T0, count: 2 },
          { t: T0 + MIN, count: 1 },
          { t: T0 + 2 * MIN, count: 3 },
        ]);
        assert.equal(truncated, false);
      });

      it('honours from, to and limit', async () => {
        assert.deepEqual(
          (await store.snapshots('transit', { from: T0 + MIN, to: T0 + MIN }))
            .snapshots,
          [{ t: T0 + MIN, count: 1 }],
        );
        const limited = await store.snapshots('transit', { limit: 2 });
        assert.equal(limited.snapshots.length, 2);
        assert.equal(limited.truncated, true);
      });

      it('is empty for a feed with no data', async () => {
        assert.deepEqual(await store.snapshots('water'), {
          snapshots: [],
          truncated: false,
        });
      });
    });

    describe('coverage', () => {
      it('reports spans separated by gaps larger than maxGapMs', async () => {
        const times = [0, 1, 2, 30, 31].map((m) => T0 + m * MIN);
        await store.append(
          'firms',
          times.map((t) => obs(t, 'x', 0, 0)),
        );
        const coverage = await store.coverage('firms', { maxGapMs: 5 * MIN });
        assert.equal(coverage.count, 5);
        assert.equal(coverage.snapshots, 5);
        assert.equal(coverage.firstT, T0);
        assert.equal(coverage.lastT, T0 + 31 * MIN);
        assert.deepEqual(coverage.spans, [
          { from: T0, to: T0 + 2 * MIN, snapshots: 3 },
          { from: T0 + 30 * MIN, to: T0 + 31 * MIN, snapshots: 2 },
        ]);
      });

      it('limits itself to from..to', async () => {
        await store.append(
          'firms',
          [0, 10, 20].map((m) => obs(T0 + m * MIN, 'x', 0, 0)),
        );
        const coverage = await store.coverage('firms', {
          from: T0 + 5 * MIN,
          to: T0 + 15 * MIN,
        });
        assert.equal(coverage.snapshots, 1);
        assert.equal(coverage.firstT, T0 + 10 * MIN);
      });

      it('is empty, not an error, for a feed with no data', async () => {
        assert.deepEqual(await store.coverage('water'), {
          feed: 'water',
          count: 0,
          snapshots: 0,
          firstT: null,
          lastT: null,
          maxGapMs: 3_600_000,
          spans: [],
        });
      });
    });

    describe('prune', () => {
      it('removes only rows older than before, in that feed', async () => {
        await store.append('aircraft', [
          obs(T0, 'a', 0, 0),
          obs(T0 + 10 * MIN, 'a', 0, 0),
          obs(T0 + 20 * MIN, 'a', 0, 0),
        ]);
        await store.append('military', [obs(T0, 'm', 0, 0)]);
        assert.deepEqual(
          await store.prune('aircraft', { before: T0 + 10 * MIN }),
          { deleted: 1 },
        );
        assert.equal((await store.coverage('aircraft')).count, 2);
        assert.equal((await store.coverage('military')).count, 1);
      });

      it('deletes nothing when everything is newer', async () => {
        await store.append('aircraft', [obs(T0, 'a', 0, 0)]);
        assert.deepEqual(await store.prune('aircraft', { before: 0 }), {
          deleted: 0,
        });
      });
    });

    describe('health', () => {
      it('reports ok with each feed that holds data', async () => {
        await store.append('aircraft', [
          obs(T0, 'a', 0, 0),
          obs(T0 + MIN, 'a', 0, 0),
        ]);
        const health = await store.health();
        assert.equal(health.ok, true);
        assert.equal(typeof health.backend, 'string');
        assert.deepEqual(health.feeds.aircraft, {
          firstT: T0,
          lastT: T0 + MIN,
        });
      });

      it('reports an empty store as ok with no feeds', async () => {
        const health = await store.health();
        assert.equal(health.ok, true);
        assert.deepEqual(health.feeds, {});
      });
    });

    describe('close', () => {
      it('makes later calls fail with CLOSED and health report not ok', async () => {
        await store.close();
        await rejectsWith(store.append('aircraft', []), 'CLOSED');
        await rejectsWith(store.slice('aircraft', { t: T0 }), 'CLOSED');
        assert.equal((await store.health()).ok, false);
        await store.close();
      });
    });
  });
}
