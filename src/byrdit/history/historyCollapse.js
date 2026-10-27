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
 *
 * FETCH COST (card t_5dc0e0c3, measured 2026-10-18 on the live cluster, the
 * adsb.lol write index at 1 shard / 70.6 M docs): the query phase of one
 * bucket (term snap, ~10 k docs) takes 50-100 ms, but reading the docs'
 * stored _source takes 0.6-28 s (profile: load_stored_fields). The TSDS
 * index is sorted by _tsid then @timestamp, so the docs of one moment are
 * scattered over the whole shard and every doc decompresses its own stored
 * block. `_source: false` still reads stored fields (2.2 s p50). Doc values
 * are columnar: 10 k docs x 20 fields p50 0.8 s, the collapse key alone
 * 0.3 s. Hence:
 *  - `docValues` (field -> type): the docs are read with
 *    `stored_fields: '_none_'` + `docvalue_fields` and turned back into the
 *    _source shape (fromDocValues). Only for indices whose every read field
 *    has doc values (keyword, numeric, date, boolean, geo_point).
 *  - The probe reads the collapse key from doc values only.
 *  - A probe that fits one page has seen EVERY key of its range, so its
 *    range is cut at those keys into `fanout` parts that are fetched in
 *    parallel (each is known to fit a page), instead of one big re-read.
 *  - `memo`: the cuts that split the last answer of the same lane evenly are
 *    kept and start the next answer (playback asks the same lane every
 *    frame and key distributions are stable), so no probe is needed. Cuts
 *    are only a starting partition: any part that comes back full is split
 *    as above, so the answer is exact whatever the cuts are.
 */

/** index.max_result_window (Elasticsearch default; collapse pages are capped by it). */
export const COLLAPSE_PAGE = 10_000;
/** Most collapse requests one answer may make (abuse / runaway bound). */
export const COLLAPSE_MAX_QUERIES = 200;
/** Partition requests in flight at once for one answer. */
export const COLLAPSE_CONCURRENCY = 4;
/** Sub-ranges a full partition is split into. */
export const COLLAPSE_FANOUT = 8;
/** Learned cuts aim at about this many docs per partition (memo). */
export const COLLAPSE_PART_DOCS = 1_500;
/** Lanes (e.g. feed + bbox) whose cuts a memo keeps (LRU). */
export const COLLAPSE_MEMO_LANES = 64;
/** Keys sampled to learn cuts. */
export const CUTS_SAMPLE = 4_096;
/**
 * Response filter of doc-value collapse requests: per hit only _id and the
 * doc values (no _index, _score, sort), plus what checkShards reads. About
 * a fifth of the bytes the server parses per answer.
 */
export const DOC_VALUE_FILTER_PATH =
  'took,timed_out,_shards.failed,hits.hits._id,hits.hits.fields';

/** Field types fromDocValues can turn back into their _source value. */
export const DOC_VALUE_TYPES = Object.freeze([
  'keyword',
  'date',
  'geo_point',
  'float',
  'double',
  'long',
  'integer',
  'short',
  'byte',
  'boolean',
]);

/** Shortest decimal that is the same float32 (what was indexed). */
export function shortestFloat32(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return v;
  const f = Math.fround(v);
  if (f !== v) return v; // not a float32 value: leave it
  // fewest decimals = fewest significant digits; k / 10^d is the double
  // JSON.parse gives for that decimal (cheap: toPrecision was a CPU hotspot)
  for (let d = 0, m = 1; d <= 10; d += 1, m *= 10) {
    const c = Math.round(v * m) / m;
    if (Math.fround(c) === f) return c === 0 ? 0 : c;
  }
  for (let p = 1; p <= 9; p += 1) {
    const c = Number(v.toPrecision(p));
    if (Math.fround(c) === f) return c;
  }
  return v;
}

/** Lucene GeoEncodingUtils steps: a doc value is floor(v / step) * step. */
const LAT_STEP = 180 / 2 ** 32;
const LON_STEP = 360 / 2 ** 32;

/**
 * The shortest decimal in the encoding cell [d, d + step] of a decoded
 * geo doc value: exactly the indexed value whenever that had at most 7
 * decimals (the cell is < 1e-7 deg wide), else within the cell (< 1 cm).
 */
export function geoCellValue(d, step) {
  if (!Number.isFinite(d)) return d;
  for (let p = 0; p <= 10; p += 1) {
    const m = 10 ** p;
    const c = Math.ceil(d * m - 1e-6) / m;
    if (c >= d - 1e-12 && c <= d + step + 1e-12) return c === 0 ? 0 : c; // no -0
  }
  return d;
}

/**
 * geo_point doc value -> {lat, lon}. Doc values come back as "lat, lon"
 * (a string); objects and GeoJSON points are accepted too.
 */
