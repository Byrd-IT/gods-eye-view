// Byrd-IT b12 (script fix program, STANDARD KB SeY7S6EBs9sMHq_KSKLr R3/R7/R8):
// every server provider that calls an upstream must, on failure, log the
// target, HTTP status or cause class, elapsed time and a redacted <=300-byte
// body snippet, never a key, and keep its client-facing response unchanged.
// Each provider is forced through a mock 500, a timeout and a network error.
// No test here reaches the network: fetch is always mocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Readable } from 'node:stream';
import { promises as fsp } from 'node:fs';
import { createApiFetch } from '../../server/mcp/services.js';
import { adsbLolProxy } from '../../server/providers/aircraft/adsb-lol.js';
import { handleHudSummary } from '../../server/providers/openai/hud-summary.js';
import { fetchOverpassPayload } from '../../server/providers/overpass/transport.js';
import { googlePlacesContextProxy } from '../../server/providers/places/google.js';
import {
  installRouteMiddleware,
  _resetRouteUpstreamForTest,
  _setRouteUpstreamIntervalForTest,
} from '../../server/providers/places/routes.js';
import { celestrakProxy } from '../../server/providers/space.js';

const BODY_500 =
  '<html><body><h1>500</h1> upstream exploded; trace=42 ' +
  'x'.repeat(800) +
  '</body></html>';
const GOOGLE_KEY = 'AIzaSyFIXTURE-google-key-0123456789abc';
const OPENAI_KEY = 'sk-fixture-openai-SECRET-0123456789';

/** A thrown fetch the way undici reports a refused/unresolvable host. */
function networkError(code = 'ECONNREFUSED') {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error(`connect ${code} 10.0.0.1:443`), { code }),
  });
}

/** Mock fetch that never answers until its signal aborts (a hung upstream). */
function hangUntilAbort(init) {
  return new Promise((_, reject) => {
    const signal = init?.signal;
    assert.ok(signal, 'every upstream call must carry an AbortSignal');
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), {
      once: true,
    });
  });
}

/**
 * Make AbortSignal.timeout(ms) fire after a few real ms, recording the
 * requested ms, so the timeout path is exercised without waiting 10-30 s.
 */
function fastTimeouts(t) {
  const requested = [];
  t.mock.method(AbortSignal, 'timeout', (ms) => {
    requested.push(ms);
    const controller = new AbortController();
    setTimeout(
      () =>
        controller.abort(
          new DOMException(
            'The operation was aborted due to timeout',
            'TimeoutError',
          ),
        ),
      5,
    );
    return controller.signal;
  });
  return requested;
}

// GEV_B12_PRINT_LOGS=1 echoes every captured provider log line to stdout,
// for build evidence.
const PRINT = process.env.GEV_B12_PRINT_LOGS === '1';
const echo = (line) => {
  if (PRINT) process.stdout.write(`LOG| ${line}\n`);
};

/** Capture console.warn/error/info lines for one test. */
function captureLogs(t) {
  const lines = [];
  for (const level of ['warn', 'error', 'info'])
    t.mock.method(console, level, (...args) => {
      const line = `${level.toUpperCase()} ${args.join(' ')}`;
      echo(line);
      lines.push(args.join(' '));
    });
  return lines;
}

/** The JSON-quoted body= value of a log line. */
function loggedBody(line) {
  const match = line.match(/body=("(?:[^"\\]|\\.)*")/);
  assert.ok(match, `log line carries body=: ${line}`);
  return JSON.parse(match[1]);
}

/** Shared assertions for a non-OK upstream log line. */
function assertHttpFailureLine(line, { target, status = 500 }) {
  assert.match(line, new RegExp(`status=${status}\\b`));
  assert.match(line, /elapsed_ms=\d+/);
  assert.ok(line.includes(target), `target ${target} in: ${line}`);
  const body = loggedBody(line);
  assert.ok(body.length > 0 && body.length <= 300, `body length ${body.length}`);
  assert.match(body, /upstream exploded; trace=42/);
  assert.doesNotMatch(body, /<html>|<h1>/);
}

function assertNoSecrets(lines) {
  const all = lines.join('\n');
  assert.ok(!all.includes(GOOGLE_KEY), 'Google key leaked to the log');
  assert.ok(!all.includes(OPENAI_KEY), 'OpenAI key leaked to the log');
  assert.doesNotMatch(all, /AIza[\w-]{20,}|sk-[\w-]{12,}/);
}

