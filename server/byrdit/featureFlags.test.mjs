import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  applyRuntimeFlagMetas,
  featureFlagsHtmlPlugins,
  previewFlagHtmlMiddleware,
  runtimeFeatureFlags,
  readTargetResolver,
} from './featureFlags.js';

const HEAD = '<!doctype html><html lang="en"><head><title>gev</title>';
const BODIED = '</head><body></body></html>';
/** What `vite build` bakes today when both flags are on at build time. */
const BAKED_BOTH =
  '<meta name="gev-basemap" content="1"><meta name="gev-wayback" content="1">';
const BUILT = `${HEAD}${BAKED_BOTH}${BODIED}`;

test('runtime flags: off by default, only "1" enables (same trim rule as the server flags)', () => {
  assert.deepEqual(runtimeFeatureFlags({}), { basemap: false, wayback: false });
  assert.deepEqual(
    runtimeFeatureFlags({ GEV_BASEMAP: '0', GEV_BYRDIT_WAYBACK: 'true' }),
    { basemap: false, wayback: false },
  );
  assert.deepEqual(runtimeFeatureFlags({ GEV_BASEMAP: ' 1' }), {
    basemap: true,
    wayback: false,
  });
  assert.deepEqual(runtimeFeatureFlags({ GEV_BYRDIT_WAYBACK: '1' }), {
    basemap: false,
    wayback: true,
  });
});

test('both flags off: baked flag metas are stripped and none are added', () => {
  const out = applyRuntimeFlagMetas(BUILT, { basemap: false, wayback: false });
  assert.equal(out.includes('gev-basemap'), false);
  assert.equal(out.includes('gev-wayback'), false);
  assert.equal(out.includes('<title>gev</title>'), true);
});

test('runtime on: exactly one head tag per enabled flag, baked copies removed', () => {
  const out = applyRuntimeFlagMetas(BUILT, { basemap: true, wayback: false });
  assert.equal(out.split('gev-basemap').length - 1, 1);
  assert.equal(out.includes('gev-wayback'), false);
  // Runtime tag sits inside <head>, where the browser readers find it.
  assert.ok(
    out.includes('<head') &&
      out.indexOf('gev-basemap') < out.indexOf('</head>'),
    'basemap tag must be in head',
  );
  const both = applyRuntimeFlagMetas(`${HEAD}${BODIED}`, {
    basemap: true,
    wayback: true,
  });
  assert.equal(both.split('gev-basemap').length - 1, 1);
  assert.equal(both.split('gev-wayback').length - 1, 1);
});

test('baked metas also strip in other attribute orders and quote styles', () => {
  const odd =
    '<head><meta content="1" name="gev-wayback"><meta name="unrelated" content="1"></head>';
  const out = applyRuntimeFlagMetas(odd, { basemap: false, wayback: false });
  assert.equal(out.includes('gev-wayback'), false);
  assert.equal(out.includes('unrelated'), true);
});

test('html without <head> still gets its tags (after <html> when present)', () => {
  const out = applyRuntimeFlagMetas('<html><body>x</body></html>', {
    basemap: true,
    wayback: false,
  });
  assert.equal(out.split('gev-basemap').length - 1, 1);
});

test('idempotent: applying twice is the same as applying once', () => {
  const once = applyRuntimeFlagMetas(BUILT, { basemap: true, wayback: true });
  const twice = applyRuntimeFlagMetas(once, { basemap: true, wayback: true });
  assert.equal(twice, once);
});

/** Minimal connect-style response double. */
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

const get = (url, accept = 'text/html') => ({
  method: 'GET',
  headers: { accept },
  url,
});

test('preview middleware: flag on serves the runtime tag with no-store; off serves stripped html', async () => {
  const live = { GEV_BASEMAP: '1' };
  const middleware = previewFlagHtmlMiddleware({
    env: live,
    readTarget: async () =>
      `<!doctype html><html><head><title>g</title>${BAKED_BOTH}</head></html>`,
  });
  const on = await call(middleware, get('/'));
  assert.equal(on.nexted, 0);
  assert.equal(on.res.status, 200);
  assert.match(on.res.headers['content-type'], /text\/html/);

  assert.equal(on.res.headers['cache-control'], 'no-store');
  assert.equal(on.res.body.split('gev-basemap').length - 1, 1);
  assert.equal(on.res.body.includes('gev-wayback'), false);

  // Runtime config: flipping the env flips the page without any rebuild.
  live.GEV_BASEMAP = '0';
  const off = await call(middleware, get('/index.html'));
  assert.equal(off.res.body.includes('gev-basemap'), false);
  assert.equal(off.res.body.includes('gev-wayback'), false);
});

