import {
  DEFAULT_MAX_GAP_MS,
  HistoryStoreError,
  assertFeed,
  normalizeBatch,
  normalizeCoverageOptions,
  normalizeLatestBefore,
  normalizeSliceOptions,
  normalizeSnapshotOptions,
} from '../store/common.js';

/**
 * The backend for a feed that keeps no history. It accepts what a recorder
 * hands it and drops it, and every question about the past has an empty
 * answer, so a caller never has to special-case the feed. The settings screen
 * reads `describeSupport` to hide the time slider for such a feed.
 *
 * Arguments are validated exactly as the real backends do, so a bug in a
 * caller shows up here as it would anywhere else.
 */
export function createLiveOnlyStore() {
  let closed = false;
  const open = () => {
    if (closed)
      throw new HistoryStoreError('CLOSED', 'history store is closed');
  };
  return {
    backend: 'live-only',

    async append(feed, observations) {
      open();
      assertFeed(feed);
      normalizeBatch(observations);
      return { written: 0 };
    },

    async slice(feed, options) {
      open();
      assertFeed(feed);
      normalizeSliceOptions(options);
      return { observations: [], truncated: false };
    },

    async latestBefore(feed, options) {
      open();
      assertFeed(feed);
      normalizeLatestBefore(options);
      return null;
    },

    async snapshots(feed, options) {
      open();
      assertFeed(feed);
      normalizeSnapshotOptions(options);
      return { snapshots: [], truncated: false };
    },

    async coverage(feed, options) {
      open();
      assertFeed(feed);
      const { maxGapMs } = normalizeCoverageOptions(options);
      return {
        feed,
        count: 0,
        snapshots: 0,
        firstT: null,
        lastT: null,
        maxGapMs: maxGapMs ?? DEFAULT_MAX_GAP_MS,
        spans: [],
      };
    },

    async prune(feed) {
      open();
      assertFeed(feed);
      return { deleted: 0 };
    },

    async health() {
      return closed
        ? { backend: 'live-only', ok: false, reason: 'closed', feeds: {} }
        : { backend: 'live-only', ok: true, feeds: {}, keepsHistory: false };
    },

    async close() {
      closed = true;
    },
  };
}
