// Shared fixtures for the recorder tests and gate. Not a test file.
export const T0 = Date.UTC(2026, 9, 31, 12, 0);

/** Parsed FIRMS records, as /api/firms returns them. */
export function fire(overrides = {}) {
  return {
    lat: 30.1234567,
    lon: -97.7654321,
    frp: 12.5,
    confidence: 'h',
    brightness: 331.2,
    brightnessTi5: 290.1,
    daynight: 'D',
    acqDate: '2026-10-31',
    acqTime: '1130',
    satellite: 'N20',
    instrument: 'VIIRS',
    ...overrides,
  };
}

export function firmsPayload(fires, fetchedAt = T0) {
  return {
    fetchedAt,
    stale: false,
    ttlMs: 1_800_000,
    sources: [],
    count: fires.length,
    fires,
  };
}

/** An in-memory store that records what it was given. `fail` makes append reject. */
export function stubStore({ fail = false } = {}) {
  const store = {
    appended: [],
    ingests: [],
    fail,
    async append(feed, rows) {
      if (store.fail) {
        const error = new Error('stub failure with /secret/path');
        error.code = 'BACKEND';
        throw error;
      }
      store.appended.push({ feed, rows });
      return { written: rows.length };
    },
    async recordIngest(feed, record) {
      store.ingests.push({ feed, ...record });
      return { recorded: 1 };
    },
    async prune() {
      return { deleted: 0 };
    },
    async close() {},
  };
  return store;
}

export const recorderConfig = (overrides = {}) => ({
  feeds: { firms: { record: true, minIntervalMs: 30 * 60_000 } },
  queueRows: 10_000,
  flushMs: 5_000,
  ...overrides,
});
