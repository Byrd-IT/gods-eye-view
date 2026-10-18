// Byrd-IT b12 repair (review t_49610c02, repair t_9db45c90): adversarial
// tests for the provider failure logging added in b12.
//  1. CelesTrak latches the halt on refusal HEADERS, before reading the body;
//     the bounded body evidence enriches that same latch and never re-opens
//     or re-creates it (GP and SATCAT, operator clear, evidence deadline).
//  2. Every copied log sanitizer masks JSON / escaped-JSON / query / header
//     secret fields, URL userinfo, key shapes and the request's own secrets;
//     the HUD never logs body text, so a reflected prompt cannot leak.
//  3. Body-phase failures (read timeout/reset, malformed JSON) are logged
//     while the client reply stays exactly what c3884c6 returned.
//  4. Google null / non-object / malformed replies keep the c3884c6 reply.
//  5. Snippets are <= 300 UTF-8 BYTES and never split a code point.
//  6. Timeout budgets: slow-but-valid replies inside the budget are served,
//     and GEV_*_TIMEOUT_MS overrides are honoured.
// fetch and every latch disk operation are mocked: nothing here reaches the
// network or writes a real file.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { Readable } from 'node:stream';
import { createApiFetch } from '../../server/mcp/services.js';
import {
  adsbLolProxy,
  adsbLolTimeoutMs,
  ADSB_LOL_TIMEOUT_MS,
} from '../../server/providers/aircraft/adsb-lol.js';
import {
  handleHudSummary,
  hudSummaryTimeoutMs,
  HUD_SUMMARY_TIMEOUT_MS,
} from '../../server/providers/openai/hud-summary.js';
import { fetchOverpassPayload } from '../../server/providers/overpass/transport.js';
import {
  googlePlacesContextProxy,
  googlePlacesTimeoutMs,
  GOOGLE_PLACES_TIMEOUT_MS,
} from '../../server/providers/places/google.js';
import {
  installRouteMiddleware,
  _resetRouteUpstreamForTest,
  _setRouteUpstreamIntervalForTest,
} from '../../server/providers/places/routes.js';
import { celestrakProxy } from '../../server/providers/space.js';

// ------------------------------------------------------------------ helpers

function captureLogs(t) {
  const lines = [];
  for (const level of ['warn', 'error', 'info', 'log'])
    t.mock.method(console, level, (...args) => lines.push(args.join(' ')));
  return lines;
}

/** Every JSON-quoted body= value in a log line. */
function loggedBodies(line) {
  return [...line.matchAll(/body=("(?:[^"\\]|\\.)*")/g)].map((m) =>
    JSON.parse(m[1]),
  );
}

function assertSnippetBounded(snippet, label) {
  const bytes = Buffer.byteLength(snippet, 'utf8');
  assert.ok(bytes <= 300, `${label}: snippet is ${bytes} bytes`);
  assert.ok(!/\uFFFD/.test(snippet), `${label}: replacement char in snippet`);
  assert.ok(
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
      snippet,
    ),
    `${label}: split surrogate pair`,
  );
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
  const routes = new Map();
  plugin.configureServer({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
  });
  return routes;
}

/** A Response-like object whose body read throws `error`. */
function bodyThrows(status, error) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => {
      throw error;
    },
    json: async () => {
      throw error;
    },
  };
}
const bodyTimeout = () => new DOMException('body deadline', 'TimeoutError');
const bodyReset = () =>
  Object.assign(new TypeError('terminated'), {
    cause: Object.assign(new Error('other side closed'), { code: 'ECONNRESET' }),
  });

let peerSeq = 0;
const nextPeer = () =>
  `127.91.${Math.floor(++peerSeq / 250)}.${(peerSeq % 250) + 1}`;

// The canary corpus every sanitizer copy must neutralise. Each entry is one
// upstream body; "CANARY" must not survive in any log line.
const SECRET_BODIES = [
  ['JSON token', JSON.stringify({ error: 'bad', token: 'CANARY-JSON-TOKEN' })],
  ['JSON password with spaces', JSON.stringify({ password: 'CANARY pass word' })],
  [
    'JSON api_key / client_secret / accessToken',
    JSON.stringify({
      api_key: 'CANARY-AK',
      client_secret: 'CANARY-CS',
      accessToken: 'CANARY-AT',
    }),
  ],
  [
    'escaped JSON inside a string',
    JSON.stringify({ detail: JSON.stringify({ refresh_token: 'CANARY-ESC' }) }),
  ],
  [
    'double-escaped JSON',
    JSON.stringify({
      d: JSON.stringify(JSON.stringify({ secret: 'CANARY-ESC2' })),
    }),
  ],
  [
    'password containing escaped quotes',
    JSON.stringify({ password: 'CANARY"quoted", tail-CANARY' }),
  ],
  ['userinfo URL', 'see https://user:CANARY-URLPW@example.test/path'],
  [
    'escaped userinfo URL',
    '{"url":"https:\\/\\/u:CANARY-ESCURL@example.test\\/"}',
  ],
  ['Bearer header', 'Authorization: Bearer CANARY-BEARER.abc'],
  ['Basic header', 'authorization: Basic CANARYBASIC=='],
  [
    'query secrets',
    'GET /x?key=CANARY-Q1&access_token=CANARY-Q2&sig=CANARY-Q3&q=ok',
  ],
  ['header style', 'X-Api-Key: CANARY-HDR\nCookie: session=CANARY-COOKIE'],
  ['single-quoted repr', "{'session_id': 'CANARY-PY'}"],
  [
    'key shapes',
    'sk-proj-CANARYabcdef AIzaSyCANARY0123456789abcdef ghp_CANARY0123456789',
  ],
  ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJDQU5BUlkifQ.CANARYsig'],
];
const MULTIBYTE_BODIES = [
  ['CJK (3-byte)', '界'.repeat(400)],
  ['emoji (4-byte)', '😀'.repeat(200)],
  ['ASCII then emoji boundary', 'a' + '😀'.repeat(100)],
  ['mixed after redaction', `token=${'x'.repeat(50)} ` + 'é界😀'.repeat(120)],
];

