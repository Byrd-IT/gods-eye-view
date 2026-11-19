import test from 'node:test';
import assert from 'node:assert/strict';
import { createSkyVoice } from './skyVoice.js';
import { createSkyClock } from './skyClock.js';

test('sky voice operates real clock and refuses history ownership', async () => {
  const clock = createSkyClock({
    now: () => Date.parse('2026-01-01T00:00:00Z'),
  });
  const sky = {
    active: true,
    clock,
    time: { provider: 'builtin', getTime: clock.getTime },
  };
  const voice = createSkyVoice({ getHandle: () => sky });
  assert.equal((await voice.playback('speed', 3600)).rate, 3600);
  assert.equal((await voice.playback('play')).playing, true);
  assert.equal((await voice.playback('reverse')).rate, -3600);
  sky.time.provider = 'history';
  assert.equal((await voice.playback('pause')).ok, false);
  assert.equal(clock.playing, true);
});
