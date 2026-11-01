import test from 'node:test';
import assert from 'node:assert/strict';
import { naipDriver, waybackDriver, weatherDriver } from './clockRows.js';

const T0 = Date.parse('2026-11-01T00:00:00Z');

test('weather driver: setTarget with the ISO time; LIVE = latest; gap text when no product has a frame', () => {
  const calls = [];
  let selected = null;
  const clock = {
    setTarget: (t) => calls.push(['target', t]),
    latest: () => calls.push(['latest']),
    getTimeline: () => [new Date(T0).toISOString(), new Date(T0 + 3600_000).toISOString()],
    getState: () => ({ products: [{ id: 'weather-radar', selected, suspended: false }] }),
  };
  const d = weatherDriver(() => clock);
  assert.equal(d.available(), true);
  assert.equal(d.earliest(), T0);
  d.apply(T0 + 1000);
  d.apply(null);
  assert.deepEqual(calls, [['target', new Date(T0 + 1000).toISOString()], ['latest']]);
  assert.match(d.status(T0 - 86_400_000), /^No imagery \(provider serves 2026-11-01 00:00Z on\)$/);
  selected = new Date(T0).toISOString();
  assert.equal(d.status(T0 + 1000), '');
  assert.equal(weatherDriver(() => null).available(), false);
});

test('wayback / naip drivers pick the release at or before the time', () => {
  const picked = [];
  const win = {
    __gevWayback: {
      catalog: () => [{ date: '2020-01-01' }, { date: '2023-06-01' }, { date: '2025-01-01' }],
      state: () => ({ index: 2 }),
      setIndex: (i) => picked.push(['wb', i]),
    },
    __gevNaip: { state: () => ({ ticks: [2012, 2016, 2022], year: 2022 }), setYear: (y) => picked.push(['naip', y]) },
  };
  const wb = waybackDriver(win);
  wb.apply(Date.parse('2024-01-01T00:00:00Z'));
  wb.apply(null);
  const naip = naipDriver(win);
  naip.apply(Date.parse('2017-01-01T00:00:00Z'));
  naip.apply(null);
  // LIVE puts the release that was in effect before the menu moved it back
  assert.deepEqual(picked, [['wb', 1], ['wb', 2], ['naip', 2016], ['naip', 2022]]);
  assert.equal(waybackDriver({}).available(), false);
});

test('weather driver: a radar loop that was playing resumes on LIVE and is paused for history', async () => {
  const calls = [];
  const clock = { getState: () => ({ playing: true, products: [] }), getTimeline: () => [], pause: () => calls.push('pause'), setTarget: () => calls.push('target'), latest: () => { calls.push('latest'); return Promise.resolve(true); }, play: () => calls.push('play') };
  const d = weatherDriver(() => clock);
  d.apply(Date.parse('2026-10-01T00:00:00Z'));
  d.apply(null);
  await new Promise((r) => setTimeout(r, 1));
  assert.deepEqual(calls, ['pause', 'target', 'latest', 'play']);
});
