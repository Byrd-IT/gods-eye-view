import assert from 'node:assert/strict';
import test from 'node:test';
import { STATE } from './satCore.js';
import {
  CLASS_CHIPS,
  LIST_LIMIT,
  STATE_TEXT,
  ageBanner,
  cardData,
  listIndexFromTarget,
  overheadList,
} from './satPanel.js';

const DAY = 86_400_000;

test('overhead list: above 0 deg only, chip filter, behind-terrain marked, highest first, limited', () => {
  const objects = [];
  for (let i = 0; i < 60; i++)
    objects.push({
      index: i,
      name: `S${i}`,
      azDeg: i * 6,
      elDeg: i - 5,
      klass: i % 2 ? 'other' : 'visual',
      state: STATE.VISIBLE,
    });
  const list = overheadList(objects, {
    classesOn: new Set(['visual']),
    occlusion: (az, el) => (el < 10 ? 'terrain' : 'clear'),
  });
  assert.equal(list.total, 27); // even i from 6..58
  assert.ok(list.rows.length <= LIST_LIMIT);
  assert.equal(list.rows[0].index, 58);
  assert.ok(list.rows.every((r) => r.elDeg > 0 && r.klass === 'visual'));
  assert.equal(list.rows.at(-1).behindTerrain, true);
  assert.equal(overheadList(null).total, 0);
});

test('element-age banner: newest epoch, greyed and hidden counts, warning levels', () => {
  const t = Date.parse('2026-10-12T00:00:00Z');
  const fresh = ageBanner(
    { total: 10, stale: 0, dropped: 0, newestEpochMs: t - 0.5 * DAY },
    t,
  );
  assert.equal(fresh.level, 'ok');
  assert.match(
    fresh.text,
    /newest epoch 2026-10-11 12:00 UTC \(0\.5 d before Sky time\)/,
  );
  const old = ageBanner(
    { total: 10, stale: 4, dropped: 2, newestEpochMs: t - 9 * DAY },
    t,
  );
  assert.equal(old.level, 'warn');
  assert.match(old.text, /4 older than 7 d greyed · 2 beyond 30 d hidden/);
  assert.equal(
    ageBanner(
      { total: 1, stale: 0, dropped: 1, newestEpochMs: t - 40 * DAY },
      t,
    ).level,
    'error',
  );
  assert.match(
    ageBanner({ total: 1, stale: 0, dropped: 0, newestEpochMs: t + DAY }, t)
      .text,
    /after Sky time/,
  );
  assert.equal(ageBanner(null, t), null);
  assert.equal(ageBanner({ total: 0 }, t), null);
});

test('card: name, NORAD, class, az/el, range, range rate, state, element age; below-horizon case', () => {
  const t = Date.parse('2026-10-12T00:00:00Z');
  const meta = {
    index: 0,
    noradId: 25544,
    name: 'ISS (ZARYA)',
    objectId: '1998-067A',
    group: 'stations',
    klass: 'station',
    epochMs: t - 2 * DAY,
  };
  const card = cardData(
    {
      meta,
      row: {
        azDeg: 200,
        elDeg: 45.25,
        rangeKm: 580.4,
        rangeRateKmS: -3.21,
        state: STATE.VISIBLE,
      },
    },
    t,
  );
  const lines = Object.fromEntries(card.lines);
  assert.equal(card.title, 'ISS (ZARYA)');
  assert.equal(lines.NORAD, '25544');
  assert.equal(lines.Class, 'STATION · ISS');
  assert.equal(lines['Az / El'], '200.0° S / 45.3°');
  assert.equal(lines.Range, '580 km');
  assert.match(lines['Range rate'], /-3\.21 km\/s \(approaching\)/);
  assert.equal(lines.State, STATE_TEXT[STATE.VISIBLE]);
  assert.match(lines.Elements, /2\.0 d old/);
  assert.equal(card.aboveHorizon, true);
  const below = cardData(
    {
      meta: { ...meta, klass: 'other', group: 'active', epochMs: t - 9 * DAY },
      row: null,
    },
    t,
  );
  const b = Object.fromEntries(below.lines);
  assert.equal(b.Class, 'ACTIVE');
  assert.equal(b.Position, 'Below your horizon now');
  assert.match(b.Elements, /old: position less certain/);
  assert.equal(below.aboveHorizon, false);
  const dropped = cardData(
    { meta: { ...meta, epochMs: t - 31 * DAY }, row: null },
    t,
  );
  assert.equal(
    Object.fromEntries(dropped.lines).Position,
    'Hidden: elements more than 30 days from Sky time',
  );
  assert.equal(cardData(null, t), null);
});

test('chips cover every sky class', () => {
  assert.deepEqual(
    CLASS_CHIPS.map((c) => c.klass),
    ['station', 'nav', 'geo', 'visual', 'comms', 'other'],
  );
});

test('list click target: only a row button inside the list with a valid data-index selects', () => {
  const node = (tagName, attrs = {}, parentNode = null) => ({
    tagName,
    parentNode,
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
  });
  const list = node('UL');
  const li = node('LI', {}, list);
  const button = node('BUTTON', { 'data-index': '7' }, li);
  const span = node('SPAN', {}, button);
  // legitimate: the button itself and a nested element inside it
  assert.equal(listIndexFromTarget(list, button, 100), 7);
  assert.equal(listIndexFromTarget(list, span, 100), 7);
  // background: the list itself, an <li> gap, null, a node outside the list
  assert.equal(listIndexFromTarget(list, list, 100), null);
  assert.equal(listIndexFromTarget(list, li, 100), null);
  assert.equal(listIndexFromTarget(list, null, 100), null);
  const outside = node('BUTTON', { 'data-index': '3' }, node('DIV'));
  assert.equal(listIndexFromTarget(list, outside, 100), null);
  // a button in the list without / with a bad data-index
  for (const bad of [undefined, '', ' 1', '-1', '1.5', '1e2', 'x', '100']) {
    const attrs = bad === undefined ? {} : { 'data-index': bad };
    assert.equal(
      listIndexFromTarget(
        list,
        node('BUTTON', attrs, node('LI', {}, list)),
        100,
      ),
      null,
      `data-index ${JSON.stringify(bad)}`,
    );
  }
  assert.equal(
    listIndexFromTarget(list, node('BUTTON', { 'data-index': '0' }, li), 1),
    0,
  );
});
