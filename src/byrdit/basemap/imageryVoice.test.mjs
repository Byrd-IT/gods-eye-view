import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createImageryVoice,
  countyLabels,
  ensureByrditOpen,
  flyToImageryBounds,
} from './imageryVoice.js';

const SECRET = 'Bearer sk-synthTEST123suffix';

function catalog() {
  return {
    available: true,
    defaultYear: 2024,
    years: [
      {
        kind: 'statewide',
        key: 'naip-2024',
        year: 2024,
        bounds: [-106.7, 25.8, -93.4, 36.6],
      },
    ],
    regional: [
      {
        id: 'hist-titus-1940',
        year: 1940,
        name: 'Titus 1940 historic aerial',
        bounds: [-95.2, 33.0, -94.8, 33.3],
        greyscale: true,
      },
      {
        id: 'hist-camp-1940',
        year: 1940,
        name: 'Camp 1940 historic aerial',
        bounds: [-95.1, 32.9, -94.7, 33.1],
        greyscale: true,
      },
      {
        id: 'hires-2018',
        year: 2018,
        name: 'Wood+Upshur 2018 15 cm',
        bounds: [-95.5, 32.5, -94.5, 33.0],
      },
      {
        id: 'hires-titus-2018',
        year: 2018,
        name: 'Titus 2018 15 cm (partial)',
        bounds: [-95.3, 33.0, -94.9, 33.2],
      },
      {
        id: 'hires-ring-2018',
        year: 2018,
        name: 'Rains-Van Zandt-Camp-Gregg-Harrison-Marion 2018 15 cm',
        bounds: [-95.8, 32.3, -94.0, 33.2],
      },
    ],
  };
}

function fakeNaip(year = 2024) {
  const state = { year, enabled: true };
  return {
    calls: [],
    setYear(next) {
      this.calls.push(['setYear', next]);
      if (!Number.isInteger(next) || next === state.year) return false;
      state.year = next;
      return true;
    },
    setEnabled(on) {
      this.calls.push(['setEnabled', on]);
      state.enabled = Boolean(on);
    },
    state: () => ({ ...state }),
  };
}

function fakeWayback(rows) {
  const state = {
    on: false,
    date: rows.at(-1)?.date ?? null,
    index: rows.length - 1,
  };
  return {
    calls: [],
    catalog: () => rows,
    setIndex(index) {
      this.calls.push(['setIndex', index]);
      state.index = index;
      state.date = rows[index]?.date ?? null;
      return true;
    },
    async enable() {
      this.calls.push(['enable']);
      state.on = true;
      return true;
    },
    async disable() {
      this.calls.push(['disable']);
      state.on = false;
    },
    settleNow() {
      this.calls.push(['settleNow']);
    },
    state: () => ({ ...state }),
  };
}

function voice(extra = {}) {
  const naip = extra.naip === undefined ? fakeNaip() : extra.naip;
  const opened = [];
  const flown = [];
  const api = createImageryVoice({
    getNaip: () => naip,
    getCatalog: extra.catalog === undefined ? catalog : extra.catalog,
    getWayback: extra.getWayback ?? (() => null),
    ensureOpen:
      extra.ensureOpen ??
      (async () => {
        opened.push(true);
        return { ok: true, switched: true };
      }),
    flyTo: async (bounds) => {
      flown.push(bounds);
      return true;
    },
  });
  return { api, naip, opened, flown };
}

test('county labels come from the set name, not a hardcoded list', () => {
  assert.deepEqual(countyLabels(catalog().regional[2]), ['Wood', 'Upshur']);
  assert.deepEqual(countyLabels(catalog().regional[4]), [
    'Rains',
    'Van Zandt',
    'Camp',
    'Gregg',
    'Harrison',
    'Marion',
  ]);
});

test('an unknown year lists the catalog years and does not echo other text', async () => {
  const { api, naip } = voice();
  const result = await api.year({ year: 1999, county: SECRET });
  assert.equal(result.ok, false);
  assert.match(result.error, /1999/);
  assert.deepEqual(result.years, [1940, 2018, 2024]);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(JSON.stringify(result).includes('sk-synth'), false);
  assert.equal(naip.calls.length, 0);
});

