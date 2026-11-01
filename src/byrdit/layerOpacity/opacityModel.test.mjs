import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOpacityModel, encodeLop, decodeLop, writeLopToUrl, readLopFromUrl,
  normalizeOpacity, opacityPercent,
} from './opacityModel.js';

test('default is 100% and set to default stores nothing', () => {
  const m = createOpacityModel();
  assert.equal(m.get('wind'), 1);
  assert.equal(m.set('wind', 1), false);
  assert.deepEqual(m.entries(), []);
});
test('set/get/entries/reset and listeners', () => {
  const m = createOpacityModel({ ids: ['wind', 'flights'] });
  const seen = [];
  m.subscribe((id, v) => seen.push([id, v]));
  assert.equal(m.set('wind', 0.5), true);
  assert.equal(m.set('wind', 0.5), false);
  assert.equal(m.set('nope', 0.5), false);
  assert.equal(m.set('flights', '0.25'), true);
  assert.deepEqual(m.entries(), [['flights', 0.25], ['wind', 0.5]]);
  m.reset();
  assert.deepEqual(m.entries(), []);
  assert.deepEqual(seen, [['wind', 0.5], ['flights', 0.25], ['wind', 1], ['flights', 1]]);
});
test('a throwing listener does not stop the others', () => {
  const m = createOpacityModel();
  let hit = 0;
  m.subscribe(() => { throw new Error('x'); });
  m.subscribe(() => hit++);
  m.set('a', 0.4);
  assert.equal(hit, 1);
});
test('normalize clamps and rejects junk', () => {
  assert.equal(normalizeOpacity(2), 1);
  assert.equal(normalizeOpacity(-1), 0);
  assert.equal(normalizeOpacity(NaN), 1);
  assert.equal(normalizeOpacity('abc'), 1);
  assert.equal(normalizeOpacity(0.333), 0.33);
  assert.equal(opacityPercent(0.5), 50);
});
test('encode/decode round trip, 100% omitted', () => {
  const text = encodeLop([['wind', 0.5], ['x', 1], ['Bad Id', 0.2], ['flights', 0]]);
  assert.equal(text, 'wind:50,flights:0');
  assert.deepEqual([...decodeLop(text)], [['wind', 0.5], ['flights', 0]]);
});
test('decode drops malformed, unknown, duplicate, 100 and oversized input', () => {
  const known = (id) => id !== 'ghost';
  assert.deepEqual([...decodeLop('wind:50,wind:20,ghost:30,a:101x,b:,:5,c:100,d:150', known)], [['wind', 0.5]]);
  assert.equal(decodeLop('x'.repeat(5000)).size, 0);
  assert.equal(decodeLop(Array.from({ length: 200 }, (_, i) => `l${i}:5`).join(',')).size, 0);
  assert.equal(decodeLop(null).size, 0);
  assert.equal(decodeLop(undefined).size, 0);
  assert.equal(decodeLop('__proto__:50').size, 0);
});
test('url write keeps other params and removes lop when empty', () => {
  const href = 'https://x.test/?ht=2026&hl=a:b#v=2&lat=1';
  const w = writeLopToUrl(href, [['wind', 0.5]]);
  assert.equal(w, 'https://x.test/?ht=2026&hl=a:b&lop=wind:50#v=2&lat=1');
  assert.equal(writeLopToUrl(w, [['wind', 0.25]]), 'https://x.test/?ht=2026&hl=a:b&lop=wind:25#v=2&lat=1');
  assert.equal(writeLopToUrl(w, []), 'https://x.test/?ht=2026&hl=a:b#v=2&lat=1');
  assert.equal(writeLopToUrl('https://x.test/?lop=a:5', []), 'https://x.test/');
});
test('read from url', () => {
  assert.deepEqual([...readLopFromUrl('https://x.test/?lop=wind:50,flights:10')], [['wind', 0.5], ['flights', 0.1]]);
  assert.equal(readLopFromUrl('not a url').size, 0);
  assert.equal(readLopFromUrl('https://x.test/').size, 0);
});
