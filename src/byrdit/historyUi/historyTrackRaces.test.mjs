/**
 * B12e review R1: a track answer that arrives late never publishes the
 * track chip for an aircraft or a frame that is no longer shown.
 *
 * The track requests are held open (deferred) so each test decides the
 * order in which answers arrive: deselect before success / failure, an
 * out-of-order aircraft switch, a cross-layer switch, a newer playback
 * frame, a seek and LIVE. The same-frame cache reuse still publishes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryRouter } from './historyRouter.js';
import { fakeWindow, jsonResponse } from './fakeDom.mjs';

const T = Date.parse('2026-10-13T12:00:00Z');
const MIN = 60_000;

function setup() {
  const pending = [];
  let slices = 0;
  const win = fakeWindow('https://gev.example/', async (input) => {
    const u = new URL(String(input), 'https://gev.example');
    if (u.pathname.endsWith('/history/track'))
      return new Promise((resolve) => pending.push({ u, resolve }));
    slices++;
    return jsonResponse({ time: T / 1000, states: [] });
  });
  const router = createHistoryRouter({ target: win });
  router.install();
  /** The held track request for an id (the newest one when asked twice). */
  const held = (id) => {
    const p = pending.filter((x) => x.u.searchParams.get('id') === id).at(-1);
    assert.ok(p, `track request for ${id}`);
    return p;
  };
  const ok = (id) => {
    const p = held(id);
    p.resolve(
      jsonResponse({
        id,
        path: [
          [
            Date.parse(p.u.searchParams.get('to')) / 1000 - 60,
            30,
            -97,
            1000,
            0,
            false,
            'opensky',
          ],
        ],
        sources: ['opensky'],
      }),
    );
  };
  const fail = (id) =>
    held(id).resolve(jsonResponse({ error: 'x' }, { status: 503 }));
  const event = (type, layerId, id) =>
    win.dispatchEvent({ type, detail: { layerId, id } });
  const cleared = (layerId, id) =>
    event('gev:awareness-subject-cleared', layerId, id);
  const selected = (layerId, id) =>
    event('gev:awareness-subject-selected', layerId, id);
  const askFlight = (id) => win.fetch(`/api/flights/track?icao24=${id}`);
  const askMil = (id) => win.fetch(`/api/military/track?hex=${id}`);
  return {
    router,
    win,
    pending,
    ok,
    fail,
    cleared,
    selected,
    askFlight,
    askMil,
    slices: () => slices,
    track: () => router.getState().track,
  };
}

test('R1 deselect before success: the late answer never brings the chip back; a new selection still publishes', async () => {
  const k = setup();
  k.router.setHistory({ active: true, timeMs: T });
  await k.win.fetch('/api/flights');
  const a = k.askFlight('aaaaaa');
  k.cleared('flights', 'aaaaaa');
  k.ok('aaaaaa');
  await a; // the caller still gets its answer (its own token drops it)
  assert.equal(k.track(), null);
  // selecting it again asks again (same window: cached) and publishes
  k.selected('flights', 'aaaaaa');
  await k.askFlight('aaaaaa');
  assert.equal(k.track()?.id, 'aaaaaa');
  assert.equal(k.pending.length, 1, 'same-frame cache reuse kept');
  assert.equal(k.router.getState().stats.trackCacheHits, 1);
});

test('R1 deselect before failure: no UNAVAILABLE chip for an aircraft no longer selected', async () => {
  const k = setup();
  k.router.setHistory({ active: true, timeMs: T });
  await k.win.fetch('/api/flights');
  const a = k.askFlight('aaaaaa');
  k.cleared('flights', 'aaaaaa');
  k.fail('aaaaaa');
  const res = await a;
  assert.equal(res.status, 404);
  assert.equal(k.track(), null);
});

test('R1 out-of-order switch: the newer aircraft C keeps its chip when old B answers last (success and failure)', async () => {
  for (const late of ['ok', 'fail']) {
    const k = setup();
    k.router.setHistory({ active: true, timeMs: T });
    await k.win.fetch('/api/flights');
    k.selected('flights', 'bbbbbb');
    const b = k.askFlight('bbbbbb');
    k.cleared('flights', 'bbbbbb');
    k.selected('flights', 'cccccc');
    const c = k.askFlight('cccccc');
    k.ok('cccccc');
    await c;
    assert.equal(k.track()?.id, 'cccccc');
    k[late]('bbbbbb');
    await b;
    assert.equal(k.track()?.id, 'cccccc', `old B (${late}) never replaces C`);
    assert.equal(k.track()?.status === 'unavailable', false);
  }
});