function assertNoCanary(lines, label) {
  const all = lines.join('\n');
  assert.ok(!/canary/i.test(all), `${label}: secret leaked:\n${all}`);
}

// ------------------------------------------------- 2/5. sanitizer copies

const SANITIZER_FILES = [
  'server/mcp/services.js',
  'server/providers/aircraft/adsb-lol.js',
  'server/providers/overpass/transport.js',
  'server/providers/places/google.js',
  'server/providers/places/routes.js',
  'server/providers/space/celestrak.js',
];

/** The redactSnippet source of one file, de-indented. */
function sanitizerSource(file) {
  const src = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
  const start = src.indexOf('function redactSnippet(');
  assert.ok(start >= 0, `${file} has redactSnippet`);
  const lineStart = src.lastIndexOf('\n', start) + 1;
  const indent = src.slice(lineStart, start);
  const end = src.indexOf(`\n${indent}}\n`, start);
  assert.ok(end > start, `${file}: end of redactSnippet`);
  return src
    .slice(lineStart, end + indent.length + 2)
    .split('\n')
    .map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l))
    .join('\n');
}

test('sanitizer: every copied redactSnippet is the same code', () => {
  // Compared modulo formatting: the formatter wraps the nested copy in
  // celestrak.js (2 more columns of indent) differently.
  const sources = SANITIZER_FILES.map((file) =>
    sanitizerSource(file)
      .replace(/\s+/g, '')
      .replace(/,\)/g, ')'),
  );
  for (const [i, src] of sources.entries())
    assert.equal(src, sources[0], `${SANITIZER_FILES[i]} differs`);
  // The HUD has no snippet sanitizer at all: it never logs body text.
  const hud = readFileSync(
    new URL('../../server/providers/openai/hud-summary.js', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(hud, /redactSnippet|body=\$\{/);
});

for (const file of SANITIZER_FILES) {
  test(`sanitizer copy in ${file}: secrets corpus, request secrets, UTF-8 byte bound`, () => {
    // eslint-disable-next-line no-new-func
    const redact = new Function(`${sanitizerSource(file)}\nreturn redactSnippet;`)();
    for (const [label, body] of SECRET_BODIES) {
      const out = redact(body);
      assert.ok(!/canary/i.test(out), `${label}: ${out}`);
      assertSnippetBounded(out, label);
    }
    // The request's own secrets, echoed raw, JSON-escaped or URL-encoded.
    const own = 'own "secret" CANARY/value';
    const echo = `${own} ${JSON.stringify(own)} ${encodeURIComponent(own)}`;
    assert.ok(!/canary/i.test(redact(echo, [own])), 'request secret echoed');
    for (const [label, body] of MULTIBYTE_BODIES) {
      const out = redact(body);
      assertSnippetBounded(out, label);
      assert.ok(Buffer.byteLength(out) > 290, `${label}: cut too early`);
    }
    assert.equal(redact('x'.repeat(1000)).length, 300);
    // Plain diagnostics survive.
    assert.equal(
      redact('<html><h1>503</h1> Service  Unavailable: quota exceeded</html>'),
      '503 Service Unavailable: quota exceeded',
    );
  });
}

// ------------------------------------- 2/5. each provider path end to end

test('MCP non-OK body log: secrets corpus, request credentials and byte bound', async () => {
  for (const [label, body] of [...SECRET_BODIES, ...MULTIBYTE_BODIES]) {
    const out = [];
    const f = createApiFetch({
      log: (line) => out.push(line),
      fetchImpl: async () => new Response(body, { status: 500 }),
    });
    const res = await f('/api/test');
    assert.equal(await res.text(), body, `${label}: caller body unchanged`);
    assert.equal(out.length, 1);
    assertNoCanary(out, label);
    for (const b of loggedBodies(out[0])) assertSnippetBounded(b, label);
  }
  // The request's own credentials echoed back by the server.
  const out = [];
  const f = createApiFetch({
    log: (line) => out.push(line),
    fetchImpl: async () =>
      new Response('echo: own-CANARY-query own-CANARY-auth-token', {
        status: 500,
      }),
  });
  await f('/api/test?api_key=own-CANARY-query', {
    headers: { Authorization: 'Bearer own-CANARY-auth-token' },
  });
  assertNoCanary(out, 'request credentials');
});

test('MCP: a stalled error body delays the caller by at most the 1 s peek', async () => {
  const out = [];
  const stalled = new ReadableStream({ start() {} });
  const f = createApiFetch({
    log: (line) => out.push(line),
    fetchImpl: async () => new Response(stalled, { status: 502 }),
  });
  const started = performance.now();
  const res = await f('/api/test');
  const waited = performance.now() - started;
  assert.equal(res.status, 502);
  assert.ok(waited < 3000, `waited ${Math.round(waited)} ms`);
  assert.match(out[0], /status=502 .*body="\[no body bytes before peek deadline\]"/);
});

async function military(handler) {
  const res = fakeRes();
  await handler({ url: '/', method: 'GET' }, res, () => {});
  return res;
}

test('adsb.lol relayed failure body: secrets corpus and byte bound', async (t) => {
  for (const [label, body] of [...SECRET_BODIES, ...MULTIBYTE_BODIES]) {
    const logs = captureLogs(t);
    t.mock.method(globalThis, 'fetch', async () => new Response(body, { status: 500 }));
    const res = await military(installPlugin(adsbLolProxy()).get('/api/military'));
    assert.equal(res.body, body, `${label}: relayed body unchanged`);
    assertNoCanary(logs, label);
    for (const b of loggedBodies(logs.join('\n'))) assertSnippetBounded(b, label);
    t.mock.restoreAll();
  }
});

let opSeq = 0;
test('Overpass refusal + malformed body: secrets corpus, endpoint credentials, byte bound', async (t) => {
  for (const [label, body] of [...SECRET_BODIES, ...MULTIBYTE_BODIES]) {
    for (const status of [500, 200]) {
      const logs = captureLogs(t);
      const payload = await fetchOverpassPayload('data=x', 1 << 20, {
        endpoints: [`https://op-adv-${++opSeq}.example/api/interpreter`],
        fetchImpl: async () => new Response(body, { status }),
      });
      assert.equal(payload.status, 502, `${label} ${status}`);
      assert.equal(logs.length, 1, `${label} ${status}: ${logs}`);
      const bodies = loggedBodies(logs[0]);
      assert.equal(bodies.length, 1, `${label} ${status}: snippet kept`);
      assertNoCanary(logs, `${label} ${status}`);
      assertSnippetBounded(bodies[0], label);
      t.mock.restoreAll();
    }
  }
  // Endpoint credentials echoed in the body.
  const logs = captureLogs(t);
  await fetchOverpassPayload('data=x', 1 << 20, {
    endpoints: [
      `https://opuser:op-CANARY-pass@op-adv-${++opSeq}.example/api/interpreter?apikey=op-CANARY-key`,
    ],
    fetchImpl: async () =>
      new Response(
        `remark: denied for opuser:op-CANARY-pass ${Buffer.from('opuser:op-CANARY-pass').toString('base64')} op-CANARY-key`,
        { status: 500 },
      ),
  });
  assertNoCanary(logs, 'endpoint credentials');
});

test('Overpass: a malformed 200 keeps its body snippet in the failure log', async (t) => {
  const logs = captureLogs(t);
  await fetchOverpassPayload('data=x', 1 << 20, {
    endpoints: [`https://op-adv-${++opSeq}.example/api/interpreter`],
    fetchImpl: async () => new Response('<html>proxy error page</html>'),
  });
  assert.match(logs[0], /class=malformed status=200 .*body="proxy error page"/);
});

function googleHandler(fetchImpl, route) {
  return installPlugin(
    googlePlacesContextProxy({
      resolveApiKey: () => 'goog-CANARY-api-key',
      fetchImpl,
    }),
  ).get(route);
}

async function callGoogle(handler, url = '/?q=CANARY+secret+cafe&lat=30.2747&lon=-97.7404') {
  const res = fakeRes();
  await handler(
    { url, method: 'GET', headers: { host: 'localhost:4173' }, socket: { remoteAddress: nextPeer() } },
    res,
  );
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

test('Google non-OK + malformed bodies: secrets corpus, key and query echo, byte bound', async (t) => {
  for (const route of ['/api/google/nearby-places', '/api/google/text-search'])
    for (const [label, body] of [...SECRET_BODIES, ...MULTIBYTE_BODIES])
      for (const status of [500, 200]) {
        const logs = captureLogs(t);
        // A 200 is only a failure when it is not JSON: make it malformed.
        const sent = status === 200 ? `garbage ${body}` : body;
        await callGoogle(googleHandler(async () => new Response(sent, { status }), route));
        assert.equal(logs.length, 1, `${route} ${label} ${status}: ${logs}`);
        assertNoCanary(logs, `${route} ${label} ${status}`);
        for (const b of loggedBodies(logs[0])) assertSnippetBounded(b, label);
        t.mock.restoreAll();
      }
  // The key, the user's query text and coordinates echoed back.
  const logs = captureLogs(t);
  await callGoogle(
    googleHandler(
      async () =>
        Response.json(
          {
            error: {
              message:
                'key goog-CANARY-api-key rejected for textQuery "CANARY secret cafe" at 30.2747,-97.7404',
            },
          },
          { status: 400 },
        ),
      '/api/google/text-search',
    ),
  );
  assertNoCanary(logs, 'request echo');
  assert.doesNotMatch(logs.join('\n'), /30\.2747|-97\.7404/);
});

async function callRoute(fetchImpl, endpoints = {}) {
  _resetRouteUpstreamForTest();
  _setRouteUpstreamIntervalForTest(0);
  let handler;
  installRouteMiddleware({ use: (_r, h) => (handler = h) }, { endpoints, fetchImpl });
  const res = fakeRes();
  await handler(
    {
      url: '/api/route?profile=car&coords=-97.741234,30.271234;-97.751234,30.281234',
      method: 'GET',
      headers: {},
      socket: { remoteAddress: nextPeer() },
    },
    res,
  );
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

test('routes non-OK + malformed JSON bodies: secrets corpus, coordinates echo, byte bound', async (t) => {
  for (const [label, body] of [...SECRET_BODIES, ...MULTIBYTE_BODIES]) {
    for (const [status, ctype] of [
      [500, 'text/plain'],
      [200, 'application/json'],
    ]) {
      const logs = captureLogs(t);
      // A JSON 200 is only a failure when it does not parse: make it malformed.
      const sent = status === 200 ? `garbage ${body}` : body;
      const res = await callRoute(
        async () => new Response(sent, { status, headers: { 'content-type': ctype } }),
      );
      assert.equal(res.status, 200);
      const bodies = loggedBodies(logs.join('\n'));
      assert.equal(bodies.length, 1, `${label} ${status}: snippet kept: ${logs}`);
      assertNoCanary(logs, `${label} ${status}`);
      assertSnippetBounded(bodies[0], label);
      t.mock.restoreAll();
    }
  }
  const logs = captureLogs(t);
  await callRoute(
    async () =>
      new Response('{"code":"InvalidValue","message":"bad coordinate -97.741234,30.271234 for u:route-CANARY-pw"}', {
        status: 400,
      }),
    { car: 'https://u:route-CANARY-pw@osrm.example/routed-car' },
  );
  assertNoCanary(logs, 'endpoint userinfo');
  assert.doesNotMatch(logs.join('\n'), /-97\.741234|30\.271234/);
});

test('routes: a malformed JSON 200 keeps its body snippet in the failure log', async (t) => {
  const logs = captureLogs(t);
  const res = await callRoute(
    async () =>
      new Response('{"code":"Ok", truncated', {
        headers: { 'content-type': 'application/json' },
      }),
  );
  assert.deepEqual(res.body, { ok: false, error: 'route proxy error' });
  assert.match(logs[0], /class=malformed status=200 .*body="\{\\"code\\":\\"Ok\\", truncated"/);
});

// --------------------------------------------- 2/3. HUD: no body text, body phase

const HUD_CONTEXT = { note: 'PRIVATE-PROMPT-CANARY', place: 'Fort Kelso' };

function hudRequest(t, fetchImpl, context = HUD_CONTEXT) {
  t.mock.method(globalThis, 'fetch', fetchImpl);
  const prior = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-hud-CANARY-key-123456';
  t.after(() => {
    if (prior === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prior;
  });
  const req = Readable.from([Buffer.from(JSON.stringify(context))]);
  Object.assign(req, {
    method: 'POST',
    url: '/',
    headers: { host: 'localhost:4173' },
    socket: { remoteAddress: nextPeer() },
  });
  const res = fakeRes();
  return handleHudSummary(req, res).then(() => ({
    status: res.statusCode,
    body: JSON.parse(res.body),
  }));
}

const REFLECTIONS = [
  ['message', () => Response.json({ error: { message: 'invalid input: PRIVATE-PROMPT-CANARY' } }, { status: 400 })],
  ['escaped context in message', () => Response.json({ error: { message: `bad input ${JSON.stringify(JSON.stringify(HUD_CONTEXT))}` } }, { status: 400 })],
  ['unicode-escaped', () => new Response('{"error":{"message":"\\u0050RIVATE-PROMPT-CANARY"}}', { status: 400 })],
  ['in error.code', () => Response.json({ error: { code: 'PRIVATE-PROMPT-CANARY', type: 'invalid_request_error' } }, { status: 400 })],
  ['in error.param (lower case)', () => Response.json({ error: { param: 'private-prompt-canary', type: 'x' } }, { status: 400 })],
  ['in error.type', () => Response.json({ error: { type: 'Fort' } }, { status: 400 })],
  ['non-JSON echo', () => new Response(`<html>you sent ${JSON.stringify(HUD_CONTEXT)}</html>`, { status: 502 })],
  ['200 echo, malformed', () => new Response(`{"output_text": "PRIVATE-PROMPT-CANARY`, { status: 200 })],
  ['200 echo, no summary', () => Response.json({ output: [{ content: [{ refusal: 'PRIVATE-PROMPT-CANARY' }] }] })],
];

for (const [label, reply] of REFLECTIONS) {
  test(`HUD: upstream reflection (${label}) never reaches the log`, async (t) => {
    const logs = captureLogs(t);
    await hudRequest(t, async () => reply());
    assert.ok(logs.length >= 1, 'the failure is logged');
    const all = logs.join('\n');
    assert.ok(!/private-prompt-canary/i.test(all), all);
    assert.ok(!/PRIVATE.{0,12}PROMPT/i.test(all), all);
    assert.doesNotMatch(all, /Fort Kelso|\bFort\b|hud-CANARY|body=/);
    assert.match(all, /body_bytes=\d+/);
  });
}

test('HUD: identifier facts that are not in the context are kept', async (t) => {
  const logs = captureLogs(t);
  await hudRequest(t, async () =>
    new Response(
      JSON.stringify({ error: { message: 'x', type: 'insufficient_quota', code: 'insufficient_quota', param: null } }),
      { status: 429, headers: { 'x-request-id': 'req_abc123' } },
    ),
  );
  assert.match(logs[0], /status=429 elapsed_ms=\d+ body_bytes=\d+ error_type=insufficient_quota error_code=insufficient_quota request_id=withheld$/);
  assert.ok(!logs[0].includes('abc123'), logs[0]);
});

const HUD_EMPTY_200 = { status: 200, body: { summary: null, error: null } };

test('HUD: HTTP 200 whose body read times out keeps the reply and logs the cause', async (t) => {
  const logs = captureLogs(t);
  const res = await hudRequest(t, async () => bodyThrows(200, bodyTimeout()));
  assert.deepEqual(res, HUD_EMPTY_200, 'c3884c6 reply');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /upstream body read failed class=timeout target="POST https:\/\/api\.openai\.com\/v1\/responses" status=200 elapsed_ms=\d+ timeout_ms=15000/);
});

test('HUD: body reset after headers keeps the reply and logs the network cause', async (t) => {
  const logs = captureLogs(t);
  const res = await hudRequest(t, async () => bodyThrows(200, bodyReset()));
  assert.deepEqual(res, HUD_EMPTY_200);
  assert.match(logs[0], /body read failed class=network code=ECONNRESET .*status=200/);
});

test('HUD: HTTP 500 whose body read fails logs both the read cause and the status', async (t) => {
  const logs = captureLogs(t);
  const res = await hudRequest(t, async () => bodyThrows(500, bodyTimeout()));
  assert.deepEqual(res, { status: 500, body: { summary: null, error: 'OpenAI HUD summary request failed' } });
  assert.match(logs[0], /body read failed class=timeout .*status=500/);
  assert.match(logs[1], /upstream HTTP 500 .*status=500 elapsed_ms=\d+ body_bytes=0/);
});

test('HUD: malformed JSON 200 keeps the reply and logs class=malformed', async (t) => {
  const logs = captureLogs(t);
  const res = await hudRequest(t, async () => new Response('{"output_text": "Two', { status: 200 }));
  assert.deepEqual(res, HUD_EMPTY_200);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /upstream body malformed class=malformed .*status=200 elapsed_ms=\d+ body_bytes=20 body_format=non-json/);
});

test('HUD: a healthy reply adds no log line', async (t) => {
  const logs = captureLogs(t);
  const res = await hudRequest(t, async () => Response.json({ output_text: 'Two aircraft over Austin now' }));
  assert.deepEqual(res, { status: 200, body: { summary: 'Two aircraft over Austin now', error: null } });
  assert.deepEqual(logs, []);
});

// --------------------------------------------- 3/4. Google contracts + body phase

// Replies c3884c6 gives for these upstream replies (verified side by side
// against c3884c6 by the repair's contract-parity probe, 67/67 identical).
const NULL_502 = {
  status: 502,
  body: { error: "Cannot read properties of null (reading 'places')", places: [] },
};
const EMPTY_200 = { status: 200, body: { places: [], error: null } };
const GOOGLE_CASES = [
  ['JSON null', () => new Response('null'), NULL_502, /reply is not a JSON object .*json_type=null status=200/],
  ['JSON null on 500', () => new Response('null', { status: 500 }), NULL_502, /upstream HTTP 500 .*body="null"/],
  ['JSON number', () => new Response('5'), EMPTY_200, /json_type=number status=200 .*body="5"/],
  ['JSON string', () => new Response('"str"'), EMPTY_200, /json_type=string/],
  ['malformed JSON', () => new Response('{"places": [tru'), EMPTY_200, /upstream body malformed .*class=malformed status=200 .*body="\{\\"places\\": \[tru"/],
  ['empty body', () => new Response(''), EMPTY_200, /class=malformed status=200 .*body=""/],
  ['body read timeout', () => bodyThrows(200, bodyTimeout()), EMPTY_200, /upstream body read failed .*class=timeout status=200 elapsed_ms=\d+ timeout_ms=60000/],
  ['body reset', () => bodyThrows(200, bodyReset()), EMPTY_200, /body read failed .*class=network code=ECONNRESET status=200/],
];

for (const route of ['/api/google/nearby-places', '/api/google/text-search'])
  for (const [label, reply, expected, logPattern] of GOOGLE_CASES)
    test(`Google ${route.split('/').pop()}: ${label} keeps the c3884c6 reply and is logged`, async (t) => {
      const logs = captureLogs(t);
      const res = await callGoogle(googleHandler(async () => reply(), route));
      assert.deepEqual(res, expected);
      assert.ok(logs.some((l) => logPattern.test(l)), logs.join('\n'));
      if (expected.status === 502)
        assert.ok(logs.some((l) => /reply processing failed class=TypeError response=502/.test(l)));
      assertNoCanary(logs, label);
    });

test('Google: a thrown fetch is logged once (not again by the route catch)', async (t) => {
  const logs = captureLogs(t);
  const res = await callGoogle(
    googleHandler(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }, '/api/google/nearby-places'),
  );
  assert.deepEqual(res, { status: 502, body: { error: 'fetch failed', places: [] } });
  assert.equal(logs.length, 1);
});

// --------------------------------------------- 1. CelesTrak halt timing

const HALT_FILE = path.join(process.cwd(), '.gev-cache', 'celestrak-HALT.json');
const GP_CSV =
  'OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION\r\nISS,1998-067A,2026-09-19T00:00:00.000000,15.5';

/** In-memory disk; the 'r+' handle behaves like an inode (unlink-safe). */
function memoryDisk(t) {
  const files = new Map();
  const writes = [];
  t.mock.method(fsp, 'readFile', async (p) => {
    if (!files.has(String(p)))
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return files.get(String(p));
  });
  t.mock.method(fsp, 'writeFile', async (p, data) => {
    files.set(String(p), String(data));
    writes.push(String(p));
  });
  t.mock.method(fsp, 'mkdir', async () => {});
  t.mock.method(fsp, 'stat', async () => {
    throw new Error('no stat');
  });
  t.mock.method(fsp, 'open', async (p, flags) => {
    const key = String(p);
    assert.equal(flags, 'r+', 'the halt file is only ever opened r+');
    if (!files.has(key))
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    let content = files.get(key);
    const linked = () => files.has(key);
    return {
      readFile: async () => content,
      truncate: async () => {
        content = '';
        if (linked()) files.set(key, content);
      },
      write: async (text) => {
        content = String(text);
        if (linked()) files.set(key, content);
      },
      close: async () => {},
    };
  });
  return { files, writes };
}

function celestrakApp() {
  const handlers = {};
  celestrakProxy().configureServer({
    middlewares: { use: (route, h) => (handlers[route] = h) },
  });
  return {
    async gp(group) {
      const res = fakeRes();
      await handlers['/api/celestrak']({ url: `/${group}` }, res);
      return res;
    },
    async rcs() {
      const res = fakeRes();
      await handlers['/api/celestrak-rcs']({ url: '/' }, res);
      return res;
    },
    startGp(group) {
      const res = fakeRes();
      return { res, done: handlers['/api/celestrak']({ url: `/${group}` }, res) };
    },
    startRcs() {
      const res = fakeRes();
      return { res, done: handlers['/api/celestrak-rcs']({ url: '/' }, res) };
    },
  };
}

/** A refused response whose body is released only by `release(text)`. */
function stalledRefusal(status = 403) {
  let release;
  const body = new Promise((resolve) => (release = resolve));
  return {
    response: { status, ok: false, headers: new Headers(), text: () => body },
    release,
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

for (const [first, second] of [
  ['GP', 'GP'],
  ['GP', 'SATCAT'],
  ['SATCAT', 'GP'],
]) {
  test(`CelesTrak: a ${first} 403 halts on its headers; a ${second} request during the stalled body is refused without a request`, async (t) => {
    const { files } = memoryDisk(t);
    const logs = captureLogs(t);
    const refusal = stalledRefusal(403);
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls += 1;
      return calls === 1 ? refusal.response : new Response(GP_CSV);
    });
    const app = celestrakApp();
    const pending = first === 'GP' ? app.startGp('stations') : app.startRcs();
    await settle();
    // Latched before any body byte: the file exists with no body yet.
    const latched = JSON.parse(files.get(HALT_FILE));
    assert.equal(latched.halted, true);
    assert.equal(latched.reason, 'HTTP 403');
    assert.equal(latched.status, 403);
    assert.equal(latched.body, undefined);
    const refused = second === 'GP' ? await app.gp('starlink') : await app.rcs();
    assert.equal(refused.statusCode, 503);
    assert.equal(calls, 1, 'no second CelesTrak request while the body stalls');
    refusal.release('<html><body>403 Forbidden: your IP is blocked</body></html>');
    await pending.done;
    assert.equal(pending.res.statusCode, 502);
    // Same latch, now with the body evidence; S3 key fields unchanged.
    const enriched = JSON.parse(files.get(HALT_FILE));
    for (const k of ['halted', 'at', 'group', 'reason', 'status', 'url', 'elapsed_ms'])
      assert.deepEqual(enriched[k], latched[k], k);
    assert.equal(enriched.body, '403 Forbidden: your IP is blocked');
    assert.equal(enriched.group, first === 'GP' ? 'stations' : 'satcat');
    assert.equal(logs.filter((l) => /refresh failed/.test(l)).length, 1);
    assert.ok(logs.some((l) => /halt evidence \(HTTP 403\) status=403 body="403 Forbidden: your IP is blocked"$/.test(l)));
    assertSnippetBounded(enriched.body, 'halt body');
  });
}

test('CelesTrak: an operator clear during the body read is honoured (latch not re-created)', async (t) => {
  const { files } = memoryDisk(t);
  const logs = captureLogs(t);
  const refusal = stalledRefusal(500);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () =>
    ++calls === 1 ? refusal.response : new Response(GP_CSV),
  );
  const app = celestrakApp();
  const pending = app.startGp('stations');
  await settle();
  assert.ok(files.has(HALT_FILE));
  files.delete(HALT_FILE); // the operator clears the latch
  refusal.release('Internal Server Error');
  await pending.done;
  assert.equal(files.has(HALT_FILE), false, 'enrichment never re-creates a cleared latch');
  assert.ok(logs.some((l) => /halt evidence .*halt file not updated: removed by an operator/.test(l)));
  // Upstream is re-enabled exactly as before: the next request fetches.
  const next = await app.gp('stations');
  assert.equal(next.statusCode, 200);
  assert.equal(next.headers['x-tle-cache'], 'MISS');
  assert.equal(calls, 2);
  assert.ok(logs.some((l) => /halt file removed by operator/.test(l)));
});

test('CelesTrak: a body that never arrives is cut at the 5 s evidence deadline', async (t) => {
  const { files } = memoryDisk(t);
  captureLogs(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const refusal = stalledRefusal(429);
  t.mock.method(globalThis, 'fetch', async () => refusal.response);
  const app = celestrakApp();
  const pending = app.startGp('active');
  for (let i = 0; i < 5; i++) await settle();
  assert.equal(JSON.parse(files.get(HALT_FILE)).reason, 'HTTP 429');
  t.mock.timers.tick(5000);
  await pending.done;
  const halt = JSON.parse(files.get(HALT_FILE));
  assert.equal(halt.body, '');
  assert.match(halt.body_note, /cut at 5000 ms evidence deadline/);
  assert.equal(pending.res.statusCode, 502);
});

test('CelesTrak: two refusals already in flight keep the first latch untouched', async (t) => {
  const { files, writes } = memoryDisk(t);
  captureLogs(t);
  const a = stalledRefusal(403);
  const b = stalledRefusal(503);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => (++calls === 1 ? a.response : b.response));
  const app = celestrakApp();
  const first = app.startGp('stations');
  const second = app.startGp('geo'); // both in flight before either answers
  await settle();
  b.release('second body');
  a.release('first body');
  await Promise.all([first.done, second.done]);
  assert.equal(writes.filter((p) => p === HALT_FILE).length, 1);
  const halt = JSON.parse(files.get(HALT_FILE));
  assert.equal(halt.group, 'stations');
  assert.equal(halt.reason, 'HTTP 403');
  assert.equal(halt.body, 'first body');
});

test('CelesTrak halt body: secrets corpus and byte bound', async (t) => {
  for (const [label, body] of [...SECRET_BODIES, ...MULTIBYTE_BODIES]) {
    const { files } = memoryDisk(t);
    const logs = captureLogs(t);
    t.mock.method(globalThis, 'fetch', async () => new Response(body, { status: 403 }));
    await celestrakApp().gp('stations');
    const halt = files.get(HALT_FILE);
    assert.ok(!/canary/i.test(halt), `${label}: halt file leaked`);
    assertNoCanary(logs, label);
    assertSnippetBounded(JSON.parse(halt).body, label);
    t.mock.restoreAll();
  }
});

// --------------------------------------------- 6. timeout budgets

/**
 * Simulated latency: the upstream answers `delayMs` after the request. The
 * request's AbortSignal.timeout(ms) fires first when delayMs >= ms.
 */
function simulatedLatency(t, delayMs) {
  const requested = [];
  t.mock.method(AbortSignal, 'timeout', (ms) => {
    requested.push(ms);
    const controller = new AbortController();
    if (delayMs >= ms)
      queueMicrotask(() =>
        controller.abort(
          new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
        ),
      );
    return controller.signal;
  });
  const answerAfter = (init, response) =>
    new Promise((resolve, reject) =>
      setTimeout(() => {
        if (init?.signal?.aborted) reject(init.signal.reason);
        else resolve(response());
      }, 2),
    );
  return { requested, answerAfter };
}

function withEnv(t, name, value) {
  const prior = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (prior === undefined) delete process.env[name];
    else process.env[name] = prior;
  });
}

