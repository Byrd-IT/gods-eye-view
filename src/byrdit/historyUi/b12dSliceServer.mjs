/**
 * Test helper (B12d): the REAL /api/history/slice route (historyApi.js +
 * historySlicesB12c.js) over an in-memory Elasticsearch double, answering
 * the client's fetch with a real Response. So the client tests run the
 * whole chain: layer source -> history router -> adapter -> B12c server.
 * The ES double implements the query subset the B12c slices use (the same
 * subset as the double in src/byrdit/history/historyB12c.test.mjs).
 */
import { createHistoryApi } from '../history/historyApi.js';

const get = (doc, field) => field.split('.').reduce((o, k) => o?.[k], doc);
const asMs = (v) =>
  typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : v;

function matches(doc, q) {
  if (!q || q.match_all) return true;
  if (q.bool) {
    const should = q.bool.should ?? [];
    return (
      (q.bool.filter ?? []).every((f) => matches(doc, f)) &&
      !(q.bool.must_not ?? []).some((f) => matches(doc, f)) &&
      (should.length === 0 || should.some((f) => matches(doc, f)))
    );
  }
  if (q.term) {
    const [[f, v]] = Object.entries(q.term);
    return get(doc, f) === v;
  }
  if (q.terms) {
    const [[f, v]] = Object.entries(q.terms);
    return v.includes(get(doc, f));
  }
  if (q.range) {
    const [[f, r]] = Object.entries(q.range);
    let v = get(doc, f);
    if (v === undefined) return false;
    v = asMs(v);
    return (
      (r.gte === undefined || v >= r.gte) &&
      (r.gt === undefined || v > r.gt) &&
      (r.lte === undefined || v <= r.lte) &&
      (r.lt === undefined || v < r.lt)
    );
  }
  throw new Error('fake ES: unsupported query ' + JSON.stringify(q));
}

/** data: { indexName: [doc | {_index, _source}] } */
export function createFakeEs(data) {
  const reply = (status, body) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const docsFor = (expr) =>
    expr.split(',').flatMap((name) =>
      Object.entries(data)
        .filter(([k]) =>
          name.endsWith('*') ? k.startsWith(name.slice(0, -1)) : k === name,
        )
        .flatMap(([k, docs]) =>
          docs.map((d, i) => ({
            _index: d._source ? (d._index ?? k) : k,
            _id: `${k}#${i}`,
            _source: d._source ?? d,
          })),
        ),
    );
  function search(all, body) {
    let hits = all.filter((h) => matches(h._source, body.query));
    for (const s of [...(body.sort ?? [])].reverse()) {
      const [[f, dir]] = Object.entries(s);
      hits = [...hits].sort((x, y) => {
        const a = asMs(get(x._source, f));
        const b = asMs(get(y._source, f));
        const c = a < b ? -1 : a > b ? 1 : 0;
        return dir === 'desc' ? -c : c;
      });
    }
    if (body.collapse) {
      const seen = new Set();
      hits = hits.filter((h) => {
        const k = get(h._source, body.collapse.field);
        if (k === undefined || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    const keep = Array.isArray(body._source) ? body._source : null;
    return hits.map((h) => ({
      ...h,
      _source: keep
        ? Object.fromEntries(
            Object.entries(h._source).filter(([k]) => keep.includes(k)),
          )
        : h._source,
    }));
  }
  return async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (u.pathname === '/_security/_authenticate')
      return reply(200, {
        authentication_type: 'api_key',
        api_key: { name: 'gev-history-reader' },
      });
    if (u.pathname.endsWith('/_search')) {
      const index = decodeURIComponent(u.pathname.slice(1, -8));
      const all = docsFor(index);
      const hits = search(all, body);
      const out = {
        _shards: { failed: 0 },
        hits: { hits: hits.slice(0, body.size) },
      };
      if (body.aggs) {
        out.aggregations = {};
        for (const [name, spec] of Object.entries(body.aggs)) {
          const values = all
            .filter((h) => matches(h._source, body.query))
            .map((h) => asMs(get(h._source, spec.min.field)))
            .filter((v) => v !== undefined);
          out.aggregations[name] = {
            value: values.length ? Math.min(...values) : null,
          };
        }
      }
      return reply(200, out);
    }
    return reply(404, {});
  };
}

/**
 * The real history API over the ES double. Returns handle(url) -> Response
 * (the HTTP answer the browser would get) and the list of slice queries.
 */
export function createSliceServer(data, { now, windReader = null } = {}) {
  const api = createHistoryApi({
    env: {
      GEV_HISTORY_ES_URL: 'https://es.example.test',
      GEV_HISTORY_ES_API_KEY: 'reader-key-value',
    },
    fetchImpl: createFakeEs(data),
    now,
    log: () => {},
    allow: () => true,
    windReader,
    weatherTimes: null,
    cache: null,
  });
  const asked = [];
  async function handle(path) {
    asked.push(Object.fromEntries(new URL(path, 'http://x').searchParams));
    const res = {
      statusCode: 0,
      headers: {},
      body: '',
      setHeader(k, v) {
        this.headers[k.toLowerCase()] = String(v);
      },
      end(b) {
        this.body = b ?? '';
        this.resolve();
      },
    };
    const done = new Promise((r) => (res.resolve = r));
    api(
      {
        url: path,
        method: 'GET',
        headers: { host: 'localhost' },
        socket: { remoteAddress: '127.0.0.1' },
      },
      res,
      () => res.resolve(),
    );
    await done;
    const headers = new Headers();
    for (const [k, v] of Object.entries(res.headers))
      if (k !== 'content-length') headers.set(k, v);
    return new Response(res.statusCode === 304 ? null : res.body, {
      status: res.statusCode,
      headers,
    });
  }
  return { handle, asked };
}
