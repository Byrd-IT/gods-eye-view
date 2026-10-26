import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HISTORY_EVENT, mountHistoryControl } from './historyControl.js';
import { HISTORY_UNAVAILABLE } from './historyClient.js';
import { HISTORY_STYLE_ID } from './historyStyles.js';
import { DAY_MS, MINUTE_MS, readHtFromUrl } from './historyTimeline.js';
import { createHistoryProvider } from '../skyView/historyTime.js';
import { fixtureFetch, fixtureWorld } from './fixtures/b11Coverage.mjs';
import { fakeClock, fakeDocument, fakeWindow, flush } from './fakeDom.mjs';

const NOW = Date.parse('2026-10-14T16:00:00Z');
const HREF =
  'https://gev.example/?sv=29.76,-95.37,180,45,60#lat=29.7&lon=-95.3&l=abcDEF';

function setup({
  href = HREF,
  fetchImpl,
  tileOutlines = null,
  worldOptions = {},
} = {}) {
  const clock = fakeClock(NOW);
  const world = fixtureWorld(NOW, worldOptions);
  const calls = [];
  const doc = fakeDocument();
  const win = fakeWindow(href, fetchImpl ?? fixtureFetch(world, { calls }));
  const control = mountHistoryControl({
    document: doc,
    window: win,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    tileOutlines,
  });
  const root = control.root;
  const q = (sel) => root.find(sel);
  const qa = (sel) => root.findAll(sel);
  const pointer = async (type, fraction) => {
    q('.gev-hist-scrub').dispatch(type, {
      clientX: fraction * 1000,
      pointerId: 1,
    });
    await flush();
  };
  const historyEvents = () =>
    win.events.filter((e) => e.type === HISTORY_EVENT).map((e) => e.detail);
  return {
    clock,
    world,
    calls,
    doc,
    win,
    control,
    root,
    q,
    qa,
    pointer,
    historyEvents,
  };
}

test('mounts collapsed with a LIVE badge, styles injected once, no request yet', async () => {
  const h = setup();
  assert.equal(h.root.getAttribute('data-mode'), 'live');
  assert.equal(h.root.getAttribute('data-expanded'), 'false');
  assert.equal(h.q('.gev-hist-badge').textContent, 'LIVE');
  assert.equal(h.q('.gev-hist-panel').hidden, true);
  assert.ok(h.doc.getElementById(HISTORY_STYLE_ID));
  // a second mount on the same parent returns the same control
  assert.equal(
    mountHistoryControl({ document: h.doc, window: h.win }),
    h.control,
  );
  assert.equal(h.doc.head.findAll((n) => n.id === HISTORY_STYLE_ID).length, 1);
  await h.clock.run(1000);
  assert.equal(
    h.calls.length,
    0,
    'collapsed + live asks the history API nothing',
  );
  assert.deepEqual(h.historyEvents().at(-1), {
    ...h.historyEvents().at(-1),
    active: false,
  });
  h.control.destroy();
});