/** Minimal connect-style install for middleware plugins. */
function installPlugin(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
  });
  return routes;
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

// ---------------------------------------------------------------- 1. mcp/services.js

test('mcp api fetch: 500 is logged with method/url/status/elapsed/body and returned unchanged', async (t) => {
  const logs = [];
  const apiFetch = createApiFetch({
    apiBase: 'http://127.0.0.1:5000',
    fetchImpl: async () => new Response(BODY_500, { status: 500 }),
    log: (line) => {
      echo(line);
      logs.push(line);
    },
  });
  const res = await apiFetch('/api/launches?key=SHOULD-NOT-LOG', {
    method: 'POST',
  });
  assert.equal(res.status, 500);
  assert.equal(await res.text(), BODY_500, 'the caller still reads the full body');
  assert.equal(logs.length, 1);
  assertHttpFailureLine(logs[0], {
    target: 'method=POST url=http://127.0.0.1:5000/api/launches?key=REDACTED',
  });
  assert.ok(!logs[0].includes('SHOULD-NOT-LOG'));
});

test('mcp api fetch: timeout is logged with class=timeout and the error is re-thrown', async (t) => {
  const requested = fastTimeouts(t);
  const logs = [];
  const apiFetch = createApiFetch({
    fetchImpl: (_url, init) => hangUntilAbort(init),
    log: (line) => {
      echo(line);
      logs.push(line);
    },
  });
  await assert.rejects(apiFetch('/api/military'), { name: 'TimeoutError' });
  assert.deepEqual(requested, [30_000]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /method=GET url=http:\/\/localhost:4173\/api\/military/);
  assert.match(logs[0], /class=timeout elapsed_ms=\d+ timeout_ms=30000/);
});

test('mcp api fetch: network error is logged with its code and re-thrown as-is', async () => {
  const logs = [];
  const error = networkError('ECONNREFUSED');
  const apiFetch = createApiFetch({
    fetchImpl: async () => {
      throw error;
    },
    log: (line) => {
      echo(line);
      logs.push(line);
    },
  });
  await assert.rejects(apiFetch('/api/x'), (e) => e === error);
  assert.match(logs[0], /class=network code=ECONNREFUSED elapsed_ms=\d+/);
  assert.doesNotMatch(logs[0], /10\.0\.0\.1/, 'no raw error message');
});

test('mcp bundled read keeps the 404 contract and logs the real cause', async () => {
  const logs = [];
  const apiFetch = createApiFetch({
    log: (line) => {
      echo(line);
      logs.push(line);
    },
  });
  const missing = new URL(
    '../data/local_data/does-not-exist.json',
    import.meta.url,
  ).href;
  const res = await apiFetch(missing);
  assert.equal(res.status, 404);
  assert.match(logs[0], /bundled read failed path=does-not-exist\.json code=ENOENT status=404/);
  const outside = await apiFetch('file:///etc/passwd');
  assert.equal(outside.status, 404);
  assert.match(logs[1], /refused/);
});

// ---------------------------------------------------------------- 2. adsb.lol

async function military(handler) {
  const res = fakeRes();
  await handler({ url: '/', method: 'GET' }, res, () => {});
  return res;
}

test('adsb.lol: 500 relays status/body unchanged and logs target/status/elapsed/body', async (t) => {
  const logs = captureLogs(t);
  t.mock.method(globalThis, 'fetch', async () => new Response(BODY_500, { status: 500 }));
  const handler = installPlugin(adsbLolProxy()).get('/api/military');
  const res = await military(handler);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body, BODY_500);
  assert.equal(res.headers['x-feed-cache'], 'MISS');
  assert.ok(Number(res.headers['retry-after']) > 0);
  assert.equal(logs.length, 1);
  assertHttpFailureLine(logs[0], { target: 'target="GET https://api.adsb.lol/v2/mil"' });
  assert.match(logs[0], /cooling down 15 s/);
});

test('adsb.lol: 500 with cache serves stale first, then logs the body snippet', async (t) => {
  const logs = captureLogs(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () =>
    ++calls === 1
      ? Response.json({ ac: [{ hex: 'abc' }] })
      : new Response(BODY_500, { status: 500 }),
  );
  const handler = installPlugin(adsbLolProxy()).get('/api/military');
  const fresh = await military(handler);
  now += 13_000;
  const stale = await military(handler);
  assert.equal(stale.statusCode, 200);
  assert.equal(stale.body, fresh.body);
  assert.equal(stale.headers['x-feed-cache'], 'STALE');
  assert.equal(stale.headers['x-ads-b-upstream-status'], '500');
  assert.equal(logs.length, 1);
  assertHttpFailureLine(logs[0], { target: 'target="GET https://api.adsb.lol/v2/mil"' });
  assert.match(logs[0], /serving stale/);
});

