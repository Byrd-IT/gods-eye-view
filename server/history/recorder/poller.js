/**
 * Poller for feeds that no route handler sees (adapter.mode === 'poller').
 * Off unless the feed is switched on: it makes one request to the adapter's
 * upstreamUrl every pollMs and hands the parsed body to the recorder, the same
 * path a tee uses. It holds no credential and sends none.
 *
 * A failed poll is logged as a gap (recorder.tapFailure) and a fixed message;
 * the error's own text, which may quote a URL or body, is never logged.
 */
const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const FIRST_POLL_DELAY_MS = 5_000;

function describeFailure(err) {
  if (
    /^(HTTP \d{3}|malformed upstream response|response too large)$/.test(
      err?.message ?? '',
    )
  )
    return err.message;
  const codes = [err?.code, err?.cause?.code].filter(
    (code) => typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code),
  );
  return [String(err?.name ?? 'Error').slice(0, 40), ...codes].join(' ');
}

async function fetchJson(url, fetchImpl) {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const res = await fetchImpl(url, { signal });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${res.status}`);
  }
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await res.body?.cancel().catch(() => {});
    throw new Error('response too large');
  }
  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error('response too large');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('malformed upstream response');
  }
}

/**
 * @param {{ recorder: { tap: Function, tapFailure: Function }, adapters: Record<string, object>, feeds: readonly string[], fetchImpl?: typeof fetch, warn?: Function, clock?: () => number }} options
 */
export function createPollers({
  recorder,
  adapters,
  feeds,
  fetchImpl = (...args) => globalThis.fetch(...args),
  warn = console.warn,
  clock = Date.now,
}) {
  const polled = feeds.filter((feed) => adapters[feed]?.mode === 'poller');
  const timers = new Map();
  let stopped = true;
  // Bumped by every start() and stop(), so a chain left over from an earlier run cannot reschedule.
  let generation = 0;
  const running = new Set();

  async function pollOnce(feed) {
    const adapter = adapters[feed];
    const t = clock();
    try {
      const payload = await fetchJson(adapter.upstreamUrl, fetchImpl);
      if (!Array.isArray(payload?.features))
        throw new Error('malformed upstream response');
      recorder.tap(feed, payload, { t });
    } catch (err) {
      warn(`[history-poller] ${feed} poll failed (${describeFailure(err)})`);
      recorder.tapFailure(feed, { t });
    }
  }

  function schedule(feed, delay, chain) {
    if (stopped || chain !== generation) return;
    const timer = setTimeout(() => {
      const job = pollOnce(feed).finally(() => {
        running.delete(job);
        schedule(feed, adapters[feed].pollMs, chain);
      });
      running.add(job);
    }, delay);
    timer.unref?.();
    timers.set(feed, timer);
  }

  return {
    feeds: Object.freeze([...polled]),
    pollOnce,
    start() {
      if (!stopped) return;
      stopped = false;
      generation += 1;
      for (const feed of polled)
        schedule(feed, FIRST_POLL_DELAY_MS, generation);
    },
    async stop() {
      stopped = true;
      generation += 1;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      await Promise.allSettled([...running]);
    },
  };
}
