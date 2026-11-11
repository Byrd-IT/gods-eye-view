import assert from 'node:assert/strict';
import test from 'node:test';
import { json2satrec } from 'satellite.js';
import { createHistory } from './history.js';
import { parseGP } from '../../byrdit/gpCsv.js';

const HEADER =
  'OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION,ECCENTRICITY,INCLINATION,RA_OF_ASC_NODE,ARG_OF_PERICENTER,MEAN_ANOMALY,EPHEMERIS_TYPE,CLASSIFICATION_TYPE,NORAD_CAT_ID,ELEMENT_SET_NO,REV_AT_EPOCH,BSTAR,MEAN_MOTION_DOT,MEAN_MOTION_DDOT';
const row = (id, epoch, anomaly = 88.1156) =>
  `SAT ${id},1998-067A,${epoch},15.48899044,.0006748,51.6326,58.3278,271.9059,${anomaly},0,U,${id},999,59060,.15012E-3,.7803E-4,0`;
const csv = (...rows) => [HEADER, ...rows].join('\r\n') + '\r\n';
const satrecOf = (id, epoch, anomaly) => json2satrec(parseGP(csv(row(id, epoch, anomaly)))[0].gp);

function make(fetchText) {
  const state = {
    _historyMs: null,
    _lastPropagation: 99,
    _catalog: new Map(),
    _points: new Map(),
  };
  const live = new Map();
  for (const id of [25544, 99999]) {
    const satrec = satrecOf(id, '2026-10-16T18:57:11.428512');
    live.set(id, satrec);
    state._catalog.set(id, { name: `SAT ${id}`, satrec, group: 'stations' });
    state._points.set(id, { show: true });
  }
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, text: async () => fetchText() };
  };
  return { state, live, calls, h: createHistory({ state, parts: {} }) };
}

test('satellites at a history time: recorded elset swapped in, untracked satellite hidden, live restored', async () => {
  const { state, live, calls, h } = make(() =>
    csv(row(25544, '2025-03-01T12:00:00.000000', 10)),
  );
  const t = Date.parse('2025-03-01T13:00:00Z');
  const out = await h.methods.setHistoryTime(t);
  assert.equal(out.status, 'ok');
  assert.match(calls[0], /feed=gp&group=active.*&t=2025-03-01T13%3A00%3A00.000Z/);
  assert.equal(state._historyMs, t);
  assert.notEqual(state._catalog.get(25544).satrec, live.get(25544), 'recorded elset');
  assert.equal(state._points.get(25544).show, true);
  assert.equal(state._points.get(99999).show, false, 'no elset at that time: not drawn');
  assert.equal(state._lastPropagation, 0, 'repropagates at once');
  // a nearby time reuses the elsets (no second request)
  await h.methods.setHistoryTime(t + 3_600_000);
  assert.equal(calls.length, 1);
  // LIVE restores
  const back = await h.methods.setHistoryTime(null);
  assert.equal(back.status, 'live');
  assert.equal(state._historyMs, null);
  assert.equal(state._catalog.get(25544).satrec, live.get(25544));
  assert.equal(state._points.get(99999).show, true);
});

test('satellites history: an elset dated far after the asked time is not used; an empty answer hides all', async () => {
  const { state, live, h } = make(() =>
    csv(row(25544, '2026-11-02T12:00:00.000000')),
  );
  await h.methods.setHistoryTime(Date.parse('2025-03-01T13:00:00Z'));
  assert.equal(state._catalog.get(25544).satrec, live.get(25544), 'future-dated epoch ignored');
  assert.equal(state._points.get(25544).show, false);
  const empty = make(() => csv());
  const out = await empty.h.methods.setHistoryTime(Date.parse('2025-03-01T13:00:00Z'));
  assert.equal(out.status, 'empty');
  assert.equal(empty.state._points.get(25544).show, false, 'no recorded elset: not drawn from the live one');
});

test('satellites history: an empty or failed answer hides everything (never the live positions)', async () => {
  let body = csv(row(25544, '2025-03-01T12:00:00.000000', 10));
  const { state, h } = make(() => body);
  await h.methods.setHistoryTime(Date.parse('2025-03-01T13:00:00Z'));
  body = csv();
  const out = await h.methods.setHistoryTime(Date.parse('2020-01-01T00:00:00Z'));
  assert.equal(out.status, 'empty');
  for (const p of state._points.values()) assert.equal(p.show, false);
  globalThis.fetch = async () => ({ ok: false, text: async () => '' });
  const bad = await h.methods.setHistoryTime(Date.parse('2019-01-01T00:00:00Z'));
  assert.equal(bad.status, 'unavailable');
  for (const p of state._points.values()) assert.equal(p.show, false);
});

test('satellites history: the tracked satellite stays hidden as a point on restore (its entity draws it)', async () => {
  const { state, h } = make(() => csv(row(25544, '2025-03-01T12:00:00.000000', 10)));
  state._trackedNorad = 25544;
  await h.methods.setHistoryTime(Date.parse('2025-03-01T13:00:00Z'));
  assert.equal(state._points.get(25544).show, false);
  await h.methods.setHistoryTime(null);
  assert.equal(state._points.get(25544).show, false);
  assert.equal(state._points.get(99999).show, true);
});