test('R1 switch without events: the newest request alone wins (B answers after C was asked)', async () => {
  const k = setup();
  k.router.setHistory({ active: true, timeMs: T });
  await k.win.fetch('/api/flights');
  const b = k.askFlight('bbbbbb');
  const c = k.askFlight('cccccc');
  k.ok('bbbbbb');
  await b;
  assert.equal(k.track(), null, 'B was superseded before it answered');
  k.ok('cccccc');
  await c;
  assert.equal(k.track()?.id, 'cccccc');
});

test('R1 cross-layer: a military selection (or any other layer) drops the pending flights track', async () => {
  const k = setup();
  k.router.setHistory({ active: true, timeMs: T });
  await k.win.fetch('/api/flights');
  await k.win.fetch('/api/military');
  const a = k.askFlight('aaaaaa');
  // flights hands off: its untrack emits cleared, military selects + asks
  k.cleared('flights', 'aaaaaa');
  k.selected('military', 'ae1234');
  const m = k.askMil('ae1234');
  k.ok('ae1234');
  await m;
  k.ok('aaaaaa');
  await a;
  assert.equal(k.track()?.layerId, 'military');
  assert.equal(k.track()?.id, 'ae1234');
  // a vessel / satellite selection (no recorded track) drops it as well
  const m2 = k.askMil('ae1234');
  await m2; // cached, publishes again
  k.selected('satellites', '25544');
  assert.equal(k.track(), null);
  // and a pending one never comes back after another layer was selected
  const k2 = setup();
  k2.router.setHistory({ active: true, timeMs: T });
  await k2.win.fetch('/api/flights');
  const p = k2.askFlight('aaaaaa');
  k2.selected('ais-live-vessels', '123456789');
  k2.ok('aaaaaa');
  await p;
  assert.equal(k2.track(), null);
});

test('R1 playback: an answer for a frame no longer shown never becomes the chip; the shown frame does', async () => {
  const k = setup();
  k.router.setHistory({ active: true, timeMs: T, playing: true });
  await k.win.fetch('/api/flights');
  const f1 = k.askFlight('aaaaaa');
  // the next frame (+1 min, playing: not a seek) is served while F1 waits
  k.router.setHistory({ active: true, timeMs: T + MIN, playing: true });
  await k.win.fetch('/api/flights');
  k.ok('aaaaaa');
  await f1;
  assert.equal(k.track(), null, 'F1 track is not the shown frame');
  // the shown frame asks its own window, answered after an older F1 again
  const f2 = k.askFlight('aaaaaa');
  const to2 = k.pending.at(-1).u.searchParams.get('to');
  assert.equal(to2, new Date(T + MIN).toISOString());
  k.ok('aaaaaa');
  await f2;
  assert.equal(k.track()?.to, T + MIN);
  // the next frame publishes its own window
  k.router.setHistory({ active: true, timeMs: T + 2 * MIN, playing: true });
  await k.win.fetch('/api/flights');
  const f3 = k.askFlight('aaaaaa');
  k.ok('aaaaaa');
  await f3;
  assert.equal(k.track()?.to, T + 2 * MIN);
});

test('R1 seek and LIVE while pending: neither the success nor the failure publishes', async () => {
  for (const late of ['ok', 'fail']) {
    const k = setup();
    k.router.setHistory({ active: true, timeMs: T });
    await k.win.fetch('/api/flights');
    const a = k.askFlight('aaaaaa');
    k.router.setHistory({ active: true, timeMs: T - 60 * MIN }); // seek
    k[late]('aaaaaa');
    assert.equal((await a).status, 404);
    assert.equal(k.track(), null, `seek (${late})`);

    const k2 = setup();
    k2.router.setHistory({ active: true, timeMs: T });
    await k2.win.fetch('/api/flights');
    const b = k2.askFlight('aaaaaa');
    k2.router.setHistory({ active: false }); // LIVE
    k2[late]('aaaaaa');
    assert.equal((await b).status, 404);
    assert.equal(k2.track(), null, `LIVE (${late})`);
  }
});