test('a non-year does not echo the caller text', async () => {
  const { api } = voice();
  const result = await api.year({ year: SECRET });
  assert.equal(result.ok, false);
  assert.match(result.error, /four-digit year/);
  assert.equal(JSON.stringify(result).includes('sk-synth'), false);
  assert.equal(JSON.stringify(result).includes('Bearer'), false);
});

test('show 2018 aerial sets the year and switches to Byrd-IT Open', async () => {
  const { api, naip, opened, flown } = voice();
  const result = await api.year({ year: 2018 });
  assert.equal(result.ok, true);
  assert.equal(result.year, 2018);
  assert.equal(result.switched, true);
  assert.equal(opened.length, 1);
  assert.deepEqual(naip.calls[0], ['setEnabled', true]);
  assert.deepEqual(naip.calls[1], ['setYear', 2018]);
  assert.match(result.label, /2018/);
  assert.equal(result.sets.length, 3);
  assert.equal(flown.length, 0);
  assert.equal(result.framed, null);
});

test('Titus 1940 frames the county set, not a different county', async () => {
  const { api, flown } = voice();
  const result = await api.year({ year: 1940, county: 'Titus County' });
  assert.equal(result.ok, true);
  assert.equal(result.framed.id, 'hist-titus-1940');
  assert.equal(result.framed.flew, true);
  assert.deepEqual(flown[0], [-95.2, 33.0, -94.8, 33.3]);
});

test('a county-specific set wins over a ring that merely lists the county', async () => {
  const { api } = voice();
  const result = await api.year({ year: 2018, county: 'titus' });
  assert.equal(result.framed.id, 'hires-titus-2018');
});

test('Van Zandt matches the ring name', async () => {
  const { api } = voice();
  const result = await api.year({ year: 2018, county: 'Van Zandt' });
  assert.equal(result.framed.id, 'hires-ring-2018');
});

test('a known county with no set that year lists the counties that do', async () => {
  const { api, naip } = voice();
  const result = await api.year({ year: 1940, county: 'Wood' });
  assert.equal(result.ok, false);
  assert.match(result.error, /Wood has no set for 1940/);
  assert.deepEqual(result.counties, ['Titus', 'Camp']);
  assert.equal(naip.calls.length, 0);
});

test('an unrecognized county is not echoed', async () => {
  const { api } = voice();
  const result = await api.year({ year: 2018, county: SECRET });
  assert.equal(result.ok, false);
  assert.match(result.error, /No county set matched/);
  assert.ok(result.counties.includes('Wood'));
  assert.equal(JSON.stringify(result).includes('sk-synth'), false);
});

test('a failed stack switch does not change the year', async () => {
  const { api, naip } = voice({
    ensureOpen: async () => ({ ok: false, error: 'nope' }),
  });
  const result = await api.year({ year: 2018 });
  assert.equal(result.ok, false);
  assert.match(result.error, /Byrd-IT Open/);
  assert.equal(result.error.includes('nope'), false);
  assert.equal(naip.calls.length, 0);
});

test('missing aerial handle is a fixed unavailable error', async () => {
  const { api } = voice({ naip: null, catalog: () => null });
  const result = await api.year({ year: 2018 });
  assert.deepEqual(result, {
    ok: false,
    error: 'Aerial imagery is not available right now',
  });
});

test('wayback year picks the latest release in that year', async () => {
  const rows = [
    { release: 10, date: '2014-02-20' },
    { release: 11, date: '2014-09-01' },
    { release: 20, date: '2018-06-15' },
  ];
  const wb = fakeWayback(rows);
  const { api } = voice({ getWayback: () => wb });
  const result = await api.wayback({ date: '2014' });
  assert.equal(result.ok, true);
  assert.equal(result.date, '2014-09-01');
  assert.equal(result.release, 11);
  assert.deepEqual(wb.calls[0], ['setIndex', 1]);
  assert.deepEqual(wb.calls[1], ['enable']);
});