test('adsb.lol: timeout returns the same 502 and logs class=timeout', async (t) => {
  const requested = fastTimeouts(t);
  const logs = captureLogs(t);
  t.mock.method(globalThis, 'fetch', (_url, init) => hangUntilAbort(init));
  const res = await military(installPlugin(adsbLolProxy()).get('/api/military'));
  assert.deepEqual(requested, [10_000]);
  assert.equal(res.statusCode, 502);
  assert.deepEqual(JSON.parse(res.body), { error: 'ADS-B proxy error' });
  assert.match(logs[0], /target="GET https:\/\/api\.adsb\.lol\/v2\/mil" class=timeout status=none elapsed_ms=\d+ timeout_ms=10000/);
});

test('adsb.lol: network error returns the same 502 and logs the cause code', async (t) => {
  const logs = captureLogs(t);
  t.mock.method(globalThis, 'fetch', async () => {
    throw networkError('ENOTFOUND');
  });
  const res = await military(installPlugin(adsbLolProxy()).get('/api/military'));
  assert.equal(res.statusCode, 502);
  assert.deepEqual(JSON.parse(res.body), { error: 'ADS-B proxy error' });
  assert.match(logs[0], /class=dns code=ENOTFOUND status=none elapsed_ms=\d+/);
});

// ---------------------------------------------------------------- 3. OpenAI HUD summary

function hudRequest(t, remoteAddress) {
  const prior = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = OPENAI_KEY;
  t.after(() => {
    if (prior === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prior;
  });
  return new Promise((resolve, reject) => {
    const req = Readable.from([
      Buffer.from(JSON.stringify({ secretPrompt: 'PROMPT-CANARY-77' })),
    ]);
    Object.assign(req, {
      method: 'POST',
      url: '/',
      headers: { host: 'localhost:4173', 'content-type': 'application/json' },
      socket: { remoteAddress },
    });
    const res = fakeRes();
    res.end = (body) => resolve({ status: res.statusCode, body });
    handleHudSummary(req, res).catch(reject);
  });
}

function assertHudLogsClean(logs) {
  assertNoSecrets(logs);
  assert.ok(!logs.join('\n').includes('PROMPT-CANARY-77'), 'prompt/context leaked');
}

test('HUD summary: 500 keeps the generic reply and logs status/elapsed/redacted body', async (t) => {
  const logs = captureLogs(t);
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(
      `{"error":{"message":"Incorrect API key provided: ${OPENAI_KEY}. trace upstream exploded; trace=42"}}`,
      { status: 500 },
    ),
  );
  const res = await hudRequest(t, '10.77.0.1');
  assert.equal(res.status, 500);
  assert.deepEqual(JSON.parse(res.body), {
    summary: null,
    error: 'OpenAI HUD summary request failed',
  });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /target="POST https:\/\/api\.openai\.com\/v1\/responses" status=500 elapsed_ms=\d+/);
  assert.match(loggedBody(logs[0]), /Incorrect API key provided: REDACTED/);
  assertHudLogsClean(logs);
});

test('HUD summary: timeout keeps the 502 reply and logs stage/class/elapsed', async (t) => {
  const requested = fastTimeouts(t);
  const logs = captureLogs(t);
  t.mock.method(globalThis, 'fetch', (_url, init) => hangUntilAbort(init));
  const res = await hudRequest(t, '10.77.0.2');
  assert.deepEqual(requested, [15_000]);
  assert.equal(res.status, 502);
  assert.deepEqual(JSON.parse(res.body), { error: 'OpenAI HUD summary request failed' });
  assert.match(logs[0], /stage=upstream class=timeout target="POST https:\/\/api\.openai\.com\/v1\/responses" status=none elapsed_ms=\d+ timeout_ms=15000/);
  assertHudLogsClean(logs);
});

