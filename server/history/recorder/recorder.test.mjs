import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRecorder, NOOP_RECORDER } from './index.js';
import { ADAPTERS } from './adapters/index.js';
import firms, { toRecords } from './adapters/firms.js';
import { T0, fire, firmsPayload, recorderConfig, stubStore } from './fixtures.mjs';

const make = (options = {}) => {
  const store = options.store ?? stubStore();
  const warnings = [];
  const recorder = createRecorder({
    store,
    config: recorderConfig(options.config),
    adapters: ADAPTERS,
    clock: () => T0,
    warn: (message) => warnings.push(message),
  });
  return { recorder, store, warnings };
};

describe('firms adapter', () => {
  it('maps a detection to a keyed, timed, whitelisted record', () => {
    const [record] = toRecords(firmsPayload([fire()]));
    assert.equal(record.id, 'VIIRS:N20:30.1235:-97.7654');
    assert.equal(record.t, Date.UTC(2026, 9, 31, 11, 30));
    assert.equal(record.lat, 30.1234567);
    assert.deepEqual(Object.keys(record.props).sort(), [...firms.fields].sort());
  });

  it('drops fields outside the whitelist, even ones that look sensitive', () => {
    const [record] = toRecords(
      firmsPayload([fire({ api_key: 'k', url: 'https://u:p@h/?api_key=k', headers: { a: 1 } })]),
    );
    assert.equal(JSON.stringify(record).includes('api_key'), false);
    assert.equal(JSON.stringify(record).includes('u:p'), false);
  });

  it('skips detections it cannot place or time', () => {
    const records = toRecords(
      firmsPayload([fire({ lat: NaN }), fire({ acqDate: 'nope' }), fire({ acqTime: '9999' }), fire()]),
    );
    assert.equal(records.length, 1);
  });

  it('tolerates a payload with no fires', () => {
    assert.deepEqual(toRecords({}), []);
    assert.deepEqual(toRecords(null), []);
  });

  it('declares its cadence and mode', () => {
    assert.equal(firms.mode, 'view-driven');
    assert.equal(firms.cadenceMs, 1_800_000);
  });
});

