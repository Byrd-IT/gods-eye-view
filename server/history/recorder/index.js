/**
 * History recorder: taps the payload a route handler already returns and keeps
 * a copy in the history store. It never fetches anything itself.
 *
 *   tap(feed, payload, meta)    queue one poll's records; synchronous, never throws
 *   tapFailure(feed, meta)      note a poll that did not answer (a gap, not an empty answer)
 *   flush() / close()           write what is queued
 *   health()                    counters, no payloads
 *
 * A request never waits on the store: records go to a bounded queue and are
 * written in batches on a timer. A full queue drops the oldest poll and counts
 * it. A store error is counted and logged by feed and error code only.
 */
import { createHash } from 'node:crypto';

const FLUSH_CHUNK_ROWS = 2_000;
// Enough for several world-wide FIRMS passes; the store's own uniqueness covers older repeats.
const MAX_SEEN = 400_000;

/** What a disabled recorder is: every call returns at once and nothing is opened. */
export const NOOP_RECORDER = Object.freeze({
  enabled: false,
  feeds: Object.freeze([]),
  tap: () => ({ skipped: 'disabled' }),
  tapFailure: () => ({ skipped: 'disabled' }),
  flush: async () => {},
  start() {},
  close: async () => {},
  health: () => ({ enabled: false }),
});

// A moving entity (an aircraft, a vessel) keeps its props but changes place, so
// the place is part of what "unchanged" means.
const digestOf = (lat, lon, props) =>
  createHash('sha1')
    .update(JSON.stringify([lat ?? null, lon ?? null, props]))
    .digest('base64url');

/**
 * @param {{
 *   store: { append: Function, recordIngest: Function },
 *   config: { feeds: Record<string,{record:boolean,minIntervalMs:number}>, queueRows: number, flushMs: number },
 *   adapters: Record<string, { feed: string, toRecords: Function }>,
 *   clock?: () => number,
 *   warn?: (message: string) => void,
 * }} options
 */
