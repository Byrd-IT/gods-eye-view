// Byrd-IT: GEV_TRUSTED_PROXIES lets the same-site gate admit requests that
// arrive through our own reverse proxy (NPM on S2, 10.10.99.102) while every
// other peer keeps upstream's "proxy headers -> 403" behaviour. Pins the
// parser, the transport facts fed to admitSameSiteRequest, the gate verdicts
// through sameSiteGated, and a real-socket run (IPv4 and IPv4-mapped IPv6).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  TRUSTED_PROXIES_ENV,
  normalizeProxyAddress,
  parseTrustedProxies,
  sameSiteTransport,
} from '../../server/byrdit/trustedProxy.js';
import {
  admitSameSite,
  sameSiteGated,
} from '../../server/providers/common/same-site.js';

const NPM = '10.10.99.102';
const PUBLIC = 'https://godseyeview.byrd-it.com';
const npmHeaders = {
  host: 'godseyeview.byrd-it.com',
  'x-forwarded-for': '203.0.113.9',
  'x-forwarded-proto': 'https',
  'x-forwarded-scheme': 'https',
  'x-real-ip': '203.0.113.9',
};

function fakeReq({ remoteAddress = NPM, encrypted, headers = {} } = {}) {
  return { socket: { remoteAddress, encrypted }, headers };
}

function fakeRes() {
  const out = { statusCode: 200, headers: {}, body: '' };
  return {
    out,
    get statusCode() {
      return out.statusCode;
    },
    set statusCode(value) {
      out.statusCode = value;
    },
    setHeader(name, value) {
      out.headers[name.toLowerCase()] = String(value);
    },
    end(body = '') {
      out.body = String(body);
    },
  };
}

/** Run admitSameSite with GEV_TRUSTED_PROXIES set to `trusted` (undefined = unset). */
function gate(req, trusted) {
  const before = process.env[TRUSTED_PROXIES_ENV];
  if (trusted === undefined) delete process.env[TRUSTED_PROXIES_ENV];
  else process.env[TRUSTED_PROXIES_ENV] = trusted;
  try {
    const res = fakeRes();
    const refused = admitSameSite(req, res);
    return {
      ok: !refused,
      status: res.out.statusCode,
      error: res.out.body ? JSON.parse(res.out.body).error : undefined,
    };
  } finally {
    if (before === undefined) delete process.env[TRUSTED_PROXIES_ENV];
    else process.env[TRUSTED_PROXIES_ENV] = before;
  }
}

test('normalizeProxyAddress reduces IPv4-mapped IPv6 and lower-cases', () => {
  assert.equal(normalizeProxyAddress('::ffff:10.10.99.102'), NPM);
  assert.equal(normalizeProxyAddress('::FFFF:10.10.99.102'), NPM);
  assert.equal(normalizeProxyAddress(' 10.10.99.102 '), NPM);
  assert.equal(normalizeProxyAddress('FE80::1'), 'fe80::1');
  assert.equal(normalizeProxyAddress(undefined), '');
});

test('parseTrustedProxies keeps exact IP literals only', () => {
  assert.deepEqual([...parseTrustedProxies('')], []);
  assert.deepEqual([...parseTrustedProxies(undefined)], []);
  assert.deepEqual([...parseTrustedProxies(' , ,')], []);
  assert.deepEqual(
    [...parseTrustedProxies('10.10.99.102, ::ffff:10.10.99.103,fd00::5')],
    [NPM, '10.10.99.103', 'fd00::5'],
  );
  // CIDR, hostnames, wildcards and out-of-range octets are ignored, never widened.
  assert.deepEqual(
    [
      ...parseTrustedProxies(
        '10.10.99.0/24,npm.lan,*,0.0.0.0/0,256.1.1.1,10.10.99',
      ),
    ],
    [],
  );
});

test('unset or empty setting = upstream transport facts, byte for byte', () => {
  for (const env of [
    {},
    { [TRUSTED_PROXIES_ENV]: '' },
    { [TRUSTED_PROXIES_ENV]: '  ' },
  ]) {
    const req = fakeReq({ headers: npmHeaders });
    const t = sameSiteTransport(req, env);
    assert.equal(t.protocol, 'http:');
    assert.equal(
      t.proxyHeaders,
      req.headers,
      'same headers object as upstream',
    );
  }
  const tls = sameSiteTransport(fakeReq({ encrypted: true }), {});
  assert.equal(tls.protocol, 'https:');
  const bare = sameSiteTransport({ socket: {} }, {});
  assert.deepEqual(bare, { protocol: 'http:', proxyHeaders: {} });
});

