import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageryVoice } from '../byrdit/basemap/imageryVoice.js';
import { createHistoryVoice } from '../byrdit/historyUi/historyVoice.js';
import { createSkyVoice } from '../byrdit/skyView/skyVoice.js';

async function rejectsWith(result, error) {
  const actual = await result;
  assert.equal(actual.ok, false);
  assert.equal(actual.error, error);
}

test('imagery owner failure branches never claim success', async () => {
  const state = {
    year: 2018,
    yearB: 2018,
    compare: false,
    ticks: [2018, 2024],
    layers: [],
  };
  const naip = {
    state: () => state,
    setCompare() {},
    setYearB() {},
    setYear() {},
    step() {},
  };
  const archive = {
    catalog: () => [],
    latest() {},
    step() {},
    state: () => ({ on: true, ready: true }),
    transport: () => ({ start: () => false, setPlaybackRate: () => false }),
  };
  const voice = createImageryVoice({
    getNaip: () => naip,
    getCatalog: () => ({
      years: [{ year: 2018 }, { year: 2024 }],
      regional: [],
    }),
    getWayback: () => archive,
  });
  await rejectsWith(
    voice.compare({ enabled: 'untrusted' }),
    'Choose compare on or off and an available second year',
  );
  await rejectsWith(
    voice.compare({ enabled: true }),
    'Compare could not be set',
  );
  await rejectsWith(
    voice.yearB({ yearB: 1900 }),
    'Choose an available second year',
  );
  await rejectsWith(
    voice.yearB({ yearB: 2024 }),
    'Second year could not be set',
  );
  state.ticks = [];
  await rejectsWith(voice.move({ delta: 1 }), 'No aerial years are available');
  state.ticks = [2018, 2024];
  await rejectsWith(
    voice.move({ delta: 'untrusted' }),
    'step needs an integer direction and available control',
  );
  await rejectsWith(
    voice.move({ latest: true }),
    'Latest year could not be set',
  );
  await rejectsWith(
    voice.move({ target: 'untrusted' }),
    'Choose aerial or wayback',
  );
  await rejectsWith(
    createImageryVoice().move({ target: 'wayback', latest: true }),
    'Wayback is not available right now',
  );
  await rejectsWith(
    voice.move({ target: 'wayback', delta: 'untrusted' }),
    'step needs an integer direction',
  );
  await rejectsWith(voice.transport({ action: 'play' }), 'Wayback cannot play');
  await rejectsWith(
    voice.transport({ action: 'speed', rate: 3 }),
    'Wayback speed must be 1, 2 or 4',
  );
  await rejectsWith(
    voice.transport({ action: 'other' }),
    'Unknown Wayback playback action',
  );
  const unavailable = createImageryVoice({
    getWayback: () => ({ state: () => ({ on: false }) }),
  });
  await rejectsWith(
    unavailable.transport({ action: 'play' }),
    'Wayback playback is not available right now',
  );
});

test('history owner failure branches never claim success', async () => {
  const handle = {
    setPreset() {},
    expand() {},
    getState: () => ({ preset: '1h', expanded: false }),
  };
  const clocks = { row: () => ({}), setLocked() {}, isLocked: () => false };
  const voice = createHistoryVoice({
    getHandle: () => handle,
    getClocks: () => clocks,
  });
  await rejectsWith(voice.preset('untrusted'), 'Unknown History window preset');
  await rejectsWith(voice.preset('24h'), 'History preset did not change');
  await rejectsWith(
    voice.expand('untrusted'),
    'expanded must be true or false',
  );
  await rejectsWith(voice.expand(true), 'History panel did not change');
  await rejectsWith(voice.lock('flights', true), 'History lock did not change');
});

test('sky owner failure branches never claim success', async () => {
  const sky = {
    active: true,
    time: { provider: 'builtin' },
    clock: { play: () => false },
    content: { flags: {}, setFlags() {}, setUserLimit() {} },
    setNakedEye() {},
    nakedEye: {},
    enterAt: async () => false,
    clearView: { on: false, set() {} },
  };
  const voice = createSkyVoice({ getHandle: () => sky });
  sky.time.provider = 'history';
  await rejectsWith(
    voice.playback('play'),
    'History is setting the Sky time. Leave History first.',
  );
  sky.time.provider = 'builtin';
  await rejectsWith(
    voice.playback('play'),
    'Sky playback action could not be applied',
  );
  await rejectsWith(
    voice.layers('untrusted', true),
    'A valid Sky layer and enabled true or false are required',
  );
  await rejectsWith(voice.layers('stars', true), 'Sky layer did not change');
  await rejectsWith(
    voice.magnitude('untrusted'),
    'Choose a valid magnitude and target',
  );
  await rejectsWith(
    voice.magnitude(5, 'stars'),
    'Star magnitude did not change',
  );
  await rejectsWith(
    voice.magnitude(5, 'satellites'),
    'Satellite magnitude did not change',
  );
  await rejectsWith(
    voice.location('untrusted', -95),
    'location needs valid latitude and longitude',
  );
  await rejectsWith(voice.location(32, -95), 'Sky location could not be set');
  await rejectsWith(
    voice.clear('untrusted'),
    'clear needs enabled true or false',
  );
  await rejectsWith(voice.clear(true), 'Sky clear view did not change');
});