test('HUD summary: network error keeps the 502 reply and logs the cause code', async (t) => {
  const logs = captureLogs(t);
  t.mock.method(globalThis, 'fetch', async () => {
    throw networkError('ECONNRESET');
  });
  const res = await hudRequest(t, '10.77.0.3');
  assert.equal(res.status, 502);
  assert.match(logs[0], /stage=upstream class=network code=ECONNRESET/);
  assertHudLogsClean(logs);
});

// ---------------------------------------------------------------- 4. Overpass transport

const OVERPASS_REFUSAL = {
  error: 'Configured Overpass upstream unavailable',
  code: 'OVERPASS_UNAVAILABLE',
  retryable: true,
};

test('Overpass: 500 keeps the 502 refusal and logs endpoint/status/elapsed/body (no credentials)', async (t) => {
  const logs = captureLogs(t);
  const payload = await fetchOverpassPayload('data=x', 1 << 20, {
    endpoints: ['https://user:pa55word@op-500.example/api/interpreter?token=abc'],
    fetchImpl: async () => new Response(BODY_500, { status: 500 }),
  });
  assert.equal(payload.status, 502);
  assert.deepEqual(
    { ...JSON.parse(payload.body), retryAfterMs: undefined },
    { ...OVERPASS_REFUSAL, retryAfterMs: undefined },
  );
  assert.equal(logs.length, 1);
  assertHttpFailureLine(logs[0], {
    target: 'endpoint=https://op-500.example/api/interpreter',
  });
  assert.match(logs[0], /class=http/);
  assert.doesNotMatch(logs[0], /pa55word|user:|token=abc/);
});

test('Overpass: timeout keeps the 502 refusal and logs class=timeout', async (t) => {
  const logs = captureLogs(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let called;
  const fetched = new Promise((resolve) => {
    called = resolve;
  });
  const pending = fetchOverpassPayload('data=x', 1 << 20, {
    endpoints: ['https://op-timeout.example/api/interpreter'],
    fetchImpl: (_url, init) => {
      called();
      return hangUntilAbort(init);
    },
  });
  await fetched;
  t.mock.timers.tick(22_000);
  const payload = await pending;
  assert.equal(payload.status, 502);
  assert.equal(JSON.parse(payload.body).code, 'OVERPASS_UNAVAILABLE');
  assert.match(logs[0], /endpoint=https:\/\/op-timeout\.example\/api\/interpreter class=timeout status=none elapsed_ms=\d+ timeout_ms=22000/);
});

test('Overpass: DNS failure and malformed body are told apart in the log', async (t) => {
  const logs = captureLogs(t);
  const dns = await fetchOverpassPayload('data=x', 1 << 20, {
    endpoints: ['https://op-dns.example/api/interpreter'],
    fetchImpl: async () => {
      throw networkError('ENOTFOUND');
    },
  });
  const malformed = await fetchOverpassPayload('data=x', 1 << 20, {
    endpoints: ['https://op-bad.example/api/interpreter'],
    fetchImpl: async () => new Response('{"not":"overpass"}'),
  });
  assert.equal(dns.status, 502);
  assert.equal(malformed.status, 502);
  assert.match(logs[0], /op-dns\.example.* class=dns code=ENOTFOUND/);
  assert.match(logs[1], /op-bad\.example.* class=malformed status=200/);
});

// ---------------------------------------------------------------- 5a. Google Places

function googleRoute(fetchImpl, route = '/api/google/nearby-places', endpoints = {}) {
  return installPlugin(
    googlePlacesContextProxy({ resolveApiKey: () => GOOGLE_KEY, fetchImpl, endpoints }),
  ).get(route);
}

async function callGoogle(handler, url, peer) {
  const res = fakeRes();
  await handler(
    { url, method: 'GET', headers: { host: 'localhost:4173' }, socket: { remoteAddress: peer } },
    res,
  );
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

test('Google Places: 500 keeps status + places[] contract and logs status/body with the key stripped', async (t) => {
  const logs = captureLogs(t);
  const handler = googleRoute(
    async () =>
      new Response(
        `{"error":{"code":500,"message":"upstream exploded; trace=42 key=${GOOGLE_KEY}"}}`,
        { status: 500 },
      ),
    '/api/google/text-search',
    { textSearch: `https://places.example/v1/places:searchText?key=${GOOGLE_KEY}` },
  );
  const res = await callGoogle(handler, '/?q=capitol&lat=30.27&lon=-97.74', '10.88.0.1');
  assert.equal(res.status, 500);
  assert.deepEqual(res.body.places, []);
  assert.equal(res.body.error, `upstream exploded; trace=42 key=${GOOGLE_KEY}`, 'client reply unchanged (relays data.error.message as before)');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /text-search upstream HTTP 500 target="POST https:\/\/places\.example\/v1\/places:searchText\?key=REDACTED" status=500 elapsed_ms=\d+/);
  assert.match(loggedBody(logs[0]), /upstream exploded; trace=42/);
  assertNoSecrets(logs);
});

test('Google Places: timeout keeps the 502 contract and logs class=timeout', async (t) => {
  const requested = fastTimeouts(t);
  const logs = captureLogs(t);
  const handler = googleRoute((_url, init) => hangUntilAbort(init));
  const res = await callGoogle(handler, '/?lat=30.27&lon=-97.74', '10.88.0.2');
  assert.deepEqual(requested, [10_000]);
  assert.equal(res.status, 502);
  assert.deepEqual(res.body.places, []);
  assert.equal(res.body.error, 'The operation was aborted due to timeout');
  assert.match(logs[0], /nearby-places request failed target="POST https:\/\/places\.googleapis\.com\/v1\/places:searchNearby" class=timeout status=none elapsed_ms=\d+ timeout_ms=10000/);
  assertNoSecrets(logs);
});

test('Google Places: network error keeps the 502 contract and logs the cause code', async (t) => {
  const logs = captureLogs(t);
  const handler = googleRoute(async () => {
    throw networkError('ECONNREFUSED');
  });
  const res = await callGoogle(handler, '/?lat=30.27&lon=-97.74', '10.88.0.3');
  assert.equal(res.status, 502);
  assert.deepEqual(res.body, { error: 'fetch failed', places: [] });
  assert.match(logs[0], /class=network code=ECONNREFUSED/);
  assertNoSecrets(logs);
});

// ---------------------------------------------------------------- 5b. OSRM routes

async function callRoute(fetchImpl, peer, endpoints = {}) {
  _resetRouteUpstreamForTest();
  _setRouteUpstreamIntervalForTest(0);
  let handler;
  installRouteMiddleware({ use: (_r, h) => (handler = h) }, { endpoints, fetchImpl });
  const res = fakeRes();
  await handler(
    {
      url: '/api/route?profile=car&coords=-97.74,30.27;-97.75,30.28',
      method: 'GET',
      headers: {},
      socket: { remoteAddress: peer },
    },
    res,
  );
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

test('routes: 500 keeps "no route found" and logs target/status/elapsed/body (no coordinates)', async (t) => {
  const logs = captureLogs(t);
  const res = await callRoute(
    async () => new Response(BODY_500, { status: 500 }),
    '10.99.0.1',
    { car: 'https://u:p@osrm.example/routed-car' },
  );
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: false, error: 'no route found' });
  assert.equal(logs.length, 1);
  assertHttpFailureLine(logs[0], {
    target: 'target="GET https://osrm.example/routed-car/route/v1/driving/<2 coords>"',
  });
  assert.doesNotMatch(logs[0], /-97\.74|u:p@/);
});

