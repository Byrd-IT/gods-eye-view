// Byrd-IT: no long-lived third-party key may reach a browser. This starts the
// real standalone Vite config with realistic-looking fake secrets in the
// environment, transforms the entry module graph the way the dev server serves
// it, and fails if any secret value (or its recognisable prefix pattern) shows
// up in served client code. The full production-build variant lives in
// scripts/check-key-exposure.mjs (npm run check:key-exposure).
//
// Google 3D is the one key the browser really needs (it requests tiles from
// Google itself). It is delivered at runtime from /api/google/tiles-key in
// obfuscated form: the PLAINTEXT key (and its base64/hex forms) must still be
// absent from every served file and from that endpoint's body.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { createServer } from 'vite';
import { decodeGoogleKey } from '../byrdit/googleKeyCodec.js';
import { createBrowserViteConfig } from '../../build/vite.js';
import { KEY_SETUP_KEYS, keySetupStatus } from '../keySetupCore.mjs';

const GOOGLE = `AIza${'Sy'}${'F'.repeat(33)}`;
const MAPILLARY = `MLY|${'7'.repeat(16)}|${'b'.repeat(32)}`;
const ION = [
  'eyJ',
  'h'.repeat(24),
  '.',
  'p'.repeat(24),
  '.',
  's'.repeat(24),
].join('');
const SECRETS = {
  GOOGLE_MAPS_API_KEY: GOOGLE,
  MAPILLARY_CLIENT_TOKEN: MAPILLARY,
  CESIUM_ION_TOKEN: ION,
};
// Recognisable shapes of the credentials (the SDK's own public default ion
// token is excluded: it is compared by exact value of OUR token instead).
const LEAK_PATTERNS = [/AIza[0-9A-Za-z_-]{30,}/, /MLY\|\d{8,}\|[0-9a-f]{20,}/i];

// Trivial re-encodings of the Google key that a "view source" grep would catch.
const GOOGLE_FORMS = [
  GOOGLE,
  Buffer.from(GOOGLE).toString('base64'),
  Buffer.from(GOOGLE).toString('hex'),
  encodeURIComponent(GOOGLE),
  [...GOOGLE].reverse().join(''),
];

function findLeaks(text, secrets = Object.values(SECRETS)) {
  const hits = [];
  for (const secret of secrets) if (text.includes(secret)) hits.push('value');
  for (const form of GOOGLE_FORMS) if (text.includes(form)) hits.push('google-form');
  for (const pattern of LEAK_PATTERNS)
    if (pattern.test(text)) hits.push(String(pattern));
  return hits;
}

test('the scanner itself catches each credential shape', () => {
  assert.deepEqual(findLeaks('x'), []);
  assert.ok(findLeaks(`k="${GOOGLE}"`).length);
  assert.ok(findLeaks(`k="${MAPILLARY}"`).length);
  assert.ok(findLeaks(`k="${ION}"`).length);
  assert.ok(findLeaks(`k="${Buffer.from(GOOGLE).toString('base64')}"`).length);
  assert.ok(findLeaks(`k="${Buffer.from(GOOGLE).toString('hex')}"`).length);
});

