// Byrd-IT: a request from a configured trusted proxy (GEV_TRUSTED_PROXIES, i.e.
// NPM on S2 after it has basic-authenticated the user) gets exactly what a
// loopback/LAN user gets on every gate that treats forwarded requests
// differently (CCTV Street View fallback, Gemini voice token gate; the same-site
// gate and per-client history key are covered in trustedProxy.test.mjs and
// historyWiring.test.mjs). Per gate: (a) trusted peer + forwarding headers -> full access,
// (b) untrusted peer + forwarding headers -> refused / placeholder, (c) loopback
// with no headers -> unchanged, (d) setting unset -> upstream behaviour.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cctvProxy } from '../../server/providers/cctv.js';
import { PROXY_SIGNALS } from '../localRequestGate.mjs';
import { isGeminiRequestOriginAllowed } from '../../server/providers/gemini/request.js';
import {
  TRUSTED_PROXIES_ENV,
  hasUntrustedForwarding,
  isTrustedProxyPeer,
  trustedClientAddress,
} from '../../server/byrdit/trustedProxy.js';

const NPM = '10.10.99.102';
const OTHER = '10.10.99.77';
const HOST = 'godseyeview.byrd-it.com';
const npmHeaders = {
  host: HOST,
  'x-forwarded-for': '203.0.113.9',
  'x-forwarded-proto': 'https',
  'x-real-ip': '203.0.113.9',
};
const req = (remoteAddress, headers = {}, extra = {}) => ({
  socket: { remoteAddress },
  headers,
  ...extra,
});

function withTrusted(t, value) {
  const before = process.env[TRUSTED_PROXIES_ENV];
  if (value === undefined) delete process.env[TRUSTED_PROXIES_ENV];
  else process.env[TRUSTED_PROXIES_ENV] = value;
  t.after(() => {
    if (before === undefined) delete process.env[TRUSTED_PROXIES_ENV];
    else process.env[TRUSTED_PROXIES_ENV] = before;
  });
}

// ---- shared helper ---------------------------------------------------------

test('isTrustedProxyPeer: exact peer only, IPv4-mapped normalised, unset = false', () => {
  const env = { [TRUSTED_PROXIES_ENV]: NPM };
  assert.equal(isTrustedProxyPeer(req(NPM), env), true);
  assert.equal(isTrustedProxyPeer(req(`::ffff:${NPM}`), env), true);
  assert.equal(isTrustedProxyPeer(req(OTHER), env), false);
  assert.equal(isTrustedProxyPeer(req(undefined), env), false);
  assert.equal(isTrustedProxyPeer(req(NPM), {}), false);
  assert.equal(
    isTrustedProxyPeer(req(NPM), { [TRUSTED_PROXIES_ENV]: '' }),
    false,
  );
  // CIDR / wildcard / hostname entries never widen the rule.
  for (const bad of ['10.10.99.0/24', '10.10.99.*', 'npm.local'])
    assert.equal(
      isTrustedProxyPeer(req(NPM), { [TRUSTED_PROXIES_ENV]: bad }),
      false,
    );
});

test('hasUntrustedForwarding: any signal counts (even empty) unless the peer is trusted', () => {
  const env = { [TRUSTED_PROXIES_ENV]: NPM };
  assert.equal(
    hasUntrustedForwarding(req(NPM, npmHeaders), PROXY_SIGNALS, env),
    false,
  );
  assert.equal(
    hasUntrustedForwarding(req(OTHER, npmHeaders), PROXY_SIGNALS, env),
    true,
  );
  for (const name of PROXY_SIGNALS) {
    assert.equal(
      hasUntrustedForwarding(req(OTHER, { [name]: '' }), PROXY_SIGNALS, env),
      true,
      name,
    );
    assert.equal(
      hasUntrustedForwarding(req(NPM, { [name]: 'x' }), PROXY_SIGNALS, env),
      false,
      name,
    );
    assert.equal(
      hasUntrustedForwarding(req(NPM, { [name]: 'x' }), PROXY_SIGNALS, {}),
      true,
      name,
    );
  }
  assert.equal(
    hasUntrustedForwarding(req('127.0.0.1'), PROXY_SIGNALS, env),
    false,
  );
  assert.equal(
    hasUntrustedForwarding(req('127.0.0.1'), PROXY_SIGNALS, {}),
    false,
  );
});

test('trustedClientAddress: only a trusted peer with a well-formed X-Real-IP', () => {
  const env = { [TRUSTED_PROXIES_ENV]: NPM };
  assert.equal(
    trustedClientAddress(req(NPM, npmHeaders), env),
    'proxied:203.0.113.9',
  );
  assert.equal(trustedClientAddress(req(OTHER, npmHeaders), env), null);
  assert.equal(
    trustedClientAddress(req(NPM, { 'x-real-ip': 'a b; drop' }), env),
    null,
  );
  assert.equal(trustedClientAddress(req(NPM, {}), env), null);
  assert.equal(trustedClientAddress(req(NPM, npmHeaders), {}), null);
});

// ---- gate: CCTV Street View fallback (server/providers/cctv.js) -------------

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

function cctvFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'gev-pubaccess-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'config'));
  writeFileSync(
    path.join(root, 'config/cctv_sources.austin.json'),
    JSON.stringify([
      { id: 'cam1', name: 'Cam 1', lat: 30.27, lon: -97.74, feedType: 'video' },
    ]),
  );
  for (const name of [
    'CCTV_SOURCES_FILE',
    'CCTV_SOURCES_JSON',
    'CCTV_FORCE_AUSTIN',
    'GOOGLE_MAPS_API_KEY',
  ]) {
    const previous = process.env[name];
    delete process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  const prevKey = process.env.GOOGLE_MAPS_SERVER_API_KEY;
  process.env.GOOGLE_MAPS_SERVER_API_KEY = 'SYNTHETIC-TEST-KEY';
  t.after(() => {
    if (prevKey === undefined) delete process.env.GOOGLE_MAPS_SERVER_API_KEY;
    else process.env.GOOGLE_MAPS_SERVER_API_KEY = prevKey;
  });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    return new Response(PNG, { headers: { 'content-type': 'image/png' } });
  });
  let handler;
  cctvProxy({ sourceRoot: root }).configureServer({
    middlewares: { use: (_route, fn) => (handler = fn) },
  });
  return async (request) => {
    const res = {
      writeHead(status, headers) {
        Object.assign(this, { status, headers });
      },
      end(body) {
        this.body = body;
      },
    };
    await handler({ url: '/frame/cam1', method: 'GET', ...request }, res);
    return res;
  };
}

const streetViewCalls = (calls) =>
  calls.filter((url) =>
    url.includes('maps.googleapis.com/maps/api/streetview'),
  );

test('CCTV frame: trusted proxy peer + forwarding headers gets the Street View fallback (a)', async (t) => {
  withTrusted(t, NPM);
  const frame = cctvFixture(t);
  const res = await frame(req(NPM, npmHeaders));
  assert.equal(res.status, 200);
  assert.equal(res.headers['X-CCTV-Source'], 'streetview');
  assert.equal(
    streetViewCalls(globalThis.fetch.mock.calls.map((c) => c.arguments[0]))
      .length,
    1,
  );
});

test('CCTV frame: untrusted peer + forwarding headers gets the placeholder, no Google call (b)', async (t) => {
  withTrusted(t, NPM);
  const frame = cctvFixture(t);
  for (const headers of [
    npmHeaders,
    { 'x-forwarded-for': '' },
    { via: '1.1 evil' },
    { forwarded: 'for=1.2.3.4' },
    { 'cf-ray': 'abc' },
    { 'cf-connecting-ip': '1.2.3.4' },
  ]) {
    const res = await frame(req(OTHER, headers));
    assert.notEqual(
      res.headers['X-CCTV-Source'],
      'streetview',
      JSON.stringify(headers),
    );
  }
  assert.equal(
    streetViewCalls(globalThis.fetch.mock.calls.map((c) => c.arguments[0]))
      .length,
    0,
  );
});

test('CCTV frame: loopback with no headers keeps the Street View fallback (c)', async (t) => {
  withTrusted(t, NPM);
  const frame = cctvFixture(t);
  const res = await frame(req('127.0.0.1', { host: 'localhost:4173' }));
  assert.equal(res.headers['X-CCTV-Source'], 'streetview');
});

test('CCTV frame: GEV_TRUSTED_PROXIES unset = upstream (forwarded -> placeholder, plain -> Street View) (d)', async (t) => {
  withTrusted(t, undefined);
  const frame = cctvFixture(t);
  const forwarded = await frame(req(NPM, npmHeaders));
  assert.notEqual(forwarded.headers['X-CCTV-Source'], 'streetview');
  assert.equal(
    streetViewCalls(globalThis.fetch.mock.calls.map((c) => c.arguments[0]))
      .length,
    0,
  );
  const plain = await frame(req('127.0.0.1', { host: 'localhost:4173' }));
  assert.equal(plain.headers['X-CCTV-Source'], 'streetview');
});

// ---- gate: Gemini voice token (server/providers/gemini/request.js) ----------

const geminiReq = (peer, headers) =>
  req(peer, {
    ...headers,
    origin: headers.origin ?? `https://${HOST}`,
  });

test('Gemini token gate: trusted proxy peer + forwarding headers is admitted (a)', (t) => {
  withTrusted(t, NPM);
  assert.equal(
    isGeminiRequestOriginAllowed(geminiReq(NPM, npmHeaders), HOST),
    true,
  );
  // Effective protocol is X-Forwarded-Proto: an http Origin on an https front fails.
  assert.equal(
    isGeminiRequestOriginAllowed(
      geminiReq(NPM, { ...npmHeaders, origin: `http://${HOST}` }),
      HOST,
    ),
    false,
  );
  assert.equal(
    isGeminiRequestOriginAllowed(
      geminiReq(NPM, { ...npmHeaders, origin: 'https://evil.example' }),
      HOST,
    ),
    false,
  );
  assert.equal(
    isGeminiRequestOriginAllowed(
      geminiReq(NPM, { ...npmHeaders, 'sec-fetch-site': 'cross-site' }),
      HOST,
    ),
    false,
  );
});

test('Gemini token gate: untrusted peer + forwarding headers is refused (b)', (t) => {
  withTrusted(t, NPM);
  assert.equal(
    isGeminiRequestOriginAllowed(geminiReq(OTHER, npmHeaders), HOST),
    false,
  );
});

test('Gemini token gate: loopback with no headers is unchanged (c)', (t) => {
  withTrusted(t, NPM);
  const local = req('127.0.0.1', {
    host: 'localhost:4173',
    origin: 'http://localhost:4173',
  });
  assert.equal(isGeminiRequestOriginAllowed(local, 'localhost'), true);
});

test('Gemini token gate: unset = upstream, forwarded peers refused (d)', (t) => {
  withTrusted(t, undefined);
  assert.equal(
    isGeminiRequestOriginAllowed(geminiReq(NPM, npmHeaders), HOST),
    false,
  );
  const local = req('127.0.0.1', {
    host: 'localhost:4173',
    origin: 'http://localhost:4173',
  });
  assert.equal(isGeminiRequestOriginAllowed(local, 'localhost'), true);
});
