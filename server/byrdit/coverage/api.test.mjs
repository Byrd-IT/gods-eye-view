// Byrd-IT photo-coverage proxy: auth, CSRF, closed route allowlist, traversal,
// fixed origin, redirect refusal, credential redaction, size and time limits.
// Every upstream call is a synthetic fetch; every credential is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  COVERAGE_API_PREFIX,
  COVERAGE_ASSET_LIMITS,
  COVERAGE_MODEL_IDS,
  COVERAGE_MODELS,
  COVERAGE_ORIGIN,
  COVERAGE_TOKEN_PATH,
  createCoverageHandler,
  coveragePlugins,
  defaultReadToken,
  isSafeCoverageSegment,
  isSafeCoverageToken,
  matchCoverageRoute,
  parseCoverageTarget,
} from './api.js';

const TOKEN = 'synthetic-coverage-token-0123456789abcdef';
const UPSTREAM = `${COVERAGE_ORIGIN}/${TOKEN}/cov`;

const jsonResponse = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const bytesResponse = (value, type = 'application/octet-stream') =>
  new Response(Buffer.from(value), {
    status: 200,
    headers: { 'content-type': type },
  });

async function boot({
  trusted = '127.0.0.1',
  token = TOKEN,
  readToken = () => token,
  fetchImpl = async () => jsonResponse({ ok: true }),
  env = {},
  ...rest
} = {}) {
  const calls = [];
  const logs = [];
  const handler = createCoverageHandler({
    env: { GEV_TRUSTED_PROXIES: trusted, ...env },
    readToken,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return fetchImpl(url, init);
    },
    logger: { error: (...args) => logs.push(args) },
    ...rest,
  });
  const server = http.createServer((req, res) =>
    handler(req, res, () => {
      res.statusCode = 404;
      res.end('next');
    }),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const call = (method, suffix, options = {}) => {
    const { headers = {}, body, origin, contentType } = options;
    const user = Object.prototype.hasOwnProperty.call(options, 'user')
      ? options.user
      : 'Alice';
    return new Promise((resolve, reject) => {
      const h = { ...headers };
      if (user !== undefined) h['x-gev-user'] = user;
      let payload = body;
      if (method === 'POST' && payload !== undefined) {
        if (typeof payload === 'object' && !Buffer.isBuffer(payload)) {
          payload = JSON.stringify(payload);
          if (contentType === undefined) h['content-type'] = 'application/json';
        } else if (contentType !== undefined) {
          h['content-type'] = contentType;
        } else {
          h['content-type'] = 'application/json';
        }
      } else if (contentType !== undefined) {
        h['content-type'] = contentType;
      }
      if (origin !== undefined) h.origin = origin;
      const request = http.request(
        {
          host: '127.0.0.1',
          port,
          method,
          path: `${COVERAGE_API_PREFIX}${suffix}`,
          headers: h,
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const buffer = Buffer.concat(chunks);
            const text = buffer.toString('utf8');
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {
              /* not every answer is JSON */
            }
            resolve({
              status: res.statusCode,
              headers: res.headers,
              buffer,
              text,
              json,
            });
          });
        },
      );
      request.on('error', reject);
      request.end(payload);
    });
  };
  return {
    call,
    calls,
    logs,
    port,
    handler,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function direct(handler, url, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
      end(text) {
        resolve({
          status: this.statusCode,
          headers: this.headers,
          text:
            text === undefined
              ? ''
              : typeof text === 'string'
                ? text
                : Buffer.from(text).toString('utf8'),
        });
      },
    };
    const req = {
      method,
      url,
      headers: { 'x-gev-user': 'Alice', ...headers },
      socket: { remoteAddress: '127.0.0.1' },
    };
    const fallthrough = handler(req, res, () => resolve(null));
    if (fallthrough !== undefined) resolve(null);
  });
}

test('the fixed origin, credential file and static model list are explicit', () => {
  assert.equal(COVERAGE_ORIGIN, 'http://10.10.99.103:8791');
  assert.equal(COVERAGE_TOKEN_PATH, '/etc/gods-eye-view/coverage-token');
  assert.deepEqual(COVERAGE_MODEL_IDS, ['s4_today', 's6_shop800', 'nov16plus']);
  assert.deepEqual(
    COVERAGE_MODELS.map(({ id, state }) => [id, state]),
    [
      ['s4_today', 'configured'],
      ['s6_shop800', 'configured'],
      ['nov16plus', 'configured'],
    ],
  );
  for (const [name, bytes] of Object.entries(COVERAGE_ASSET_LIMITS)) {
    assert.ok(Number.isSafeInteger(bytes) && bytes > 0, name);
  }
});

