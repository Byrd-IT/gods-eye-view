/**
 * Process-wide history recorder. Nothing is opened, read or created unless a
 * HISTORY_RECORD* variable is set; otherwise `recorder` is the no-op recorder
 * and a tap costs one function call.
 */
import { HistoryConfigError } from './config.js';
import { historyTeePlugin } from './recorder/tee.js';
import { createFeedRoutes } from './recorder/routes.js';
import { loadRecorderConfig, recordingRequested } from './recorder/config.js';
import { ADAPTERS } from './recorder/adapters/index.js';
import { NOOP_RECORDER, createRecorder } from './recorder/index.js';
import { createPollers } from './recorder/poller.js';
import {
  AVAILABLE_BACKENDS,
  applyRetention,
  createHistoryStore,
} from './store/index.js';

const RETENTION_FIRST_RUN_MS = 60_000;
const RETENTION_EVERY_MS = 24 * 3600 * 1000;

const NOOP_RUNTIME = Object.freeze({
  recorder: NOOP_RECORDER,
  store: null,
  pollers: Object.freeze({ feeds: Object.freeze([]) }),
  start() {},
  close: async () => {},
});

/**
 * Validate the settings and, when recording is on, open the store and start the
 * recorder. Throws HistoryConfigError at boot for anything unsupported.
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {{ adapters?: object, fetchImpl?: Function, createStore?: Function, warn?: Function, clock?: () => number }} [options] test seams
 */
export function createHistoryRuntime(env = process.env, options = {}) {
  if (!recordingRequested(env)) return NOOP_RUNTIME;
  const adapters = options.adapters ?? ADAPTERS;
  const createStore = options.createStore ?? createHistoryStore;
  const warn = options.warn ?? console.warn;
  const config = loadRecorderConfig(env, {
    adapters,
    available: AVAILABLE_BACKENDS,
  });
  if (config.active.length === 0) return NOOP_RUNTIME;

  let store = null;
  const openStore = () => {
    if (store) return store;
    const opened = createStore(env);
    for (const method of ['append', 'recordIngest', 'prune']) {
      if (typeof opened[method] !== 'function') {
        Promise.resolve(opened.close?.()).catch(() => {});
        throw new HistoryConfigError([
          'The history store cannot take new records, so recording is refused.',
        ]);
      }
    }
    store = opened;
    return store;
  };
  // With deferOpen the store is opened by start(), not at construction, so a
  // build that only lists the plugins never opens a file or starts a timer.
  const lazyStore = {
    append: (...args) => openStore().append(...args),
    recordIngest: (...args) => openStore().recordIngest(...args),
  };
  if (!options.deferOpen) openStore();
  const recorder = createRecorder({
    store: options.deferOpen ? lazyStore : store,
    config,
    adapters,
    warn,
    clock: options.clock,
  });

  // Feeds nothing else sees get a poller; it is empty unless one is switched on.
  const pollers = createPollers({
    recorder,
    adapters,
    feeds: config.active,
    fetchImpl: options.fetchImpl,
    warn,
    clock: options.clock,
  });

  let first = null;
  let daily = null;
  let started = false;
  // Retention is the store's housekeeping, run only while recording.
  const prune = () => {
    applyRetention(openStore(), openStore().config).catch((error) => {
      warn(`[history-recorder] retention failed (${error?.code ?? 'error'})`);
    });
  };
  function start() {
    if (started) return;
    started = true;
    openStore();
    recorder.start();
    pollers.start();
    first = setTimeout(prune, RETENTION_FIRST_RUN_MS);
    daily = setInterval(prune, RETENTION_EVERY_MS);
    first.unref?.();
    daily.unref?.();
  }
  if (!options.deferOpen) start();

  let closing = null;
  return {
    recorder,
    pollers,
    get store() {
      return store;
    },
    start,
    close() {
      closing ??= (async () => {
        clearTimeout(first);
        clearInterval(daily);
        await pollers.stop();
        await recorder.close();
        await store?.close();
      })();
      return closing;
    },
  };
}

let shared = null;

/** The runtime for process.env, created on first use and shared by every provider. */
export function getHistoryRuntime() {
  shared ??= createHistoryRuntime(process.env, { deferOpen: true });
  return shared;
}

/** The shared recorder: the no-op recorder unless recording was switched on. */
export function getHistoryRecorder() {
  return getHistoryRuntime().recorder;
}

/**
 * Vite plugin that opens the store when a dev or preview server starts and closes it,
 * after one last flush, when that server stops. `vite build` never starts it.
 */
export function historyRecorderLifecycle(runtime = getHistoryRuntime()) {
  const install = (server) => {
    runtime.start();
    server.httpServer?.once('close', () => {
      runtime.close().catch(() => {});
    });
  };
  return {
    name: 'history-recorder',
    apply: 'serve',
    configureServer: install,
    configurePreviewServer: install,
  };
}

/**
 * Vite plugin: watches the proxy routes of the feeds that record (see
 * recorder/routes.js) and hands each answer to the recorder. List it before the
 * providers. With recording off it registers nothing.
 */
export function historyResponseTee(runtime = getHistoryRuntime()) {
  const plugin = historyTeePlugin({
    recorder: runtime.recorder,
    routes: createFeedRoutes(),
  });
  if (runtime.recorder.enabled) return plugin;
  // Off: the same two hooks (every provider plugin has both), but mounts nothing.
  return { ...plugin, configureServer() {}, configurePreviewServer() {} };
}
