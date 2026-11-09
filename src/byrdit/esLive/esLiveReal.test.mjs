import test from 'node:test';
import assert from 'node:assert/strict';
import { createEsLive } from './esLive.js';
import { createHistoryService } from '../history/historyService.js';
import { HISTORY_INDICES } from '../history/historyEs.js';
import { createAdsbGnssSource } from '../../layers/gnss/source.js';
import {
  normalizeAqhiObservations,
  normalizeAqhiStations,
} from '../../layers/airQuality/model.js';
import {
  accumulateGnssObservations,
  binGnssCells,
} from '../../layers/gnss/records.js';

/**
 * Success path through the REAL history slices (createHistoryService ->
 * historySlicesAirGnss.js) over an in-memory Elasticsearch, so a change in a
 * slice shape breaks these tests, not the page. Docs have the shape of real
 * gev-history-aqhi / gev-history-gnss-integrity hits.
 */
const MIN = 60_000;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 9, 6, 0, 0);
const iso = (ms) => new Date(ms).toISOString();

const get = (doc, f) => f.split('.').reduce((o, k) => o?.[k], doc);
const asMs = (v) =>
  typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : v;
function matches(doc, q) {
  if (!q) return true;
  if (q.bool) return (q.bool.filter ?? []).every((f) => matches(doc, f));
  if (q.term) {
    const [f, v] = Object.entries(q.term)[0];
    return get(doc, f) === v;
  }
  if (q.range) {
    const [f, r] = Object.entries(q.range)[0];
    const v = asMs(get(doc, f));
    return (r.gte === undefined || v >= r.gte) && (r.lte === undefined || v <= r.lte);
  }
  return true;
}
function fakeEs(docsByIndex) {
  return {
    async search(index, body) {
      const docs = docsByIndex[index] ?? [];
      if (body.size === 0 && body.aggs?.first) {
        const field = Object.values(body.aggs.first.min)[0];
        const values = docs.map((d) => asMs(get(d, field)));
        return { aggregations: { first: { value: values.length ? Math.min(...values) : null } } };
      }
      if (body.size === 0 && body.aggs?.newest) {
        const field = Object.values(body.aggs.newest.max)[0];
        const values = docs.map((d) => asMs(get(d, field)));
        return { aggregations: { newest: { value: values.length ? Math.max(...values) : null } } };
      }
      let hits = docs.filter((d) => matches(d, body.query));
      const [sf, sd] = Object.entries(body.sort?.[0] ?? {})[0] ?? [];
      if (sf)
        hits = [...hits].sort(
          (a, b) => (asMs(get(a, sf)) - asMs(get(b, sf))) * (sd === 'asc' ? 1 : -1),
        );
      if (body.collapse) {
        const seen = new Set();
        hits = hits.filter((d) => {
          const k = get(d, body.collapse.field);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      }
      return { hits: { hits: hits.slice(0, body.size).map((_source) => ({ _source })) } };
    },
    async searchAll(index, { query, maxRows }) {
      const hits = (docsByIndex[index] ?? []).filter((d) => matches(d, query));
      return {
        hits: hits.slice(0, maxRows).map((_source) => ({ _source })),
        truncated: hits.length > maxRows,
      };
    },
  };
}

const aq = (id, name, at, aqhi, lon, lat) => ({
  '@timestamp': iso(at),
  aqhi,
  aqhi_value: Math.max(1, Math.round(aqhi)),
  band: 'low',
  location: { lat, lon },
  location_id: id,
  observation_type: 'original',
  snap: at + 5 * MIN,
  source: 'eccc-aqhi',
  station: name,
});
const gc = (cell, snap, lat, lon, total, bad) => ({
  '@timestamp': iso(snap),
  bad,
  band: 'none',
  cell,
  location: { lat, lon },
  snap,
  source: 'adsb.lol-mil',
  total,
});

function build(docs) {
  const es = fakeEs(docs);
  const service = createHistoryService({ es, now: () => NOW });
  const freshness = async (feed) => {
    const index = { gnss: HISTORY_INDICES.gnss, aqhi: HISTORY_INDICES.aqhi, quakes: HISTORY_INDICES.quakesLive }[feed];
    const json = await es.search(index, { size: 0, aggs: { newest: { max: { field: 'snap' } } } });
    return json.aggregations.newest.value;
  };
  return createEsLive({ service, enabled: ['gnss', 'aqhi'], freshness, now: () => NOW, log: () => {} });
}

function call(mw, path) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) {
        this.headers[k.toLowerCase()] = String(v);
      },
      end(text) {
        resolve({ status: this.statusCode, headers: this.headers, text });
      },
    };
    Promise.resolve(mw({ url: path, method: 'GET' }, res, () => resolve({ passed: true }))).catch(reject);
  });
}

