/**
 * History store interface.
 *
 * A store keeps timestamped observations per feed. Every method is async and
 * takes the feed first, so a router can send each feed to its own backend.
 * All times are integer milliseconds since the epoch.
 *
 *   append(feed, observations)       -> { written }
 *       observation = { t, key, lat?, lon?, data? }. (t, key) is unique per feed:
 *       appending it again replaces the earlier row, so a retried batch is safe.
 *       A batch is all-or-nothing.
 *   slice(feed, { t, windowMs?, bbox?, limit? })
 *                                    -> { observations, truncated }
 *       Newest observation per key in [t - windowMs, t], ordered by key.
 *       bbox is { west, south, east, north }; west > east crosses the
 *       antimeridian. Rows without a position never match a bbox.
 *   latestBefore(feed, { t, key })   -> observation | null
 *   snapshots(feed, { from?, to?, limit? })
 *                                    -> { snapshots: [{ t, count }], truncated }
 *       Distinct observation times, ascending.
 *   coverage(feed, { from?, to?, maxGapMs? })
 *                                    -> { feed, count, snapshots, firstT, lastT, maxGapMs,
 *                                         spans: [{ from, to, snapshots }] }
 *       Snapshots no more than maxGapMs apart share a span; the gaps between
 *       spans are the times history holds nothing for.
 *   prune(feed, { before })          -> { deleted }     removes t < before
 *   health()                         -> { backend, ok, feeds, ... }  never throws
 *   close()
 *
 * Backend failures surface as HistoryStoreError (code BACKEND); a bad argument
 * is code INVALID_ARGUMENT. Neither message quotes payloads or file paths.
 */
import { loadHistoryConfig } from '../config.js';
import { HistoryStoreError, assertFeed, assertTime } from './common.js';
import { LIVE_BACKENDS, describeSupport } from '../live/index.js';
import { createSqliteStore } from './sqlite.js';

export { HistoryStoreError } from './common.js';

/** Backends this build implements. */
const BACKENDS = Object.freeze({
  sqlite: (config) => createSqliteStore({ path: config.sqlitePath }),
  ...LIVE_BACKENDS,
});

export const AVAILABLE_BACKENDS = Object.freeze(Object.keys(BACKENDS));

const METHODS = [
  'append',
  'slice',
  'latestBefore',
  'snapshots',
  'coverage',
  'prune',
];

/**
 * Validate the environment and open one store per backend in use. Throws
 * HistoryConfigError before touching disk when the settings are unsupported, so
 * a bad setting stops the boot rather than the first write.
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {{ backends?: Record<string, Function> }} [options] test seam
 */
export function createHistoryStore(env = process.env, options = {}) {
  const backends = options.backends ?? BACKENDS;
  const config = loadHistoryConfig(env, { available: Object.keys(backends) });
  const opened = new Map();
  try {
    for (const { store } of Object.values(config.feeds)) {
      if (!opened.has(store)) opened.set(store, backends[store](config, env));
    }
  } catch (error) {
    for (const backend of opened.values()) {
      try {
        Promise.resolve(backend.close()).catch(() => {});
      } catch {
        // Already failing to open; the original error is the one to report.
      }
    }
    throw error;
  }
  const route = (feed) => {
    assertFeed(feed);
    const setting = Object.hasOwn(config.feeds, feed)
      ? config.feeds[feed]
      : undefined;
    if (!setting)
      throw new HistoryStoreError(
        'INVALID_ARGUMENT',
        'feed is not enabled for history',
      );
    return opened.get(setting.store);
  };
  const router = {
    config,
    backend: 'router',
    // What each feed does: stored, live-api or live-only, and whether the slider is offered.
    support: () => describeSupport(config),
  };
  for (const method of METHODS)
    router[method] = async (feed, options) =>
      route(feed)[method](feed, options);
  router.health = async () => {
    const parts = await Promise.all(
      [...opened.entries()].map(async ([name, backend]) => [
        name,
        await backend.health(),
      ]),
    );
    return {
      backend: 'router',
      ok: parts.every(([, health]) => health.ok),
      backends: Object.fromEntries(parts),
    };
  };
  router.close = async () => {
    await Promise.all([...opened.values()].map((backend) => backend.close()));
  };
  return router;
}

/**
 * Apply each feed's retention: delete what is older than its window. Feeds with
 * retentionDays 0 are kept forever. Returns the number deleted per feed.
 */
export async function applyRetention(store, config, now = Date.now()) {
  assertTime(now, 'now');
  const deleted = {};
  for (const [feed, setting] of Object.entries(config.feeds)) {
    if (setting.retentionDays === 0) continue;
    const before = Math.max(0, now - setting.retentionDays * 24 * 3600 * 1000);
    deleted[feed] = (await store.prune(feed, { before })).deleted;
  }
  return deleted;
}
