import { HISTORY_INDICES as IDX } from './historyEs.js';
import { staleThresholdMs } from './staleness.js';

/**
 * GET /api/history/health (gev-history DESIGN 2.4b, 2.5, 4.3; card B10
 * item 4, owner N5).
 *
 * Collector part: GET <GEV_COLLECTOR_URLS>/v1/health in order (S4 then S5);
 * the first ACTIVE collector is the truth (a standby's feed table is old).
 * Per feed it exposes the N5 facts the chips need, computed exactly like the
 * collector's own X-Feed-* headers (gev-history src/latestStore.js):
 *   lastOK      epoch ms of the last OK poll (null = none yet)
 *   staleSince  lastOK + max(3 x cadence, 90 s) once that is past, else null
 *   reason      'halted' | 'opensky_paused_until=HH:MM' | 'upstream_error'
 *               | 'no_snapshot' (state none) | null (live); no active
 *               collector at all -> top-level reason 'collector_down'
 *   state       'live' | 'stale' | 'none' (no OK poll yet)
 * judged on the collector's clock (its `now`), never the browser's. A
 * demand-driven feed (OpenSky viewport) is never stale for lack of viewers
 * (DESIGN 2.4b); only a pause or a halt makes it grey.
 * Only these fields leave the server: no instance names, hosts, error texts
 * or lease details (the raw /v1/health stays on the LAN).
 *
 * Coverage part: per ingest-log feed over the last 24 h, polls, OK polls,
 * docs written and the newest OK snap (one aggregation). If the store is
 * unavailable the coverage part is null and the answer is still 200: the
 * health of the live path does not depend on the history store.
 */

export const HEALTH_CACHE_MS = 5_000;
export const HEALTH_COVERAGE_WINDOW_MS = 24 * 3_600_000;
export const HEALTH_MAX_BODY_BYTES = 1024 * 1024;
const FEED_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** gev-history src/opensky/viewportRunner.js VISIBLE_PAUSES. */
const VISIBLE_PAUSES = new Set(['day', '429', 'tokens']);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function hhmmUtc(ms) {
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(
    d.getUTCMinutes(),
  ).padStart(2, '0')}`;
}

/**
 * N5 facts of one collector feed entry at collector time `now`.
 * @returns {{cadenceMs: number|null, lastOK: number|null, staleSince: number|null, reason: string|null, state: string}}
 */
export function feedHealth(entry, now) {
  const cadenceMs = num(entry?.cadenceMs);
  const lastOK = num(entry?.lastOkAt);
  const halted = entry?.halted && typeof entry.halted === 'object';
  const demand = entry?.demandDriven === true;
  const p = entry?.paused;
  // viewportRunner pauseReason: only visible pauses still in force
  const paused =
    p && VISIBLE_PAUSES.has(p.why) && num(p.until) !== null && p.until > now
      ? p
      : null;
  let staleSince = null;
  let reason = null;
  if (demand) {
    // DESIGN 2.4b: no viewers is not stale; halt / budget pause is
    if (halted) {
      reason = 'halted';
      staleSince = num(entry.halted.at) ?? now;
    } else if (paused) {
      reason = `opensky_paused_until=${hhmmUtc(paused.until)}`;
      staleSince = num(paused.since) ?? now;
    }
  } else if (lastOK !== null && cadenceMs !== null && cadenceMs > 0) {
    // collector latestStore.render: stale = age > max(3 x cadence, 90 s),
    // X-Feed-Stale-Since = lastOK + threshold, reason halted|upstream_error
    const threshold = staleThresholdMs(cadenceMs);
    if (now - lastOK > threshold) {
      staleSince = lastOK + threshold;
      reason = halted ? 'halted' : 'upstream_error';
    }
  }
  const state =
    lastOK === null && !demand ? 'none' : reason !== null ? 'stale' : 'live';
  return {
    cadenceMs,
    lastOK,
    staleSince,
    reason: state === 'none' ? (halted ? 'halted' : 'no_snapshot') : reason,
    state,
  };
}

/**
 * @param {object} options
 * @param {ReturnType<import('./historyEs.js').createHistoryEsClient>|null} options.es
 * @param {string[]} options.collectorUrls
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @param {() => number} [options.now]
 */
export function createHealthService({
  es,
  collectorUrls,
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = 2_000,
  now = () => Date.now(),
}) {
  let memo = null;

  async function readCollector(base) {
    try {
      const response = await fetchImpl(`${base}/v1/health`, {
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status !== 200) return null;
      const text = await response.text();
      if (text.length > HEALTH_MAX_BODY_BYTES) return null;
      const json = JSON.parse(text);
      return json && typeof json === 'object' ? json : null;
    } catch {
      return null;
    }
  }

  async function collectorPart() {
    const answers = [];
    for (const base of collectorUrls) {
      const h = await readCollector(base);
      if (h) answers.push(h);
      if (h?.role === 'active') break;
    }
    const active = answers.find((h) => h.role === 'active');
    if (!active) {
      return {
        collector: {
          state: answers.length ? 'standby_only' : 'down',
          reachable: answers.length,
        },
        feeds: {},
        reason: 'collector_down',
      };
    }
    const at = num(active.now) ?? now();
    const feeds = {};
    for (const [name, entry] of Object.entries(active.feeds ?? {})) {
      if (!FEED_NAME.test(name) || !entry || typeof entry !== 'object')
        continue;
      feeds[name] = feedHealth(entry, at);
    }
    return {
      collector: {
        state: 'active',
        reachable: answers.length,
        now: at,
        esWritable: active.esWritable === true,
        spool: {
          files: num(active.spool?.files) ?? 0,
          bytes: num(active.spool?.bytes) ?? 0,
        },
      },
      feeds,
      reason: null,
    };
  }

  async function coveragePart() {
    if (!es) return null;
    const to = now();
    const from = to - HEALTH_COVERAGE_WINDOW_MS;
    try {
      const json = await es.search(IDX.ingestLog, {
        size: 0,
        query: {
          bool: {
            filter: [
              { term: { kind: 'poll' } },
              {
                range: {
                  '@timestamp': { gte: from, lte: to, format: 'epoch_millis' },
                },
              },
            ],
          },
        },
        aggs: {
          f: {
            terms: { field: 'feed', size: 200 },
            aggs: {
              ok: {
                filter: { term: { ok: true } },
                aggs: { last: { max: { field: 'snap' } } },
              },
              docs: { sum: { field: 'docs_written' } },
            },
          },
        },
      });
      const feeds = {};
      for (const b of json?.aggregations?.f?.buckets ?? []) {
        if (typeof b.key !== 'string' || !FEED_NAME.test(b.key)) continue;
        feeds[b.key] = {
          polls: b.doc_count ?? 0,
          pollsOk: b.ok?.doc_count ?? 0,
          docs: Math.round(b.docs?.value ?? 0),
          lastOkSnap: num(b.ok?.last?.value),
        };
      }
      return { from, to, feeds };
    } catch {
      return null;
    }
  }

  async function health() {
    const t = now();
    if (memo && t - memo.at < HEALTH_CACHE_MS) return memo.value;
    const [c, coverage] = await Promise.all([collectorPart(), coveragePart()]);
    const value = {
      now: t,
      ...c,
      coverage,
      historyStore: es ? (coverage ? 'ok' : 'unavailable') : 'not_configured',
    };
    memo = { at: t, value };
    return value;
  }

  return { health };
}
