import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HISTORY_FEEDS, HistoryConfigError } from '../config.js';
import { ADAPTERS } from './adapters/index.js';
import { loadRecorderConfig, recordingRequested } from './config.js';

// Feeds that record from HISTORY_RECORD=1 alone: every adapter except the heavy ones, in settings order.
const light = HISTORY_FEEDS.filter((feed) => ADAPTERS[feed] && ADAPTERS[feed].defaultOn !== false);
const without = (...names) => light.filter((feed) => !names.includes(feed));
const load = (env, available) => loadRecorderConfig(env, { adapters: ADAPTERS, available });
const problems = (env, available) => {
  try {
    load(env, available);
  } catch (error) {
    assert.ok(error instanceof HistoryConfigError);
    return error.problems;
  }
  assert.fail('expected a configuration error');
};

describe('recorder configuration', () => {
  it('is off by default', () => {
    assert.equal(recordingRequested({}), false);
    assert.equal(recordingRequested({ HISTORY_RECORD: '  ' }), false);
    assert.deepEqual(load({}).active, []);
  });

  it('HISTORY_RECORD=1 turns on every feed that has an adapter', () => {
    assert.equal(recordingRequested({ HISTORY_RECORD: '1' }), true);
    assert.deepEqual(load({ HISTORY_RECORD: '1' }).active, light);
  });

  it('a heavy feed records only when it is named, never from HISTORY_RECORD=1', () => {
    assert.equal(load({ HISTORY_RECORD: '1' }).feeds.aircraft.record, false);
    assert.deepEqual(load({ HISTORY_RECORD_AIRCRAFT: '1' }).active, ['aircraft']);
    assert.deepEqual(load({ HISTORY_RECORD: '1', HISTORY_RECORD_AIRCRAFT: '1' }).active, ['aircraft', ...light]);
  });

  it('a per-feed setting overrides the global one', () => {
    assert.deepEqual(load({ HISTORY_RECORD: '1', HISTORY_RECORD_FIRMS: '0' }).active, without('firms'));
    assert.deepEqual(load({ HISTORY_RECORD_FIRMS: '1' }).active, ['firms']);
  });

  it('defaults the minimum interval to the feed cadence and honours overrides', () => {
    assert.equal(load({ HISTORY_RECORD: '1' }).feeds.firms.minIntervalMs, 1_800_000);
    assert.equal(load({ HISTORY_RECORD: '1', HISTORY_MIN_INTERVAL_S: '60' }).feeds.firms.minIntervalMs, 60_000);
    assert.equal(
      load({ HISTORY_RECORD: '1', HISTORY_MIN_INTERVAL_S: '60', HISTORY_MIN_INTERVAL_S_FIRMS: '0' }).feeds.firms.minIntervalMs,
      0,
    );
  });

  it('reads queue and flush settings', () => {
    const config = load({ HISTORY_RECORD: '1', HISTORY_RECORD_QUEUE_ROWS: '5000', HISTORY_RECORD_FLUSH_S: '2' });
    assert.equal(config.queueRows, 5000);
    assert.equal(config.flushMs, 2000);
    assert.equal(load({}).queueRows, 200_000);
  });

  it('rejects bad values without quoting them', () => {
    const found = problems({
      HISTORY_RECORD: 'maybe-sk-abc123',
      HISTORY_MIN_INTERVAL_S: '-5',
      HISTORY_RECORD_QUEUE_ROWS: '3',
      HISTORY_RECORD_FLUSH_S: '0',
    });
    assert.equal(found.length, 4);
    assert.equal(found.join('\n').includes('sk-abc123'), false);
  });

  it('rejects a feed with no adapter and a misspelled feed', () => {
    assert.match(problems({ HISTORY_RECORD_WATER: '1' })[0], /no recorder adapter for water/);
    assert.match(problems({ HISTORY_RECORD_FIRM: '1' })[0], /names no known feed/);
    assert.match(problems({ HISTORY_RECORD_QUEUE: '1' })[0], /names no known feed/);
  });

  it('rejects a backend that cannot take new records', () => {
    const env = { HISTORY_RECORD: '1', HISTORY_STORE_FIRMS: 'elasticsearch' };
    const options = { adapters: ADAPTERS, available: ['sqlite', 'elasticsearch'], appendBackends: ['sqlite'] };
    assert.throws(() => loadRecorderConfig(env, options), /firms is set to record, but its backend cannot take new records/);
    assert.deepEqual(loadRecorderConfig(env, { ...options, appendBackends: ['sqlite', 'elasticsearch'] }).active, light);
    assert.match(problems({ HISTORY_RECORD: '1', HISTORY_STORE_FIRMS: 'live' })[0], /HISTORY_STORE_FIRMS must be one of/);
  });

  it('still reports unknown HISTORY_* names', () => {
    assert.match(problems({ HISTORY_RECORD: '1', HISTORY_RECORDD: '1' })[0], /not a history setting/);
  });
});
