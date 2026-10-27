import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageryVoice, countyLabels } from './imageryVoice.js';

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

test('status reports the catalog years and wayback availability', async () => {
  const wb = fakeWayback([{ release: 20, date: '2018-06-15' }]);
  const { api } = voice({ getWayback: () => wb });
  const result = await api.status();
  assert.equal(result.ok, true);
  assert.deepEqual(result.years, [1940, 2018, 2024]);
  assert.equal(result.wayback.available, true);
  assert.deepEqual(result.wayback.years, [2018]);
});
