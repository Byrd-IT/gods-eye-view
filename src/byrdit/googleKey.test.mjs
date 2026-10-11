// Byrd-IT: Google Photorealistic 3D runs directly on OUR Google key, delivered
// at runtime from a same-origin endpoint in obfuscated form (obfuscation, not
// secrecy: the key still shows in tile request URLs). Pins the codec, the
// route (no-store, same-site gated, GET only, never plaintext) and the
// browser-side fetch + decode.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  encodeGoogleKey,
  decodeGoogleKey,
} from './googleKeyCodec.js';
import {
  createGoogleKeyRouteHandler,
  gatedGoogleKeyRoute,
  GOOGLE_KEY_PATH,
} from '../../server/byrdit/keyIsolation/googleKey.js';
import { fetchGoogleKey } from './serverKeys.js';

const KEY = `AIza${'Sy'}${'Q'.repeat(10)}${'k'.repeat(10)}${'9'.repeat(13)}`;
const salt = Uint8Array.from({ length: 16 }, (_, i) => 17 * i + 5);

function call(handler, { method = 'GET', url = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const out = {};
    const res = {
      statusCode: 200,
      setHeader(name, value) {
        out[name.toLowerCase()] = String(value);
      },
      end(body) {
        resolve({ status: this.statusCode, headers: out, text: body ?? '' });
      },
    };
    Promise.resolve(
      handler(
        {
          method,
          url,
          headers: { host: '127.0.0.1:4173', ...headers },
          socket: { remoteAddress: '127.0.0.1' },
        },
        res,
      ),
    ).catch(reject);
  });
}

test('codec: round-trips, and the wire form never contains the key or its base64', () => {
  for (let n = 0; n < 50; n += 1) {
    const nonce = randomBytes(12);
    const payload = encodeGoogleKey(KEY, { salt, nonce });
    assert.equal(decodeGoogleKey(payload), KEY);
    const wire = JSON.stringify(payload);
    assert.equal(wire.includes(KEY), false);
    assert.equal(wire.includes(Buffer.from(KEY).toString('base64')), false);
    assert.equal(wire.includes(KEY.slice(0, 8)), false);
    assert.ok(payload.p.length >= 3 && payload.p.length <= 5);
  }
});

test('codec: a different nonce gives a different wire form (per-response), same key', () => {
  const a = encodeGoogleKey(KEY, { salt, nonce: randomBytes(12) });
  const b = encodeGoogleKey(KEY, { salt, nonce: randomBytes(12) });
  assert.notEqual(JSON.stringify(a), JSON.stringify(b));
  assert.equal(decodeGoogleKey(a), decodeGoogleKey(b));
});

test('codec: shard order on the wire is shuffled, decode restores key order', () => {
  let shuffled = false;
  for (let n = 0; n < 40 && !shuffled; n += 1) {
    const payload = encodeGoogleKey(KEY, { salt, nonce: randomBytes(12) });
    shuffled = payload.p.some((shard, index) => shard.i !== index);
  }
  assert.ok(shuffled, 'shards were never reordered in 40 tries');
});

test('codec: malformed, tampered and wrong-version payloads decode to empty, never throw', () => {
  const good = encodeGoogleKey(KEY, { salt, nonce: randomBytes(12) });
  for (const bad of [
    null,
    undefined,
    {},
    'x',
    { ...good, v: 2 },
    { ...good, p: [] },
    { ...good, p: good.p.slice(1) },
    { ...good, p: good.p.slice(0, -1) },
    { ...good, c: undefined },
    ...good.p.map((_, drop) => ({
      ...good,
      p: good.p.filter((__, index) => index !== drop),
    })),
    { ...good, s: '***' },
    { ...good, n: '' },
    { ...good, p: good.p.map((shard) => ({ ...shard, d: '!!' })) },
  ])
    assert.equal(decodeGoogleKey(bad), '');
  assert.throws(() => encodeGoogleKey('', { salt, nonce: randomBytes(12) }));
  assert.throws(() => encodeGoogleKey(KEY, { salt: new Uint8Array(0), nonce: randomBytes(12) }));
});