test('expand shows presets and the coverage ribbon; presets change the window', async () => {
  const h = setup();
  h.q('.gev-hist-badge').click();
  await h.clock.run(500);
  assert.equal(h.q('.gev-hist-panel').hidden, false);
  assert.deepEqual(
    h.qa('[data-preset]').map((b) => b.textContent),
    ['1 h', '24 h', '7 d', '30 d', '90 d', 'all'],
  );
  assert.equal(h.q('[data-preset="24h"]').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(
    h.qa('.gev-hist-lane').map((l) => l.getAttribute('data-lane')),
    ['adsblol', 'opensky', 'military'],
  );
  assert.ok(
    h.calls.some((c) => c.includes('feed=aircraft') && c.includes('bucket=5m')),
  );
  const before = h.calls.length;
  h.q('[data-preset="all"]').click();
  await h.clock.run(500);
  assert.equal(
    h.control.getState().window.to - h.control.getState().window.from,
    730 * DAY_MS,
  );
  assert.ok(h.calls.slice(before).some((c) => c.includes('bucket=1d')));
  h.control.destroy();
});

test('known gap: hatched ribbon segment + HUD text while inside it', async () => {
  const h = setup();
  h.q('.gev-hist-badge').click();
  await h.clock.run(500);
  // scrub to 14:05 in the 24 h window ending 16:00 -> fraction (22h05m / 24h)
  const f = (Date.parse('2026-10-14T14:05:00Z') - (NOW - DAY_MS)) / DAY_MS;
  await h.pointer('pointerdown', f);
  await h.pointer('pointerup', f);
  await h.clock.run(500);
  const gap = h
    .qa('.gev-hist-seg-gap')
    .find((n) => n.getAttribute('data-from') === '2026-10-14T14:02:00.000Z');
  assert.ok(gap, 'a hatched gap segment 14:02-14:09');
  assert.equal(gap.getAttribute('data-to'), '2026-10-14T14:09:00.000Z');
  assert.equal(h.root.getAttribute('data-mode'), 'history');
  // snapped? no: nothing recorded within tolerance, the time stays in the gap
  assert.equal(h.root.getAttribute('data-time'), '2026-10-14T14:05:00.000Z');
  assert.match(
    h.q('.gev-hist-hud').textContent,
    /No recording at this time \(gap 14:02-14:09 UTC\) - Military/,
  );
  // the today note sits beside it (adsb.lol ends yesterday)
  assert.match(
    h.q('.gev-hist-hud').textContent,
    /adsb\.lol history ends yesterday 23:59Z; OpenSky only where you looked/,
  );
  h.control.destroy();
});

test('scrub: enter history, ht in the address, snap to recorded data on release', async () => {
  const h = setup();
  h.q('.gev-hist-badge').click();
  await h.clock.run(500);
  const target = NOW - 6 * 3_600_000 + 25_000; // 25 s past a recorded minute
  const f = (target - (NOW - DAY_MS)) / DAY_MS;
  await h.pointer('pointerdown', f);
  await h.pointer('pointermove', f);
  const during = h.calls.length;
  await h.pointer('pointermove', f + 0.0001);
  assert.equal(h.calls.length, during, 'no request while dragging');
  await h.pointer('pointerup', f);
  await h.clock.run(1500);
  const t = Date.parse(h.root.getAttribute('data-time'));
  assert.equal(t % MINUTE_MS, 0, 'snapped onto a recorded minute');
  assert.ok(Math.abs(t - target) <= MINUTE_MS);
  assert.equal(readHtFromUrl(h.win.location.href, NOW), t);
  const url = new URL(h.win.location.href);
  assert.equal(
    url.hash,
    '#lat=29.7&lon=-95.3&l=abcDEF',
    'share hash (l=) untouched',
  );
  assert.equal(url.searchParams.get('sv'), '29.76,-95.37,180,45,60');
  const last = h.historyEvents().at(-1);
  assert.equal(last.active, true);
  assert.equal(last.timeMs, t);
  h.control.destroy();
});

test('ht round trip: a reload with the address restores the same moment; LIVE clears it', async () => {
  const h = setup();
  h.control.seek(NOW - 3 * DAY_MS + 7 * MINUTE_MS, { snap: true });
  await h.clock.run(1500);
  const href = h.win.location.href;
  const t = readHtFromUrl(href, NOW);
  assert.ok(Number.isFinite(t));
  h.control.destroy();

  const again = setup({ href });
  await again.clock.run(500);
  assert.equal(again.root.getAttribute('data-mode'), 'history');
  assert.equal(Date.parse(again.root.getAttribute('data-time')), t);
  assert.equal(again.root.getAttribute('data-expanded'), 'true');
  again.q('.gev-hist-live').click();
  await again.clock.run(100);
  assert.equal(again.root.getAttribute('data-mode'), 'live');
  assert.equal(new URL(again.win.location.href).searchParams.has('ht'), false);
  assert.equal(
    new URL(again.win.location.href).hash,
    '#lat=29.7&lon=-95.3&l=abcDEF',
  );
  assert.equal(again.historyEvents().at(-1).active, false);
  again.control.destroy();
});

test('seek with snap returns the promise that settles on recorded data', async () => {
  const h = setup();
  const asked = NOW - 3 * DAY_MS + 30_000;
  const pending = h.control.seek(asked, { snap: true });
  assert.equal(typeof pending?.then, 'function');
  assert.equal(h.control.getState().timeMs, asked);
  await pending;
  assert.notEqual(h.control.getState().timeMs, asked);
  h.control.destroy();
});

test('keyboard: Space toggles play, arrows step recorded snapshots, Shift = 10', async () => {
  const h = setup();
  h.q('.gev-hist-badge').click();
  const start = NOW - 5 * 3_600_000;
  h.control.seek(start);
  await h.clock.run(500);
  h.doc.key('ArrowRight');
  await h.clock.run(100);
  assert.equal(Date.parse(h.root.getAttribute('data-time')), start + MINUTE_MS);
  h.doc.key('ArrowRight', { shiftKey: true });
  await h.clock.run(100);
  assert.equal(
    Date.parse(h.root.getAttribute('data-time')),
    start + 11 * MINUTE_MS,
  );
  h.doc.key('ArrowLeft');
  await h.clock.run(100);
  assert.equal(
    Date.parse(h.root.getAttribute('data-time')),
    start + 10 * MINUTE_MS,
  );
  // Space tap: play / pause, even after voice push-to-talk already
  // preventDefaulted the background Space (src/voice/realtimeInput.js)
  const voice = (e) => e.preventDefault();
  h.doc.addEventListener('keydown', voice);
  h.doc.addEventListener('keyup', voice);
  await h.doc.tap(' ', h.clock);
  assert.equal(h.root.getAttribute('data-playing'), 'true');
  await h.doc.tap(' ', h.clock);
  assert.equal(h.root.getAttribute('data-playing'), 'false');
  // a HELD Space belongs to push-to-talk: no toggle
  await h.doc.tap(' ', h.clock, { holdMs: 800 });
  assert.equal(h.root.getAttribute('data-playing'), 'false');
  // typing in a field is never hijacked
  const input = h.doc.createElement('input');
  h.doc.body.append(input);
  await h.doc.tap(' ', h.clock, { target: input });
  assert.equal(h.root.getAttribute('data-playing'), 'false');
  // a focused button keeps its native Space activation (no double toggle)
  const button = h.q('.gev-hist-play');
  await h.doc.tap(' ', h.clock, { target: button });
  assert.equal(h.root.getAttribute('data-playing'), 'false');
  // arrows inside a widget that owns them (tabs) are not stolen
  h.doc.removeEventListener('keydown', voice);
  h.doc.removeEventListener('keyup', voice);
  const tabs = h.doc.createElement('div');
  tabs.setAttribute('role', 'tablist');
  const tab = h.doc.createElement('button');
  tabs.append(tab);
  h.doc.body.append(tabs);
  const at = h.root.getAttribute('data-time');
  const arrow = h.doc.key('ArrowRight', { target: tab });
  await h.clock.run(100);
  assert.equal(arrow.defaultPrevented, false);
  assert.equal(h.root.getAttribute('data-time'), at);
  h.control.destroy();
});

test('Shift + arrow steps exactly 10 recorded snapshots, also across a gap', async () => {
  const h = setup();
  // 10 back from 14:20 = 14:19 .. 14:10 (all recorded)
  h.control.seek(Date.parse('2026-10-14T14:20:00Z'));
  await h.clock.run(300);
  h.doc.key('ArrowLeft', { shiftKey: true });
  await h.control.settle();
  assert.equal(h.root.getAttribute('data-time'), '2026-10-14T14:10:00.000Z');
  h.doc.key('ArrowLeft', { shiftKey: true });
  await h.control.settle();
  // 14:09, then the gap [14:02, 14:09), then 14:01 .. 13:53 (10 in all)
  assert.equal(h.root.getAttribute('data-time'), '2026-10-14T13:53:00.000Z');
  h.control.destroy();
});

test('stepping across the known gap lands on the next recorded snapshot', async () => {
  const h = setup();
  h.control.seek(h.world.gap.from - MINUTE_MS); // 14:01, the last before the gap
  await h.clock.run(300);
  h.control.step(1, 1);
  await h.control.settle();
  await h.clock.run(100);
  assert.equal(
    h.root.getAttribute('data-time'),
    new Date(h.world.gap.to).toISOString(),
  );
  h.control.destroy();
});

test('play at 1x/10x/60x/600x advances history time by rate x wall time; stops at now', async () => {
  const h = setup();
  h.control.seek(NOW - 2 * DAY_MS);
  for (const rate of [1, 10, 60, 600]) {
    h.q(`[data-rate="${rate}"]`).click();
    assert.equal(h.root.getAttribute('data-rate'), String(rate));
    const t0 = Date.parse(h.root.getAttribute('data-time'));
    h.q('.gev-hist-play').click();
    await h.clock.run(10_000);
    h.q('.gev-hist-play').click();
    const t1 = Date.parse(h.root.getAttribute('data-time'));
    // history moves rate x 10 s, while the wall clock moved 10 s too
    assert.ok(
      Math.abs(t1 - t0 - rate * 10_000) <= rate * 250 + 1000,
      `${rate}x: ${t1 - t0}`,
    );
  }
  // near now: 600x reaches now and stops (stays in history)
  h.control.seek(NOW + 60_000 - 30_000); // clock has moved ~40 s
  h.q('[data-rate="600"]').click();
  h.control.seek(h.clock.now() - 30_000);
  h.q('.gev-hist-play').click();
  await h.clock.run(2_000);
  assert.equal(h.root.getAttribute('data-playing'), 'false');
  assert.equal(h.root.getAttribute('data-mode'), 'history');
  assert.match(h.q('.gev-hist-hud').textContent, /Reached now/);
  h.control.destroy();
});

test('Sky view follows: the History-bound provider reads the emitted state', async () => {
  const h = setup();
  const sky = createHistoryProvider({ target: h.win, now: h.clock.now });
  h.control.seek(NOW - DAY_MS);
  assert.equal(sky.active, true);
  assert.equal(sky.getTime(), NOW - DAY_MS);
  // Sky presets can move the History time
  assert.equal(sky.seek(NOW - 2 * DAY_MS), true);
  await h.clock.run(1500);
  assert.ok(Math.abs(sky.getTime() - (NOW - 2 * DAY_MS)) <= MINUTE_MS);
  h.q('[data-rate="60"]').click();
  h.q('.gev-hist-play').click();
  assert.equal(sky.playing, true);
  assert.equal(sky.rate, 60);
  h.q('.gev-hist-live').click();
  assert.equal(sky.active, false);
  // a Sky mounted later still learns the state from the heartbeat
  h.control.seek(NOW - DAY_MS);
  const late = createHistoryProvider({ target: h.win, now: h.clock.now });
  assert.equal(late.active, false);
  await h.clock.run(2_100);
  assert.equal(late.active, true);
  sky.destroy();
  late.destroy();
  h.control.destroy();
});

test('quiet failure: history API off -> "history unavailable", live keeps running', async () => {
  const layerCalls = [];
  const fetchImpl = async (url) => {
    const path = String(url);
    if (path.startsWith('/api/history/'))
      return new Response('<!doctype html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    layerCalls.push(path);
    return new Response('{"ac":[]}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const h = setup({ fetchImpl });
  h.q('.gev-hist-badge').click();
  await h.clock.run(500);
  assert.equal(h.root.getAttribute('data-unavailable'), 'true');
  assert.equal(h.q('.gev-hist-hud').textContent, HISTORY_UNAVAILABLE);
  assert.equal(h.q('.gev-hist-lane-empty').textContent, HISTORY_UNAVAILABLE);
  // the scrub still works locally; Sky is told to keep its own clock
  h.control.seek(NOW - 3_600_000, { snap: true });
  await h.clock.run(500);
  assert.equal(h.historyEvents().at(-1).error, HISTORY_UNAVAILABLE);
  // a live layer request is passed straight through, unchanged
  const r = await h.win.fetch('/api/military');
  assert.deepEqual(await r.json(), { ac: [] });
  assert.deepEqual(layerCalls, ['/api/military']);
  h.control.destroy();
});

test('OpenSky tile outlines follow t in history mode only', async () => {
  const shown = [];
  const outlines = {
    show: (t) => shown.push(t),
    clear: () => shown.push('clear'),
    destroy: () => shown.push('destroy'),
  };
  const h = setup({ tileOutlines: outlines });
  h.q('.gev-hist-badge').click();
  await h.clock.run(500);
  h.control.seek(NOW - 3 * 3_600_000);
  await h.clock.run(500);
  assert.deepEqual(shown.filter((x) => x !== 'clear').at(-1), [
    [-106.6, 25.8, -93.5, 36.5],
  ]);
  h.q('.gev-hist-live').click();
  assert.equal(shown.at(-1), 'clear');
  h.control.destroy();
  assert.equal(shown.at(-1), 'destroy');
});

test('feed chips render from bridge answers seen through window.fetch', async () => {
  const lastOk = NOW - 20 * MINUTE_MS;
  const fetchImpl = async (url) => {
    const path = String(url);
    if (path === '/api/military')
      return new Response('{}', {
        headers: {
          'X-Feed-Last-OK': String(lastOk),
          'X-Feed-Age-Ms': String(20 * MINUTE_MS),
          'X-Feed-Cache': 'STALE',
          'X-Feed-Stale-Since': String(lastOk + 3 * MINUTE_MS),
          'X-Feed-Grey-Until': String(lastOk + 63 * MINUTE_MS),
        },
      });
    return fixtureFetch(fixtureWorld(NOW))(url);
  };
  const h = setup({ fetchImpl });
  await h.win.fetch('/api/military');
  await flush();
  const chip = h.q('.gev-hist-chip');
  assert.equal(chip.getAttribute('data-state'), 'grey');
  assert.match(
    chip.textContent,
    /^Military: No data since \d\d:\d\d \S+ \(20 min ago\)$/,
  );
  h.control.destroy();
});

test('destroy removes the DOM, listeners, timers and the fetch wrapper', async () => {
  const h = setup();
  const original = h.win.fetch;
  h.control.seek(NOW - DAY_MS);
  h.control.destroy();
  assert.equal(h.root.parentNode, null);
  assert.notEqual(
    h.win.fetch,
    original,
    'sanity: the wrapper was the current fetch',
  );
  h.doc.key(' ');
  await h.clock.run(5_000);
  assert.equal(h.historyEvents().at(-1).active, false);
});

test('app shell touch point: exactly one dynamic import + one call', () => {
  const shell = readFileSync(
    new URL('../../ui/applicationShell.js', import.meta.url),
    'utf8',
  );
  const hits = shell.split('\n').filter((line) => line.includes('historyUi/'));
  assert.equal(hits.length, 1, hits.join('\n'));
  assert.match(
    hits[0],
    /import\('\.\.\/byrdit\/historyUi\/historyShell\.js'\)/,
  );
  assert.match(shell, /mountHistoryForShell\(this\)/);
});

test('mixed-source snapshots: Shift + arrow moves exactly 10 DISTINCT times both ways, across the gap (review R1)', async () => {
  const h = setup({ worldOptions: { mixedSources: true } });
  const at = (iso) => h.root.getAttribute('data-time') === iso;
  h.control.seek(Date.parse('2026-10-14T14:20:00Z'));
  await h.clock.run(300);
  h.doc.key('ArrowLeft', { shiftKey: true });
  await h.control.settle();
  assert.ok(at('2026-10-14T14:10:00.000Z'), h.root.getAttribute('data-time'));
  h.doc.key('ArrowLeft', { shiftKey: true });
  await h.control.settle();
  // 14:09, gap [14:02, 14:09), 14:01 .. 13:53
  assert.ok(at('2026-10-14T13:53:00.000Z'), h.root.getAttribute('data-time'));
  h.doc.key('ArrowRight', { shiftKey: true });
  await h.control.settle();
  // 13:54 .. 14:01 (8), 14:09 (9), 14:10 (10)
  assert.ok(at('2026-10-14T14:10:00.000Z'), h.root.getAttribute('data-time'));
  h.doc.key('ArrowRight', { shiftKey: true });
  await h.control.settle();
  assert.ok(at('2026-10-14T14:20:00.000Z'), h.root.getAttribute('data-time'));
  h.doc.key('ArrowRight');
  await h.control.settle();
  assert.ok(at('2026-10-14T14:21:00.000Z'), h.root.getAttribute('data-time'));
  h.control.destroy();
});

test('a Military gap does not stop aircraft snapping where aircraft was recorded (review R3)', async () => {
  const h = setup({ worldOptions: { aircraftContinuous: true } });
  h.q('.gev-hist-badge').click();
  await h.clock.run(500);
  const target = Date.parse('2026-10-14T14:05:25Z');
  const f = (target - (NOW - DAY_MS)) / DAY_MS;
  const before = h.calls.length;
  await h.pointer('pointerdown', f);
  await h.pointer('pointerup', f);
  await h.clock.run(500);
  const asked = h.calls.slice(before).filter((c) => c.includes('/snapshots'));
  assert.ok(
    asked.some((c) => c.includes('feed=aircraft')),
    asked.join(' '),
  );
  assert.ok(
    !asked.some((c) => c.includes('feed=military')),
    'Military gap: not asked',
  );
  assert.equal(h.root.getAttribute('data-time'), '2026-10-14T14:05:00.000Z');
  // the Military lane gap is still named by the HUD
  assert.match(
    h.q('.gev-hist-hud').textContent,
    /No recording at this time \(gap 14:02-14:09 UTC\) - Military/,
  );
  h.control.destroy();
});

test('control: nothing recorded near t in any lane -> the time stays in the gap', async () => {
  const h = setup();
  h.q('.gev-hist-badge').click();
  await h.clock.run(500);
  const target = Date.parse('2026-10-14T14:05:25Z');
  const f = (target - (NOW - DAY_MS)) / DAY_MS;
  const before = h.calls.length;
  await h.pointer('pointerdown', f);
  await h.pointer('pointerup', f);
  await h.clock.run(500);
  const asked = h.calls.slice(before).filter((c) => c.includes('/snapshots'));
  assert.ok(
    !asked.some((c) => c.includes('feed=military')),
    'Military gap: not asked',
  );
  assert.equal(h.root.getAttribute('data-time'), '2026-10-14T14:05:25.000Z');
  assert.match(h.q('.gev-hist-hud').textContent, /gap 14:02-14:09 UTC/);
  h.control.destroy();
});