test('credential and path segments accept only one safe URL segment', () => {
  for (const good of [TOKEN, 'a_b-c.d~e+==', 's4_today', 'model.json']) {
    assert.equal(isSafeCoverageToken(good), true, good);
  }
  for (const bad of [
    '',
    '.',
    '..',
    '../x',
    'a/b',
    'a\\b',
    'a b',
    'a%2fb',
    'a\nb',
    'x'.repeat(513),
    null,
    5,
  ]) {
    assert.equal(isSafeCoverageToken(bad), false, String(bad));
  }
  for (const good of ['model.json', 'a_b-c.d~e+==', 'keepsets', 'a'.repeat(128)])
    assert.equal(isSafeCoverageSegment(good), true, good);
  for (const bad of [
    '',
    '.',
    '..',
    '.hidden',
    'a/b',
    'a\\b',
    'a b',
    'a:b',
    'a%2fb',
    'a'.repeat(129),
    null,
    5,
  ])
    assert.equal(isSafeCoverageSegment(bad), false, String(bad));
});

test('parseCoverageTarget refuses traversal, encoding, queries and fragments', () => {
  for (const raw of [
    '/api/byrdit/coverage/s4_today/../model.json',
    '/api/byrdit/coverage/s4_today/%2e%2e/model.json',
    '/api/byrdit/coverage/s4_today/..%2fmodel.json',
    '/api/byrdit/coverage/s4_today/model%2ejson',
    '/api/byrdit/coverage/s4_today/model.json?x=1',
    '/api/byrdit/coverage/s4_today/model.json#x',
    '/api/byrdit/coverage/s4_today\\model.json',
    '/api/byrdit/coverage//s4_today/model.json',
    '/api/byrdit/coverage/s4_today/.hidden',
    '/api/byrdit/coverage/s4_today/thumbs/../../x',
  ]) {
    assert.deepEqual(parseCoverageTarget(raw), { bad: true }, raw);
  }
  for (const raw of [
    '/other',
    '/api/byrdit/coveragex',
    '/api/byrdit/plan',
    'http://evil.example/other',
  ]) {
    assert.equal(parseCoverageTarget(raw), null, raw);
  }
  assert.deepEqual(parseCoverageTarget('/api/byrdit/coverage'), { rest: [] });
  assert.deepEqual(parseCoverageTarget('/api/byrdit/coverage/'), { rest: [] });
  assert.deepEqual(
    parseCoverageTarget('/api/byrdit/coverage/s4_today/model.json'),
    { rest: ['s4_today', 'model.json'] },
  );
  assert.deepEqual(
    parseCoverageTarget(
      'http://evil.example/api/byrdit/coverage/s4_today/model.json',
    ),
    { rest: ['s4_today', 'model.json'] },
  );
});

test('the route allowlist is closed and names no index.json', () => {
  const route = (suffix) => matchCoverageRoute(parseCoverageTarget(suffix).rest);
  assert.equal(route('/api/byrdit/coverage/models').kind, 'models');
  assert.equal(route('/api/byrdit/coverage/s4_today/model.json').kind, 'json');
  assert.equal(route('/api/byrdit/coverage/s4_today/photos.json').kind, 'json');
  assert.equal(route('/api/byrdit/coverage/s4_today/cells.json').kind, 'json');

  assert.equal(route('/api/byrdit/coverage/s4_today/points.bin').kind, 'binary');
  assert.equal(
    route('/api/byrdit/coverage/s4_today/thumbs/a.jpg').kind,
    'thumb',
  );
  assert.equal(route('/api/byrdit/coverage/s4_today/thumbs/a/b.png'), null);
  assert.equal(route('/api/byrdit/coverage/s4_today/keepsets').kind, 'keepsets');
  assert.equal(
    route('/api/byrdit/coverage/s4_today/keepsets/k1.json').kind,
    'keepset',
  );
  for (const suffix of [
    '/api/byrdit/coverage/s4_today/index.json',
    '/api/byrdit/coverage/s4_today/secret.json',
    '/api/byrdit/coverage/evil/model.json',
    '/api/byrdit/coverage/s4_today/thumbs',
    '/api/byrdit/coverage/s4_today/thumbs/a/b/c/d/e.jpg',
    '/api/byrdit/coverage/s4_today/keepsets/a/b',
    '/api/byrdit/coverage/s4_today/keepsets/a/restore',
  ]) {
    assert.equal(route(suffix), null, suffix);
  }
});

