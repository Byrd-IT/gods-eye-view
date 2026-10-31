import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  HistoryStoreError,
  assertFeed,
  assertTime,
  coverageResult,
  coverageSql,
  DEFAULT_SQLITE_PATH,
  decodeRow,
  invalid,
  normalizeBatch,
  normalizeCoverageOptions,
  normalizeLatestBefore,
  normalizeSliceOptions,
  normalizeSnapshotOptions,
} from './common.js';

/** Bump when the table layout changes; open() refuses a newer file. */
export const SQLITE_SCHEMA_VERSION = 1;
export { DEFAULT_SQLITE_PATH };

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS observations (
    feed TEXT NOT NULL,
    t    INTEGER NOT NULL,
    key  TEXT NOT NULL,
    lat  REAL,
    lon  REAL,
    data TEXT NOT NULL,
    PRIMARY KEY (feed, t, key)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS observations_by_key ON observations (feed, key, t);
  CREATE TABLE IF NOT EXISTS feeds (feed TEXT PRIMARY KEY) WITHOUT ROWID;
`;

function backendError(action, error) {
  // Only the SQLite error code is surfaced: its message can carry the file path.
  const code = error?.errcode ?? error?.code ?? 'unknown';
  return new HistoryStoreError('BACKEND', `sqlite ${action} failed (${code})`);
}

/**
 * SQLite history backend on node:sqlite (built in to Node 24; no dependency).
 *
 * One file, WAL journal so readers never block the single writer, and
 * `synchronous=NORMAL`, which the WAL mode documents as safe against a crash
 * (a power cut can lose the last commits but cannot corrupt the file).
 *
 * @param {{ path?: string }} [options] `:memory:` gives a throwaway store.
 */
export function createSqliteStore(options = {}) {
  const file = options.path ?? DEFAULT_SQLITE_PATH;
  if (typeof file !== 'string' || file.trim() === '') {
    throw new HistoryStoreError(
      'CONFIG',
      'sqlite path must be a non-empty string',
    );
  }
  const inMemory = file === ':memory:';
  let db;
  try {
    if (!inMemory)
      mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    // Loaded on first use: node:sqlite prints an ExperimentalWarning when it loads,
    // and a deployment that keeps every feed elsewhere should not see it.
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    db = new DatabaseSync(file);
    db.exec('PRAGMA busy_timeout = 5000');
    const mode = db.prepare('PRAGMA journal_mode = WAL').get().journal_mode;
    if (!inMemory && mode !== 'wal') {
      // Some network and FUSE filesystems cannot do WAL; without it a reader
      // blocks the writer, so refuse instead of degrading quietly.
      throw new HistoryStoreError(
        'BACKEND',
        'the history database location does not support the WAL journal',
      );
    }
    db.exec('PRAGMA synchronous = NORMAL');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > SQLITE_SCHEMA_VERSION) {
      throw new HistoryStoreError(
        'BACKEND',
        `history database schema ${version} is newer than this build supports (${SQLITE_SCHEMA_VERSION})`,
      );
    }
    db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
  } catch (error) {
    try {
      db?.close();
    } catch {
      /* already unusable */
    }
    throw error instanceof HistoryStoreError
      ? error
      : backendError('open', error);
  }

  const sql = {
    upsert: db.prepare(`
      INSERT INTO observations (feed, t, key, lat, lon, data) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (feed, t, key) DO UPDATE SET lat = excluded.lat, lon = excluded.lon, data = excluded.data`),
    feed: db.prepare('INSERT OR IGNORE INTO feeds (feed) VALUES (?)'),
    latest: db.prepare(
      'SELECT t, key, lat, lon, data FROM observations WHERE feed = ? AND key = ? AND t <= ? ORDER BY t DESC LIMIT 1',
    ),
    prune: db.prepare('DELETE FROM observations WHERE feed = ? AND t < ?'),
    feeds: db.prepare('SELECT feed FROM feeds ORDER BY feed'),
    minT: db.prepare('SELECT MIN(t) AS v FROM observations WHERE feed = ?'),
    maxT: db.prepare('SELECT MAX(t) AS v FROM observations WHERE feed = ?'),
  };
  let closed = false;
  // The few shapes of range queries are prepared once, not per request.
  const statements = new Map();
  const prepared = (text) => {
    let statement = statements.get(text);
    if (!statement) {
      statement = db.prepare(text);
      statements.set(text, statement);
    }
    return statement;
  };

  const guard = (action, fn) => {
    if (closed)
      throw new HistoryStoreError('CLOSED', 'history store is closed');
    try {
      return fn();
    } catch (error) {
      if (error instanceof HistoryStoreError) throw error;
      throw backendError(action, error);
    }
  };

  function rangeClause(range, params) {
    let clause = '';
    if (range.from !== undefined) {
      clause += ' AND t >= ?';
      params.push(range.from);
    }
    if (range.to !== undefined) {
      clause += ' AND t <= ?';
      params.push(range.to);
    }
    return clause;
  }

  return {
    backend: 'sqlite',

    async append(feed, observations) {
      assertFeed(feed);
      const rows = normalizeBatch(observations);
      return guard('append', () => {
        if (rows.length === 0) return { written: 0 };
        db.exec('BEGIN IMMEDIATE');
        try {
          sql.feed.run(feed);
          for (const row of rows)
            sql.upsert.run(feed, row.t, row.key, row.lat, row.lon, row.json);
          db.exec('COMMIT');
        } catch (error) {
          try {
            db.exec('ROLLBACK');
          } catch {
            /* connection already rolled back */
          }
          throw error;
        }
        return { written: rows.length };
      });
    },

    async slice(feed, options) {
      assertFeed(feed);
      const { t, windowMs, limit, bbox } = normalizeSliceOptions(options);
      return guard('slice', () => {
        // Newest observation per key inside the window, chosen by feed and time
        // alone. The bounding box is applied to that newest row afterwards: a key
        // whose latest position is outside the box must not show an older
        // position that happened to be inside it. CROSS JOIN fixes the join
        // order: without it SQLite may walk the whole feed by key for each
        // window row (200 ms instead of 2 ms on 200k rows).
        const params = [feed, Math.max(0, t - windowMs), t, feed];
        let inBox = '';
        if (bbox) {
          inBox = ' AND o.lat >= ? AND o.lat <= ?';
          params.push(bbox.south, bbox.north);
          inBox +=
            bbox.west <= bbox.east
              ? ' AND o.lon >= ? AND o.lon <= ?'
              : ' AND (o.lon >= ? OR o.lon <= ?)';
          params.push(bbox.west, bbox.east);
        }
        const statement = prepared(`
          SELECT o.t, o.key, o.lat, o.lon, o.data
          FROM (SELECT key, MAX(t) AS t FROM observations
                WHERE feed = ? AND t >= ? AND t <= ? GROUP BY key) newest
          CROSS JOIN observations o ON o.feed = ? AND o.t = newest.t AND o.key = newest.key
          WHERE 1 = 1${inBox}
          ORDER BY o.key
          LIMIT ?`);
        const found = statement.all(...params, limit + 1);
        const truncated = found.length > limit;
        return {
          observations: found.slice(0, limit).map(decodeRow),
          truncated,
        };
      });
    },

    async latestBefore(feed, options) {
      assertFeed(feed);
      const { t, key } = normalizeLatestBefore(options);
      return guard('latestBefore', () => {
        const row = sql.latest.get(feed, key, t);
        return row ? decodeRow(row) : null;
      });
    },

    async snapshots(feed, options) {
      assertFeed(feed);
      const { from, to, limit } = normalizeSnapshotOptions(options);
      return guard('snapshots', () => {
        const params = [feed];
        const clause = rangeClause({ from, to }, params);
        const found = prepared(
          `SELECT t, COUNT(*) AS count FROM observations WHERE feed = ?${clause} GROUP BY t ORDER BY t LIMIT ?`,
        ).all(...params, limit + 1);
        return {
          snapshots: found
            .slice(0, limit)
            .map((row) => ({ t: Number(row.t), count: Number(row.count) })),
          truncated: found.length > limit,
        };
      });
    },

    async coverage(feed, options) {
      assertFeed(feed);
      const { from, to, maxGapMs } = normalizeCoverageOptions(options);
      return guard('coverage', () => {
        // The gap comes first: `?` placeholders bind in text order.
        const params = [maxGapMs, feed];
        const clause = rangeClause({ from, to }, params);
        const rows = prepared(
          coverageSql({
            table: 'observations',
            feedPlaceholder: '?',
            clause,
            gapPlaceholder: '?',
          }),
        ).all(...params);
        return coverageResult(feed, maxGapMs, rows);
      });
    },

    async prune(feed, options) {
      assertFeed(feed);
      const before = assertTime(options?.before, 'before');
      return guard('prune', () => {
        const result = sql.prune.run(feed, before);
        if (Number(result.changes) > 0 && !inMemory)
          db.exec('PRAGMA wal_checkpoint(PASSIVE)');
        return { deleted: Number(result.changes) };
      });
    },

    async health() {
      if (closed)
        return { backend: 'sqlite', ok: false, reason: 'closed', feeds: {} };
      try {
        const feeds = {};
        for (const { feed } of sql.feeds.all()) {
          feeds[feed] = {
            firstT: sql.minT.get(feed).v ?? null,
            lastT: sql.maxT.get(feed).v ?? null,
          };
          if (feeds[feed].firstT !== null) {
            feeds[feed].firstT = Number(feeds[feed].firstT);
            feeds[feed].lastT = Number(feeds[feed].lastT);
          }
        }
        let sizeBytes = 0;
        if (!inMemory) {
          for (const suffix of ['', '-wal']) {
            try {
              sizeBytes += statSync(file + suffix).size;
            } catch {
              /* no WAL file yet */
            }
          }
        }
        return {
          backend: 'sqlite',
          ok: true,
          journalMode: db.prepare('PRAGMA journal_mode').get().journal_mode,
          schemaVersion: db.prepare('PRAGMA user_version').get().user_version,
          sizeBytes,
          feeds,
        };
      } catch (error) {
        const failure = backendError('health', error);
        return {
          backend: 'sqlite',
          ok: false,
          reason: failure.message,
          feeds: {},
        };
      }
    },

    async close() {
      if (closed) return;
      closed = true;
      try {
        db.close();
      } catch {
        /* nothing left to release */
      }
    },
  };
}