test('timeouts: defaults, GEV_*_TIMEOUT_MS overrides and invalid values', () => {
  assert.equal(ADSB_LOL_TIMEOUT_MS, 30_000);
  assert.equal(GOOGLE_PLACES_TIMEOUT_MS, 60_000);
  assert.equal(HUD_SUMMARY_TIMEOUT_MS, 15_000);
  for (const [fn, name, def] of [
    [adsbLolTimeoutMs, 'GEV_ADSB_LOL_TIMEOUT_MS', 30_000],
    [googlePlacesTimeoutMs, 'GEV_GOOGLE_PLACES_TIMEOUT_MS', 60_000],
    [hudSummaryTimeoutMs, 'GEV_HUD_SUMMARY_TIMEOUT_MS', 15_000],
  ]) {
    assert.equal(fn({}), def);
    assert.equal(fn({ [name]: '45000' }), 45_000);
    for (const bad of ['', 'abc', '0', '999', '600001', '1500.5', '-5000'])
      assert.equal(fn({ [name]: bad }), def, `${name}=${bad}`);
  }
});

test('adsb.lol: a valid reply after 29.9 s is served; at 30 s it times out', async (t) => {
  captureLogs(t);
  const slow = simulatedLatency(t, 29_999);
  t.mock.method(globalThis, 'fetch', (_u, init) =>
    slow.answerAfter(init, () => Response.json({ ac: [{ hex: 'abc' }] })),
  );
  const ok = await military(installPlugin(adsbLolProxy()).get('/api/military'));
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['x-feed-cache'], 'MISS');
  assert.deepEqual(slow.requested, [30_000]);
  t.mock.restoreAll();
  const logs = captureLogs(t);
  const late = simulatedLatency(t, 30_000);
  t.mock.method(globalThis, 'fetch', (_u, init) =>
    late.answerAfter(init, () => Response.json({ ac: [] })),
  );
  const timedOut = await military(installPlugin(adsbLolProxy()).get('/api/military'));
  assert.equal(timedOut.statusCode, 502);
  assert.match(logs[0], /class=timeout .*timeout_ms=30000/);
});

