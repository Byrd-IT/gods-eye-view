import { DEFAULT_SQLITE_PATH, HistoryStoreError } from './store/common.js';

/** Feeds history can be kept for. A typo in HISTORY_STORE_<FEED> is a boot error. */
export const HISTORY_FEEDS = Object.freeze([
  'aircraft',
  'military',
  'vessels',
  'transit',
  'bikeshare',
  'firms',
  'perimeters',
  'cyclones',
  'launches',
  'water',
]);

/** Every backend name the settings recognise. A build supplies which ones it implements. */
export const KNOWN_BACKENDS = Object.freeze(['sqlite', 'elasticsearch']);

export const DEFAULT_BACKEND = 'sqlite';
export const DEFAULT_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 3650;

const STORE_PREFIX = 'HISTORY_STORE_';
const RETENTION_PREFIX = 'HISTORY_RETENTION_DAYS_';

export class HistoryConfigError extends HistoryStoreError {
  /** @param {string[]} problems one sentence per problem; none quotes a configured value */
  constructor(problems) {
    super(
      'CONFIG',
      `Invalid history configuration:\n- ${problems.join('\n- ')}`,
    );
    this.name = 'HistoryConfigError';
    this.problems = problems;
  }
}

function text(env, name) {
  const value = env[name];
  return typeof value === 'string' ? value.trim() : '';
}

function parseBackend(env, name, available, problems) {
  const raw = text(env, name).toLowerCase();
  if (raw === '') return null;
  if (!KNOWN_BACKENDS.includes(raw)) {
    problems.push(`${name} must be one of: ${KNOWN_BACKENDS.join(', ')}.`);
    return null;
  }
  if (!available.includes(raw)) {
    problems.push(
      `${name} selects a backend this build does not provide (available: ${available.join(', ')}).`,
    );
    return null;
  }
  return raw;
}

function parseRetention(env, name, problems) {
  const raw = text(env, name);
  if (raw === '') return null;
  const days = /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(days) || days > MAX_RETENTION_DAYS) {
    problems.push(
      `${name} must be a whole number of days from 0 to ${MAX_RETENTION_DAYS} (0 keeps history forever).`,
    );
    return null;
  }
  return days;
}

/**
 * Read and validate the history settings. Pure: takes the environment, touches
 * nothing. Collects every problem before throwing so one boot shows them all.
 *
 *   HISTORY_STORE                 default backend (sqlite | elasticsearch); sqlite when unset
 *   HISTORY_STORE_<FEED>          backend for one feed, e.g. HISTORY_STORE_AIRCRAFT
 *   HISTORY_RETENTION_DAYS        default retention in days (30); 0 keeps everything
 *   HISTORY_RETENTION_DAYS_<FEED> retention for one feed
 *   HISTORY_SQLITE_PATH           SQLite file (./data/history.sqlite)
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {{ feeds?: readonly string[], available?: readonly string[] }} [options]
 */
export function loadHistoryConfig(env = process.env, options = {}) {
  const feeds = options.feeds ?? HISTORY_FEEDS;
  const available = options.available ?? ['sqlite'];
  const problems = [];
  const warnings = [];

  const defaultStore =
    parseBackend(env, 'HISTORY_STORE', available, problems) ?? DEFAULT_BACKEND;
  const defaultRetention =
    parseRetention(env, 'HISTORY_RETENTION_DAYS', problems) ??
    DEFAULT_RETENTION_DAYS;

  const known = new Set(feeds.map((feed) => feed.toUpperCase()));
  for (const name of Object.keys(env)) {
    for (const prefix of [STORE_PREFIX, RETENTION_PREFIX]) {
      if (
        name.startsWith(prefix) &&
        !known.has(name.slice(prefix.length)) &&
        text(env, name) !== ''
      ) {
        // A variable name is echoed only when it looks like one, so a stray
        // value that was exported under an odd name is never repeated back.
        const shown = /^[A-Z0-9_]{1,64}$/.test(name)
          ? name
          : `${prefix}<unrecognised>`;
        problems.push(
          `${shown} names no known feed (known: ${feeds.join(', ')}).`,
        );
      }
    }
  }

  const perFeed = {};
  for (const feed of feeds) {
    const suffix = feed.toUpperCase();
    perFeed[feed] = Object.freeze({
      store:
        parseBackend(env, STORE_PREFIX + suffix, available, problems) ??
        defaultStore,
      retentionDays:
        parseRetention(env, RETENTION_PREFIX + suffix, problems) ??
        defaultRetention,
    });
  }

  const sqlitePath = text(env, 'HISTORY_SQLITE_PATH');
  const usesSqlite = Object.values(perFeed).some(
    (feed) => feed.store === 'sqlite',
  );
  if (sqlitePath !== '' && !usesSqlite) {
    warnings.push(
      'HISTORY_SQLITE_PATH is set but no feed uses the sqlite backend, so it is ignored.',
    );
  }
  if (sqlitePath.includes('\0'))
    problems.push('HISTORY_SQLITE_PATH must not contain a NUL character.');

  if (problems.length) throw new HistoryConfigError(problems);
  return Object.freeze({
    defaultStore,
    defaultRetentionDays: defaultRetention,
    sqlitePath: sqlitePath === '' ? DEFAULT_SQLITE_PATH : sqlitePath,
    feeds: Object.freeze(perFeed),
    warnings: Object.freeze(warnings),
  });
}