test('no src module reads a provider key from the build environment', () => {
  const run = spawnSync(
    'git',
    [
      'grep',
      '-nE',
      'import\\.meta\\.env\\??\\.(GOOGLE_MAPS_API_KEY|CESIUM_ION_TOKEN|MAPILLARY_CLIENT_TOKEN)',
      '--',
      'src',
      'build',
      'server',
      ':!*.test.*',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 1, `git grep matched:\n${run.stdout}`);
});

test('the build config defines no provider keys, whatever the caller passes', () => {
  const config = createBrowserViteConfig({
    googleApiKey: GOOGLE,
    cesiumToken: ION,
    mapillaryToken: MAPILLARY,
  });
  assert.equal(JSON.stringify(config).includes(GOOGLE), false);
  assert.equal(JSON.stringify(config).includes(MAPILLARY), false);
  assert.equal(JSON.stringify(config).includes(ION), false);
});

test('key setup status reports set/unset only, with no browser-exposed key', () => {
  const status = keySetupStatus({ ...SECRETS });
  assert.equal(findLeaks(JSON.stringify(status)).length, 0);
  for (const id of ['google-maps', 'cesium-ion', 'mapillary']) {
    const entry = status.keys.find((k) => k.id === id);
    assert.equal(entry.set, true);
    assert.equal(entry.clientExposed, false, id);
  }
  assert.equal(
    KEY_SETUP_KEYS.some((k) => k.clientExposed),
    false,
  );
});

test(
  'dev-served client modules carry no key value or key-shaped string',
  { timeout: 240_000 },
  async () => {
    const saved = {};
    for (const [name, value] of Object.entries(SECRETS)) {
      saved[name] = process.env[name];
      process.env[name] = value;
    }
    let server;
    try {
      server = await createServer({
        configFile: new URL(
          '../../server/standalone/vite.config.js',
          import.meta.url,
        ).pathname,
        server: { middlewareMode: true, hmr: false, watch: null },
        appType: 'custom',
        optimizeDeps: { noDiscovery: true, include: [] },
        logLevel: 'silent',
      });
      const seen = new Set();
      const queue = ['/src/main.js'];
      let scanned = 0;
      while (queue.length && scanned < 400) {
        const url = queue.shift();
        if (seen.has(url)) continue;
        seen.add(url);
        const result = await server.transformRequest(url).catch(() => null);
        if (!result) continue;
        scanned += 1;
        assert.deepEqual(findLeaks(result.code), [], `leak in ${url}`);
        for (const dep of result.deps ?? [])
          if (dep.startsWith('/src/')) queue.push(dep);
        for (const match of result.code.matchAll(
          /from\s+["'](\/src\/[^"'?]+)/g,
        ))
          queue.push(match[1]);
      }
      assert.ok(scanned >= 5, `scanned ${scanned} modules`);
      const html = await server.transformIndexHtml(
        '/',
        readFileSync(new URL('../../index.html', import.meta.url), 'utf8'),
      );
      assert.deepEqual(findLeaks(html), []);
    } finally {
      await server?.close();
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  },
);

// The production build targets es2020 (Vite default), which rejects top-level
// await. The dev server tolerates it, so a TLA in the entry module only fails
// at `vite build`. Guard it with the same target.
test('entry module has no top-level await (production build target)', async () => {
  const { transform } = await import('esbuild');
  await transform(readFileSync(new URL('../main.js', import.meta.url), 'utf8'), {
    loader: 'js',
    target: ['es2020', 'chrome87', 'safari14'],
    format: 'esm',
  });
});

// The runtime endpoint: behind the app's server, obfuscated, never cached.
test(
  'the Google key endpoint serves only an obfuscated, no-store payload; ion asset 2275207 is refused',
  { timeout: 240_000 },
  async () => {
    const saved = {};
    for (const [name, value] of Object.entries(SECRETS)) {
      saved[name] = process.env[name];
      process.env[name] = value;
    }
    let server;
    let listener;
    try {
      server = await createServer({
        configFile: new URL(
          '../../server/standalone/vite.config.js',
          import.meta.url,
        ).pathname,
        server: { middlewareMode: true, hmr: false, watch: null },
        appType: 'custom',
        optimizeDeps: { noDiscovery: true, include: [] },
        logLevel: 'silent',
      });
      listener = http.createServer(server.middlewares);
      await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${listener.address().port}`;

      const res = await fetch(`${origin}/api/google/tiles-key`);
      const body = await res.text();
      assert.equal(res.status, 200);
      assert.match(res.headers.get('cache-control') ?? '', /no-store/);
      assert.deepEqual(findLeaks(body), [], 'plaintext key in endpoint body');
      assert.equal(decodeGoogleKey(JSON.parse(body)), GOOGLE);
      // A second call is a different wire form (fresh nonce, shuffled shards).
      const again = await (await fetch(`${origin}/api/google/tiles-key`)).text();
      assert.notEqual(again, body);

      // No fallback of Google 3D to Cesium's account: ion asset 2275207 is refused.
      const ion = await fetch(`${origin}/api/ion/v1/assets/2275207/endpoint`);
      assert.equal(ion.status, 404);
      await ion.arrayBuffer();

      // Other key routes stay free of every plaintext secret.
      for (const route of ['/api/ion/status', '/api/mapillary/status', '/api/setup/status']) {
        const other = await fetch(`${origin}${route}`);
        assert.deepEqual(findLeaks(await other.text()), [], route);
      }
    } finally {
      await new Promise((resolve) => (listener ? listener.close(resolve) : resolve()));
      await server?.close();
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  },
);