test('trusted peer: forwarded protocol, no proxy-signal input', () => {
  const env = { [TRUSTED_PROXIES_ENV]: NPM };
  assert.deepEqual(sameSiteTransport(fakeReq({ headers: npmHeaders }), env), {
    protocol: 'https:',
    proxyHeaders: {},
  });
  assert.deepEqual(
    sameSiteTransport(
      fakeReq({ headers: { ...npmHeaders, 'x-forwarded-proto': 'HTTP' } }),
      env,
    ),
    { protocol: 'http:', proxyHeaders: {} },
  );
  const noProto = { ...npmHeaders };
  delete noProto['x-forwarded-proto'];
  assert.deepEqual(sameSiteTransport(fakeReq({ headers: noProto }), env), {
    protocol: 'http:',
    proxyHeaders: {},
  });
});

test('trusted peer with a malformed X-Forwarded-Proto falls back to upstream (refused)', () => {
  for (const proto of ['https, http', 'ftp', 'https:', '', 'wss']) {
    const req = fakeReq({
      headers: { ...npmHeaders, 'x-forwarded-proto': proto },
    });
    const r = gate(req, NPM);
    assert.equal(r.ok, false, proto);
    assert.equal(r.status, 403);
    assert.equal(r.error, 'Proxied requests are not accepted');
  }
});

test('trusted proxy + same-origin GET is admitted', () => {
  const r = gate(
    fakeReq({ headers: { ...npmHeaders, 'sec-fetch-site': 'same-origin' } }),
    NPM,
  );
  assert.equal(r.ok, true);
  // GET without Sec-Fetch-Site / Origin (e.g. a curl through NPM) too.
  assert.equal(gate(fakeReq({ headers: npmHeaders }), NPM).ok, true);
});

test('trusted proxy + POST with the public https Origin is admitted', () => {
  const r = gate(
    fakeReq({
      headers: {
        ...npmHeaders,
        origin: PUBLIC,
        'sec-fetch-site': 'same-origin',
      },
    }),
    NPM,
  );
  assert.equal(r.ok, true);
});

test('trusted proxy: the Origin must match the forwarded scheme and Host exactly', () => {
  const headers = { ...npmHeaders, origin: PUBLIC };
  for (const [label, h] of [
    [
      'http origin over https',
      { ...headers, origin: 'http://godseyeview.byrd-it.com' },
    ],
    ['origin with port', { ...headers, origin: `${PUBLIC}:8443` }],
    ['other host', { ...headers, host: 'evil.example' }],
    [
      'X-Forwarded-Host is ignored',
      {
        ...headers,
        host: 'evil.example',
        'x-forwarded-host': 'godseyeview.byrd-it.com',
      },
    ],
    [
      'proto http but origin https',
      { ...headers, 'x-forwarded-proto': 'http' },
    ],
  ]) {
    const r = gate(fakeReq({ headers: h }), NPM);
    assert.equal(r.ok, false, label);
    assert.equal(r.status, 403, label);
  }
});

test('trusted proxy + foreign Origin is refused', () => {
  const r = gate(
    fakeReq({ headers: { ...npmHeaders, origin: 'https://evil.example' } }),
    NPM,
  );
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.equal(r.error, 'Cross-origin requests are not accepted');
  assert.equal(
    gate(fakeReq({ headers: { ...npmHeaders, origin: 'null' } }), NPM).error,
    'Opaque origins are not accepted',
  );
});

test('trusted proxy + Sec-Fetch-Site cross-site / same-site is refused', () => {
  for (const site of ['cross-site', 'same-site']) {
    const r = gate(
      fakeReq({ headers: { ...npmHeaders, 'sec-fetch-site': site } }),
      NPM,
    );
    assert.equal(r.ok, false, site);
    assert.equal(r.error, 'Cross-site requests are not accepted');
  }
});

test('untrusted socket + proxy headers is refused even with the setting on', () => {
  // The spoofing case: another LAN host sends X-Forwarded-* straight to :4173.
  for (const remoteAddress of [
    '10.10.99.50',
    '::ffff:10.10.99.50',
    '127.0.0.1',
    null,
    '',
  ]) {
    const r = gate(
      fakeReq({
        remoteAddress,
        headers: {
          ...npmHeaders,
          origin: PUBLIC,
          'sec-fetch-site': 'same-origin',
        },
      }),
      NPM,
    );
    assert.equal(r.ok, false, String(remoteAddress));
    assert.equal(r.error, 'Proxied requests are not accepted');
  }
});

test('spoofed X-Forwarded-Proto from an untrusted socket is ignored', () => {
  // Without trust the header is a proxy signal (refused); and the protocol fed
  // to the gate stays the socket protocol.
  const req = fakeReq({
    remoteAddress: '10.10.99.50',
    headers: {
      host: 'godseyeview.byrd-it.com',
      'x-forwarded-proto': 'https',
      origin: PUBLIC,
    },
  });
  assert.equal(
    sameSiteTransport(req, { [TRUSTED_PROXIES_ENV]: NPM }).protocol,
    'http:',
  );
  assert.equal(gate(req, NPM).ok, false);
});

