import test from 'node:test';
import assert from 'node:assert/strict';
import { mountHistoryMenu } from './historyMenu.js';
import { fakeDocument, fakeWindow } from './fakeDom.mjs';

const NOW = Date.parse('2026-11-01T18:00:00Z');
const D = 86_400_000;
const MIN = 60_000;

function setup({ href = 'https://gev.example/?ht=2026-10-13T14:05:30Z', drivers } = {}) {
  const doc = fakeDocument();
  const win = fakeWindow(href, async () => ({ ok: false }));
  const parent = doc.createElement('div');
  doc.body.append(parent);
  const routed = [];
  const ctl = { active: false, ms: null, calls: [] };
  const control = {
    getState: () => ({ active: ctl.active, timeMs: ctl.ms }),
    enter(ms) {
      ctl.calls.push(['enter', ms]);
      ctl.active = true;
      ctl.ms = ms;
      menu.onHistory({ active: true, timeMs: ms, playing: false, rate: 1 });
    },
    seek(ms) {
      ctl.calls.push(['seek', ms]);
      ctl.ms = ms;
      menu.onHistory({ active: true, timeMs: ms, playing: false, rate: 1 });
    },
    leave() {
      ctl.calls.push(['leave']);
      ctl.active = false;
      ctl.ms = null;
      menu.onHistory({ active: false, timeMs: null });
    },
  };
  const menu = mountHistoryMenu({
    document: doc,
    window: win,
    parent,
    control,
    drivers: drivers ?? new Map(),
    onRouter: (d) => routed.push(d),
    now: () => NOW,
  });
  const row = (id) => menu.root.find((n) => n.getAttribute('data-row') === id);
  const part = (id, cls) => row(id).find((n) => n.className === cls);
  return { doc, win, menu, routed, ctl, control, row, part };
}

test('menu lists the router rows; driver rows stay hidden until their layer exists', () => {
  const { row } = setup();
  for (const id of ['flights', 'military', 'vessels', 'quakes', 'wind']) assert.equal(row(id).hidden, false, id);
  for (const id of ['satellites', 'weather', 'wayback', 'naip', 'ghostmaps']) assert.equal(row(id).hidden, true, id);
});

test('all rows start locked; the shared time reaches the router with no own times', () => {
  const { menu, routed } = setup();
  menu.onHistory({ active: true, timeMs: NOW - 3 * D, playing: false, rate: 1 });
  const last = routed.at(-1);
  assert.equal(last.timeMs, NOW - 3 * D);
  assert.deepEqual(last.layerTimes, {});
});

test('unticking a row, then moving it, gives it its own time while the group stays', () => {
  const { menu, routed, part } = setup();
  menu.onHistory({ active: true, timeMs: NOW - 3 * D, playing: false, rate: 1 });
  const lock = part('vessels', 'gev-hm-lock');
  lock.checked = false;
  lock.dispatch('change');
  const range = part('vessels', 'gev-hm-range');
  range.value = String(Math.floor((NOW - 20 * D) / MIN));
  range.dispatch('input');
  range.dispatch('change');
  assert.deepEqual(routed.at(-1).layerTimes, { vessels: Math.floor((NOW - 20 * D) / MIN) * MIN });
  assert.equal(routed.at(-1).timeMs, NOW - 3 * D);
  assert.match(menu.root.textContent, /LIVE/);
});

test('moving a ticked row moves the whole group through the main control', () => {
  const { menu, ctl, part } = setup();
  const range = part('quakes', 'gev-hm-range');
  range.value = String(Math.floor((NOW - 9 * D) / MIN));
  range.dispatch('change');
  assert.equal(ctl.calls[0][0], 'enter');
  assert.equal(ctl.calls[0][1], Math.floor((NOW - 9 * D) / MIN) * MIN);
  range.value = String(Math.floor((NOW - 8 * D) / MIN));
  range.dispatch('change');
  assert.equal(ctl.calls[1][0], 'seek');
  assert.equal(menu.clocks.effective('flights'), Math.floor((NOW - 8 * D) / MIN) * MIN);
});

test('Unlock all / Lock all buttons; share URL carries hl only while rows are unlocked', () => {
  const { menu, win, routed } = setup();
  menu.onHistory({ active: true, timeMs: NOW - D, playing: false, rate: 1 });
  const [lockAll, unlockAll] = menu.root.findAll((n) => n.tagName === 'BUTTON' && ['Lock all', 'Unlock all'].includes(n.textContent));
  assert.equal(lockAll.textContent, 'Lock all');
  assert.equal(lockAll.disabled, true);
  unlockAll.click();
  assert.equal(menu.clocks.getState().noneLocked, true);
  assert.match(win.location.href, /hl=/);
  assert.equal(Object.keys(routed.at(-1).layerTimes).length > 5, true);
  lockAll.click();
  assert.equal(menu.clocks.getState().allLocked, true);
  assert.doesNotMatch(win.location.href, /hl=/);
  assert.match(win.location.href, /ht=2026-10-13/);
  assert.deepEqual(routed.at(-1).layerTimes, {});
});

test('an hl= link restores unlocked rows; old ht= links stay all locked', () => {
  const a = setup({ href: 'https://gev.example/?ht=2026-10-13T14:05:30Z&hl=vessels:2026-09-01T00:00:00Z,quakes:live' });
  assert.equal(a.menu.clocks.isLocked('vessels'), false);
  assert.equal(a.menu.clocks.effective('vessels'), Date.parse('2026-09-01T00:00:00Z'));
  assert.equal(a.menu.clocks.effective('quakes'), null);
  assert.equal(a.menu.clocks.isLocked('flights'), true);
  const b = setup();
  assert.equal(b.menu.clocks.getState().allLocked, true);
});

