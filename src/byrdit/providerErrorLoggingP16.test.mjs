// Byrd-IT p16 (card t_6c3b6558, STANDARD R3/R7, KB SeY7S6EBs9sMHq_KSKLr):
// upstream-failure logging in six providers not covered by b12:
//   cctv/sources.js, aircraft/opensky.js, traffic.js, regional/http.js,
//   firms.js, local-receivers.js.
// Every upstream is a LOCALHOST stub (node:http on 127.0.0.1). globalThis.fetch
// is wrapped so a request for https://<host>/<path> is sent to the stub as
// /<host>/<path>; local-receivers fetches 127.0.0.1 directly. Nothing here
// reaches the network, and cache/budget files go to a private temp dir.
//
// For each file the test checks:
//   - the client-visible result (status/body/return value) is exactly what the
//     pre-p16 code returned (run with P16_ROOT=<base worktree> to prove it on
//     57734c5: then the log assertions are skipped);
//   - the failure line has target (or the feed label), status, elapsed_ms and a
//     body of at most 300 UTF-8 bytes;
//   - no synthetic secret (bearer, URL userinfo, ghp_ token, header key, query
//     key, the provider's own key) appears in any captured log line.
// P16_LOG_OUT=<file> writes every captured line there for secret_probe.py scan.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const BASE_MODE = Boolean(process.env.P16_ROOT);
const ROOT = BASE_MODE
  ? pathToFileURL(`${path.resolve(process.env.P16_ROOT)}/`)
  : new URL('../../', import.meta.url);
const mod = (rel) => import(new URL(rel, ROOT).href);

// ------------------------------------------------------- synthetic secrets
const nonce = () => Math.random().toString(36).slice(2, 10);
const SYNTH = {
  bearer: process.env.SYNTH_BEARER_TOKEN || `synthbearer${nonce()}${nonce()}`,
  userinfo:
    process.env.SYNTH_URL_USERINFO ||
    `https://synthuser:SynthPw${nonce()}@example.test/x`,
  token: process.env.SYNTH_TOKEN || `ghp_SYNTH${nonce()}${nonce()}${nonce()}`,
  apiKey: process.env.SYNTH_API_KEY || `SYNTHhdrkey${nonce()}${nonce()}`,
  queryUrl:
    process.env.SYNTH_QUERY_URL ||
    `https://api.example.test/v1?api_key=AKSYNTHq${nonce()}${nonce()}`,
};
const queryKey = new URL(SYNTH.queryUrl).searchParams.get('api_key') || '';
const userPw = new URL(SYNTH.userinfo).password;
const ownKey = `OWNKEY${nonce()}${nonce()}`; // the provider's configured key
/** Every value that must never reach a log line (name -> value). */
const NEEDLES = Object.entries({
  bearer: SYNTH.bearer,
  token: SYNTH.token,
  apiKey: SYNTH.apiKey,
  queryKey,
  userPw,
  ownKey,
}).filter(([, v]) => v && v.length >= 6);

/** An upstream error body that echoes every secret shape. */
function secretBody(extra = '', { echoOwnKey = true } = {}) {
  return [
    `<html><h1>Upstream error</h1>`,
    `Authorization: Bearer ${SYNTH.bearer}`,
    `see ${SYNTH.userinfo}`,
    `token ${SYNTH.token}`,
    `X-Api-Key: ${SYNTH.apiKey}`,
    `retry ${SYNTH.queryUrl}`,
    // A bare echo of the provider's own key (no key= context): only the
    // request-secret masking can catch it, so it is sent only to providers
    // that hold that key.
    echoOwnKey ? `your key ${ownKey} is not valid` : 'your key is not valid',
    extra,
    'pad '.repeat(400),
    '</html>',
  ].join('\n');
}