function geoPoint(v) {
  let lat;
  let lon;
  if (typeof v === 'string') {
    // "lat, lon" (no regex: this runs once per doc of a 32 k-doc answer)
    const c = v.indexOf(',');
    if (c < 0 || v.indexOf(',', c + 1) >= 0) return undefined;
    const a = v.slice(0, c).trim();
    const b = v.slice(c + 1).trim();
    if (!a || !b) return undefined;
    lat = Number(a);
    lon = Number(b);
  } else if (Array.isArray(v?.coordinates)) {
    [lon, lat] = v.coordinates;
  } else if (v && typeof v === 'object') {
    ({ lat, lon } = v);
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  return { lat: geoCellValue(lat, LAT_STEP), lon: geoCellValue(lon, LON_STEP) };
}

function fromDocValue(v, type) {
  switch (type) {
    case 'keyword':
      return typeof v === 'string' ? v : v == null ? undefined : String(v);
    case 'date': {
      // requested as epoch_millis (a string of digits)
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isFinite(n)) return n;
      const p = Date.parse(v);
      return Number.isFinite(p) ? p : undefined;
    }
    case 'geo_point':
      return geoPoint(v);
    case 'float':
      return shortestFloat32(typeof v === 'number' ? v : Number(v));
    case 'boolean':
      return v === true || v === 'true';
    default: {
      // double, long, integer, short, byte
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : undefined;
    }
  }
}

/** `docvalue_fields` for a {field: type} spec (dates as epoch_millis). */
export function docValueFields(spec) {
  return Object.entries(spec).map(([field, type]) =>
    type === 'date' ? { field, format: 'epoch_millis' } : field,
  );
}

/**
 * A hit's doc-value `fields` -> the _source-shaped doc (spec: field -> type).
 * A field without a value is left out (as it is absent from _source). A
 * multi-valued field stays an array.
 */
export function fromDocValues(fields, spec) {
  return docValueReader(spec)(fields);
}

const readers = new WeakMap();
/** A compiled fromDocValues for one spec (cached per spec object). */
function docValueReader(spec) {
  let read = readers.get(spec);
  if (read) return read;
  const entries = Object.entries(spec);
  read = (fields) => {
    const doc = {};
    if (!fields) return doc;
    for (let i = 0; i < entries.length; i += 1) {
      const [field, type] = entries[i];
      const raw = fields[field];
      if (raw === undefined) continue;
      if (!Array.isArray(raw)) {
        const v = fromDocValue(raw, type);
        if (v !== undefined) doc[field] = v;
        continue;
      }
      if (raw.length === 1) {
        const v = fromDocValue(raw[0], type);
        if (v !== undefined) doc[field] = v;
        continue;
      }
      const vals = [];
      for (const r of raw) {
        const v = fromDocValue(r, type);
        if (v !== undefined) vals.push(v);
      }
      if (vals.length) doc[field] = vals.length === 1 ? vals[0] : vals;
    }
    return doc;
  };
  readers.set(spec, read);
  return read;
}

/** The collapse key of a hit (_source, or the probe's doc value). */
function keyOf(hit, field) {
  const s = hit?._source?.[field];
  if (s !== undefined) return s;
  const f = hit?.fields?.[field];
  return Array.isArray(f) ? f[0] : f;
}

/**
 * Cuts that split `keys` into about `parts` equal ranges: sorted distinct
 * real keys, none of them the smallest key (so no empty first range).
 */
export function cutsFor(keys, parts) {
  // quantiles of an even sample are enough for a starting partition (any
  // cuts give the exact answer); sorting all 32 k vessel keys was not
  const step = Math.max(1, Math.floor(keys.length / CUTS_SAMPLE));
  const sample = [];
  for (let i = 0; i < keys.length; i += step)
    if (typeof keys[i] === 'string') sample.push(keys[i]);
  const sorted = [...new Set(sample)].sort(compareKeys);
  const k = Math.min(parts, sorted.length);
  const cuts = [];
  for (let j = 1; j < k; j += 1) {
    const b = sorted[Math.floor((j * sorted.length) / k)];
    if (cuts.at(-1) !== b) cuts.push(b);
  }
  return cuts;
}

/** Ranges [null, c1), [c1, c2), ..., [ck, null) for sorted cuts. */
function rangesFromCuts(cuts) {
  const out = [];
  let from = null;
  for (const c of cuts) {
    out.push({ lo: from, hi: c, probe: false });
    from = c;
  }
  out.push({ lo: from, hi: null, probe: false });
  return out;
}

/**
 * Bounded LRU of learned cuts per lane. `lane(key)` returns the slot object
 * latestPerKey reads (`cuts`) and writes back.
 */
export function createCutMemo(maxLanes = COLLAPSE_MEMO_LANES) {
  const lanes = new Map();
  return {
    lane(key) {
      let slot = lanes.get(key);
      if (slot) lanes.delete(key);
      else slot = { cuts: undefined };
      lanes.set(key, slot);
      while (lanes.size > maxLanes) lanes.delete(lanes.keys().next().value);
      return slot;
    },
    get size() {
      return lanes.size;
    },
  };
}