test('adsb.lol: GEV_ADSB_LOL_TIMEOUT_MS raises the budget for a slower valid reply', async (t) => {
  withEnv(t, 'GEV_ADSB_LOL_TIMEOUT_MS', '45000');
  captureLogs(t);
  const slow = simulatedLatency(t, 40_000);
  t.mock.method(globalThis, 'fetch', (_u, init) =>
    slow.answerAfter(init, () => Response.json({ ac: [] })),
  );
  const res = await military(installPlugin(adsbLolProxy()).get('/api/military'));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(slow.requested, [45_000]);
});

test('Google Places: a valid reply after 59.9 s is served (both routes)', async (t) => {
  const logs = captureLogs(t);
  const slow = simulatedLatency(t, 59_999);
  const place = {
    places: [
      { id: 'p1', displayName: { text: 'Capitol' }, location: { latitude: 30.2747, longitude: -97.7404 }, types: ['point_of_interest'] },
    ],
  };
  for (const route of ['/api/google/nearby-places', '/api/google/text-search']) {
    const res = await callGoogle(
      googleHandler((_u, init) => slow.answerAfter(init, () => Response.json(place)), route),
      '/?q=capitol&lat=30.27&lon=-97.74',
    );
    assert.equal(res.status, 200, route);
    assert.equal(res.body.places.length, 1, route);
  }
  assert.deepEqual(slow.requested, [60_000, 60_000]);
  assert.deepEqual(logs, []);
});

