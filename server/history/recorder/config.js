import {
  HistoryConfigError,
  HISTORY_FEEDS,
  loadHistoryConfig,
} from '../config.js';

/** Backends that can take `append`. A read-only backend is refused at boot. */
export const APPEND_BACKENDS = Object.freeze(['sqlite', 'elasticsearch']);

export const DEFAULT_QUEUE_ROWS = 200_000;
export const MIN_QUEUE_ROWS = 1_000;
export const MAX_QUEUE_ROWS = 2_000_000;
export const DEFAULT_FLUSH_S = 5;
export const MAX_FLUSH_S = 300;
export const MAX_MIN_INTERVAL_S = 24 * 3600;

const text = (env, name) => {
  const value = env[name];
  return typeof value === 'string' ? value.trim() : '';
};

/** True when any HISTORY_RECORD* variable is set; the only trigger for recorder setup. */
export function recordingRequested(env = process.env) {
  return Object.keys(env).some(
    (name) => name.startsWith('HISTORY_RECORD') && text(env, name) !== '',
  );
}

function parseFlag(env, name, problems) {
  const raw = text(env, name).toLowerCase();
  if (raw === '') return null;
  if (['1', 'true', 'on', 'yes'].includes(raw)) return true;
  if (['0', 'false', 'off', 'no'].includes(raw)) return false;
  problems.push(`${name} must be 1 or 0.`);
  return null;
}

function parseWhole(env, name, [min, max], unit, problems) {
  const raw = text(env, name);
  if (raw === '') return null;
  const value = /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(value) || value < min || value > max) {
    problems.push(
      `${name} must be a whole number of ${unit} from ${min} to ${max}.`,
    );
    return null;
  }
  return value;
}

/**
 * Read and validate the recorder settings. Pure. Collects every problem before
 * it throws, and never quotes a configured value.
 *
 *   HISTORY_RECORD=1               record every feed that has an adapter, except heavy ones
 *                                  (aircraft, vessels), which must be named; default off
 *   HISTORY_RECORD_<FEED>=1|0      switch one feed on or off, overriding HISTORY_RECORD
 *   HISTORY_MIN_INTERVAL_S[_<FEED>] skip an unchanged entity seen again within this many
 *                                  seconds (default: the feed's cadence; 0 keeps every one)
 *   HISTORY_RECORD_QUEUE_ROWS      rows held while the store is busy (default 200000)
 *   HISTORY_RECORD_FLUSH_S         seconds between batched writes (default 5)
 *
 * @param {Record<string, string|undefined>} env
 * @param {{ adapters: Record<string, {cadenceMs: number}>, available?: readonly string[], appendBackends?: readonly string[] }} options
 */
export function loadRecorderConfig(
  env,
  { adapters, available, appendBackends = APPEND_BACKENDS },
) {
  const problems = [];
  // Re-use the history settings check: unknown HISTORY_* names, bad backends.
  let history;
  try {
    history = loadHistoryConfig(env, available ? { available } : {});
  } catch (error) {
    if (!(error instanceof HistoryConfigError)) throw error;
    problems.push(...error.problems);
  }

  const globalOn = parseFlag(env, 'HISTORY_RECORD', problems) ?? false;
  const globalInterval = parseWhole(
    env,
    'HISTORY_MIN_INTERVAL_S',
    [0, MAX_MIN_INTERVAL_S],
    'seconds',
    problems,
  );
  const queueRows =
    parseWhole(
      env,
      'HISTORY_RECORD_QUEUE_ROWS',
      [MIN_QUEUE_ROWS, MAX_QUEUE_ROWS],
      'rows',
      problems,
    ) ?? DEFAULT_QUEUE_ROWS;
  const flushS =
    parseWhole(
      env,
      'HISTORY_RECORD_FLUSH_S',
      [1, MAX_FLUSH_S],
      'seconds',
      problems,
    ) ?? DEFAULT_FLUSH_S;

  const feeds = {};
  for (const feed of HISTORY_FEEDS) {
    const suffix = feed.toUpperCase();
    const own = parseFlag(env, `HISTORY_RECORD_${suffix}`, problems);
    const interval = parseWhole(
      env,
      `HISTORY_MIN_INTERVAL_S_${suffix}`,
      [0, MAX_MIN_INTERVAL_S],
      'seconds',
      problems,
    );
    const adapter = Object.hasOwn(adapters, feed) ? adapters[feed] : undefined;
    if (own === true && !adapter) {
      problems.push(
        `HISTORY_RECORD_${suffix} is set but this build has no recorder adapter for ${feed} (adapters: ${Object.keys(adapters).join(', ')}).`,
      );
      continue;
    }
    if (!adapter) continue;
    // A heavy feed (adapter.defaultOn === false) records only when named.
    const on = own ?? (adapter.defaultOn === false ? false : globalOn);
    const store = history?.feeds?.[feed]?.store;
    if (on && store && !appendBackends.includes(store)) {
      problems.push(
        `${feed} is set to record, but its backend cannot take new records (backends that can: ${appendBackends.join(', ')}).`,
      );
      continue;
    }
    feeds[feed] = Object.freeze({
      record: on,
      minIntervalMs:
        (interval ?? globalInterval ?? Math.round(adapter.cadenceMs / 1000)) *
        1000,
    });
  }

  if (problems.length) throw new HistoryConfigError(problems);
  return Object.freeze({
    feeds: Object.freeze(feeds),
    active: Object.freeze(
      Object.keys(feeds).filter((feed) => feeds[feed].record),
    ),
    queueRows,
    flushMs: flushS * 1000,
    history,
  });
}