test('no identity is 401: no credential read, no upstream call', async () => {
  let reads = 0;
  const s = await boot({
    readToken: () => {
      reads += 1;
      return TOKEN;
    },
  });
  try {
    const list = await s.call('GET', '/models', { user: undefined });
    assert.equal(list.status, 401);
    const asset = await s.call('GET', '/s4_today/model.json', {
      user: undefined,
    });
    assert.equal(asset.status, 401);
    assert.equal(reads, 0, 'the credential file is not touched');
    assert.equal(s.calls.length, 0);
  } finally {
    await s.close();
  }
});

test('a header from an untrusted peer is ignored', async () => {
  const s = await boot({ trusted: '10.9.9.9' });
  try {
    const r = await s.call('GET', '/s4_today/model.json');
    assert.equal(r.status, 401);
    assert.equal(s.calls.length, 0);
  } finally {
    await s.close();
  }
});

test('the static model list is local, authenticated and credential-free', async () => {
  let reads = 0;
  const s = await boot({
    readToken: () => {
      reads += 1;
      return TOKEN;
    },
  });
  try {
    for (const suffix of ['', '/', '/models']) {
      const r = await s.call('GET', suffix);
      assert.equal(r.status, 200, suffix);
      assert.deepEqual(r.json, { source: 'static', models: COVERAGE_MODELS });
      assert.equal(r.headers['cache-control'], 'no-store');
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.equal(r.headers['set-cookie'], undefined);
      assert.ok(!r.text.includes(TOKEN));
    }
    assert.equal(reads, 0, 'listing is local and needs no credential');
    assert.equal(s.calls.length, 0);
  } finally {
    await s.close();
  }
});

test('CSRF: POST keepsets needs X-Requested-With and a same-origin Origin', async () => {
  let reads = 0;
  const s = await boot({
    readToken: () => {
      reads += 1;
      return TOKEN;
    },
    fetchImpl: async (_url, init) =>
      init.method === 'POST'
        ? jsonResponse({ id: 'k1' }, 201)
        : jsonResponse({ model: 's4_today' }),
  });
  try {
    const body = { name: 'keep' };
    const missing = await s.call('POST', '/s4_today/keepsets', {
      body,
      headers: { 'x-requested-with': '' },
    });
    assert.equal(missing.status, 403);
    const foreign = await s.call('POST', '/s4_today/keepsets', {
      body,
      headers: { 'x-requested-with': 'gev' },
      origin: 'https://evil.example',
    });
    assert.equal(foreign.status, 403);
    const wrongPort = await s.call('POST', '/s4_today/keepsets', {
      body,
      headers: { 'x-requested-with': 'gev' },
      origin: `http://127.0.0.1:${s.port + 1}`,
    });
    assert.equal(wrongPort.status, 403);
    assert.equal(reads, 0, 'a refused write never reads the credential');
    assert.equal(s.calls.length, 0);
    const same = await s.call('POST', '/s4_today/keepsets', {
      body,
      headers: { 'x-requested-with': 'gev' },
      origin: `http://127.0.0.1:${s.port}`,
    });
    assert.equal(same.status, 201);
    const noOrigin = await s.call('POST', '/s4_today/keepsets', {
      body,
      headers: { 'x-requested-with': 'gev' },
    });
    assert.equal(noOrigin.status, 201, 'an absent Origin is the same-origin case');
    // A read needs no CSRF proof.
    const read = await s.call('GET', '/s4_today/model.json');
    assert.equal(read.status, 200);
  } finally {
    await s.close();
  }
});