test('preview middleware: HEAD answers headers only; non-HTML traffic passes', async () => {
  const middleware = previewFlagHtmlMiddleware({
    env: { GEV_BASEMAP: '1' },
    readTarget: async () => `${HEAD}${BODIED}`,
  });
  const head = await call(middleware, {
    method: 'HEAD',
    headers: { accept: 'text/html' },
    url: '/',
  });
  assert.equal(head.res.status, 200);
  assert.equal(head.res.body, null);

  const post = await call(middleware, {
    method: 'POST',
    headers: { accept: 'text/html' },
    url: '/',
  });
  assert.equal(post.nexted, 1);

  const api = await call(
    previewFlagHtmlMiddleware({ env: {}, readTarget: async () => '<html>' }),
    {
      method: 'GET',
      headers: { accept: 'application/json' },
      url: '/api/byrdit/wayback/releases',
    },
  );
  assert.equal(api.nexted, 1);
});

test('preview middleware: real dotless files hand off to sirv; missing builds pass through', async () => {
  let asked = [];
  const middleware = previewFlagHtmlMiddleware({
    env: { GEV_BASEMAP: '1' },
    readTarget: async (rel) => {
      asked.push(rel);
      return rel === 'manifest' ? 'FILE' : rel === null ? '<html>' : null;
    },
  });
  // /plan/foo is the SPA fallback: there is no such file, so we serve index.
  const route = await call(middleware, get('/plan/foo'));
  assert.equal(route.res.status, 200);
  assert.equal(route.nexted, 0);
  // /manifest is a real file: sirv serves it, we do not.
  asked = [];
  const real = await call(middleware, get('/manifest'));
  assert.deepEqual(asked, ['manifest']);
  assert.equal(real.nexted, 1);
  // No dist build yet: everything passes through untouched.
  const none = await call(
    previewFlagHtmlMiddleware({ env: {}, readTarget: async () => null }),
    get('/'),
  );
  assert.equal(none.nexted, 1);
});

test('plugin: preview-only wiring, no build-time html change, no dev hooks', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-flags-'));
  await fs.writeFile(
    path.join(dir, 'index.html'),
    `${HEAD}${BAKED_BOTH}${BODIED}`,
  );
  const [plugin] = featureFlagsHtmlPlugins();
  assert.equal(plugin.name, 'byrdit-feature-flags');
  assert.equal(plugin.transformIndexHtml, undefined);
  assert.equal(plugin.configureServer, undefined);
  assert.equal(typeof plugin.configurePreviewServer, 'function');
  const installed = [];
  plugin.configResolved({ root: path.dirname(dir), build: { outDir: dir } });
  plugin.configurePreviewServer({
    middlewares: { use: (fn) => installed.push(fn) },
  });
  assert.equal(installed.length, 1);
  const res = await call(installed[0], {
    method: 'GET',
    headers: { accept: 'text/html' },
    url: '/',
  });
  assert.equal(res.res.status, 200);
  await fs.rm(dir, { recursive: true, force: true });
});

test('plugin: built html from disk gets runtime tags under preview (serves real outDir)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-flags2-'));
  await fs.writeFile(
    path.join(dir, 'index.html'),
    `${HEAD}${BAKED_BOTH}${BODIED}`,
  );
  const [plugin] = featureFlagsHtmlPlugins({ env: { GEV_BASEMAP: '1' } });
  let mw = null;
  plugin.configResolved({ root: dir, build: { outDir: dir } });
  plugin.configurePreviewServer({
    middlewares: { use: (fn) => (mw = fn) },
  });
  const out = await call(mw, {
    method: 'GET',
    headers: { accept: 'text/html' },
    url: '/',
  });
  assert.equal(out.res.status, 200);
  assert.equal(out.res.body.split('gev-basemap').length - 1, 1);
  assert.equal(out.res.body.includes('gev-wayback'), false);
  await fs.rm(dir, { recursive: true, force: true });
});

test('preview resolver does not read outside the build root', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-resolver-'));
  const root = path.join(dir, 'dist');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'index.html'), 'index');
  await fs.writeFile(path.join(dir, 'outside'), 'NOT PUBLIC');
  await fs.symlink(path.join(dir, 'outside'), path.join(root, 'link'));
  const read = readTargetResolver(root);
  assert.equal(await read(null), 'index');
  assert.equal(await read('../outside'), null);
  assert.equal(await read('link'), null);
  await fs.rm(dir, { recursive: true, force: true });
});

