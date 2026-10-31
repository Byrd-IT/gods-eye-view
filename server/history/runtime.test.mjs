import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HistoryConfigError } from './config.js';
import { createHistoryRuntime, historyRecorderLifecycle } from './runtime.js';
import { ADAPTERS } from './recorder/adapters/index.js';
import { fire, firmsPayload } from './recorder/fixtures.mjs';

describe('history runtime', () => {
  it('opens nothing and creates no file unless recording is on', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'gev-runtime-'));
    try {
      const file = path.join(directory, 'h.sqlite');
      let opened = 0;
      const runtime = createHistoryRuntime(
        { HISTORY_SQLITE_PATH: file },
        { createStore: () => (opened += 1) },
      );
      assert.equal(runtime.recorder.enabled, false);
      assert.equal(runtime.store, null);
      assert.equal(opened, 0);
      assert.equal(existsSync(file), false);
      await runtime.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('waits for the store to open at boot and names a failure without its detail', async () => {
    const warnings = [];
    const store = {
      append: async () => {},
      recordIngest: async () => {},
      prune: async () => {},
      close: async () => {},
      config: {},
      ready: async () => Promise.reject(Object.assign(new Error('password=hunter2'), { code: 'STORE_UNAVAILABLE' })),
    };
    const runtime = createHistoryRuntime(
      { HISTORY_RECORD: '1' },
      { createStore: () => store, warn: (line) => warnings.push(line) },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(warnings, ['[history-recorder] store not ready (STORE_UNAVAILABLE)']);
    await runtime.close();
  });

  it('records into a real SQLite store and closes it after a last flush', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'gev-runtime-'));
    try {
      const file = path.join(directory, 'h.sqlite');
      const runtime = createHistoryRuntime({ HISTORY_RECORD: '1', HISTORY_SQLITE_PATH: file });
      assert.equal(runtime.recorder.enabled, true);
      runtime.recorder.tap('firms', firmsPayload([fire()]));
      const store = runtime.store;
      await runtime.close();
      assert.equal(existsSync(file), true);
      await assert.rejects(() => store.coverage('firms'), /closed/);
      const reopened = createHistoryRuntime({ HISTORY_RECORD: '1', HISTORY_SQLITE_PATH: file });
      const coverage = await reopened.store.coverage('firms');
      assert.equal(coverage.count, 1);
      assert.deepEqual((await reopened.store.ingestLog('firms')).polls.length, 1);
      await reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails the boot on a misspelled setting before opening a store', () => {
    let opened = 0;
    assert.throws(
      () => createHistoryRuntime({ HISTORY_RECORD: '1', HISTORY_RECORD_FIRM: '1' }, { createStore: () => (opened += 1) }),
      HistoryConfigError,
    );
    assert.equal(opened, 0);
  });

  it('refuses a store that cannot take records', () => {
    assert.throws(
      () => createHistoryRuntime({ HISTORY_RECORD: '1' }, { createStore: () => ({ close() {} }) }),
      /cannot take new records/,
    );
  });

  it('stays off when every feed is switched off', () => {
    const off = Object.fromEntries(Object.keys(ADAPTERS).map((feed) => [`HISTORY_RECORD_${feed.toUpperCase()}`, '0']));
    const runtime = createHistoryRuntime({ HISTORY_RECORD: '1', ...off }, { createStore: () => assert.fail('opened') });
    assert.equal(runtime.recorder.enabled, false);
  });

  it('with deferOpen nothing is opened until start(), and a build never starts it', async () => {
    let opened = 0;
    const store = { append: async () => ({}), recordIngest: async () => ({}), prune: async () => ({}), close: async () => {} };
    const runtime = createHistoryRuntime({ HISTORY_RECORD: '1' }, { deferOpen: true, createStore: () => ((opened += 1), store) });
    assert.equal(runtime.recorder.enabled, true);
    assert.equal(runtime.store, null);
    assert.equal(opened, 0);
    const plugin = historyRecorderLifecycle(runtime);
    assert.equal(plugin.apply, 'serve');
    await runtime.close();
    assert.equal(opened, 0, 'closing an unstarted runtime opens nothing');
    const second = createHistoryRuntime({ HISTORY_RECORD: '1' }, { deferOpen: true, createStore: () => ((opened += 1), store) });
    historyRecorderLifecycle(second).configureServer({ httpServer: { once() {} } });
    assert.equal(opened, 1);
    await second.close();
  });

  it('deferOpen still fails the boot on a bad setting', () => {
    assert.throws(() => createHistoryRuntime({ HISTORY_RECORD: '1', HISTORY_RECORD_FIRM: '1' }, { deferOpen: true }), HistoryConfigError);
  });

  it('the lifecycle plugin closes the runtime when the http server closes', async () => {
    let closed = 0;
    let onClose;
    const plugin = historyRecorderLifecycle({ start() {}, close: async () => { closed += 1; } });
    plugin.configureServer({ httpServer: { once: (name, fn) => { assert.equal(name, 'close'); onClose = fn; } } });
    onClose();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, 1);
    assert.doesNotThrow(() => plugin.configureServer({}));
  });
});
