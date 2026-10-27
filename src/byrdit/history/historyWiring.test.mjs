import test from 'node:test';
import assert from 'node:assert/strict';
import {
  historyClientKey,
  historyPlugins,
} from '../../../server/byrdit/history.js';

/**
 * B9 wiring: server/standalone/vite.config.js -> server/byrdit/history.js ->
 * src/byrdit/history. GEV_HISTORY_API off = no plugin (upstream's order pin
 * unchanged); on = the history API with Vite's own Host rule, the common
 * cost rate limiter and a proxy-aware client key.
 */

async function pluginNames(t, value) {
  const before = process.env.GEV_HISTORY_API;
  if (value === undefined) delete process.env.GEV_HISTORY_API;
  else process.env.GEV_HISTORY_API = value;
  t.after(() => {
    if (before === undefined) delete process.env.GEV_HISTORY_API;
    else process.env.GEV_HISTORY_API = before;
  });
  const { default: config } =
    await import('../../../server/standalone/vite.config.js');
  const resolved = await config({ command: 'serve', mode: 'test' });
  return resolved.plugins
    .flat(Infinity)
    .filter(Boolean)
    .map((plugin) => plugin.name);
}

test('GEV_HISTORY_API off: plugin list unchanged; on: history API before providers', async (t) => {
  const off = await pluginNames(t, undefined);
  assert.ok(!off.includes('byrdit-history-api'));
  const on = await pluginNames(t, '1');
  const api = on.indexOf('byrdit-history-api');
  assert.ok(api >= 0);
  assert.ok(api < on.indexOf('opensky-proxy'));
  assert.ok(on.indexOf('host-check') >= 0, 'global Host check still present');
  assert.deepEqual(
    on.filter((name) => name !== 'byrdit-history-api'),
    off,
  );
});

function fakeServer(allowedHosts) {
  const stack = [];
  return {
    stack,
    config: {
      server: { allowedHosts, host: '0.0.0.0' },
      preview: { allowedHosts, host: undefined },
    },
    middlewares: { use: (fn) => stack.push(fn) },
  };
}

async function hit(
  mw,
  { host, ip = '10.0.0.5', headers = {}, url = '/api/history/nope' },
) {
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    end(b) {
      this.body = b;
      this.done();
    },
  };
  const done = new Promise((r) => (res.done = r));
  mw(
    {
      url,
      method: 'GET',
      headers: { host, ...headers },
      socket: { remoteAddress: ip },
    },
    res,
    () => res.done(),
  );
  await done;
  return res.statusCode;
}

test('server composition: Vite allowedHosts decide the Host rule', async () => {
  const [plugin] = historyPlugins({
    env: { GEV_HISTORY_API: '1', GEV_RATELIMIT_HISTORY_PER_MIN: '0' },
  });
  const server = fakeServer([
    'localhost',
    '127.0.0.1',
    'godseyeview.byrd-it.com',
  ]);
  plugin.configureServer(server);
  const [mw] = server.stack;
  assert.equal(await hit(mw, { host: 'godseyeview.byrd-it.com' }), 404);
  assert.equal(await hit(mw, { host: '10.10.99.104:4173' }), 404); // IP literal
  assert.equal(await hit(mw, { host: 'rebind.attacker.example' }), 403);
});

test('server composition: GEV_RATELIMIT_HISTORY_PER_MIN caps per client', async () => {
  const [plugin] = historyPlugins({
    env: { GEV_HISTORY_API: '1', GEV_RATELIMIT_HISTORY_PER_MIN: '2' },
  });
  const server = fakeServer(['localhost']);
  plugin.configureServer(server);
  const [mw] = server.stack;
  // a real route (an unknown route 404s before the limiter)
  const url = '/api/history/slice?feed=nope&t=2026-10-14T00:00:00Z';
  const codes = [];
  for (let i = 0; i < 3; i += 1)
    codes.push(await hit(mw, { host: 'localhost', ip: '10.0.0.7', url }));
  codes.push(await hit(mw, { host: 'localhost', ip: '10.0.0.8', url }));
  assert.deepEqual(codes, [404, 404, 429, 404]);
});

test('client key: X-Real-IP only from a trusted proxy, malformed falls back', () => {
  const key = historyClientKey({ GEV_TRUSTED_PROXIES: '10.10.99.102' });
  const req = (ip, real) => ({
    socket: { remoteAddress: ip },
    headers: real === undefined ? {} : { 'x-real-ip': real },
  });
  assert.equal(key(req('10.10.99.102', '203.0.113.9')), 'proxied:203.0.113.9');
  assert.equal(
    key(req('::ffff:10.10.99.102', '203.0.113.9')),
    'proxied:203.0.113.9',
  );
  assert.equal(key(req('10.10.99.102', 'x'.repeat(80))), '10.10.99.102');
  assert.equal(key(req('10.10.99.102')), '10.10.99.102');
  assert.equal(key(req('198.51.100.1', '203.0.113.9')), '198.51.100.1');
  assert.equal(
    historyClientKey({})(req('10.10.99.102', '1.2.3.4')),
    '10.10.99.102',
  );
});