// ------------------------------------------------------------- stub server
const routes = new Map(); // `/<host><path>` prefix -> handler(req, res)
const seen = [];
const server = http.createServer((req, res) => {
  seen.push(req.url);
  const key = [...routes.keys()]
    .sort((a, b) => b.length - a.length)
    .find((prefix) => req.url.startsWith(prefix));
  if (!key) {
    res.writeHead(599, { 'content-type': 'text/plain' });
    res.end(`no stub route for ${req.url}`);
    return;
  }
  routes.get(key)(req, res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const PORT = server.address().port;
const STUB = `http://127.0.0.1:${PORT}`;
// A localhost port with nothing listening: connection refused, no network.
const CLOSED_PORT = await new Promise((resolve) => {
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
const REFUSED = `http://127.0.0.1:${CLOSED_PORT}/`;
test.after(() => server.close());

const realFetch = globalThis.fetch;
function stubFetch(t) {
  t.mock.method(globalThis, 'fetch', (input, init) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    if (u.hostname === '127.0.0.1') return realFetch(input, init);
    return realFetch(`${STUB}/${u.host}${u.pathname}${u.search}`, init);
  });
}
function reply(status, body, headers = {}) {
  return (req, res) => {
    res.writeHead(status, { 'content-type': 'text/html', ...headers });
    res.end(body);
  };
}

// ----------------------------------------------------------------- helpers
const LOG_OUT = process.env.P16_LOG_OUT;
function captureLogs(t) {
  const lines = [];
  for (const level of ['warn', 'error', 'info', 'log'])
    t.mock.method(console, level, (...args) => {
      const line = args
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ');
      lines.push(line);
      if (LOG_OUT) appendFileSync(LOG_OUT, `${line}\n`);
    });
  return lines;
}
function bodiesOf(line) {
  return [...line.matchAll(/body=("(?:[^"\\]|\\.)*")/g)].map((m) =>
    JSON.parse(m[1]),
  );
}
function assertSafe(lines, label) {
  const all = lines.join('\n');
  // Messages name the synthetic secret, never its value.
  for (const [name, needle] of NEEDLES) {
    assert.ok(!all.includes(needle), `${label}: ${name} leaked`);
    assert.ok(
      !all.includes(encodeURIComponent(needle)),
      `${label}: url-encoded ${name} leaked`,
    );
    assert.ok(
      !all.includes(Buffer.from(needle).toString('base64')),
      `${label}: base64 ${name} leaked`,
    );
    assert.ok(
      !all.includes(needle.slice(-8)),
      `${label}: ${name} suffix leaked`,
    );
  }
  assert.doesNotMatch(all, /<html>|<h1>/i, `${label}: markup in log`);
}
/** The failure line: has status, elapsed_ms and a body of <= 300 bytes. */
function assertFailureLine(lines, re, { status, target } = {}) {
  const line = lines.find((l) => re.test(l));
  assert.ok(line, `no line matching ${re}:\n${lines.join('\n')}`);
  if (status !== undefined)
    assert.match(line, new RegExp(`status=${status}\\b`));
  assert.match(line, /elapsed_ms=\d+/);
  if (target) assert.ok(line.includes(`target="${target}"`), line);
  const bodies = bodiesOf(line);
  assert.ok(bodies.length >= 1, `no body= in ${line}`);
  for (const b of bodies)
    assert.ok(Buffer.byteLength(b, 'utf8') <= 300, `body > 300 B: ${line}`);
  return line;
}
function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    headersSent: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headersSent = true;
      for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
    },
    end(body) {
      this.body = body;
    },
  };
}
function installPlugin(plugin) {
  const handlers = new Map();
  plugin.configureServer({
    middlewares: { use: (route, handler) => handlers.set(route, handler) },
  });
  return handlers;
}
const localReq = (url) => ({
  url,
  method: 'GET',
  headers: { host: '127.0.0.1:4173' },
  socket: { remoteAddress: '127.0.0.1' },
});
function withEnv(t, vars) {
  const old = {};
  for (const [k, v] of Object.entries(vars)) {
    old[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(old))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });
}
function tempCwd(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'p16-'));
  t.mock.method(process, 'cwd', () => dir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// --------------------------------------------- 0. helper copies identical
const P16_FILES = [
  'server/providers/cctv/sources.js',
  'server/providers/aircraft/opensky.js',
  'server/providers/traffic.js',
  'server/providers/regional/http.js',
  'server/providers/firms.js',
  'server/providers/local-receivers.js',
];
const START = '// --- Byrd-IT p16: upstream failure log helpers';
const END = '// --- end of p16 helpers';
test(
  'p16 helper block is the same text in all six files; redactSnippet equals b12',
  {
    skip: BASE_MODE && 'base tree has no p16 block',
  },
  () => {
    const blocks = P16_FILES.map((file) => {
      const src = readFileSync(new URL(file, ROOT), 'utf8');
      const a = src.indexOf(START);
      const b = src.indexOf(END);
      assert.ok(a >= 0 && b > a, `${file} has the p16 block`);
      return src.slice(a, b);
    });
    for (const [i, block] of blocks.entries())
      assert.equal(block, blocks[0], `${P16_FILES[i]} block differs`);
    const fn = (src) => {
      const a = src.indexOf('function redactSnippet(');
      return src.slice(a, src.indexOf('\n}\n', a));
    };
    const b12 = readFileSync(
      new URL('server/providers/aircraft/adsb-lol.js', ROOT),
      'utf8',
    );
    assert.equal(
      fn(blocks[0]),
      fn(b12),
      'redactSnippet must equal the b12 copy',
    );
  },
);

// ------------------------------------------------------- 1. traffic.js
test('traffic.js: TomTom 500 + body -> same 502, line has status/body, key masked', async (t) => {
  stubFetch(t);
  tempCwd(t);
  withEnv(t, { TOMTOM_API_KEY: ownKey, TOMTOM_DAILY_TILE_BUDGET: undefined });
  routes.set(
    '/api.tomtom.com/traffic/map/4/tile/flow/relative/10/235/415.pbf',
    reply(500, secretBody(`?key=${ownKey}`)),
  );
  const logs = captureLogs(t);
  const { tomtomProxy } = await mod('server/providers/traffic.js');
  const handler = installPlugin(tomtomProxy()).get('/api/tomtom');
  const res = fakeRes();
  await handler(localReq('/flow/10/235/415.pbf'), res);
  assert.equal(res.statusCode, 502);
  assert.deepEqual(JSON.parse(res.body), { error: 'upstream' });
  if (BASE_MODE) return;
  assertFailureLine(
    logs,
    /\[tomtom-proxy\] 10\/235\/415 fetch failed \(target=/,
    {
      status: 500,
      target:
        'GET https://api.tomtom.com/traffic/map/4/tile/flow/relative/10/235/415.pbf',
    },
  );
  assertSafe(logs, 'traffic');
});

test('traffic.js: connection refused -> same 502, class instead of message', async (t) => {
  tempCwd(t);
  withEnv(t, { TOMTOM_API_KEY: ownKey });
  t.mock.method(globalThis, 'fetch', () =>
    // A closed localhost port: ECONNREFUSED, no network.
    realFetch(REFUSED),
  );
  const logs = captureLogs(t);
  const { tomtomProxy } = await mod('server/providers/traffic.js');
  const handler = installPlugin(tomtomProxy()).get('/api/tomtom');
  const res = fakeRes();
  await handler(localReq('/flow/10/236/415.pbf'), res);
  assert.equal(res.statusCode, 502);
  if (BASE_MODE) return;
  const line = logs.find((l) => l.includes('fetch failed'));
  assert.match(
    line,
    /stage=headers class=network code=ECONNREFUSED elapsed_ms=\d+ timeout_ms=15000/,
  );
  assertSafe(logs, 'traffic refused');
});

// --------------------------------------------------------- 2. firms.js
test('firms.js: 500 + non-CSV 200 -> same 502, per-source lines, MAP_KEY masked', async (t) => {
  stubFetch(t);
  tempCwd(t);
  withEnv(t, { FIRMS_MAP_KEY: ownKey });
  routes.set(
    `/firms.modaps.eosdis.nasa.gov/api/area/csv/${ownKey}/VIIRS_NOAA20_NRT/`,
    reply(500, secretBody()),
  );
  routes.set(
    `/firms.modaps.eosdis.nasa.gov/api/area/csv/${ownKey}/`,
    reply(200, `Invalid MAP_KEY ${ownKey}. ${secretBody()}`, {
      'content-type': 'text/plain',
    }),
  );
  routes.set(
    '/firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/',
    reply(404, secretBody()),
  );
  const logs = captureLogs(t);
  const { firmsProxy } = await mod('server/providers/firms.js');
  const handler = installPlugin(firmsProxy()).get('/api/firms');
  const res = fakeRes();
  await handler(localReq('/'), res);
  assert.equal(res.statusCode, 502);
  assert.deepEqual(JSON.parse(res.body), {
    error: 'firms fetch failed and no cache available',
  });
  const st = fakeRes();
  await handler(localReq('/status'), st);
  assert.equal(st.statusCode, 200);
  assert.equal(JSON.parse(st.body).transactions, null);
  if (BASE_MODE) return;
  assertFailureLine(
    logs,
    /\[firms-proxy\] VIIRS_NOAA20_NRT fetch failed: target=/,
    {
      status: 500,
      target:
        'GET https://firms.modaps.eosdis.nasa.gov/api/area/csv/REDACTED/VIIRS_NOAA20_NRT/world/2',
    },
  );
  const nonCsv = assertFailureLine(
    logs,
    /\[firms-proxy\] MODIS_NRT fetch failed: reason=non_csv target=/,
    { status: 200 },
  );
  assert.match(nonCsv, /Invalid MAP_KEY REDACTED/);
  assertFailureLine(logs, /\[firms-proxy\] mapkey status failed: target=/, {
    status: 404,
    target: 'GET https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/',
  });
  assertSafe(logs, 'firms');
});

// ------------------------------------------------------- 3. opensky.js
test('opensky.js: OAuth 401, states 503, adsb.lol 500 -> same replies, gated lines', async (t) => {
  stubFetch(t);
  withEnv(t, {
    OPENSKY_AUTH_MODE: 'oauth',
    OPENSKY_CLIENT_ID: `synthclient${nonce()}`,
    OPENSKY_CLIENT_SECRET: ownKey,
  });
  routes.set(
    '/auth.opensky-network.org/',
    reply(
      401,
      JSON.stringify({
        error: 'invalid_client',
        error_description: `bad secret ${ownKey}`,
        access_token: SYNTH.token,
      }),
      { 'content-type': 'application/json' },
    ),
  );
  routes.set('/opensky-network.org/api/states/all', reply(503, secretBody()));
  routes.set(
    '/api.adsb.lol/v2/lat/',
    reply(500, secretBody('', { echoOwnKey: false })),
  );
  const logs = captureLogs(t);
  const { openSkyProxy } = await mod('server/providers/aircraft/opensky.js');
  const handler = installPlugin(openSkyProxy()).get('/api/flights');
  const res = fakeRes();
  await handler(localReq('/?lat=30.27&lon=-97.74'), res, () => {});
  // Unchanged: no cache and no fallback -> the upstream status and body relay.
  assert.equal(res.statusCode, 503);
  assert.equal(res.body, secretBody());
  const res2 = fakeRes();
  await handler(localReq('/'), res2, () => {});
  assert.equal(res2.statusCode, 503);
  if (BASE_MODE) return;
  const oauth = assertFailureLine(
    logs,
    /\[OpenSky\] OAuth client_credentials failed: target=/,
    {
      status: 401,
      target:
        'POST https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
    },
  );
  assert.match(oauth, /invalid_client/);
  assertFailureLine(logs, /\[OpenSky\] states upstream HTTP 503 target=/, {
    status: 503,
    target: 'GET https://opensky-network.org/api/states/all',
  });
  assertFailureLine(logs, /\[adsb\.lol Flights Fallback\] target=/, {
    status: 500,
    target: 'GET https://api.adsb.lol/v2/lat/_/lon/_/dist/250',
  });
  // Gate: the second 503 within 60 s writes no second states line.
  assert.equal(
    logs.filter((l) => l.includes('states upstream HTTP')).length,
    1,
  );
  assert.equal(
    logs.filter((l) => l.includes('OAuth client_credentials')).length,
    1,
  );
  assert.doesNotMatch(logs.join('\n'), /30\.2|-97\.7/, 'view anchor logged');
  assertSafe(logs, 'opensky');
});

// --------------------------------------------------- 4. regional/http.js
test('regional/http.js: 500 -> same rejection, one gated line, no query', async (t) => {
  stubFetch(t);
  routes.set('/api.open-meteo.com/v1/forecast', reply(500, secretBody()));
  const logs = captureLogs(t);
  const { fetchRegionalJson } = await mod('server/providers/regional/http.js');
  const url = `https://api.open-meteo.com/v1/forecast?latitude=30.27&longitude=-97.74&apikey=${ownKey}`;
  for (let i = 0; i < 3; i++)
    await assert.rejects(fetchRegionalJson(url), {
      message: 'Upstream returned 500',
    });
  if (BASE_MODE) return;
  assertFailureLine(logs, /\[regional-proxy\] upstream HTTP 500 target=/, {
    status: 500,
    target: 'GET https://api.open-meteo.com/v1/forecast',
  });
  assert.equal(logs.length, 1, 'gated: 3 failures inside 60 s -> 1 line');
  assert.doesNotMatch(logs.join('\n'), /30\.27|latitude/);
  assertSafe(logs, 'regional');
});

test('regional/http.js: refused -> same rejection class, line has class/timeout', async (t) => {
  t.mock.method(globalThis, 'fetch', (input, init) => realFetch(REFUSED, init));
  const logs = captureLogs(t);
  const { fetchRegionalText } = await mod('server/providers/regional/http.js');
  await assert.rejects(
    fetchRegionalText('https://news.google.com/rss/search?q=Austin'),
    TypeError,
  );
  if (BASE_MODE) return;
  assert.match(
    logs[0],
    /\[regional-proxy\] upstream request failed target="GET https:\/\/news\.google\.com\/rss\/search" stage=headers class=network code=ECONNREFUSED elapsed_ms=\d+ timeout_ms=9000/,
  );
});

// --------------------------------------------------- 5. local-receivers.js
test('local-receivers.js: real localhost 500 feed -> same snapshot, status-change line has status/body', async (t) => {
  let hits = 0;
  routes.set('/p16/data/aircraft.json', (req, res) => {
    hits += 1;
    reply(500, secretBody('', { echoOwnKey: false }))(req, res);
  });
  const lines = [];
  const logger = {
    warn: (l) => {
      lines.push(l);
      if (LOG_OUT) appendFileSync(LOG_OUT, `${l}\n`);
    },
    info: (l) => lines.push(l),
  };
  const { createLocalReceiversHandler } = await mod(
    'server/providers/local-receivers.js',
  );
  const handler = createLocalReceiversHandler({
    feedsValue: `1090=http://127.0.0.1:${PORT}/p16/data/aircraft.json`,
    logger,
    cacheMs: 0,
  });
  const res = fakeRes();
  await handler.handle({ url: '/', method: 'GET' }, res);
  const json = JSON.parse(res.body);
  assert.equal(hits, 1);
  assert.equal(
    json.feeds?.[0]?.status ?? json.status?.[0]?.status,
    'unreachable',
  );
  if (BASE_MODE) return;
  const line = assertFailureLine(
    lines,
    /\[local-receivers\] 1090 MHz unreachable \(HTTP_STATUS\) status=500/,
    {
      status: 500,
    },
  );
  assert.doesNotMatch(line, /target=|127\.0\.0\.1/, 'feed URL is not logged');
  assertSafe(lines, 'local-receivers');
});

// ------------------------------------------------------ 6. cctv/sources.js
const CCTV_LOADERS = [
  'loadAustinSourcesFromOpenData',
  'loadCaltransSourcesFromOpenData',
  'loadTflSourcesFromOpenData',
  'loadOntarioSourcesFromOpenData',
  'loadFintrafficSourcesFromOpenData',
  'loadDriveBcSourcesFromOpenData',
  'loadTxdotSourcesFromOpenData',
  'loadTarkteeSourcesFromDatex',
  'loadNswSourcesFromOpenData',
  'loadCalgarySourcesFromOpenData',
  'loadCataloniaSourcesFromOpenData',
  'loadDelDOTSourcesFromOpenData',
  'loadKingCountySourcesFromOpenData',
  'loadWsdotSourcesFromOpenData',
  'loadVegvesenSourcesFromOpenData',
  'loadNycSourcesFromOpenData',
  'loadTorontoSourcesFromOpenData',
];
test('cctv/sources.js: every loader on a 400/500 body -> still [], line has status/body', async (t) => {
  stubFetch(t);
  withEnv(t, {
    TFL_APP_KEY: ownKey,
    CCTV_CALTRANS_DISTRICTS: '4',
    CCTV_TXDOT_DISTRICTS: 'AUS',
  });
  routes.set(
    '/',
    reply(400, secretBody(`?app_key=${ownKey}`, { echoOwnKey: false })),
  );
  // TfL holds TFL_APP_KEY: its stub also echoes the bare key.
  routes.set('/api.tfl.gov.uk/', reply(400, secretBody()));
  t.after(() => routes.delete('/api.tfl.gov.uk/'));
  t.after(() => routes.delete('/'));
  const sources = await mod('server/providers/cctv/sources.js');
  const logs = captureLogs(t);
  for (const name of CCTV_LOADERS) {
    const before = logs.length;
    const out = await sources[name]();
    assert.deepEqual(out, [], `${name} still returns []`);
    if (BASE_MODE) continue;
    const mine = logs.slice(before);
    assertFailureLine(mine, /\[CCTV\] .*(failed|error)/, { status: 400 });
    const line = mine.find((l) => /status=400/.test(l));
    assert.match(line, /target="GET https:\/\/[^"?]+"/, `${name}: ${line}`);
    assertSafe(mine, name);
  }
});

test('cctv/sources.js: TxDOT refused -> [], class names the cause', async (t) => {
  withEnv(t, { CCTV_TXDOT_DISTRICTS: 'AUS' });
  t.mock.method(globalThis, 'fetch', (input, init) => realFetch(REFUSED, init));
  const logs = captureLogs(t);
  const { loadTxdotSourcesFromOpenData } = await mod(
    'server/providers/cctv/sources.js',
  );
  assert.deepEqual(await loadTxdotSourcesFromOpenData(), []);
  if (BASE_MODE) return;
  assert.match(
    logs.join('\n'),
    /\[CCTV\] TxDOT district fetch failed: fetch failed target="GET https:\/\/[^"]+" stage=headers class=network code=ECONNREFUSED elapsed_ms=\d+ timeout_ms=15000/,
  );
});

test('stub accounting: every upstream request went to the localhost stub', () => {
  assert.ok(seen.length > 0);
  for (const url of seen) assert.ok(url.startsWith('/'), url);
});
