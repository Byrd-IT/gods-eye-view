import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLayerClocks,
  decodeHl,
  encodeHl,
  readHlFromUrl,
  snapToRelease,
  writeHlToUrl,
} from './layerClocks.js';
import { HISTORY_FLOOR_MS } from './historyTimeline.js';

const NOW = Date.parse('2026-11-01T18:00:00Z');
const D = 86_400_000;
const rows = [
  { id: 'flights', label: 'Flights', adapterIds: ['flights'] },
  { id: 'vessels', label: 'Vessels', adapterIds: ['vessels'] },
  { id: 'wayback', label: 'Wayback', adapterIds: [], releases: [NOW - 400 * D, NOW - 100 * D, NOW - 10 * D] },
];
const make = () => createLayerClocks({ rows, now: () => NOW });

test('default: every row is locked and follows the shared time (old ht= behaviour)', () => {
  const c = make();
  assert.equal(c.getState().allLocked, true);
  assert.deepEqual(c.layerTimes(), {}, 'a locked row sends the router nothing of its own');
  c.setShared(NOW - D);
  assert.equal(c.effective('flights'), NOW - D);
  assert.equal(c.effective('vessels'), NOW - D);
  c.setShared(null);
  assert.equal(c.effective('flights'), null, 'LIVE');
});

test('an unticked row keeps its own time while the group moves', () => {
  const c = make();
  c.setShared(NOW - D);
  c.toggleLock('vessels'); // freezes at what it shows now
  assert.equal(c.effective('vessels'), NOW - D);
  c.setShared(NOW - 5 * D);
  assert.equal(c.effective('flights'), NOW - 5 * D);
  assert.equal(c.effective('vessels'), NOW - D, 'did not follow');
  c.setOwn('vessels', NOW - 3 * D);
  assert.deepEqual(c.layerTimes(), { vessels: NOW - 3 * D });
  c.toggleLock('vessels'); // ticking joins the shared time
  assert.equal(c.effective('vessels'), NOW - 5 * D);
  assert.deepEqual(c.layerTimes(), {});
});

test('moving one row on its own takes it out of the group; LIVE is its own time null', () => {
  const c = make();
  c.setShared(NOW - D);
  c.setOwn('flights', NOW - 9 * D);
  assert.equal(c.isLocked('flights'), false);
  c.setLive('vessels');
  assert.deepEqual(c.layerTimes(), { flights: NOW - 9 * D, vessels: null });
});

test('Lock all ticks every row; Unlock all freezes every row where it is', () => {
  const c = make();
  c.setShared(NOW - 2 * D);
  c.unlockAll();
  assert.equal(c.getState().noneLocked, true);
  c.setShared(NOW - 8 * D);
  assert.equal(c.effective('flights'), NOW - 2 * D);
  c.setOwn('vessels', NOW - 4 * D);
  c.lockAll();
  assert.equal(c.getState().allLocked, true);
  assert.equal(c.effective('vessels'), NOW - 8 * D);
  assert.equal(c.effective('flights'), NOW - 8 * D);
});

test('release rows snap to the nearest release at or before the time', () => {
  const c = make();
  c.setShared(NOW - 50 * D);
  assert.equal(c.effective('wayback'), NOW - 100 * D);
  c.setShared(NOW - 1 * D);
  assert.equal(c.effective('wayback'), NOW - 10 * D);
  c.setShared(NOW - 500 * D);
  assert.equal(c.effective('wayback'), null, 'before the first release: nothing');
  assert.equal(snapToRelease([3, 7], 5), 3);
  assert.equal(snapToRelease([], 5), null);
});

test('no 2-year clamp: a row can sit years back, but never before its own coverage start or the API floor', () => {
  const c = make();
  c.setOwn('flights', NOW - 1500 * D);
  assert.equal(c.effective('flights'), NOW - 1500 * D);
  c.setRowInfo('flights', { earliest: NOW - 800 * D });
  c.setOwn('flights', NOW - 1500 * D);
  assert.equal(c.effective('flights'), NOW - 800 * D, 'earliest = start of that layer coverage');
  c.setOwn('vessels', 0 - 4e12);
  assert.equal(c.effective('vessels'), HISTORY_FLOOR_MS);
  c.setOwn('vessels', NOW + 7 * D);
  assert.equal(c.effective('vessels'), NOW, 'never the future');
});

test('hl round trip: only unlocked rows are written; ht-only links stay all locked', () => {
  const c = make();
  assert.equal(writeHlToUrl('https://gev.example/?ht=2026-10-13T14:05:30Z', c.urlEntries()), 'https://gev.example/?ht=2026-10-13T14:05:30Z');
  c.setOwn('vessels', Date.parse('2026-09-01T00:00:00Z'));
  c.setLive('flights');
  const href = writeHlToUrl('https://gev.example/?ht=2026-10-13T14:05:30Z#l=abc', c.urlEntries());
  assert.match(href, /hl=flights:live,vessels:2026-09-01T00:00:00Z/);
  assert.ok(href.endsWith('#l=abc') && href.includes('ht=2026-10-13T14:05:30Z'));
  const back = make();
  back.applyHl(readHlFromUrl(href, NOW));
  assert.equal(back.isLocked('wayback'), true);
  assert.equal(back.effective('vessels'), Date.parse('2026-09-01T00:00:00Z'));
  assert.equal(back.effective('flights'), null);
  assert.equal(readHlFromUrl('https://gev.example/?ht=2026-10-13T14:05:30Z', NOW).size, 0);
});

test('hl decode ignores malformed, future-dated and pre-floor entries', () => {
  const m = decodeHl('flights:live,bad,vessels:yesterday,x y:live,wayback:1900-01-01T00:00:00Z,flights2:2099-01-01T00:00:00Z', NOW);
  assert.deepEqual([...m.keys()].sort(), ['flights']);
  const near = decodeHl('a:2026-11-01T18:03:00Z', NOW);
  assert.equal(near.get('a'), NOW, 'a few minutes ahead clamps to now');
  assert.equal(encodeHl([['a', null]]), 'a:live');
});

test('subscribers hear changes once; a no-op change is silent', () => {
  const c = make();
  let n = 0;
  const off = c.subscribe(() => n++);
  c.setShared(NOW - D);
  c.setShared(NOW - D);
  c.lockAll();
  assert.equal(n, 1);
  off();
  c.setShared(NOW - 2 * D);
  assert.equal(n, 1);
});
