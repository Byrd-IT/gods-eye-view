// Proposed regression tests for the two preview regressions.
// Placement: src/tooling/previewRegressions.test.mjs (next to viteBuild.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { previewFlagHtmlMiddleware } from '../../server/byrdit/featureFlags.js';

const BUILT =
  '<!doctype html><html><head><title>gev</title></head><body></body></html>';

function fakeRes() {
  return {
    status: null,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    writeHead(code) {
      this.status = code;
    },
    end(body) {
      this.body = body === undefined ? null : body;
    },
  };
}

async function call(middleware, req) {
  const res = fakeRes();
  let nexted = 0;
  await middleware(req, res, () => {
    nexted += 1;
  });
  return { res, nexted };
}

// --- Regression 1: preview absolute-form routing --------------------------
// The preview middleware is installed ahead of the API routes, so it must
// recognise an absolute-form target ("http://host/api/...") as an API path
// and hand it on instead of answering it with the application document.
test('preview middleware: an absolute-form target is routed by its path', async () => {
  const asked = [];
  const middleware = previewFlagHtmlMiddleware({
    env: {},
    readTarget: async (rel) => {
      asked.push(rel);
      return rel === null ? BUILT : null;
    },
  });

  // An absolute-form API path belongs to the API routes, not to the document
  // middleware: it must reach the next handler untouched.
  for (const url of [
    'http://localhost:4173/api/nope',
    'http://localhost:4173/api/byrdit/plans',
    'http://elsewhere.example/api/nope',
    'http://localhost:4173/mcp/stream',
  ]) {
    const result = await call(middleware, {
      method: 'GET',
      headers: { accept: 'text/html' },
      url,
    });
    assert.equal(result.nexted, 1, `${url} must reach the API routes`);
    assert.equal(result.res.status, null, `${url} must not be answered here`);
  }

  // An absolute-form document path is served from its path, not from the
  // whole target string.
  const entry = await call(middleware, {
    method: 'GET',
    headers: { accept: 'text/html' },
    url: 'http://localhost:4173/',
  });
  assert.equal(entry.nexted, 0, 'the absolute-form entry page is served here');
  assert.equal(entry.res.status, 200);

  asked.length = 0;
  const spa = await call(middleware, {
    method: 'GET',
    headers: { accept: 'text/html' },
    url: 'http://localhost:4173/plan/foo',
  });
  assert.equal(spa.res.status, 200);
  assert.equal(
    asked[0],
    'plan/foo',
    'the path after the authority is the file that is read',
  );
  for (const rel of asked)
    assert.ok(!String(rel).includes('localhost'), `no authority in ${rel}`);
});

// --- Regression 2: embed CSP under preview -------------------------------
// The embed-framing plugin rewrites the framing headers of an embed-mode
// document by overriding res.setHeader in its own middleware. The preview
// feature middleware serves the document itself, so it must run after that
// override is installed, or the embed policy never reaches the response.
test('actual vite preview: an embed-mode document keeps the embed framing policy', async () => {
  const { preview } = await import('vite');
  const { createBrowserViteConfig } = await import('../../build/vite.js');
  const { featureFlagsHtmlPlugins } =
    await import('../../server/byrdit/featureFlags.js');
  const previous = process.env.GEV_EMBED_FRAME_ANCESTORS;
  process.env.GEV_EMBED_FRAME_ANCESTORS = 'https://example.test';
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-embed-regress-'));
  let server;
  try {
    await fs.writeFile(path.join(dir, 'index.html'), BUILT);
    // The production plugin set: createBrowserViteConfig appends the
    // embed-framing plugin itself, after the feature plugins.
    const built = createBrowserViteConfig({
      plugins: [...featureFlagsHtmlPlugins({ env: { GEV_BASEMAP: '1' } })],
    });
    server = await preview({
      configFile: false,
      root: dir,
      build: { outDir: dir },
      envFile: false,
      publicDir: false,
      logLevel: 'silent',
      plugins: built.plugins,
      preview: {
        host: '127.0.0.1',
        port: 0,
        headers: {
          'X-Frame-Options': 'DENY',
          'Content-Security-Policy':
            "default-src 'self'; frame-ancestors 'none'",
          'X-Content-Type-Options': 'nosniff',
        },
      },
    });
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;

    // A normal document keeps the server's own framing protection.
    const normal = await fetch(base + '/', {
      headers: { accept: 'text/html' },
    });
    assert.equal(normal.headers.get('x-frame-options'), 'DENY');
    assert.match(
      normal.headers.get('content-security-policy'),
      /frame-ancestors 'none'/,
    );
    // The runtime flag still reaches the served document.
    assert.match(await normal.text(), /gev-basemap/);

    // An embed-mode document is framable by the allowed ancestor.
    const embedded = await fetch(base + '/?embed=1', {
      headers: { accept: 'text/html' },
    });
    assert.equal(
      embedded.headers.get('x-frame-options'),
      null,
      'an embed-mode document must not be denied by X-Frame-Options',
    );
    assert.match(
      embedded.headers.get('content-security-policy'),
      /frame-ancestors https:\/\/example\.test/,
      'the embed framing policy must reach the served document',
    );
    // The rest of the policy is untouched.
    assert.match(
      embedded.headers.get('content-security-policy'),
      /default-src 'self'/,
    );
  } finally {
    if (previous === undefined) delete process.env.GEV_EMBED_FRAME_ANCESTORS;
    else process.env.GEV_EMBED_FRAME_ANCESTORS = previous;
    if (server)
      await new Promise((resolve, reject) =>
        server.httpServer.close((err) => (err ? reject(err) : resolve())),
      );
    await fs.rm(dir, { recursive: true, force: true });
  }
});
