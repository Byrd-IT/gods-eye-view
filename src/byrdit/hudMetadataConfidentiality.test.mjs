// Byrd-IT b12 r5 (review t_49610c02 r4 finding, repair t_e9d3e496): the HUD
// summary logs upstream diagnostics (error.type/code/param, x-request-id and
// the failure class) but never the request's API key, HUD context or prompt,
// whether they are reflected raw, embedded, re-cased, hex or base64 encoded.
// error.type/code/param are logged only as allow-listed constants (else
// `unlisted`); the request id only as req_<hex> sharing nothing with the
// request secrets (else `withheld`). Status, target, elapsed and the client
// reply are unchanged. fetch is mocked: nothing here reaches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { handleHudSummary } from '../../server/providers/openai/hud-summary.js';
import { HUD_SUMMARY_INSTRUCTIONS } from '../hudSummaryResponse.js';

const KEY = 'sk-proj-HudR5Credential_Canary0123456789';
const HEX_KEY = '0123456789abcdef0123456789abcdef'; // hex-shaped credential
const CONTEXT = { note: 'PRIVATE-CONTEXT-CANARY', place: 'Fort Kelso' };
const CONTEXT_HEX_ID = 'feedfacecafebeef0011223344556677';
const PROMPT_FRAGMENT = HUD_SUMMARY_INSTRUCTIONS.slice(0, 24);
const REQ_ID = 'req_5f0c2b7e9a1d4c3b8e6f0a2d4c6b8e1f';

let peer = 0;
const nextPeer = () => `127.77.${Math.floor(++peer / 250)}.${(peer % 250) + 1}`;

function captureLogs(t) {
  const lines = [];
  for (const level of ['warn', 'error', 'info', 'log'])
    t.mock.method(console, level, (...args) => lines.push(args.join(' ')));
  return lines;
}