test('drivers: a layer row gets the time it shows; repeated heartbeats do not re-apply', () => {
  const applied = [];
  const sat = { available: () => true, apply: (ms) => applied.push(ms) };
  const { menu } = setup({ drivers: new Map([['satellites', sat]]) });
  menu.onHistory({ active: true, timeMs: NOW - 2 * D, playing: false, rate: 1 });
  menu.onHistory({ active: true, timeMs: NOW - 2 * D, playing: false, rate: 1 });
  assert.deepEqual(applied, [NOW - 2 * D], 'nothing at mount while LIVE; once per change');
  menu.clocks.setOwn('satellites', NOW - 40 * D);
  assert.equal(applied.at(-1), NOW - 40 * D);
  menu.clocks.setLive('satellites');
  assert.equal(applied.at(-1), null);
});

test('release rows (Wayback) snap to a release at or before the time', () => {
  const applied = [];
  const wb = { available: () => true, releases: () => [NOW - 300 * D, NOW - 100 * D, NOW - 10 * D], apply: (ms) => applied.push(ms) };
  const { menu, row } = setup({ drivers: new Map([['wayback', wb]]) });
  assert.equal(row('wayback').hidden, false);
  menu.onHistory({ active: true, timeMs: NOW - 50 * D, playing: false, rate: 1 });
  assert.equal(applied.at(-1), NOW - 100 * D);
});

test('weather: a gap note shows when the provider has nothing for the time', () => {
  const wx = { available: () => true, earliest: () => NOW - D, apply() {}, status: (ms) => (ms < NOW - D ? 'No imagery' : '') };
  const { menu, part } = setup({ drivers: new Map([['weather', wx]]) });
  menu.onHistory({ active: true, timeMs: NOW - 5 * D, playing: false, rate: 1 });
  assert.equal(part('weather', 'gev-hm-note').textContent, 'No imagery');
  assert.equal(menu.clocks.row('weather').earliest, NOW - D);
});

test('a locked row asked for a time before its coverage shows a "No data before" gap, not a different time', () => {
  const { menu, part } = setup();
  menu.onHistory({ active: true, timeMs: Date.parse('2023-01-01T00:00:00Z'), playing: false, rate: 1 });
  assert.equal(menu.clocks.effective('vessels'), Date.parse('2023-01-01T00:00:00Z'));
  assert.equal(part('vessels', 'gev-hm-note').textContent, 'No data before 2024-10-11 00:00Z');
  assert.equal(part('flights', 'gev-hm-note').textContent, '');
});

test('a locked release row before its first release is a gap, not LIVE', () => {
  const wb = { available: () => true, releases: () => [NOW - 300 * D, NOW - 10 * D], apply() { throw new Error('must not be applied in a gap'); } };
  const { menu, part } = setup({ drivers: new Map([['wayback', wb]]) });
  menu.onHistory({ active: true, timeMs: NOW - 400 * D, playing: false, rate: 1 });
  assert.match(part('wayback', 'gev-hm-note').textContent, /^No data before /);
  assert.equal(part('wayback', 'gev-hm-time').textContent, '—');
});

test('GhostMaps row hears a rate change at the same shared time', () => {
  const seen = [];
  const gm = { usesDetail: true, available: () => true, apply: (ms, o) => seen.push(o.detail?.rate) };
  const { menu } = setup({ drivers: new Map([['ghostmaps', gm]]) });
  menu.onHistory({ active: true, timeMs: NOW - D, playing: false, rate: 1 });
  menu.onHistory({ active: true, timeMs: NOW - D, playing: false, rate: 4 });
  assert.deepEqual(seen, [1, 4]);
});

test('hl write keeps every other query parameter byte for byte', async () => {
  const { writeHlToUrl } = await import('./layerClocks.js');
  const out = writeHlToUrl('https://g.example/?a=b%20c&ht=2026-10-13T14:05:30Z&q=%C3%A9+x', [['vessels', NOW - D]]);
  assert.match(out, /a=b%20c&ht=2026-10-13T14:05:30Z&q=%C3%A9\+x&hl=vessels/);
  assert.equal(writeHlToUrl(out, []), 'https://g.example/?a=b%20c&ht=2026-10-13T14:05:30Z&q=%C3%A9+x');
});

test('a driver row whose layer appears after mount (shared time LIVE) shows up on recheck and applies its hl= time', () => {
  const applied = [];
  let ready = false;
  const sat = { available: () => ready, apply: (ms) => applied.push(ms) };
  const { menu, row } = setup({
    href: 'https://gev.example/?hl=satellites:2026-10-01T00:00:00Z',
    drivers: new Map([['satellites', sat]]),
  });
  assert.equal(row('satellites').hidden, true);
  assert.deepEqual(applied, []);
  ready = true;
  menu.recheck();
  assert.equal(row('satellites').hidden, false);
  assert.deepEqual(applied, [Date.parse('2026-10-01T00:00:00Z')]);
});

test('LIVE: a rate or error change does not re-apply a driver that ignores them (a radar loop keeps playing)', () => {
  const applied = [];
  const wx = { available: () => true, apply: (ms) => applied.push(ms) };
  const { menu } = setup({ drivers: new Map([['weather', wx]]) });
  menu.onHistory({ active: false, timeMs: null, rate: 1 });
  menu.onHistory({ active: false, timeMs: null, rate: 4, error: 'x' });
  menu.onHistory({ active: false, timeMs: null, rate: 4, error: null });
  assert.deepEqual(applied, []);
});

test('one detail runs the router once (no nested sync)', () => {
  const { menu, routed } = setup();
  const before = routed.length;
  menu.onHistory({ active: true, timeMs: NOW - D, playing: false, rate: 1 });
  assert.equal(routed.length - before, 1);
});
