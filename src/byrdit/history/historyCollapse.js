/**
 * Newest document per key (gev-history DESIGN 4.3; card B10 items 1, 2, 5).
 *
 * WHY NOT PIT + search_after (measured on the live cluster 2026-10-14,
 * gev-history-vessels, 35 min window, 78,345 docs / 31,707 mmsi):
 *  - collapse + search_after is rejected by Elasticsearch unless the sort is
 *    the collapse field ALONE ("Cannot use [collapse] in conjunction with
 *    [search_after] unless the search is sorted on the same field. Multiple
 *    sort fields are not allowed."). Sorted by mmsi, the document collapse
 *    keeps per mmsi is NOT the newest one (ties broken by doc order).
 *  - collapse inner_hits (sort @timestamp desc, size 1) is rejected on the
 *    TSDS dimension ("cannot expand `inner_hits` for collapse field `mmsi`,
 *    only indexed field can retrieve `inner_hits`").
 *  - reading every doc with PIT + search_after and keeping the newest per
 *    key in process: 2.2-2.6 s; composite(mmsi) + top_hits: 2.4-5.6 s.
 *  - collapse sorted by @timestamp desc is exact (the newest doc per key)
 *    but one request returns at most index.max_result_window = 10,000
 *    groups (31,707 needed).
 * So the key space is PARTITIONED by keyword range on the collapse field and
 * each partition is one collapse request sorted by @timestamp desc. A
 * partition that comes back short (fewer groups than the page) is complete.
 * A FULL partition may hold more groups: it is split into contiguous
 * sub-ranges at quantiles of the keys its own full page returned, and the
 * sub-ranges are queried instead (the page is discarded).
 *  - Exact: the sub-ranges [lo, b1), [b1, b2), ..., [bk, hi) cover the parent
 *    exactly, so no key is lost or counted twice.
 *  - Always progresses: every boundary is a real key strictly above the
 *    smallest key of the page, so every sub-range misses at least one key
 *    of the parent; partitions shrink until they fit one page.
 *  - Alphabet-free: boundaries come from the data, so MMSI digits, ICAO
 *    hex, GTFS vehicle ids or anything else split evenly. Keys are ordered
 *    by UTF-8 bytes, as Elasticsearch orders keyword ranges.
 * PIT + search_after stays the paging path wherever paging is by time (the
 * B9 slices, tracks): see historyEs.js searchAll.
 */

/** index.max_result_window (Elasticsearch default; collapse pages are capped by it). */
export const COLLAPSE_PAGE = 10_000;
/** Most collapse requests one answer may make (abuse / runaway bound). */
export const COLLAPSE_MAX_QUERIES = 200;
/** Partition requests in flight at once for one answer. */
export const COLLAPSE_CONCURRENCY = 4;
/** Sub-ranges a full partition is split into. */
export const COLLAPSE_FANOUT = 8;

const utf8 = new TextEncoder();

/** Keyword order: UTF-8 bytes (Lucene BytesRef), not UTF-16 code units. */
export function compareKeys(a, b) {
  const x = utf8.encode(a);
  const y = utf8.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

/**
 * Contiguous sub-ranges of [lo, hi) cut at quantiles of `keys` (keys seen
 * in the partition). Returns null when no cut is possible (fewer than two
 * distinct keys).
 */
export function splitAtKeys({ lo, hi }, keys, fanout = COLLAPSE_FANOUT) {
  const sorted = [...new Set(keys.filter((k) => typeof k === 'string'))].sort(
    compareKeys,
  );
  if (sorted.length < 2) return null;
  const cuts = [];
  const k = Math.min(fanout, sorted.length);
  for (let j = 1; j < k; j += 1) {
    const b = sorted[Math.floor((j * sorted.length) / k)];
    if (cuts.at(-1) !== b) cuts.push(b);
  }
  const out = [];
  let from = lo;
  for (const b of cuts) {
    out.push({ lo: from, hi: b });
    from = b;
  }
  out.push({ lo: from, hi });
  return out;
}

function partitionFilter(field, { lo, hi }) {
  if (lo === null && hi === null) return [];
  const r = {};
  if (lo !== null) r.gte = lo;
  if (hi !== null) r.lt = hi;
  return [{ range: { [field]: r } }];
}

/**
 * Newest document per `field` value among docs matching `filter`.
 * @param {{search: (index: string, body: object) => Promise<any>}} es
 * @param {string} index allowlisted index expression
 * @param {object} options
 * @param {object[]} options.filter bool filter clauses (parsed values only)
 * @param {string} options.field keyword field to collapse on
 * @param {string} [options.timeField] newest = max of this field
 * @param {string[]} [options._source]
 * @param {number} [options.pageSize]
 * @param {number} [options.maxQueries]
 * @returns {Promise<{hits: object[], truncated: boolean, queries: number}>}
 */
export async function latestPerKey(
  es,
  index,
  {
    filter,
    field,
    timeField = '@timestamp',
    _source,
    pageSize = COLLAPSE_PAGE,
    maxQueries = COLLAPSE_MAX_QUERIES,
    concurrency = COLLAPSE_CONCURRENCY,
    fanout = COLLAPSE_FANOUT,
  },
) {
  let queue = [{ lo: null, hi: null }];
  const hits = [];
  let queries = 0;
  let truncated = false;
  // the collapse key must be returned to cut a full partition
  const source = Array.isArray(_source)
    ? [...new Set([..._source, field])]
    : [field];

  async function run(part, next) {
    queries += 1;
    const json = await es.search(index, {
      size: pageSize,
      track_total_hits: false,
      _source: source,
      query: {
        bool: { filter: [...filter, ...partitionFilter(field, part)] },
      },
      collapse: { field },
      sort: [{ [timeField]: 'desc' }],
    });
    const page = json?.hits?.hits ?? [];
    if (page.length < pageSize) {
      hits.push(...page);
      return;
    }
    const parts = splitAtKeys(
      part,
      page.map((h) => h?._source?.[field]),
      fanout,
    );
    if (!parts) {
      // a full collapse page has distinct keys, so this cannot happen
      // unless pageSize is 1; keep the page and say it may be incomplete
      truncated = true;
      hits.push(...page);
      return;
    }
    next.push(...parts);
  }

  // waves: every partition of a wave runs (bounded concurrency); the
  // sub-ranges of full partitions form the next wave
  while (queue.length) {
    let wave = queue;
    queue = [];
    if (queries + wave.length > maxQueries) {
      truncated = true;
      wave = wave.slice(0, Math.max(0, maxQueries - queries));
      if (!wave.length) break;
    }
    let at = 0;
    const worker = async () => {
      while (at < wave.length) await run(wave[at++], queue);
    };
    await Promise.all(
      Array.from(
        { length: Math.max(1, Math.min(concurrency, wave.length)) },
        worker,
      ),
    );
  }
  return { hits, truncated, queries };
}

/** Promise.all over `items` with at most `limit` calls in flight. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let at = 0;
  const worker = async () => {
    while (at < items.length) {
      const i = at++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
  );
  return out;
}