test('an unknown wayback date lists years and does not echo other text', async () => {
  const wb = fakeWayback([{ release: 20, date: '2018-06-15' }]);
  const { api } = voice({ getWayback: () => wb });
  const bad = await api.wayback({ date: SECRET });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /year or YYYY-MM-DD/);
  assert.equal(JSON.stringify(bad).includes('sk-synth'), false);
  const missing = await api.wayback({ date: '1999' });
  assert.match(missing.error, /1999/);
  assert.deepEqual(missing.years, [2018]);
  assert.equal(wb.calls.length, 0);
});

test('off turns the aerial overlay off and can turn Wayback off', async () => {
  const wb = fakeWayback([{ release: 20, date: '2018-06-15' }]);
  const { api, naip } = voice({ getWayback: () => wb });
  const aerial = await api.off({});
  assert.equal(aerial.ok, true);
  assert.equal(aerial.aerial, false);
  assert.deepEqual(naip.calls.at(-1), ['setEnabled', false]);
  const both = await api.off({ target: 'both' });
  assert.equal(both.ok, true);
  assert.equal(both.wayback, false);
  assert.ok(wb.calls.some((call) => call[0] === 'disable'));
});

test('a bad off target is not echoed', async () => {
  const { api } = voice();
  const result = await api.off({ target: SECRET });
  assert.equal(result.ok, false);
  assert.match(result.error, /aerial, wayback, or both/);
  assert.equal(JSON.stringify(result).includes('sk-synth'), false);
});

test('year says when the stack switch turns Wayback off', async () => {
  const wb = fakeWayback([{ release: 20, date: '2018-06-15' }]);
  await wb.enable();
  const { api } = voice({ getWayback: () => wb });
  const result = await api.year({ year: 2018 });
  assert.equal(result.ok, true);
  assert.equal(result.waybackOff, true);
  assert.equal(wb.state().on, false);
  assert.ok(wb.calls.some((call) => call[0] === 'disable'));
});

test('a failed stack switch leaves Wayback on', async () => {
  const wb = fakeWayback([{ release: 20, date: '2018-06-15' }]);
  await wb.enable();
  const { api } = voice({
    getWayback: () => wb,
    ensureOpen: async () => ({ ok: false }),
  });
  const result = await api.year({ year: 2018 });
  assert.equal(result.ok, false);
  assert.equal(wb.state().on, true);
  assert.equal(
    wb.calls.some((call) => call[0] === 'disable'),
    false,
  );
});

test('year still reports waybackOff when the stack switch already turned it off', async () => {
  const wb = fakeWayback([{ release: 20, date: '2018-06-15' }]);
  await wb.enable();
  const { api } = voice({
    getWayback: () => wb,
    ensureOpen: async () => {
      await wb.disable();
      return { ok: true, switched: true };
    },
  });
  const result = await api.year({ year: 2018 });
  assert.equal(result.ok, true);
  assert.equal(result.waybackOff, true);
  assert.equal(wb.state().on, false);
});

test('year does not claim Wayback turned off when it was already off', async () => {
  const wb = fakeWayback([{ release: 20, date: '2018-06-15' }]);
  const { api } = voice({ getWayback: () => wb });
  const result = await api.year({ year: 2018 });
  assert.equal(result.ok, true);
  assert.equal(result.waybackOff, false);
  assert.equal(
    wb.calls.some((call) => call[0] === 'disable'),
    false,
  );
});

test('off both on a Wayback-only voice turns Wayback off', async () => {
  const wb = fakeWayback([{ release: 20, date: '2018-06-15' }]);
  const { api } = voice({
    naip: null,
    catalog: () => null,
    getWayback: () => wb,
  });
  const result = await api.off({ target: 'both' });
  assert.equal(result.ok, true);
  assert.equal(result.target, 'both');
  assert.equal(result.wayback, false);
  assert.equal(Object.hasOwn(result, 'aerial'), false);
  assert.ok(wb.calls.some((call) => call[0] === 'disable'));
});

test('off both with only aerial turns aerial off', async () => {
  const { api, naip } = voice();
  const result = await api.off({ target: 'both' });
  assert.equal(result.ok, true);
  assert.equal(result.aerial, false);
  assert.equal(Object.hasOwn(result, 'wayback'), false);
  assert.deepEqual(naip.calls.at(-1), ['setEnabled', false]);
});