test('every allowed GET route reaches only its fixed upstream path', async () => {
  const cases = [
    ['/s4_today/model.json', 's4_today/model.json', 'json'],
    ['/s4_today/photos.json', 's4_today/photos.json', 'json'],
    ['/s4_today/cells.json', 's4_today/cells.json', 'json'],

    ['/s4_today/points.bin', 's4_today/points.bin', 'binary'],
    ['/s6_shop800/keepsets.json', 's6_shop800/keepsets.json', 'json'],
    ['/s6_shop800/keepsets/k_1.json', 's6_shop800/keepsets/k_1.json', 'json'],
    ['/nov16plus/thumbs/a.jpg', 'nov16plus/thumbs/a.jpg', 'jpg'],

  ];
  for (const [suffix, upstreamPath, kind] of cases) {
    const s = await boot({
      fetchImpl: async () =>
        kind === 'binary'
          ? bytesResponse('points')
          : kind === 'jpg'
            ? bytesResponse('jpeg', 'image/jpeg')
            : kind === 'png'
              ? bytesResponse('png', 'image/png')
              : jsonResponse({ path: upstreamPath }),
    });
    try {
      const r = await s.call('GET', suffix);
      assert.equal(r.status, 200, suffix);
      assert.equal(s.calls.length, 1, suffix);
      assert.equal(s.calls[0].url, `${UPSTREAM}/${upstreamPath}`, suffix);
      assert.equal(s.calls[0].init.method, 'GET');
      assert.equal(s.calls[0].init.redirect, 'manual');
      assert.equal(s.calls[0].init.body, undefined);
      assert.deepEqual(
        Object.keys(s.calls[0].init.headers)
          .map((name) => name.toLowerCase())
          .sort(),
        ['accept', 'user-agent'],
        'no browser header is forwarded',
      );
      if (kind === 'json')
        assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
      if (kind === 'binary')
        assert.equal(r.headers['content-type'], 'application/octet-stream');
      if (kind === 'jpg') assert.equal(r.headers['content-type'], 'image/jpeg');
      if (kind === 'png') assert.equal(r.headers['content-type'], 'image/png');
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.equal(r.headers.location, undefined);
      assert.equal(r.headers['set-cookie'], undefined);
      assert.ok(!r.text.includes(TOKEN));
    } finally {
      await s.close();
    }
  }
});

test('trainer exclude list is proxied as text from the actual upstream route', async () => {
  const s = await boot({ fetchImpl: async () => bytesResponse('photo.jpg\n', 'text/plain') });
  try {
    const r = await s.call('GET', '/s4_today/keepsets/saved.train_exclude.txt');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(r.text, 'photo.jpg\n');
    assert.equal(s.calls[0].url, `${UPSTREAM}/s4_today/keepsets/saved.train_exclude.txt`);
  } finally { await s.close(); }
});

test('POST keepsets forwards the exact body and only JSON headers', async () => {
  const body = '{"name":"keep","photo_ids":["a","b"]}';
  let seen;
  const s = await boot({
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return jsonResponse({ id: 'k1' }, 201);
    },
  });
  try {
    const r = await s.call('POST', '/s6_shop800/keepsets', {
      body,
      headers: { 'x-requested-with': 'gev' },
    });
    assert.equal(r.status, 201);
    assert.deepEqual(r.json, { id: 'k1' });
    assert.equal(seen.url, `${UPSTREAM}/s6_shop800/keepsets`);
    assert.equal(seen.init.method, 'POST');
    assert.equal(Buffer.from(seen.init.body).toString('utf8'), body);
    assert.deepEqual(
      Object.keys(seen.init.headers)
        .map((name) => name.toLowerCase())
        .sort(),
      ['accept', 'content-type', 'user-agent'],
    );
    assert.equal(seen.init.headers['Content-Type'], 'application/json');
    assert.equal(seen.init.redirect, 'manual');
  } finally {
    await s.close();
  }
});

test('POST keepsets rejects non-JSON and oversized bodies before upstream', async () => {
  let reads = 0;
  const s = await boot({
    readToken: () => {
      reads += 1;
      return TOKEN;
    },
    postBodyLimit: 16,
  });
  try {
    const text = await s.call('POST', '/s4_today/keepsets', {
      body: 'hello',
      contentType: 'text/plain',
      headers: { 'x-requested-with': 'gev' },
    });
    assert.equal(text.status, 415);
    const huge = await s.call('POST', '/s4_today/keepsets', {
      body: '{"a":"123456789"}',
      headers: { 'x-requested-with': 'gev' },
    });
    assert.equal(huge.status, 413);
    assert.equal(reads, 0, 'neither malformed write reads the credential');
    assert.equal(s.calls.length, 0);
  } finally {
    await s.close();
  }
});