test('routes: timeout keeps "route proxy error" and logs class=timeout', async (t) => {
  const logs = captureLogs(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let called;
  const fetched = new Promise((resolve) => {
    called = resolve;
  });
  const pending = callRoute((_url, init) => {
    called();
    return hangUntilAbort(init);
  }, '10.99.0.2');
  await fetched;
  t.mock.timers.tick(12_000);
  const res = await pending;
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: false, error: 'route proxy error' });
  assert.match(logs[0], /upstream request failed target="GET https:\/\/routing\.openstreetmap\.de\/routed-car\/route\/v1\/driving\/<2 coords>" class=timeout status=none elapsed_ms=\d+ timeout_ms=12000/);
  assert.match(logs[1], /\[Route Proxy\] request failed class=AbortError response="route proxy error"/);
});

test('routes: network error keeps "route proxy error" and logs the cause code', async (t) => {
  const logs = captureLogs(t);
  const res = await callRoute(async () => {
    throw networkError('EAI_AGAIN');
  }, '10.99.0.3');
  assert.deepEqual(res.body, { ok: false, error: 'route proxy error' });
  assert.match(logs[0], /class=dns code=EAI_AGAIN/);
});

// ---------------------------------------------------------------- 6. CelesTrak halt evidence

const HALT_FILE = path.join(process.cwd(), '.gev-cache', 'celestrak-HALT.json');