async function hud(t, reply, { key = KEY, context = CONTEXT } = {}) {
  t.mock.method(globalThis, 'fetch', async () => reply());
  const prior = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = key;
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
  const res = {
    statusCode: 200,
    setHeader() {},
    end(body) {
      this.body = body;
    },
  };
  await handleHudSummary(req, res);
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

const b = (s) => Buffer.from(s, 'utf8');
/** Every reflected form of a secret, as it could appear in a log line. */
function forms(secret) {
  return [
    secret,
    secret.toLowerCase(),
    secret.toUpperCase(),
    b(secret).toString('hex'),
    b(secret).toString('base64'),
    b(secret).toString('base64url'),
  ];
}
function assertNoSecrets(logs, secrets) {
  const all = logs.join('\n');
  for (const secret of secrets)
    for (const form of forms(secret))
      assert.ok(!all.includes(form), `leaked ${JSON.stringify(form)}: ${all}`);
  assert.doesNotMatch(all, /CANARY|Kelso|body=/i);
}

const FAILED_401 = {
  status: 401,
  body: { summary: null, error: 'OpenAI HUD summary request failed' },
};

// Every reflected form of the key, the context and the prompt.
const REFLECTED = {
  'raw key': KEY,
  'lower-case key': KEY.toLowerCase(),
  'upper-case key': KEY.toUpperCase(),
  'embedded key': `key_${KEY}_suffix`,
  'key tail': KEY.slice(-16),
  'hex key': b(KEY).toString('hex').slice(0, 64),
  'base64 key': b(KEY).toString('base64url'),
  'context value': 'PRIVATE-CONTEXT-CANARY',
  'context word': 'Kelso',
  'hex context': b('PRIVATE-CONTEXT-CANARY').toString('hex'),
  'prompt fragment': PROMPT_FRAGMENT,
};

for (const field of ['type', 'code', 'param'])
  for (const [label, value] of Object.entries(REFLECTED))
    test(`HUD r5: ${label} reflected in error.${field} is logged as unlisted`, async (t) => {
      const logs = captureLogs(t);
      const res = await hud(t, () =>
        Response.json(
          { error: { message: 'x', [field]: value } },
          { status: 401 },
        ),
      );
      assert.deepEqual(res, FAILED_401);
      assert.equal(logs.length, 1, 'the failure stays logged');
      assert.match(
        logs[0],
        new RegExp(
          `upstream HTTP 401 target="POST https://api\\.openai\\.com/v1/responses" status=401 elapsed_ms=\\d+ body_bytes=\\d+ error_${field}=unlisted$`,
        ),
      );
      assertNoSecrets(logs, [KEY, 'PRIVATE-CONTEXT-CANARY', PROMPT_FRAGMENT]);
    });

test('HUD r5: a non-string error.type/code/param is unlisted, never serialised', async (t) => {
  const logs = captureLogs(t);
  await hud(t, () =>
    Response.json(
      { error: { type: { k: KEY }, code: [KEY], param: 42 } },
      { status: 400 },
    ),
  );
  assert.match(
    logs[0],
    /error_type=unlisted error_code=unlisted error_param=unlisted$/,
  );
  assertNoSecrets(logs, [KEY]);
});

test('HUD r5: allow-listed identifiers are still logged', async (t) => {
  const logs = captureLogs(t);
  await hud(t, () =>
    Response.json(
      {
        error: {
          message: 'Incorrect API key provided: sk-proj-***',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
          param: 'input',
        },
      },
      { status: 401, headers: { 'x-request-id': REQ_ID } },
    ),
  );
  assert.match(
    logs[0],
    new RegExp(
      `status=401 elapsed_ms=\\d+ body_bytes=\\d+ error_type=invalid_request_error error_code=invalid_api_key error_param=input request_id=${REQ_ID}$`,
    ),
  );
});

test('HUD r5: unknown identifiers are reported as unlisted, null ones omitted', async (t) => {
  const logs = captureLogs(t);
  await hud(t, () =>
    Response.json(
      { error: { type: 'brand_new_error', code: null, param: 'tools' } },
      { status: 400 },
    ),
  );
  assert.match(
    logs[0],
    /body_bytes=\d+ error_type=unlisted error_param=unlisted$/,
  );
});

// x-request-id: every reflected form is withheld.
const REQUEST_IDS = {
  'raw key': [KEY],
  'req_ + key': [`req_${KEY}`],
  'req_ + hex key': [`req_${b(KEY).toString('hex').slice(0, 64)}`],
  'req_ + hex key, offset': [`req_${b(KEY).toString('hex').slice(7, 39)}`],
  'req_ + hex-shaped key': [`req_${HEX_KEY}`, { key: HEX_KEY }],
  'req_ + part of hex-shaped key': [
    `req_${HEX_KEY.slice(4, 20)}`,
    { key: HEX_KEY },
  ],
  'req_ + hex-shaped key inside': [
    `req_00${HEX_KEY.slice(0, 30)}`,
    { key: HEX_KEY.slice(0, 30) },
  ],
  'base64 key': [b(KEY).toString('base64url')],
  'context value': ['PRIVATE-CONTEXT-CANARY'],
  'req_ + context value': ['req_PRIVATE-CONTEXT-CANARY'],
  'req_ + hex context': [
    `req_${b('PRIVATE-CONTEXT-CANARY').toString('hex').slice(0, 64)}`,
  ],
  'req_ + hex id taken from the context': [
    `req_${CONTEXT_HEX_ID}`,
    { context: { note: `trace ${CONTEXT_HEX_ID}` } },
  ],
  'req_ + hex prompt': [`req_${b(PROMPT_FRAGMENT).toString('hex')}`],
  'upper-case hex': [REQ_ID.toUpperCase()],
  'too long': [`req_${'a'.repeat(65)}`],
};

for (const [label, [id, opts]] of Object.entries(REQUEST_IDS))
  test(`HUD r5: x-request-id with ${label} is withheld`, async (t) => {
    const logs = captureLogs(t);
    const res = await hud(
      t,
      () =>
        Response.json(
          { error: { message: 'invalid credential' } },
          { status: 401, headers: { 'x-request-id': id } },
        ),
      opts,
    );
    assert.deepEqual(res, FAILED_401);
    assert.equal(logs.length, 1);
    assert.match(
      logs[0],
      /upstream HTTP 401 .*status=401 elapsed_ms=\d+ body_bytes=\d+ request_id=withheld$/,
    );
    const hexPart = /^req_([0-9a-f]+)$/.exec(id)?.[1];
    assert.ok(!logs[0].includes(id), logs[0]);
    if (hexPart) assert.ok(!logs[0].includes(hexPart), logs[0]);
    assertNoSecrets(logs, [opts?.key || KEY, 'PRIVATE-CONTEXT-CANARY']);
  });

test('HUD r5: a realistic request id unrelated to the request is logged', async (t) => {
  const logs = captureLogs(t);
  await hud(t, () =>
    Response.json(
      { error: {} },
      { status: 500, headers: { 'x-request-id': REQ_ID } },
    ),
  );
  assert.match(logs[0], new RegExp(`status=500 .*request_id=${REQ_ID}$`));
});

test('HUD r5: no request-id header adds no request_id fact', async (t) => {
  const logs = captureLogs(t);
  await hud(t, () => Response.json({ error: {} }, { status: 500 }));
  assert.doesNotMatch(logs[0], /request_id/);
});

// The other HUD log paths carry the same metadata.
function bodyFails(status, headers) {
  const body = new ReadableStream({
    pull() {
      throw Object.assign(new Error(`reset ${KEY}`), { code: 'ECONNRESET' });
    },
  });
  return new Response(body, { status, headers });
}

test('HUD r5: body-read-failure path withholds a reflected request id', async (t) => {
  const logs = captureLogs(t);
  const res = await hud(t, () => bodyFails(200, { 'x-request-id': KEY }));
  assert.deepEqual(res, { status: 200, body: { summary: null, error: null } });
  assert.match(
    logs[0],
    /upstream body read failed class=network code=ECONNRESET .*status=200 elapsed_ms=\d+ timeout_ms=15000 request_id=withheld$/,
  );
  assertNoSecrets(logs, [KEY]);
});

test('HUD r5: malformed-200 path withholds a reflected request id', async (t) => {
  const logs = captureLogs(t);
  const res = await hud(
    t,
    () =>
      new Response(`{"output_text": "${KEY}`, {
        status: 200,
        headers: {
          'x-request-id': `req_${b(KEY).toString('hex').slice(0, 40)}`,
        },
      }),
  );
  assert.deepEqual(res, { status: 200, body: { summary: null, error: null } });
  assert.match(
    logs[0],
    /upstream body malformed class=malformed .*body_format=non-json request_id=withheld$/,
  );
  assertNoSecrets(logs, [KEY]);
});

test('HUD r5: no-summary-200 path logs only allow-listed facts', async (t) => {
  const logs = captureLogs(t);
  const res = await hud(t, () =>
    Response.json(
      {
        output: [],
        error: {
          type: KEY,
          code: 'PRIVATE-CONTEXT-CANARY',
          param: PROMPT_FRAGMENT,
        },
      },
      {
        status: 200,
        headers: { 'x-request-id': 'req_PRIVATE-CONTEXT-CANARY' },
      },
    ),
  );
  assert.deepEqual(res, { status: 200, body: { summary: null, error: null } });
  assert.match(
    logs[0],
    /upstream reply has no summary text .*error_type=unlisted error_code=unlisted error_param=unlisted request_id=withheld$/,
  );
  assertNoSecrets(logs, [KEY, 'PRIVATE-CONTEXT-CANARY', PROMPT_FRAGMENT]);
});

test('HUD r5: a thrown error never logs a non-errno code or odd class name', async (t) => {
  const logs = captureLogs(t);
  const res = await hud(t, () => {
    throw Object.assign(new TypeError('fetch failed'), {
      cause: { code: `E_${KEY}` },
    });
  });
  assert.deepEqual(res, {
    status: 502,
    body: { error: 'OpenAI HUD summary request failed' },
  });
  assert.match(
    logs[0],
    /request failed stage=upstream class=network code=OTHER target=.* status=none elapsed_ms=\d+ timeout_ms=15000$/,
  );
  assertNoSecrets(logs, [KEY]);
});

test('HUD r5: a thrown error with a reflected name logs only "error"', async (t) => {
  const logs = captureLogs(t);
  const res = await hud(t, () => {
    throw Object.assign(new Error('x'), { name: `Err ${KEY}` });
  });
  assert.equal(res.status, 502);
  assert.match(logs[0], /class=error target=/);
  assertNoSecrets(logs, [KEY]);
});

test('HUD r5: every reflected form at once leaves only constants in the log', async (t) => {
  const logs = captureLogs(t);
  const res = await hud(t, () =>
    Response.json(
      {
        error: {
          message: `${KEY} ${JSON.stringify(CONTEXT)} ${PROMPT_FRAGMENT}`,
          type: b(KEY).toString('base64'),
          code: `${KEY.toLowerCase()}`,
          param: 'note.PRIVATE-CONTEXT-CANARY',
        },
      },
      {
        status: 401,
        headers: {
          'x-request-id': `req_${b(KEY).toString('hex').slice(2, 66)}`,
        },
      },
    ),
  );
  assert.deepEqual(res, FAILED_401);
  assert.match(
    logs[0],
    /status=401 elapsed_ms=\d+ body_bytes=\d+ error_type=unlisted error_code=unlisted error_param=unlisted request_id=withheld$/,
  );
  assertNoSecrets(logs, [KEY, 'PRIVATE-CONTEXT-CANARY', PROMPT_FRAGMENT]);
});