test('IPv4-mapped IPv6 peer matches an IPv4 entry (and vice versa)', () => {
  const h = { ...npmHeaders, origin: PUBLIC };
  assert.equal(
    gate(fakeReq({ remoteAddress: `::ffff:${NPM}`, headers: h }), NPM).ok,
    true,
  );
  assert.equal(
    gate(fakeReq({ remoteAddress: NPM, headers: h }), `::ffff:${NPM}`).ok,
    true,
  );
  assert.equal(
    gate(fakeReq({ remoteAddress: NPM, headers: h }), `10.10.99.103,${NPM}`).ok,
    true,
  );
});

test('empty / unset setting = legacy: proxied requests refused, local ones admitted', () => {
  for (const trusted of [undefined, '', ' ']) {
    const r = gate(
      fakeReq({ headers: { ...npmHeaders, origin: PUBLIC } }),
      trusted,
    );
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
    assert.equal(r.error, 'Proxied requests are not accepted');
    const local = gate(
      fakeReq({
        remoteAddress: '127.0.0.1',
        headers: {
          host: 'localhost:4173',
          origin: 'http://localhost:4173',
          'sec-fetch-site': 'same-origin',
        },
      }),
      trusted,
    );
    assert.equal(local.ok, true);
  }
});

test('direct (non-proxied) requests behave the same with the setting on', () => {
  const local = {
    host: 'localhost:4173',
    origin: 'http://localhost:4173',
    'sec-fetch-site': 'same-origin',
  };
  assert.equal(
    gate(fakeReq({ remoteAddress: '127.0.0.1', headers: local }), NPM).ok,
    true,
  );
  assert.equal(
    gate(
      fakeReq({
        remoteAddress: '127.0.0.1',
        headers: { ...local, origin: 'https://evil.example' },
      }),
      NPM,
    ).ok,
    false,
  );
});

/** Real HTTP server with a sameSiteGated handler; resolves to {status, body}. */
async function realRequest({ listenHost, connectHost, trusted, headers }) {
  const before = process.env[TRUSTED_PROXIES_ENV];
  if (trusted === undefined) delete process.env[TRUSTED_PROXIES_ENV];
  else process.env[TRUSTED_PROXIES_ENV] = trusted;
  let seenPeer;
  const server = http.createServer(
    sameSiteGated((req, res) => {
      seenPeer = req.socket.remoteAddress;
      res.end('admitted');
    }),
  );
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, listenHost, resolve);
    });
    const { port } = server.address();
    const result = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: connectHost, port, path: '/api/x', method: 'POST', headers },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode, body }));
        },
      );
      req.on('error', reject);
      req.end('{}');
    });
    return { ...result, seenPeer };
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (before === undefined) delete process.env[TRUSTED_PROXIES_ENV];
    else process.env[TRUSTED_PROXIES_ENV] = before;
  }
}

const npmPost = {
  ...npmHeaders,
  'x-forwarded-for': '203.0.113.9',
  origin: PUBLIC,
  'sec-fetch-site': 'same-origin',
  'content-type': 'application/json',
};

test('real socket: trusted 127.0.0.1 peer through the gate', async () => {
  const ok = await realRequest({
    listenHost: '127.0.0.1',
    connectHost: '127.0.0.1',
    trusted: '127.0.0.1',
    headers: npmPost,
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body, 'admitted');
  const legacy = await realRequest({
    listenHost: '127.0.0.1',
    connectHost: '127.0.0.1',
    trusted: undefined,
    headers: npmPost,
  });
  assert.equal(legacy.status, 403);
  assert.match(legacy.body, /Proxied requests are not accepted/);
  const other = await realRequest({
    listenHost: '127.0.0.1',
    connectHost: '127.0.0.1',
    trusted: NPM,
    headers: npmPost,
  });
  assert.equal(other.status, 403);
  const foreign = await realRequest({
    listenHost: '127.0.0.1',
    connectHost: '127.0.0.1',
    trusted: '127.0.0.1',
    headers: { ...npmPost, origin: 'https://evil.example' },
  });
  assert.equal(foreign.status, 403);
});

test('real socket: dual-stack listener sees ::ffff:127.0.0.1 and still matches', async (t) => {
  let r;
  try {
    r = await realRequest({
      listenHost: '::',
      connectHost: '127.0.0.1',
      trusted: '127.0.0.1',
      headers: npmPost,
    });
  } catch (error) {
    if (['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code))
      return t.skip('no IPv6 on this host');
    throw error;
  }
  assert.equal(r.status, 200);
  assert.equal(r.seenPeer, '::ffff:127.0.0.1');
});