test('preview middleware never shadows MCP GET or HEAD routes', async () => {
  const middleware = previewFlagHtmlMiddleware({
    env: {},
    readTarget: async (rel) => (rel === null ? '<html></html>' : null),
  });
  for (const url of ['/mcp', '/mcp/stream']) {
    for (const method of ['GET', 'HEAD']) {
      const result = await call(middleware, { method, url, headers: {} });
      assert.equal(result.nexted, 1, `${method} ${url} must reach MCP`);
    }
  }
});

test('preview respects API casing and non-HTML Accept headers', async () => {
  const middleware = previewFlagHtmlMiddleware({
    env: {},
    readTarget: async (rel) => (rel === null ? BUILT : null),
  });
  assert.equal((await call(middleware, get('/API/missing'))).nexted, 1);
  assert.equal(
    (await call(middleware, get('/some/route', 'application/json'))).nexted,
    1,
  );
});

test('preview respects directory index and sibling HTML fallback', async () => {
  const middleware = previewFlagHtmlMiddleware({
    env: {},
    readTarget: async (rel) =>
      [null, 'panel/index.html', 'about.html'].includes(rel) ? BUILT : null,
  });
  assert.equal((await call(middleware, get('/panel/'))).nexted, 1);
  assert.equal((await call(middleware, get('/about'))).nexted, 1);
});

test('preview applies configured document security headers', async () => {
  const [plugin] = featureFlagsHtmlPlugins({ env: {} });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-preview-headers-'));
  try {
    await fs.writeFile(path.join(dir, 'index.html'), BUILT);
    plugin.configResolved({
      root: dir,
      build: { outDir: dir },
      preview: {
        headers: {
          'X-Frame-Options': 'DENY',
          'Content-Security-Policy': "default-src 'self'",
        },
      },
    });
    let mw;
    plugin.configurePreviewServer({
      middlewares: {
        use: (fn) => {
          mw = fn;
        },
      },
    });
    const { res } = await call(mw, get('/'));
    assert.equal(res.headers['X-Frame-Options'], 'DENY');
    assert.equal(res.headers['Content-Security-Policy'], "default-src 'self'");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('actual vite preview keeps security, embed policy, fallback and runtime flags', async () => {
  const { preview } = await import('vite');
  const { embedFramingPlugin } = await import('../../build/embed-framing.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-real-preview-'));
  let server;
  try {
    await fs.writeFile(path.join(dir, 'index.html'), BUILT);
    await fs.mkdir(path.join(dir, 'panel'));
    await fs.writeFile(
      path.join(dir, 'panel', 'index.html'),
      '<html>panel</html>',
    );
    await fs.writeFile(path.join(dir, 'about.html'), '<html>about</html>');
    server = await preview({
      configFile: false,
      root: dir,
      build: { outDir: dir },
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
      plugins: [
        embedFramingPlugin({ ancestors: 'https://example.test' }),
        ...featureFlagsHtmlPlugins({ env: { GEV_BASEMAP: '1' } }),
      ],
    });
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    const normal = await fetch(base + '/', {
      headers: { accept: 'text/html' },
    });
    assert.equal(normal.headers.get('x-frame-options'), 'DENY');
    assert.match(
      normal.headers.get('content-security-policy'),
      /frame-ancestors 'none'/,
    );
    assert.equal(normal.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await normal.text(), /gev-basemap/);
    const embedded = await fetch(base + '/?embed=1', {
      headers: { accept: 'text/html' },
    });
    assert.equal(embedded.headers.get('x-frame-options'), null);
    assert.match(
      embedded.headers.get('content-security-policy'),
      /frame-ancestors https:\/\/example\.test/,
    );
    assert.match(await (await fetch(base + '/panel/')).text(), /panel/);
    assert.match(await (await fetch(base + '/about')).text(), /about/);
    assert.equal(
      (
        await fetch(base + '/missing-path', {
          headers: { accept: 'application/json' },
        })
      ).status,
      404,
    );
  } finally {
    if (server)
      await new Promise((resolve, reject) =>
        server.httpServer.close((err) => (err ? reject(err) : resolve())),
      );
    await fs.rm(dir, { recursive: true, force: true });
  }
});