/**
 * Keyword order: UTF-8 bytes (Lucene BytesRef), not UTF-16 code units.
 * UTF-8 byte order is code point order, so this compares code points
 * without encoding (the old TextEncoder version dominated the CPU profile
 * of a 32 k-key vessels answer, t_5dc0e0c3). UTF-16 units already sort by
 * code point except surrogates (U+10000 and up) against U+E000-U+FFFF;
 * the shift below fixes exactly that case.
 */
export function compareKeys(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x === y) continue;
    if (x >= 0xd800 && y >= 0xd800) {
      x += x < 0xe000 ? 0x2000 : -0x800;
      y += y < 0xe000 ? 0x2000 : -0x800;
    }
    return x - y;
  }
  return a.length - b.length;
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
 * @param {'desc'|'asc'} [options.order] 'asc' keeps the OLDEST per key
 * @param {string[]} [options._source]
 * @param {number} [options.pageSize]
 * @param {number} [options.maxQueries]
 * @param {boolean} [options.probe] the caller expects more than one page
 *   (e.g. the global vessels slice): the first request fetches only the
 *   keys (to cut the partitions), not the documents
 * @param {number} [options.concurrency]
 * @param {Record<string, string>} [options.docValues] field -> type
 *   (DOC_VALUE_TYPES): read these fields from doc values, not _source
 * @param {{cuts?: string[]}} [options.memo] learned cuts of this lane
 *   (createCutMemo().lane(key)); read to start, written after a complete
 *   answer
 * @param {number} [options.partDocs] docs per learned partition
 * @returns {Promise<{hits: object[], truncated: boolean, queries: number}>}
 */
export async function latestPerKey(
  es,
  index,
  {
    filter,
    field,
    timeField = '@timestamp',
    order = 'desc',
    _source,
    pageSize = COLLAPSE_PAGE,
    maxQueries = COLLAPSE_MAX_QUERIES,
    concurrency = COLLAPSE_CONCURRENCY,
    fanout = COLLAPSE_FANOUT,
    probe = false,
    docValues = null,
    memo = null,
    partDocs = COLLAPSE_PART_DOCS,
  },
) {
  const cuts = Array.isArray(memo?.cuts) ? memo.cuts : null;
  let queue = cuts ? rangesFromCuts(cuts) : [{ lo: null, hi: null, probe }];
  const hits = [];
  let queries = 0;
  let truncated = false;
  // the collapse key must be returned to cut a full partition
  const spec = docValues ? { [field]: 'keyword', ...docValues } : null;
  const source = Array.isArray(_source)
    ? [...new Set([..._source, field])]
    : _source;
  const fetchDocs = spec
    ? { stored_fields: '_none_', docvalue_fields: docValueFields(spec) }
    : { _source: source };
  // the probe needs the key only: one doc-value column, no stored fields
  const fetchKeys = { stored_fields: '_none_', docvalue_fields: [field] };
  const readDocValues = spec ? docValueReader(spec) : null;
  const asDoc = spec
    ? (h) => ({
        _index: h?._index,
        _id: h?._id,
        _source: h?._source ?? readDocValues(h?.fields),
        ...(h?.sort ? { sort: h.sort } : {}),
      })
    : (h) => h;
  /** Parts for n docs: ~partDocs each, at least 1, at most fanout. */
  const partsFor = (n) =>
    Math.max(1, Math.min(fanout, Math.round(n / Math.max(1, partDocs))));

  async function run(part, next) {
    queries += 1;
    const docValuesOnly = part.probe || spec !== null;
    const json = await es.search(
      index,
      {
        size: pageSize,
        track_total_hits: false,
        ...(part.probe ? fetchKeys : fetchDocs),
        query: {
          bool: { filter: [...filter, ...partitionFilter(field, part)] },
        },
        collapse: { field },
        sort: [{ [timeField]: order === 'asc' ? 'asc' : 'desc' }],
      },
      docValuesOnly ? { filterPath: DOC_VALUE_FILTER_PATH } : undefined,
    );
    const page = json?.hits?.hits ?? [];
    const keys = page.map((h) => keyOf(h, field));
    if (page.length < pageSize) {
      if (!part.probe) {
        hits.push(...page.map(asDoc));
        return;
      }
      // the probe saw every key of the range: cut it at those keys into
      // ~partDocs-doc parts (each fits a page), fetched in parallel
      const parts = splitAtKeys(part, keys, partsFor(page.length));
      if (parts) next.push(...parts.map((p) => ({ ...p, probe: false })));
      else if (page.length) next.push({ ...part, probe: false });
      return;
    }
    const parts = splitAtKeys(part, keys, fanout);
    if (!parts) {
      // a full collapse page has distinct keys, so this cannot happen
      // unless pageSize is 1; keep the page and say it may be incomplete
      truncated = true;
      if (!part.probe) hits.push(...page.map(asDoc));
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
  if (memo && !truncated) {
    // cuts that split THIS answer into ~partDocs-doc parts start the next
    // answer of the lane; a small answer learns [] (one request, no probe)
    memo.cuts = cutsFor(
      hits.map((h) => keyOf(h, field)),
      partsFor(hits.length),
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
