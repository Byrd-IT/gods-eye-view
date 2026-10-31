import { DEFAULT_SQLITE_PATH, HistoryStoreError } from './store/common.js';
import { DEFAULT_TABLE_PREFIX } from './store/sqlStore.js';

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
export const KNOWN_BACKENDS = Object.freeze([
  'sqlite',
  'elasticsearch',
  'mysql',
  'postgres',
]);

/** Other names for a backend. `mariadb` is served by the mysql backend. */
const BACKEND_ALIASES = Object.freeze({ mariadb: 'mysql' });

/** URL schemes each networked backend accepts. */
const URL_SCHEMES = Object.freeze({
  mysql: ['mysql:', 'mariadb:'],
  postgres: ['postgres:', 'postgresql:'],
});
const URL_SETTINGS = Object.freeze({
  mysql: 'HISTORY_MYSQL_URL',
  postgres: 'HISTORY_POSTGRES_URL',
});
const TABLE_PREFIX_PATTERN = /^[a-z][a-z0-9_]{0,23}$/;

export const DEFAULT_BACKEND = 'sqlite';
export const DEFAULT_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 3650;

/** Settings with no feed suffix. A HISTORY_* name outside this list is a typo. */
const SETTINGS = Object.freeze([
  'HISTORY_STORE',
  'HISTORY_RETENTION_DAYS',
  'HISTORY_SQLITE_PATH',
  'HISTORY_MYSQL_URL',
  'HISTORY_POSTGRES_URL',
  'HISTORY_SQL_TABLE_PREFIX',
]);
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
  const typed = text(env, name).toLowerCase();
  if (typed === '') return null;
  const raw = BACKEND_ALIASES[typed] ?? typed;
  if (!KNOWN_BACKENDS.includes(raw)) {
    problems.push(
      `${name} must be one of: ${[...KNOWN_BACKENDS, ...Object.keys(BACKEND_ALIASES)].join(', ')}.`,
    );
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
 *   HISTORY_STORE                 default backend (sqlite | mysql | mariadb | postgres | elasticsearch); sqlite when unset
 *   HISTORY_STORE_<FEED>          backend for one feed, e.g. HISTORY_STORE_AIRCRAFT
 *   HISTORY_RETENTION_DAYS        default retention in days (30); 0 keeps everything
 *   HISTORY_RETENTION_DAYS_<FEED> retention for one feed
 *   HISTORY_SQLITE_PATH           SQLite file (./data/history.sqlite)
 *   HISTORY_MYSQL_URL             mysql://user:pass@host/db  (mysql and mariadb backends)
 *   HISTORY_POSTGRES_URL          postgres://user:pass@host/db
 *   HISTORY_SQL_TABLE_PREFIX      table name prefix for the SQL backends (gev_history)
 *
 * A connection string carries a password, so no message quotes it and it is kept
 * off the enumerable fields of the result (it never reaches a log by accident).
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
    if (!name.startsWith('HISTORY_') || text(env, name) === '') continue;
    if (SETTINGS.includes(name)) continue;
    const prefix = [STORE_PREFIX, RETENTION_PREFIX].find((candidate) =>
      name.startsWith(candidate),
    );
    if (prefix && known.has(name.slice(prefix.length))) continue;
    // A variable name is echoed only when it looks like one, so a stray value
    // that was exported under an odd name is never repeated back.
    const shown = /^[A-Z0-9_]{1,64}$/.test(name)
      ? name
      : `${prefix ?? 'HISTORY_'}<unrecognised>`;
    problems.push(
      prefix
        ? `${shown} names no known feed (known: ${feeds.join(', ')}).`
        : `${shown} is not a history setting (settings: ${SETTINGS.join(', ')}, plus ${STORE_PREFIX}<FEED> and ${RETENTION_PREFIX}<FEED>).`,
    );
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

  const urls = {};
  for (const backend of Object.keys(URL_SETTINGS)) {
    const name = URL_SETTINGS[backend];
    const raw = text(env, name);
    const used = Object.values(perFeed).some((feed) => feed.store === backend);
    if (!used) {
      if (raw !== '')
        warnings.push(
          `${name} is set but no feed uses the ${backend} backend, so it is ignored.`,
        );
      continue;
    }
    if (raw === '') {
      problems.push(
        `${name} must be set because a feed uses the ${backend} backend.`,
      );
      continue;
    }
    let parsed = null;
    try {
      parsed = new URL(raw);
    } catch {
      /* reported below without the value */
    }
    if (
      !parsed ||
      !URL_SCHEMES[backend].includes(parsed.protocol) ||
      parsed.hostname === '' ||
      parsed.pathname.replace(/^\/+/, '') === ''
    ) {
      problems.push(
        `${name} must look like ${URL_SCHEMES[backend][0]}//user:password@host:port/database.`,
      );
      continue;
    }
    urls[backend] = raw;
  }

  const tablePrefix = text(env, 'HISTORY_SQL_TABLE_PREFIX');
  const usesSql = Object.values(perFeed).some((feed) =>
    Object.hasOwn(URL_SETTINGS, feed.store),
  );
  if (tablePrefix !== '' && !usesSql)
    warnings.push(
      'HISTORY_SQL_TABLE_PREFIX is set but no feed uses a SQL backend, so it is ignored.',
    );
  if (tablePrefix !== '' && !TABLE_PREFIX_PATTERN.test(tablePrefix))
    problems.push(
      'HISTORY_SQL_TABLE_PREFIX must be lowercase letters, digits and _ (starts with a letter; at most 24 characters).',
    );

  if (problems.length) throw new HistoryConfigError(problems);
  const config = {
    defaultStore,
    defaultRetentionDays: defaultRetention,
    sqlitePath: sqlitePath === '' ? DEFAULT_SQLITE_PATH : sqlitePath,
    sqlTablePrefix: tablePrefix === '' ? DEFAULT_TABLE_PREFIX : tablePrefix,
    feeds: Object.freeze(perFeed),
    warnings: Object.freeze(warnings),
  };
  // Hidden from Object.keys, JSON.stringify and util.inspect; read by name.
  for (const [backend, url] of Object.entries(urls))
    Object.defineProperty(config, `${backend}Url`, {
      value: url,
      enumerable: false,
    });
  return Object.freeze(config);
}