test('real AQHI slices: observations from the 6 h window, catalog from 30 days, both parse', async () => {
  const mw = build({
    [HISTORY_INDICES.aqhi]: [
      aq('A', 'Station A', NOW - 2 * HOUR, 2.4, -52.7, 47.5),
      aq('A', 'Station A', NOW - 40 * MIN, 5.6, -52.7, 47.5), // newer A wins
      aq('B', 'Station B', NOW - 20 * HOUR, 3.1, -110.1, 52.2), // quiet: older than 6 h, still in the catalog
    ],
  });
  const stations = normalizeAqhiStations(JSON.parse((await call(mw, '/api/es-live/aqhi-stations')).text));
  assert.deepEqual([...stations.keys()].sort(), ['A', 'B']);
  const obs = JSON.parse((await call(mw, '/api/es-live/aqhi')).text);
  const readings = normalizeAqhiObservations(obs, stations, NOW);
  assert.deepEqual(readings.map((r) => [r.stationId, r.value]), [['A', 6]]);
});

test('real GNSS slices: the newest snapshot, the 250 nm circle, the unchanged layer rules', async () => {
  const snap = NOW - 3 * MIN;
  const mw = build({
    [HISTORY_INDICES.gnss]: [
      gc('old', NOW - 9 * MIN, 30.25, -95.25, 9, 9), // an older snapshot is not served
      gc('near1', snap, 30.25, -95.25, 6, 3),
      gc('near2', snap, 31.25, -96.25, 3, 0),
      gc('far', snap, -38.25, 146.75, 4, 1),
    ],
  });
  const res = await call(mw, '/api/gnss-integrity?lat=30&lon=-95');
  assert.equal(res.status, 200);
  const body = JSON.parse(res.text);
  assert.equal(body.rows.length, 9, 'near1 + near2 only');
  assert.equal(body.ageMs, 3 * MIN);
  assert.equal(body.population, 'military-aircraft');
  const source = createAdsbGnssSource({ fetchImpl: async () => new Response(res.text), now: () => NOW });
  const snapshot = await source.getSnapshot({ latitude: 30, longitude: -95 }, {});
  const observations = new Map();
  accumulateGnssObservations(observations, snapshot.rows, NOW, { windowMs: 30 * MIN, observedAt: NOW - snapshot.ageMs });
  const cells = binGnssCells(observations);
  // near1 (6 aircraft, 3 degraded) is drawn; near2 (3, none degraded) is low
  assert.ok(cells.length >= 1);
  assert.ok(cells.some((c) => c.level !== 'low'));
});

test('a stalled recording turns the real answers into 503, not an old picture', async () => {
  const mw = build({
    [HISTORY_INDICES.gnss]: [gc('near1', NOW - 40 * MIN, 30.25, -95.25, 6, 3)],
    [HISTORY_INDICES.aqhi]: [aq('A', 'Station A', NOW - 5 * HOUR, 2.4, -52.7, 47.5)],
  });
  assert.equal((await call(mw, '/api/gnss-integrity?lat=30&lon=-95')).status, 503);
  assert.equal((await call(mw, '/api/es-live/aqhi')).status, 503);
});