test('HUD: a valid reply after 14.9 s is served; GEV_HUD_SUMMARY_TIMEOUT_MS is honoured', async (t) => {
  const logs = captureLogs(t);
  const slow = simulatedLatency(t, 14_999);
  const res = await hudRequest(t, (_u, init) =>
    slow.answerAfter(init, () => Response.json({ output_text: 'Two aircraft over Austin now' })),
  );
  assert.deepEqual(res, { status: 200, body: { summary: 'Two aircraft over Austin now', error: null } });
  assert.deepEqual(slow.requested, [15_000]);
  assert.deepEqual(logs, []);
  t.mock.restoreAll();
  withEnv(t, 'GEV_HUD_SUMMARY_TIMEOUT_MS', '30000');
  const slower = simulatedLatency(t, 20_000);
  const res2 = await hudRequest(t, (_u, init) =>
    slower.answerAfter(init, () => Response.json({ output_text: 'Calm skies' })),
  );
  assert.equal(res2.status, 200);
  assert.deepEqual(slower.requested, [30_000]);
});

test('MCP: a valid local reply after 119.9 s is returned', async (t) => {
  const slow = simulatedLatency(t, 119_999);
  const out = [];
  const f = createApiFetch({
    log: (l) => out.push(l),
    fetchImpl: (_u, init) => slow.answerAfter(init, () => new Response('ok')),
  });
  const res = await f('/api/slow');
  assert.equal(await res.text(), 'ok');
  assert.deepEqual(slow.requested, [120_000]);
  assert.deepEqual(out, []);
});
