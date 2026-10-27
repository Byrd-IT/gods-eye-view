import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { createWaybackHandler, waybackSettingsFromEnv } from './index.js';
import { safeReason } from './releases.js';

/**
 * Synthetic-secret probe (pre-review self-check step 1): fake credentials are
 * pushed through every log line, error, HTTP response and header this module
 * produces on its failure paths, and must appear nowhere: verbatim, as a
 * prefix or suffix, URL-encoded or base64.
 */
const nonce = randomBytes(6).toString('hex');
const SECRETS = {
  bearer: `Bearer synthTOK${nonce}abcdefABC123`,
  userinfo: `https://synthuser${nonce}:synthpass${nonce}@evil.example/x`,
  suffixed: `synthsuffixed${nonce}ZZ9988`,
  headerKey: `synthhdrkey${nonce}Qw7rT2`,
  queryKey: `synthqrykey${nonce}Lm4nP8`,
};
const forms = (value) => {
  const raw = String(value).replace(/^Bearer /, '');
  return [
    value,
    raw,
    raw.slice(0, 8) === raw ? null : raw.slice(0, 12),
    raw.slice(-6),
    encodeURIComponent(value),
    Buffer.from(value).toString('base64'),
    Buffer.from(raw).toString('base64'),
  ].filter(Boolean);
};
const NEEDLES = Object.values(SECRETS).flatMap(forms);
const leaks = (text) => NEEDLES.filter((n) => String(text).includes(n));

const poisonedMessage = `connect failed ${SECRETS.userinfo}?api_key=${SECRETS.queryKey} ${SECRETS.bearer} x-api-key=${SECRETS.headerKey} ${SECRETS.suffixed}`;
const poisoned = () => {
  const e = new Error(poisonedMessage);
  e.cause = new Error(poisonedMessage);
  e.cause.code = 'ECONNREFUSED';
  return e;
};

function request(handler, method, url) {
  return new Promise((resolve, reject) => {
    const req = Object.assign(Readable.from([]), {
      method,
      url,
      headers: {
        authorization: SECRETS.bearer,
        cookie: `sid=${SECRETS.suffixed}`,
        'x-api-key': SECRETS.headerKey,
      },
    });
    const out = { status: 0, headers: {}, body: '' };
    const res = {
      statusCode: 200,
      setHeader: (k, v) => (out.headers[k.toLowerCase()] = String(v)),
      end(data) {
        out.status = this.statusCode;
        out.body =
          data === undefined ? '' : Buffer.from(data).toString('latin1');
        resolve(out);
      },
    };
    Promise.resolve(
      handler(req, res, () => resolve({ ...out, nexted: true })),
    ).catch(reject);
  });
}

async function run(fetchImpl) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-wb-probe-'));
  const logs = [];
  const settings = waybackSettingsFromEnv({
    GEV_BYRDIT_WAYBACK: '1',
    GEV_BYRDIT_WAYBACK_INFO: '1',
    GEV_BYRDIT_WAYBACK_CACHE_DIR: dir,
  });
  const handler = createWaybackHandler(settings, {
    fetchImpl,
    log: (...a) => logs.push(a.map(String).join(' ')),
  });
  const seen = [];
  for (const url of [
    '/api/byrdit/wayback/releases',
    '/api/byrdit/wayback/tile/63116/17/5/6',
    '/api/byrdit/wayback/cache-status',
    '/api/byrdit/wayback/info?release=63116&lat=1&lon=1&z=3',
    `/api/byrdit/wayback/tile/63116/17/5/6?api_key=${SECRETS.queryKey}`,
    `/api/byrdit/wayback/tile/${SECRETS.suffixed}/1/1/1`,
  ]) {
    const r = await request(handler, 'GET', url);
    seen.push(JSON.stringify(r));
  }
  return { logs, seen, handler };
}

const CONFIG = JSON.stringify({
  63116: {
    itemTitle: 'World Imagery (Wayback 2026-09-24)',
    metadataLayerUrl:
      'https://metadata.maptiles.arcgis.com/arcgis/rest/services/M/MapServer',
  },
});

test('secret probe: upstream network errors carrying secrets reach no log, response or header', async () => {
  const { logs, seen } = await run(async () => {
    throw poisoned();
  });
  assert.ok(logs.length > 0, 'the failure paths ran and logged');
  assert.deepEqual(leaks(logs.join('\n')), [], 'logs');
  assert.deepEqual(leaks(seen.join('\n')), [], 'responses and headers');
});

test('secret probe: upstream HTTP errors, hostile bodies and headers carrying secrets stay out', async () => {
  const hostile = new Response(`${poisonedMessage}`, {
    status: 503,
    headers: {
      'set-cookie': `sid=${SECRETS.suffixed}`,
      'x-api-key': SECRETS.headerKey,
      location: `${SECRETS.userinfo}?api_key=${SECRETS.queryKey}`,
      'www-authenticate': SECRETS.bearer,
    },
  });
  for (const make of [
    () => hostile.clone(),
    () => new Response(poisonedMessage, { status: 200 }),
    () => new Response(CONFIG + poisonedMessage, { status: 200 }),
  ]) {
    const { logs, seen } = await run(async () => make());
    assert.deepEqual(leaks(logs.join('\n')), [], 'logs');
    assert.deepEqual(leaks(seen.join('\n')), [], 'responses and headers');
  }
});

test('secret probe: tile fetch failures with a valid list leak nothing (error objects, causes, stacks)', async () => {
  const errors = [];
  const { logs, seen, handler } = await run(async (url) => {
    if (String(url).includes('waybackconfig')) return new Response(CONFIG);
    return Promise.reject(poisoned());
  });
  try {
    await handler.tiles.getTile(63116, 17, 5, 7);
  } catch (error) {
    errors.push(
      error.message,
      error.stack,
      JSON.stringify(error),
      String(error.cause ?? ''),
      JSON.stringify({ ...error }),
    );
  }
  assert.ok(errors.length >= 4, 'a thrown error was captured');
  assert.deepEqual(leaks(errors.join('\n')), [], 'thrown errors');
  assert.deepEqual(leaks(logs.join('\n')), [], 'logs');
  assert.deepEqual(leaks(seen.join('\n')), [], 'responses');
});

test('secret probe: safeReason never returns a foreign message', () => {
  const reason = safeReason(poisoned());
  assert.deepEqual(leaks(reason), []);
  assert.equal(
    safeReason(
      Object.assign(new Error(poisonedMessage), { code: 'ETIMEDOUT' }),
    ),
    'Error ETIMEDOUT',
  );
  assert.equal(safeReason('weird'), 'Error');
});

test('secret probe: the probe itself detects a leak (negative control)', () => {
  assert.ok(leaks(`oops ${SECRETS.bearer}`).length > 0);
  assert.ok(leaks(`oops ${encodeURIComponent(SECRETS.userinfo)}`).length > 0);
  assert.ok(leaks(`oops ...${SECRETS.suffixed.slice(-6)}`).length > 0);
  assert.ok(leaks(Buffer.from(SECRETS.queryKey).toString('base64')).length > 0);
});