test('satellites history: a live catalog reload while in history is replaced by the recorded sets again', async () => {
  const { state, live, calls, h } = make(() => csv(row(25544, '2025-03-01T12:00:00.000000', 10)));
  await h.methods.setHistoryTime(Date.parse('2025-03-01T13:00:00Z'));
  // ingestion.js rebuilds the catalog with live elsets
  state._catalog.get(25544).satrec = live.get(25544);
  state._points.get(99999).show = true;
  h.onCatalogReloaded();
  assert.equal(state._points.get(99999).show, false, 'live set hidden at once');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 2, 'recorded sets fetched again');
  assert.notEqual(state._catalog.get(25544).satrec, live.get(25544));
  await h.methods.setHistoryTime(null);
  assert.equal(state._catalog.get(25544).satrec, live.get(25544), 'LIVE restores the NEW live sets, not stale ones');
});

test('satellites history: a satellite with no elset cannot be tracked and a tracked one is untracked; a truncated answer is reported', async () => {
  const cleared = [];
  const mk = make(() => csv(row(25544, '2025-03-01T12:00:00.000000', 10)));
  const { state } = mk;
  const h = createHistory({ state, parts: { tracking: { _clearTracking: (...a) => { cleared.push(a); state._trackedNorad = null; } } } });
  state._trackedNorad = 99999; // has no recorded set at that time
  await h.methods.setHistoryTime(Date.parse('2025-03-01T13:00:00Z'));
  assert.equal(cleared.length, 1, 'the hidden tracked satellite is untracked');
  assert.equal(state._historyHidden.has(99999), true);
  assert.equal(state._historyHidden.has(25544), false);
  await h.methods.setHistoryTime(null);
  assert.equal(state._historyHidden.size, 0);
  globalThis.fetch = async () => ({ ok: true, headers: { get: (k) => (k === 'x-history-truncated' ? '1' : null) }, text: async () => csv(row(25544, '2025-03-01T12:00:00.000000', 10)) });
  const out = await h.methods.setHistoryTime(Date.parse('2025-03-01T13:00:00Z'));
  assert.equal(out.status, 'truncated');
});

test('satellites history: the orbit path of a satellite that is not drawn is hidden, and comes back on LIVE', async () => {
  const mk = make(() => csv(row(25544, '2025-03-01T12:00:00.000000', 10)));
  const { state, h } = mk;
  state._orbitPaths = new Map([[99999, { primitive: { show: true } }], [25544, { primitive: { show: true } }]]);
  await h.methods.setHistoryTime(Date.parse('2025-03-01T13:00:00Z'));
  assert.equal(state._orbitPaths.get(99999).primitive.show, false);
  assert.equal(state._orbitPaths.get(25544).primitive.show, true);
  await h.methods.setHistoryTime(null);
  assert.equal(state._orbitPaths.get(99999).primitive.show, true);
});

test('satellites history: while the sets for a new time load, nothing is drawn from the old ones', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { state, h } = make(() => csv(row(25544, '2025-03-01T12:00:00.000000', 10)));
  const f = globalThis.fetch;
  globalThis.fetch = async (u) => { await gate; return f(u); };
  const p = h.methods.setHistoryTime(Date.parse('2025-03-01T13:00:00Z'));
  for (const pt of state._points.values()) assert.equal(pt.show, false, 'hidden while loading');
  release();
  await p;
  assert.equal(state._points.get(25544).show, true);
});

test('satellites history: the followed satellite stays followed when its set exists at the new time (also while loading)', async () => {
  const cleared = [];
  const mk = make(() => csv(row(25544, '2025-03-01T12:00:00.000000', 10)));
  const { state } = mk;
  const h = createHistory({ state, parts: { tracking: { _clearTracking: (...a) => { cleared.push(a); state._trackedNorad = null; } } } });
  state._trackedNorad = 25544;
  let release;
  const gate = new Promise((r) => { release = r; });
  const f = globalThis.fetch;
  globalThis.fetch = async (u) => { await gate; return f(u); };
  const p = h.methods.setHistoryTime(Date.parse('2025-03-01T13:00:00Z'));
  assert.equal(cleared.length, 0, 'not untracked while the answer is pending');
  release();
  await p;
  assert.equal(cleared.length, 0, 'its set exists: still followed');
  assert.equal(state._trackedNorad, 25544);
});

test('satellites history: a satellite of a hidden class stays hidden when its set is applied and when LIVE restores', async () => {
  const mk = make(() => csv(row(25544, '2025-03-01T12:00:00.000000', 10), row(99999, '2025-03-01T12:00:00.000000', 20)));
  const { state } = mk;
  const hiddenClass = new Set([99999]);
  const h = createHistory({ state, parts: { controls: { _classVisible: (id) => !hiddenClass.has(id) } } });
  state._points.get(99999).show = false; // controls.js hid its class
  await h.methods.setHistoryTime(Date.parse('2025-03-01T13:00:00Z'));
  assert.equal(state._points.get(25544).show, true);
  assert.equal(state._points.get(99999).show, false, 'has a set at that time, but its class is hidden');
  await h.methods.setHistoryTime(null);
  assert.equal(state._points.get(25544).show, true);
  assert.equal(state._points.get(99999).show, false, 'LIVE restores class visibility, not just the tracked rule');
});