export function createRecorder({
  store,
  config,
  adapters,
  clock = Date.now,
  warn = console.warn,
}) {
  const active = Object.keys(config.feeds).filter(
    (feed) => config.feeds[feed].record,
  );
  const counters = {
    queuedRows: 0,
    written: 0,
    skipped: 0,
    dropped: 0,
    failedFlushes: 0,
    adapterErrors: 0,
    polls: 0,
  };
  /** @type {Array<{feed:string, rows:Array<object>, ingest:{t:number, ok:boolean, count:number}}>} */
  let queue = [];
  let queuedRows = 0;
  /**
   * Per feed, what the store already holds; committed only after it took the row.
   *   exact: Set of `key\0t`  -> the same observation again is skipped
   *   latest: Map key -> {t, digest} -> an unchanged entity inside the minimum interval is skipped
   */
  const seen = new Map(
    active.map((feed) => [feed, { exact: new Set(), latest: new Map() }]),
  );
  const oversizeWarned = new Set();
  let timer = null;
  let flushing = null;
  let closed = false;

  const enqueue = (job) => {
    const size = job.rows.length;
    if (size > config.queueRows) {
      counters.dropped += size;
      if (!oversizeWarned.has(job.feed)) {
        oversizeWarned.add(job.feed);
        warn(
          `[history-recorder] ${job.feed} poll of ${size} rows is larger than HISTORY_RECORD_QUEUE_ROWS (${config.queueRows}); it is dropped and reads as a gap`,
        );
      }
      return false;
    }
    while (queue.length && queuedRows + size > config.queueRows) {
      const oldest = queue.shift();
      queuedRows -= oldest.rows.length;
      counters.dropped += oldest.rows.length;
    }
    queue.push(job);
    queuedRows += size;
    return true;
  };

  function select(feed, records) {
    const { exact, latest } = seen.get(feed);
    const { minIntervalMs } = config.feeds[feed];
    const rows = [];
    for (const record of records) {
      const { id: key, t, lat, lon, props } = record;
      if (exact.has(`${key}\0${t}`)) continue;
      // Hash only when there is an earlier row to compare with; the rest are
      // hashed when they are committed, off the request path.
      const prior = latest.get(key);
      if (
        prior &&
        prior.digest === digestOf(lat, lon, props) &&
        Math.abs(t - prior.t) < minIntervalMs
      )
        continue;
      rows.push({ t, key, lat, lon, data: props });
    }
    return rows;
  }

  function commit(feed, rows) {
    const { exact, latest } = seen.get(feed);
    for (const row of rows) {
      exact.add(`${row.key}\0${row.t}`);
      latest.delete(row.key); // re-insert so the map stays oldest-first
      latest.set(row.key, {
        t: row.t,
        digest: digestOf(row.lat, row.lon, row.data),
      });
    }
    for (const set of [exact, latest]) {
      if (set.size <= MAX_SEEN) continue;
      let excess = set.size - Math.floor(MAX_SEEN * 0.9);
      for (const entry of set instanceof Set ? set.values() : set.keys()) {
        if (excess-- <= 0) break;
        set.delete(entry);
      }
    }
  }

  const recorder = {
    enabled: true,
    feeds: Object.freeze([...active]),

    tap(feed, payload, meta = {}) {
      if (closed || !active.includes(feed)) return { skipped: 'disabled' };
      try {
        const adapter = adapters[feed];
        const polledAt = Number.isSafeInteger(meta.t) ? meta.t : clock();
        const records = adapter.toRecords(payload);
        const rows = select(feed, records);
        counters.skipped += records.length - rows.length;
        counters.polls += 1;
        const queued = enqueue({
          feed,
          rows,
          ingest: { t: polledAt, ok: true, count: records.length },
        });
        if (queued) counters.queuedRows += rows.length;
        return {
          queued: queued ? rows.length : 0,
          skipped: records.length - rows.length,
        };
      } catch {
        // Adapter faults must not reach the live response. The error text can hold
        // payload content, so only the fact is counted.
        counters.adapterErrors += 1;
        return { error: 'adapter' };
      }
    },

    tapFailure(feed, meta = {}) {
      if (closed || !active.includes(feed)) return { skipped: 'disabled' };
      const t = Number.isSafeInteger(meta.t) ? meta.t : clock();
      counters.polls += 1;
      enqueue({ feed, rows: [], ingest: { t, ok: false, count: 0 } });
      return { queued: 0 };
    },

    async flush() {
      if (flushing) return flushing;
      flushing = (async () => {
        while (queue.length) {
          const job = queue.shift();
          queuedRows -= job.rows.length;
          try {
            for (let i = 0; i < job.rows.length; i += FLUSH_CHUNK_ROWS) {
              const chunk = job.rows.slice(i, i + FLUSH_CHUNK_ROWS);
              await store.append(
                job.feed,
                chunk.map(({ t, key, lat, lon, data }) => ({
                  t,
                  key,
                  lat,
                  lon,
                  data,
                })),
              );
              commit(job.feed, chunk);
              counters.written += chunk.length;
              // The SQLite backend works synchronously: let requests run between chunks.
              await new Promise((resolve) => setImmediate(resolve));
            }
            await store.recordIngest(job.feed, job.ingest);
          } catch (error) {
            counters.failedFlushes += 1;
            // Feed name and error code only: a store message can name a path.
            warn(
              `[history-recorder] ${job.feed} write failed (${error?.code ?? 'error'})`,
            );
            // The rest of this job is not retried; the next poll re-sends what is current.
          }
        }
      })().finally(() => {
        flushing = null;
      });
      return flushing;
    },

    start() {
      if (timer || closed) return;
      timer = setInterval(() => {
        recorder.flush().catch(() => {});
      }, config.flushMs);
      timer.unref?.();
    },

    async close() {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      timer = null;
      await recorder.flush();
    },

    health() {
      return {
        enabled: true,
        feeds: [...active],
        queueRows: queuedRows,
        queueLimit: config.queueRows,
        ...counters,
      };
    },
  };
  return recorder;
}