test('route: serves an obfuscated key with no-store headers; plaintext never appears', async () => {
  const handler = createGoogleKeyRouteHandler({
    env: { GOOGLE_MAPS_API_KEY: KEY },
    salt,
  });
  const res = await call(handler);
  assert.equal(res.status, 200);
  assert.match(res.headers['cache-control'], /no-store/);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.equal(res.text.includes(KEY), false);
  assert.equal(decodeGoogleKey(JSON.parse(res.text)), KEY);
});

test('route: per-boot salt is random and the same for every response of one boot', async () => {
  const one = createGoogleKeyRouteHandler({ env: { GOOGLE_MAPS_API_KEY: KEY } });
  const two = createGoogleKeyRouteHandler({ env: { GOOGLE_MAPS_API_KEY: KEY } });
  const a1 = JSON.parse((await call(one)).text);
  const a2 = JSON.parse((await call(one)).text);
  const b1 = JSON.parse((await call(two)).text);
  assert.equal(a1.s, a2.s);
  assert.notEqual(a1.s, b1.s);
  assert.notEqual(a1.n, a2.n);
});

test('route: no key → 404 configured:false; non-GET → 405; both no-store', async () => {
  const none = createGoogleKeyRouteHandler({ env: { GOOGLE_MAPS_API_KEY: '  ' } });
  const missing = await call(none);
  assert.equal(missing.status, 404);
  assert.deepEqual(JSON.parse(missing.text), { configured: false });
  assert.match(missing.headers['cache-control'], /no-store/);
  const handler = createGoogleKeyRouteHandler({ env: { GOOGLE_MAPS_API_KEY: KEY } });
  const post = await call(handler, { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.text.includes(KEY), false);
});

test('route: cross-site browser requests are refused before the key is touched', async () => {
  const handler = gatedGoogleKeyRoute({ env: { GOOGLE_MAPS_API_KEY: KEY } });
  const res = await call(handler, {
    headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(res.status, 403);
  assert.equal(res.text.includes(KEY), false);
  const ok = await call(handler, { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(ok.status, 200);
});

test('route: rate limited per client, and the limited answer carries no key', async () => {
  let calls = 0;
  const handler = createGoogleKeyRouteHandler({
    env: { GOOGLE_MAPS_API_KEY: KEY },
    allow: () => ++calls <= 1,
  });
  assert.equal((await call(handler)).status, 200);
  const limited = await call(handler);
  assert.equal(limited.status, 429);
  assert.equal(limited.text.includes(KEY), false);
});

test('the key is read per request, so a rotated .env key is served without a code change', async () => {
  const env = { GOOGLE_MAPS_API_KEY: KEY };
  const handler = createGoogleKeyRouteHandler({ env, salt });
  assert.equal(decodeGoogleKey(JSON.parse((await call(handler)).text)), KEY);
  env.GOOGLE_MAPS_API_KEY = `${KEY}Z`;
  assert.equal(
    decodeGoogleKey(JSON.parse((await call(handler)).text)),
    `${KEY}Z`,
  );
});

test('browser: fetchGoogleKey decodes the server answer; every failure reads as no key', async () => {
  const handler = createGoogleKeyRouteHandler({ env: { GOOGLE_MAPS_API_KEY: KEY } });
  const viaRoute = async (url, init) => {
    assert.equal(url, GOOGLE_KEY_PATH);
    assert.equal(init.cache, 'no-store');
    const res = await call(handler);
    return new Response(res.text, { status: res.status });
  };
  assert.equal(await fetchGoogleKey(viaRoute), KEY);
  assert.equal(
    await fetchGoogleKey(async () => new Response('{}', { status: 404 })),
    '',
  );
  assert.equal(
    await fetchGoogleKey(async () => new Response('not json', { status: 200 })),
    '',
  );
  assert.equal(
    await fetchGoogleKey(async () => {
      throw new Error('offline');
    }),
    '',
  );
});

test('the plaintext key is not a window global anywhere in production code', async () => {
  const { spawnSync } = await import('node:child_process');
  const run = spawnSync(
    'git',
    ['grep', '-n', '__GOOGLE_MAPS_API_KEY__', '--', 'src', 'server', 'build', ':!*.test.*'],
    { encoding: 'utf8' },
  );
  // Only the legacy default resolver in the search package may mention it.
  const lines = run.stdout.split('\n').filter(Boolean);
  assert.deepEqual(
    lines.filter((line) => !line.startsWith('src/search/defaults.js:')),
    [],
  );
});