test('a response over its cap is refused; a request path over its cap is 400', async () => {
  const s = await boot({
    limits: { 'model.json': 32 },
    fetchImpl: async () =>
      new Response(JSON.stringify({ x: 'y'.repeat(64) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  });
  try {
    const r = await s.call('GET', '/s4_today/model.json');
    assert.equal(r.status, 502);
    assert.ok(!r.text.includes(TOKEN));
  } finally {
    await s.close();
  }
  const long = await boot();
  try {
    const r = await long.call(
      'GET',
      `/s4_today/thumbs/${'a'.repeat(1100)}.jpg`,
    );
    assert.equal(r.status, 400);
    assert.equal(long.calls.length, 0);
  } finally {
    await long.close();
  }
});

test('upstream 404 is 404; every other refusal is a sanitized 502', async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    const s = await boot({
      fetchImpl: async () =>
        new Response(`upstream error ${TOKEN}`, {
          status,
          headers: {
            'content-type': 'text/plain',
            'www-authenticate': `Basic ${TOKEN}`,
            'set-cookie': `a=${TOKEN}`,
          },
        }),
    });
    try {
      const r = await s.call('GET', '/s4_today/model.json');
      assert.equal(r.status, 502, String(status));
      assert.deepEqual(r.json, {
        error: 'upstream-refused',
        message: 'The coverage origin refused the request',
      });
      assert.ok(!r.text.includes(TOKEN));
      assert.equal(r.headers['www-authenticate'], undefined);
      assert.equal(r.headers['set-cookie'], undefined);
      assert.equal(r.headers.location, undefined);
      assert.ok(
        s.logs.every((args) =>
          args.every((arg) => !String(arg).includes(TOKEN)),
        ),
      );
    } finally {
      await s.close();
    }
  }
  const s = await boot({ fetchImpl: async () => new Response('no', { status: 404 }) });
  try {
    const r = await s.call('GET', '/s4_today/model.json');
    assert.equal(r.status, 404);
    assert.deepEqual(r.json, {
      error: 'not-found',
      message: 'No such coverage route',
    });
    assert.equal(s.calls.length, 1);
  } finally {
    await s.close();
  }
});

test('upstream success headers are never copied', async () => {
  const s = await boot({
    fetchImpl: async () =>
      new Response('{"ok":true}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          location: `http://evil.example/${TOKEN}`,
          'set-cookie': `a=${TOKEN}`,
          'www-authenticate': `Basic ${TOKEN}`,
        },
      }),
  });
  try {
    const r = await s.call('GET', '/s4_today/model.json');
    assert.equal(r.status, 200);
    for (const name of ['location', 'set-cookie', 'www-authenticate'])
      assert.equal(r.headers[name], undefined, name);
    assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
    assert.ok(!r.text.includes(TOKEN));
  } finally {
    await s.close();
  }
});

test('redirects are refused and Location is never forwarded', async () => {
  const s = await boot({
    fetchImpl: async () =>
      new Response(null, {
        status: 302,
        headers: { location: `http://evil.example/${TOKEN}` },
      }),
  });
  try {
    const r = await s.call('GET', '/s4_today/model.json');
    assert.equal(r.status, 502);
    assert.equal(r.json.error, 'upstream-redirect');
    assert.equal(r.headers.location, undefined);
    assert.ok(!r.text.includes(TOKEN));
    assert.equal(s.calls[0].init.redirect, 'manual');
  } finally {
    await s.close();
  }
});

test('the credential never reaches a response or a log', async () => {
  const thrown = new Error(`failed ${COVERAGE_ORIGIN}/${TOKEN}/cov`);
  thrown.cause = new Error(TOKEN);
  const s = await boot({
    fetchImpl: async () => {
      throw thrown;
    },
  });
  try {
    const r = await s.call('GET', '/s4_today/model.json');
    assert.equal(r.status, 502);
    assert.equal(r.json.error, 'upstream-error');
    assert.ok(!r.text.includes(TOKEN));
    assert.ok(!JSON.stringify(r.headers).includes(TOKEN));
    assert.ok(
      s.logs.every((args) =>
        args.every((arg) => !String(arg).includes(TOKEN)),
      ),
    );
  } finally {
    await s.close();
  }

  const readFailure = await boot({
    readToken: () => {
      throw new Error(`cannot read ${TOKEN}`);
    },
  });
  try {
    const r = await readFailure.call('GET', '/s4_today/model.json');
    assert.equal(r.status, 503);
    assert.equal(r.json.error, 'coverage-unavailable');
    assert.ok(!r.text.includes(TOKEN));
    assert.equal(readFailure.calls.length, 0);
    assert.ok(
      readFailure.logs.every((args) =>
        args.every((arg) => !String(arg).includes(TOKEN)),
      ),
    );
  } finally {
    await readFailure.close();
  }

  const invalid = await boot({ token: `${TOKEN}/extra` });
  try {
    const r = await invalid.call('GET', '/s4_today/model.json');
    assert.equal(r.status, 503);
    assert.ok(!r.text.includes(TOKEN));
    assert.equal(invalid.calls.length, 0);
  } finally {
    await invalid.close();
  }
});