function memoryDisk(t) {
  const files = new Map();
  t.mock.method(fsp, 'readFile', async (p) => {
    if (!files.has(String(p)))
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return files.get(String(p));
  });
  t.mock.method(fsp, 'writeFile', async (p, data) => {
    files.set(String(p), String(data));
  });
  t.mock.method(fsp, 'mkdir', async () => {});
  t.mock.method(fsp, 'stat', async () => {
    throw new Error('no stat');
  });
  return files;
}

async function celestrak(url) {
  let handler;
  celestrakProxy().configureServer({
    middlewares: {
      use: (route, h) => {
        if (route === '/api/celestrak') handler = h;
      },
    },
  });
  const res = fakeRes();
  await handler({ url }, res);
  return res;
}

test('CelesTrak: 500 halts as before and records url/status/elapsed/body in the halt file and log', async (t) => {
  const files = memoryDisk(t);
  const logs = captureLogs(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return new Response(BODY_500, { status: 500 });
  });
  const res = await celestrak('/stations');
  assert.equal(res.statusCode, 502);
  assert.equal(res.body, 'celestrak fetch failed and no cache available');
  assert.equal(calls, 1, 'exactly one (mocked) CelesTrak request');
  const halt = JSON.parse(files.get(HALT_FILE));
  assert.equal(halt.halted, true);
  assert.equal(halt.reason, 'HTTP 500', 'reason label unchanged');
  assert.equal(halt.status, 500);
  assert.equal(
    halt.url,
    'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=csv',
  );
  assert.ok(Number.isInteger(halt.elapsed_ms));
  assert.ok(halt.body.length <= 300);
  assert.match(halt.body, /upstream exploded; trace=42/);
  assert.doesNotMatch(halt.body, /<html>/);
  assert.match(halt.clear, /delete .*celestrak-HALT\.json/);
  assert.equal(logs.length, 1);
  assertHttpFailureLine(logs[0], {
    target: 'url="https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=csv"',
  });
  assert.match(logs[0], /HALTED until an operator deletes/);
  // Halt policy unchanged: a second group is refused without a request.
  const second = await celestrak('/starlink');
  assert.equal(second.statusCode, 503);
  assert.equal(calls, 1);
});

test('CelesTrak: timeout halts and records class=timeout + url/elapsed (no message)', async (t) => {
  const files = memoryDisk(t);
  const requested = fastTimeouts(t);
  const logs = captureLogs(t);
  t.mock.method(globalThis, 'fetch', (_url, init) => hangUntilAbort(init));
  const res = await celestrak('/active');
  assert.deepEqual(requested, [20_000]);
  assert.equal(res.statusCode, 502);
  const halt = JSON.parse(files.get(HALT_FILE));
  assert.equal(halt.reason, 'upstream request failed');
  assert.equal(halt.error_class, 'timeout');
  assert.equal(halt.status, null);
  assert.equal(halt.timeout_ms, 20000);
  assert.match(halt.url, /GROUP=active/);
  assert.match(logs[0], /url="https:\/\/celestrak\.org\/[^"]*GROUP=active[^"]*" status=null elapsed_ms=\d+ timeout_ms=20000 error_class="timeout"/);
  assert.doesNotMatch(logs.join('\n'), /aborted due to timeout/);
});

test('CelesTrak: network error halts and records only the cause code', async (t) => {
  const files = memoryDisk(t);
  const logs = captureLogs(t);
  t.mock.method(globalThis, 'fetch', async () => {
    throw networkError('ECONNREFUSED');
  });
  await celestrak('/geo');
  const halt = JSON.parse(files.get(HALT_FILE));
  assert.equal(halt.reason, 'upstream request failed');
  assert.equal(halt.error_class, 'network code=ECONNREFUSED');
  assert.doesNotMatch(files.get(HALT_FILE) + logs.join('\n'), /10\.0\.0\.1/);
});

test('CelesTrak: a 200 that is not GP CSV records the body as evidence', async (t) => {
  const files = memoryDisk(t);
  captureLogs(t);
  t.mock.method(globalThis, 'fetch', async () =>
    new Response('GP data has not updated since your last successful download'),
  );
  await celestrak('/stations');
  const halt = JSON.parse(files.get(HALT_FILE));
  assert.equal(halt.reason, 'upstream request failed');
  assert.equal(halt.status, 200);
  assert.match(halt.error_class, /malformed/);
  assert.match(halt.body, /has not updated since your last successful download/);
});