describe('recorder', () => {
  it('writes a poll in a batch and logs the poll', async () => {
    const { recorder, store } = make();
    const result = recorder.tap('firms', firmsPayload([fire(), fire({ lat: 31 })]));
    assert.deepEqual(result, { queued: 2, skipped: 0 });
    assert.equal(store.appended.length, 0, 'nothing is written on the request path');
    await recorder.flush();
    assert.equal(store.appended[0].rows.length, 2);
    assert.deepEqual(store.ingests, [{ feed: 'firms', t: T0, ok: true, count: 2 }]);
    assert.deepEqual(Object.keys(store.appended[0].rows[0]).sort(), ['data', 'key', 'lat', 'lon', 't']);
  });

  it('is idempotent: tapping the same payload again writes no new rows', async () => {
    const { recorder, store } = make();
    recorder.tap('firms', firmsPayload([fire()]));
    await recorder.flush();
    const again = recorder.tap('firms', firmsPayload([fire()], T0 + 1000));
    assert.deepEqual(again, { queued: 0, skipped: 1 });
    await recorder.flush();
    assert.equal(store.appended.length, 1);
    assert.equal(store.ingests.length, 2, 'the second poll is still logged');
    assert.equal(recorder.health().skipped, 1);
  });

  it('skips an unchanged entity seen again inside the minimum interval', async () => {
    const { recorder, store } = make();
    recorder.tap('firms', firmsPayload([fire({ acqTime: '1130' })]));
    await recorder.flush();
    const near = recorder.tap('firms', firmsPayload([fire({ acqTime: '1140' })]));
    assert.equal(near.queued, 0);
    const later = recorder.tap('firms', firmsPayload([fire({ acqTime: '1230' })]));
    assert.equal(later.queued, 1);
    const changed = recorder.tap('firms', firmsPayload([fire({ acqTime: '1135', frp: 99 })]));
    assert.equal(changed.queued, 1, 'a changed value is never skipped');
    await recorder.flush();
    assert.equal(store.appended.length, 3);
  });

  it('a zero interval keeps every distinct observation', async () => {
    const { recorder } = make({ config: { feeds: { firms: { record: true, minIntervalMs: 0 } } } });
    recorder.tap('firms', firmsPayload([fire({ acqTime: '1130' })]));
    await recorder.flush();
    assert.equal(recorder.tap('firms', firmsPayload([fire({ acqTime: '1131' })])).queued, 1);
  });

  it('does not mark rows as stored until the store took them', async () => {
    const store = stubStore({ fail: true });
    const { recorder, warnings } = make({ store });
    recorder.tap('firms', firmsPayload([fire()]));
    await recorder.flush();
    assert.equal(recorder.health().failedFlushes, 1);
    store.fail = false;
    assert.equal(recorder.tap('firms', firmsPayload([fire()])).queued, 1, 'sent again after the failure');
    await recorder.flush();
    assert.equal(store.appended.length, 1);
    assert.equal(warnings.length, 1);
  });

  it('a store failure is logged by feed and code only', async () => {
    const { recorder, warnings } = make({ store: stubStore({ fail: true }) });
    recorder.tap('firms', firmsPayload([fire()]));
    await recorder.flush();
    assert.equal(warnings[0], '[history-recorder] firms write failed (BACKEND)');
    assert.equal(warnings.join('').includes('/secret/path'), false);
  });

  it('drops the oldest poll when the queue is full and counts it', async () => {
    const { recorder, store } = make({ config: { queueRows: 1_000 } });
    const poll = (offset) =>
      firmsPayload(Array.from({ length: 600 }, (_, i) => fire({ lat: offset + i / 1000 })));
    recorder.tap('firms', poll(10));
    recorder.tap('firms', poll(20));
    const health = recorder.health();
    assert.equal(health.dropped, 600);
    assert.equal(health.queueRows, 600);
    await recorder.flush();
    assert.equal(store.appended.length, 1);
    assert.ok(store.appended[0].rows[0].lat >= 20, 'the newer poll survived');
    assert.equal(store.ingests.length, 1, 'a dropped poll leaves no ingest row, so it reads as a gap');
  });

  it('drops a poll larger than the whole queue', () => {
    const { recorder } = make({ config: { queueRows: 1_000 } });
    const big = firmsPayload(Array.from({ length: 1_500 }, (_, i) => fire({ lat: i / 100 })));
    assert.equal(recorder.tap('firms', big).queued, 0);
    assert.equal(recorder.health().dropped, 1_500);
  });

  it('warns once per feed, without payload, when one poll exceeds the whole queue', () => {
    const { recorder, warnings } = make({ config: { queueRows: 1_000 } });
    const big = firmsPayload(Array.from({ length: 1_500 }, (_, i) => fire({ lat: i / 100, satellite: 'api_key=zzz' })));
    recorder.tap('firms', big);
    recorder.tap('firms', big);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /firms poll of 1500 rows is larger than HISTORY_RECORD_QUEUE_ROWS \(1000\)/);
    assert.equal(warnings[0].includes('zzz'), false);
  });

  it('lets other work run between write chunks', async () => {
    const { recorder } = make({ config: { queueRows: 100_000 } });
    recorder.tap('firms', firmsPayload(Array.from({ length: 12_000 }, (_, i) => fire({ lat: (i % 9000) / 100, lon: Math.floor(i / 9000) }))));
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 0);
    await recorder.flush();
    clearInterval(timer);
    assert.ok(ticks > 0, 'the event loop ran during the flush');
  });

  it('writes large polls in chunks under the store batch limit', async () => {
    const { recorder, store } = make({ config: { queueRows: 100_000 } });
    recorder.tap('firms', firmsPayload(Array.from({ length: 12_000 }, (_, i) => fire({ lat: (i % 9000) / 100, lon: Math.floor(i / 9000) }))));
    await recorder.flush();
    assert.deepEqual(store.appended.map((a) => a.rows.length), [2000, 2000, 2000, 2000, 2000, 2000]);
    assert.equal(store.ingests[0].count, 12_000);
  });

  it('records a failed poll as a failure with no rows', async () => {
    const { recorder, store } = make();
    recorder.tapFailure('firms', { t: T0 });
    await recorder.flush();
    assert.deepEqual(store.ingests, [{ feed: 'firms', t: T0, ok: false, count: 0 }]);
  });

  it('never throws into the caller when an adapter fails', () => {
    const throwing = { firms: { toRecords: () => { throw new Error('payload had api_key=abc'); } } };
    const recorder = createRecorder({ store: stubStore(), config: recorderConfig(), adapters: throwing, warn() {} });
    assert.deepEqual(recorder.tap('firms', {}), { error: 'adapter' });
    assert.equal(recorder.health().adapterErrors, 1);
  });

  it('ignores a feed that is not switched on', async () => {
    const { recorder, store } = make({ config: { feeds: { firms: { record: false, minIntervalMs: 0 } } } });
    assert.deepEqual(recorder.tap('firms', firmsPayload([fire()])), { skipped: 'disabled' });
    assert.deepEqual(recorder.tap('aircraft', {}), { skipped: 'disabled' });
    await recorder.flush();
    assert.equal(store.appended.length, 0);
  });

  it('close() flushes what is queued, then ignores later taps', async () => {
    const { recorder, store } = make();
    recorder.tap('firms', firmsPayload([fire()]));
    await recorder.close();
    assert.equal(store.appended.length, 1);
    assert.deepEqual(recorder.tap('firms', firmsPayload([fire({ lat: 40 })])), { skipped: 'disabled' });
  });

  it('flushes on its timer', async () => {
    const { recorder, store } = make({ config: { flushMs: 10 } });
    recorder.start();
    recorder.tap('firms', firmsPayload([fire()]));
    await new Promise((resolve) => setTimeout(resolve, 80));
    await recorder.close();
    assert.equal(store.appended.length, 1);
  });
});

describe('disabled recorder', () => {
  it('is a no-op that answers at once', async () => {
    assert.equal(NOOP_RECORDER.enabled, false);
    assert.deepEqual(NOOP_RECORDER.tap('firms', firmsPayload([fire()])), { skipped: 'disabled' });
    assert.deepEqual(NOOP_RECORDER.health(), { enabled: false });
    await NOOP_RECORDER.close();
  });

  it('treats an entity that moved as changed even when its other fields did not', async () => {
    const store = stubStore();
    const adapters = { firms: { feed: 'firms', toRecords: (p) => p.records } };
    const moving = createRecorder({
      store,
      config: recorderConfig({ feeds: { firms: { record: true, minIntervalMs: 60_000 } } }),
      adapters,
      clock: () => T0,
      warn() {},
    });
    const at = (t, lat) => ({ records: [{ id: 'k', t, lat, lon: 2, props: { a: 1 } }] });
    moving.tap('firms', at(T0, 10));
    await moving.flush();
    moving.tap('firms', at(T0 + 1000, 10)); // same place, same fields: skipped
    await moving.flush();
    moving.tap('firms', at(T0 + 2000, 11)); // moved: kept
    await moving.flush();
    assert.deepEqual(store.appended.flatMap((a) => a.rows.map((r) => r.lat)), [10, 11]);
  });
});