test('a success body that echoes the credential is refused, not forwarded', async () => {
  const s = await boot({
    fetchImpl: async () =>
      jsonResponse({ model: 's4_today', leak: TOKEN }),
  });
  try {
    const r = await s.call('GET', '/s4_today/model.json');
    assert.equal(r.status, 502);
    assert.equal(r.json.error, 'upstream-leak');
    assert.ok(!r.text.includes(TOKEN));
    assert.ok(
      s.logs.every((args) =>
        args.every((arg) => !String(arg).includes(TOKEN)),
      ),
    );
  } finally {
    await s.close();
  }
});

test('short credentials are scanned too: JSON and binary reflections fail closed', async () => {
  // Every one of these passes isSafeCoverageToken; the first three are shorter
  // than the old 8-byte scan floor. None of these strings occurs in the fixed
  // error body, so its absence proves the upstream body was not forwarded.
  const tokens = ['q7z', 'abc1234', 'tok-7ch', TOKEN];
  for (const token of tokens) {
    for (const kind of ['json', 'binary']) {
      const s = await boot({
        token,
        fetchImpl: async () =>
          kind === 'json'
            ? jsonResponse({ model: 's4_today', leak: token })
            : bytesResponse(
                Buffer.concat([
                  Buffer.from([0x00, 0x7f, 0xff]),
                  Buffer.from(token, 'utf8'),
                ]),
              ),
      });
      try {
        const suffix =
          kind === 'json' ? '/s4_today/model.json' : '/s4_today/points.bin';
        const r = await s.call('GET', suffix);
        assert.equal(r.status, 502, `${token} ${kind}`);
        assert.equal(r.json.error, 'upstream-leak', `${token} ${kind}`);
        assert.equal(r.json.message, 'The coverage origin response was refused');
        assert.ok(
          !r.buffer.includes(Buffer.from(token, 'utf8')),
          `${token} ${kind}: the reflected credential is not forwarded`,
        );
        assert.ok(
          s.logs.every((args) =>
            args.every((arg) => !String(arg).includes(token)),
          ),
          `${token} ${kind}: the credential is not logged`,
        );
      } finally {
        await s.close();
      }
    }
  }
});

test('a short credential is not refused when the body does not reflect it', async () => {
  for (const [suffix, response] of [
    ['/s4_today/model.json', () => jsonResponse({ ok: true })],
    ['/s4_today/points.bin', () => bytesResponse(Buffer.from([0x00, 0x01, 0x02]))],
  ]) {
    const s = await boot({ token: 'q7z', fetchImpl: async () => response() });
    try {
      const r = await s.call('GET', suffix);
      assert.equal(r.status, 200, suffix);
      assert.equal(s.calls.length, 1, suffix);
    } finally {
      await s.close();
    }
  }
});

test('upstream timeouts are bounded and sanitized', async () => {
  const s = await boot({
    timeoutMs: 20,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          { once: true },
        );
      }),
  });
  try {
    const r = await s.call('GET', '/s4_today/model.json');
    assert.equal(r.status, 504);
    assert.equal(r.json.error, 'upstream-timeout');
    assert.ok(!r.text.includes(TOKEN));
  } finally {
    await s.close();
  }
});

test('method allowlist: unknown methods are 405 with the right Allow', async () => {
  const s = await boot();
  try {
    const cases = [
      ['PUT', '/s4_today/model.json', 'GET'],
      ['POST', '/s4_today/model.json', 'GET'],
      ['POST', '/s4_today/keepsets/k1.json', 'GET'],
      ['DELETE', '/s4_today/keepsets', 'POST'],
      ['HEAD', '/s4_today/model.json', 'GET'],
    ];
    for (const [method, suffix, allow] of cases) {
      const r = await s.call(method, suffix, {
        headers: { 'x-requested-with': 'gev' },
      });
      assert.equal(r.status, 405, `${method} ${suffix}`);
      assert.equal(r.headers.allow, allow, `${method} ${suffix}`);
    }
    assert.equal(s.calls.length, 0);
  } finally {
    await s.close();
  }
});

