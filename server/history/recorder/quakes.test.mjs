import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import quakes, { toRecords } from './adapters/quakes.js';
import { ADAPTERS } from './adapters/index.js';
import { T0, quake, quakesPayload } from './fixtures.mjs';

describe('quakes adapter', () => {
  it('is registered under the quakes feed', () => {
    assert.equal(ADAPTERS.quakes, quakes);
    assert.equal(quakes.feed, 'quakes');
    assert.equal(quakes.mode, 'poller');
    assert.equal(quakes.optIn, true);
    assert.ok(quakes.pollMs >= 60_000, 'USGS asks for at most one request a minute');
  });

  it('turns an event into one row keyed by event id, timed by its update stamp', () => {
    const [row] = toRecords(quakesPayload([quake()]));
    assert.equal(row.id, 'us7000abcd');
    assert.equal(row.t, T0 - 3_000_000);
    assert.equal(row.lat, 37.75);
    assert.equal(row.lon, -122.5);
    assert.deepEqual(row.props, {
      mag: 4.2,
      depthKm: 8.2,
      magType: 'ml',
      place: '5 km W of Somewhere, CA',
      status: 'reviewed',
      time: T0 - 3_600_000,
      updated: T0 - 3_000_000,
    });
  });

  it('keeps nothing outside its field list (urls and detail links are dropped)', () => {
    const [row] = toRecords(quakesPayload([quake({ properties: { url: 'https://u:p@x/?api_key=zz', extra: 1 } })]));
    assert.deepEqual(Object.keys(row.props).sort(), [...quakes.fields].sort());
    assert.equal(JSON.stringify(row).includes('api_key'), false);
  });

  it('a revision is a new row and the same version again is the same row', () => {
    const a = toRecords(quakesPayload([quake()]))[0];
    const again = toRecords(quakesPayload([quake()]))[0];
    const revised = toRecords(quakesPayload([quake({ properties: { mag: 4.4, updated: T0 - 60_000 } })]))[0];
    assert.deepEqual([a.id, a.t], [again.id, again.t]);
    assert.equal(revised.id, a.id);
    assert.notEqual(revised.t, a.t);
  });

  it('falls back to the origin time when USGS gives no update stamp', () => {
    const [row] = toRecords(quakesPayload([quake({ properties: { updated: null } })]));
    assert.equal(row.t, T0 - 3_600_000);
    assert.equal('updated' in row.props, false);
  });

  it('keeps only what the live layer shows: M2.5 and up, valid position, an id', () => {
    const rows = toRecords(
      quakesPayload([
        quake({ id: 'small', properties: { mag: 2.4 } }),
        quake({ id: 'edge', properties: { mag: 2.5 } }),
        quake({ id: 'nomag', properties: { mag: null } }),
        quake({ id: 'huge', properties: { mag: 11 } }),
        quake({ id: 'badlat', geometry: { type: 'Point', coordinates: [0, 91, 1] } }),
        quake({ id: 'badlon', geometry: { type: 'Point', coordinates: ['x', 1, 1] } }),
        quake({ id: null }),
        quake({ id: '' }),
        quake({ id: 'notime', properties: { time: null, updated: null } }),
        { id: 'nogeom', properties: { mag: 5 } },
        null,
        quake({ id: 'nodepth', geometry: { type: 'Point', coordinates: [10, 10] } }),
      ]),
    );
    assert.deepEqual(rows.map((r) => r.id), ['edge', 'nodepth']);
    assert.equal(rows[1].props.depthKm, null);
  });

  it('tolerates a payload that is not a feature collection', () => {
    for (const input of [null, undefined, {}, { features: 'x' }, []]) assert.deepEqual(toRecords(input), []);
  });
});