test('off both fails only when neither handle exists', async () => {
  const { api } = voice({ naip: null, catalog: () => null });
  const result = await api.off({ target: 'both' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Aerial imagery is not available right now');
});

test('year result says when compare hides the change and when the layer is not drawn', async () => {
  const covered = fakeNaip();
  covered.state = () => ({
    year: 2018,
    enabled: true,
    compare: true,
    yearB: 1940,
    layers: [
      { key: 'left:naip-2018', side: 'left', show: false },
      { key: 'right:hist-1940', side: 'right', show: false },
    ],
  });
  const { api } = voice({ naip: covered });
  const hidden = await api.year({ year: 2018 });
  assert.equal(hidden.ok, true);
  assert.equal(hidden.compare, true);
  assert.equal(hidden.yearB, 1940);
  assert.equal(hidden.drawn, false);

  const shown = fakeNaip();
  shown.state = () => ({
    year: 2018,
    enabled: true,
    compare: false,
    layers: [{ key: 'both:hires-2018', side: 'both', show: true }],
  });
  const visible = await voice({ naip: shown }).api.year({ year: 2018 });
  assert.equal(visible.compare, false);
  assert.equal(visible.drawn, true);
  assert.equal(Object.hasOwn(visible, 'yearB'), false);
});

test('compare is on only when yearB is also set', async () => {
  const split = fakeNaip();
  split.state = () => ({
    year: 2018,
    enabled: true,
    compare: true,
    yearB: null,
    layers: [{ key: 'both:hires-2018', show: true }],
  });
  const result = await voice({ naip: split }).api.year({ year: 2018 });
  assert.equal(result.ok, true);
  assert.equal(result.compare, false);
  assert.equal(Object.hasOwn(result, 'yearB'), false);
});

test('year does not claim the layer is drawn when Wayback disable throws', async () => {
  const wb = fakeWayback([{ release: 20, date: '2018-06-15' }]);
  await wb.enable();
  wb.disable = async () => {
    wb.calls.push(['disable']);
    throw new Error(SECRET);
  };
  const covered = fakeNaip();
  covered.state = () => ({
    year: 2018,
    enabled: true,
    compare: false,
    layers: [{ key: 'both:hires-2018', show: true }],
  });
  const { api } = voice({ naip: covered, getWayback: () => wb });
  const result = await api.year({ year: 2018 });
  assert.equal(wb.state().on, true);
  assert.equal(result.ok === true && result.drawn === true, false);
  assert.equal(result.drawn, false);
  assert.equal(result.waybackStillOn, true);
  assert.equal(result.waybackOff, false);
  assert.equal(JSON.stringify(result).includes('sk-synth'), false);
  assert.equal(JSON.stringify(result).includes('Bearer'), false);
});

test('off both keeps aerial false when Wayback disable throws', async () => {
  const wb = fakeWayback([{ release: 20, date: '2018-06-15' }]);
  wb.disable = async () => {
    wb.calls.push(['disable']);
    throw new Error(SECRET);
  };
  const { api, naip } = voice({ getWayback: () => wb });
  const result = await api.off({ target: 'both' });
  assert.equal(result.ok, false);
  assert.equal(result.aerial, false);
  assert.equal(result.error, 'Wayback could not be turned off');
  assert.deepEqual(naip.calls.at(-1), ['setEnabled', false]);
  assert.equal(JSON.stringify(result).includes('sk-synth'), false);
});

test('wayback does not settle while enable is still starting', async () => {
  const rows = [{ release: 20, date: '2018-06-15' }];
  const wb = fakeWayback(rows);
  let on = true;
  let ready = false;
  wb.state = () => ({
    on,
    ready,
    date: rows[0].date,
    index: 0,
  });
  let finish;
  wb.enable = () =>
    new Promise((resolve) => {
      wb.calls.push(['enable']);
      finish = () => {
        ready = true;
        resolve(true);
      };
    });
  const { api } = voice({ getWayback: () => wb });
  const pending = api.wayback({ date: '2018' });
  await Promise.resolve();
  assert.equal(
    wb.calls.some((call) => call[0] === 'settleNow'),
    false,
  );
  finish();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.on, true);
  assert.equal(result.starting, undefined);
  assert.equal(
    wb.calls.some((call) => call[0] === 'settleNow'),
    false,
  );
});

test('wayback reports starting when enable stays unready', async () => {
  const rows = [{ release: 20, date: '2018-06-15' }];
  const wb = fakeWayback(rows);
  wb.state = () => ({
    on: true,
    ready: false,
    date: rows[0].date,
    index: 0,
  });
  wb.enable = async () => {
    wb.calls.push(['enable']);
    return false;
  };
  const { api } = voice({ getWayback: () => wb });
  const result = await api.wayback({ date: '2018' });
  assert.equal(result.ok, true);
  assert.equal(result.starting, true);
  assert.equal(result.on, false);
  assert.equal(result.date, '2018-06-15');
  assert.equal(
    wb.calls.some((call) => call[0] === 'settleNow'),
    false,
  );
  assert.equal(JSON.stringify(result).includes('sk-synth'), false);
});

test('status reports the catalog years and wayback availability', async () => {
  const wb = fakeWayback([{ release: 20, date: '2018-06-15' }]);
  const { api } = voice({ getWayback: () => wb });
  const result = await api.status();
  assert.equal(result.ok, true);
  assert.deepEqual(result.years, [1940, 2018, 2024]);
  assert.equal(result.wayback.available, true);
  assert.deepEqual(result.wayback.years, [2018]);
});

test('ensureByrditOpen fails when the controller falls back to another stack', async () => {
  let id = 'photoreal';
  const landed = await ensureByrditOpen({
    getActiveId: () => id,
    setStack: async (next) => {
      id = next;
    },
  });
  assert.deepEqual(landed, { ok: true, switched: true });
  const fallback = await ensureByrditOpen({
    getActiveId: () => 'esri-imagery',
    setStack: async () => {},
  });
  assert.equal(fallback.ok, false);
  assert.match(fallback.error, /Byrd-IT Open/);
  const thrown = await ensureByrditOpen({
    getActiveId: () => 'photoreal',
    setStack: async () => {
      throw new Error(SECRET);
    },
  });
  assert.equal(thrown.ok, false);
  assert.equal(JSON.stringify(thrown).includes('sk-synth'), false);
});

test('flyToImageryBounds rejects bad bounds and does not move the camera', () => {
  const flown = [];
  const viewer = { camera: { flyTo: (opts) => flown.push(opts) } };
  const Cesium = { Rectangle: { fromDegrees: (...nums) => nums } };
  assert.equal(flyToImageryBounds(viewer, Cesium, null), false);
  assert.equal(flyToImageryBounds(viewer, Cesium, [1, 2, 3]), false);
  assert.equal(flyToImageryBounds(viewer, Cesium, [1, 2, 3, 'east']), false);
  assert.equal(flyToImageryBounds({}, Cesium, [-95, 32, -94, 33]), false);
  assert.equal(flown.length, 0);
  assert.equal(flyToImageryBounds(viewer, Cesium, [-95, 32, -94, 33]), true);
  assert.equal(flown.length, 1);
});

test('wayback already on settles now instead of enabling again', async () => {
  const wb = fakeWayback([{ release: 20, date: '2018-06-15' }]);
  const inner = wb.state.bind(wb);
  wb.state = () => ({ ...inner(), on: true });
  const { api } = voice({ getWayback: () => wb });
  const result = await api.wayback({ date: '2018' });
  assert.equal(result.ok, true);
  assert.deepEqual(
    wb.calls.map((call) => call[0]),
    ['setIndex', 'settleNow'],
  );
});

test('wayback enable false is a fixed error', async () => {
  const wb = fakeWayback([{ release: 20, date: '2018-06-15' }]);
  wb.enable = async () => {
    wb.calls.push(['enable']);
    return false;
  };
  const { api } = voice({ getWayback: () => wb });
  const result = await api.wayback({ date: '2018' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Wayback could not be turned on');
  assert.equal(result.on, undefined);
});