test('unknown routes are 404 and never touch upstream', async () => {
  const s = await boot();
  try {
    for (const suffix of [
      '/s4_today/index.json',
      '/s4_today/secret.json',
      '/evil/model.json',
      '/s4_today/thumbs',
      '/s4_today/keepsets/a/b',
    ]) {
      const r = await s.call('GET', suffix);
      assert.equal(r.status, 404, suffix);
      assert.equal(r.json.error, 'not-found', suffix);
    }
    assert.equal(s.calls.length, 0);
  } finally {
    await s.close();
  }
});

test('unrelated targets fall through; malformed coverage targets are 400', async () => {
  const calls = [];
  const handler = createCoverageHandler({
    env: { GEV_TRUSTED_PROXIES: '127.0.0.1' },
    readToken: () => TOKEN,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ ok: true });
    },
    logger: { error: () => {} },
  });
  for (const url of ['/other%', '/api/byrdit/coveragex', '/api/byrdit/plan']) {
    assert.equal(await direct(handler, url), null, url);
  }
  for (const url of [
    '/api/byrdit/coverage/../other',
    '/api/byrdit/coverage/s4_today/model%.json',
    '/api/byrdit/coverage/%2e%2e/x',
    '/api/byrdit/coverage/s4_today/../model.json',
    '/api/byrdit/coverage/s4_today/model.json?x=1',
    '/api/byrdit/coverage/s4_today/model.json#x',
    '/api/byrdit/coverage/s4_today\\model.json',
    '/api/byrdit/coverage//s4_today/model.json',
  ]) {
    const answer = await direct(handler, url);
    assert.equal(answer.status, 400, url);
    assert.equal(JSON.parse(answer.text).error, 'bad-target', url);
  }
  // An absolute-form target naming another authority still reaches the one
  // fixed origin: the request's host is never used as an upstream.
  const absolute = await direct(
    handler,
    'http://evil.example/api/byrdit/coverage/s4_today/model.json',
  );
  assert.equal(absolute.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${UPSTREAM}/s4_today/model.json`);
});

test('defaultReadToken reads the credential file and trims it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-coverage-token-'));
  try {
    const file = path.join(dir, 'coverage-token');
    writeFileSync(file, `  ${TOKEN}\n`, { mode: 0o600 });
    assert.equal(defaultReadToken(file), TOKEN);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the plugin installs the same handler for dev and preview', () => {
  const [plugin] = coveragePlugins({
    env: {},
    readToken: () => TOKEN,
    fetchImpl: async () => jsonResponse({ ok: true }),
  });
  assert.equal(plugin.name, 'byrdit-coverage');
  const installed = [];
  for (const key of ['configureServer', 'configurePreviewServer']) {
    plugin[key]({ middlewares: { use: (handler) => installed.push(handler) } });
  }
  assert.equal(installed.length, 2);
  assert.equal(typeof installed[0], 'function');
  assert.equal(installed[0], installed[1]);
});

test('the plugin hooks return nothing, so Vite has no post hook to call', () => {
  const [plugin] = coveragePlugins({
    env: {},
    readToken: () => TOKEN,
    fetchImpl: async () => jsonResponse({ ok: true }),
  });
  // connect's `use` returns the app; a hook that passed it on would hand
  // Vite a post hook that calls the app with no request.
  const app = () => {
    throw new Error('the app was called as a post hook');
  };
  app.use = () => app;
  for (const key of ['configureServer', 'configurePreviewServer'])
    assert.equal(plugin[key]({ middlewares: app }), undefined, key);
});

test('a real Vite dev server starts and stops with the coverage plugin', async () => {
  const { createServer } = await import('vite');
  const server = await createServer({
    configFile: false,
    root: path.dirname(new URL(import.meta.url).pathname),
    plugins: coveragePlugins({
      env: {},
      readToken: () => TOKEN,
      fetchImpl: async () => jsonResponse({ ok: true }),
    }),
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
    logLevel: 'silent',
  });
  await server.close();
});
