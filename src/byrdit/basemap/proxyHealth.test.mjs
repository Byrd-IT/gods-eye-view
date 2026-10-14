import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import {
  HEALTH_BUDGET,
  basemapSettingsFromEnv,
  composeHealth,
  createBasemapHandler,
  sanitizeHealthText,
} from './proxy.js';
import { basemapConfigLeakCount } from './configSafety.js';
import {
  basemapDegradedReason,
  loadBasemapHealth,
  normalizeBasemapHealth,
} from './health.js';

/** S4 127.0.0.1:12355/health.json (P9 gb-refresh.py), 2026-10-14T10:55Z. */
const EDGE_OK = {
  host: 'server4',
  generated: '2026-10-14T10:55:37Z',
  checks: { 'gev-basemap': 'active', 'gev-basemap-imagery': 'active' },
  warnings: [],
  disk: { used_pct: 44.6, free_gb: 2502.1, guard_pct: 80.0 },
  terrain: {
    ok: true,
    version: 'mh0.0.13-wm20261011',
    cache_bytes: 28131003,
    cache_files: 365,
  },
  origin_label: 'mh0.0.13-wm20261011',
  origin_reachable: true,
  jobs: {
    'edge-sync': {
      status: 'ok',
      mode: 'dry-run',
      last_ok: null,
      last_end: '2026-10-14T10:52:53Z',
      consecutive_failures: 0,
      error: null,
    },
  },
  state: 'ok',
  gev_chip: 'OPEN',
};

/** Same report, degraded, with every kind of text a warning can carry. */
const EDGE_DEGRADED = {
  ...EDGE_OK,
  state: 'degraded',
  gev_chip: 'OPEN (degraded)',
  warnings: [
    'terrain edge /healthz timed out (service active; busy?)',
    'job edge-sync failed: <urlopen error http://admin:hunter2@10.10.99.101:8480/meta/refresh/hashes.json?token=abc>',
    'origin label unreadable: token=s3cr3t api_key: AIzaSyD-0123456789abcdefghijklmnopqrstu',
    'auth failed: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig',
    'disk 76% within 5 points of guard',
    'sixth warning is dropped',
  ],
  info: ['protomaps: upstream update available (pending next timer run)'],
  jobs: {
    'edge-sync': {
      status: 'failed',
      error: 'GET http://user:pw@10.10.99.101:8480/x failed',
    },
  },
};

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(r);
          }),
      });
    });
  });
}

/** A stub gb-refresh.py health endpoint. */
async function healthEdge(body, { status = 200, hang = false } = {}) {
  const seen = [];
  const edge = await listen((req, res) => {
    seen.push(req.url);
    if (hang) return;
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  return { ...edge, seen };
}

async function front(env, deps = {}) {
  const logs = [];
  const handler = createBasemapHandler(
    basemapSettingsFromEnv({ GEV_BASEMAP: '1', ...env }),
    { log: (...a) => logs.push(a.join(' ')), ...deps },
  );
  const server = await listen((req, res) =>
    handler(req, res, () => {
      res.statusCode = 299;
      res.end('next');
    }),
  );
  return { ...server, logs };
}

async function getJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  return { res, body: text ? JSON.parse(text) : null };
}

test('settings: GEV_BASEMAP_HEALTH_URLS is an ordered list of full URLs', () => {
  const s = basemapSettingsFromEnv({
    GEV_BASEMAP_HEALTH_URLS:
      ' http://127.0.0.1:12355/health.json , junk, http://10.10.99.101:8480/health/s1.json',
  });
  assert.deepEqual(s.healthUrls, [
    'http://127.0.0.1:12355/health.json',
    'http://10.10.99.101:8480/health/s1.json',
  ]);
  assert.deepEqual(basemapSettingsFromEnv({}).healthUrls, []);
});

test('composeHealth: only state, chip, sanitized warnings (max 5) and generated pass', () => {
  assert.deepEqual(composeHealth(EDGE_OK), {
    schema: 1,
    available: true,
    state: 'ok',
    chip: 'OPEN',
    warnings: [],
    generated: '2026-10-14T10:55:37Z',
  });
  const degraded = composeHealth(EDGE_DEGRADED);
  assert.deepEqual(Object.keys(degraded).sort(), [
    'available',
    'chip',
    'generated',
    'schema',
    'state',
    'warnings',
  ]);
  assert.equal(degraded.state, 'degraded');
  assert.equal(degraded.chip, 'OPEN (degraded)');
  assert.equal(degraded.warnings.length, 5);
  assert.equal(
    degraded.warnings[0],
    'terrain edge /healthz timed out (service active; busy?)',
  );
  const all = JSON.stringify(degraded);
  for (const secret of [
    'hunter2',
    'admin:',
    'abc',
    's3cr3t',
    'AIza',
    'eyJ',
    '10.10.99.101',
    'http',
    'server4',
    'jobs',
    'disk":',
    'upstream update',
  ])
    assert.ok(!all.includes(secret), `leaked ${secret}`);
  assert.equal(
    degraded.warnings[1],
    'job edge-sync failed: <urlopen error [url]',
  );
  assert.match(degraded.warnings[2], /token=\[redacted\]/);
  assert.match(degraded.warnings[3], /Bearer \[redacted\]/);
  assert.equal(basemapConfigLeakCount(degraded), 0);
  assert.equal(basemapConfigLeakCount(composeHealth(EDGE_OK)), 0);
});

test('composeHealth: invalid state is unknown; chip text must match the state', () => {
  for (const raw of [null, {}, { state: 'great' }, 'ok', [EDGE_OK]])
    assert.deepEqual(composeHealth(raw), {
      schema: 1,
      available: false,
      state: 'unknown',
      chip: null,
      warnings: [],
      generated: null,
    });
  assert.equal(
    composeHealth({ state: 'ok', gev_chip: 'see http://evil/' }).chip,
    'OPEN',
  );
  assert.equal(composeHealth({ state: 'degraded' }).chip, 'OPEN (degraded)');
  assert.equal(
    composeHealth({ state: 'ok', gev_chip: 'OPEN (degraded)' }).chip,
    'OPEN',
  );
  assert.equal(
    composeHealth({
      state: 'down',
      gev_chip: 'UNAVAILABLE (GEV falls back to the standby edge, then Esri)',
    }).chip,
    'UNAVAILABLE (GEV falls back to the standby edge, then Esri)',
  );
  assert.equal(
    composeHealth({ state: 'ok', generated: 'yesterday' }).generated,
    null,
  );
  assert.equal(
    composeHealth({ state: 'ok', warnings: 'not-a-list' }).warnings.length,
    0,
  );
});

test('sanitizeHealthText: plain warnings unchanged, URLs and secrets redacted', () => {
  for (const plain of [
    'disk 81% over guard 80%',
    'gev-basemap is failed',
    'edge serves mh0.0.13-wm20261011 but origin label is mh0.0.14',
    'job naip overdue (> 120 days since last ok)',
    'S1 origin unreachable (edge serves its pinned set only)',
  ])
    assert.equal(sanitizeHealthText(plain), plain);
  assert.equal(
    sanitizeHealthText('see https://x.example/a?b=c now'),
    'see [url] now',
  );
  assert.equal(sanitizeHealthText('//user:pw@host/x'), '[url]');
  assert.equal(sanitizeHealthText('password: hunter2'), 'password: [redacted]');
  assert.equal(sanitizeHealthText('a\u0000\u001f b'), 'a b');
  assert.equal(sanitizeHealthText(42), '');
  assert.equal(sanitizeHealthText('x'.repeat(999)).length, 200);
});

/**
 * Synthetic credentials (review t_19116187 R1): quoted JSON, assignments
 * with spaces and authentication schemes. The whole value must disappear,
 * not just a marker appear, so every check looks for the secret fragments.
 */
const SECRET_FRAGMENTS = ['fixture', 'sensitive'];
const LEAKY_WARNINGS = [
  [
    'upstream error: {"token":"fixture-sensitive-value"}',
    'upstream error: {"token":[redacted]}',
  ],
  [
    'upstream error: {"token": "fixture-sensitive value", "code": 7}',
    'upstream error: {"token": [redacted], "code": 7}',
  ],
  ['Authorization: Basic fixture-sensitive-value', 'Authorization: [redacted]'],
  [
    'proxy said 401 for Basic fixture-sensitive-value',
    'proxy said 401 for Basic [redacted]',
  ],
  ['password="fixture-sensitive value"', 'password=[redacted]'],
  [
    'password = "fixture-sensitive value" retry later',
    'password = [redacted] retry later',
  ],
  ["password='fixture-sensitive value'", 'password=[redacted]'],
  ['password="fixture-sensitive value', 'password=[redacted]'],
  [
    '{"password":"fixture\\"sensitive value"} rejected',
    '{"password":[redacted]} rejected',
  ],
  [
    'body {\\"api_key\\":\\"fixture-sensitive value\\"} rejected',
    'body {\\"api_key\\":[redacted]} rejected',
  ],
  [
    "{'client_secret': 'fixture-sensitive value'}",
    "{'client_secret': [redacted]}",
  ],
  ['"token" : "fixture-sensitive value"', '"token" : [redacted]'],
  [
    'authorization=Basic fixture-sensitive-value; retry',
    'authorization=[redacted]; retry',
  ],
  ['Authorization: Token fixture-sensitive-value', 'Authorization: [redacted]'],
  [
    'Authorization: Digest username="fixture-sensitive", response="fixture-sensitive value", nonce=fixture1 failed',
    'Authorization: [redacted] failed',
  ],
  [
    'upstream sent Digest username="fixture", response="sensitive value"',
    'upstream sent Digest [redacted]',
  ],
  ['x-api-key: fixture-sensitive-value', 'x-api-key: [redacted]'],
  ['refresh_token=fixture-sensitive-value&ok=1', 'refresh_token=[redacted]'],
  [
    'cookie: session_id=fixture-sensitive-value; theme=dark',
    'cookie: [redacted] theme=dark',
  ],
  [
    'failed with bearer fixture-sensitive-value',
    'failed with Bearer [redacted]',
  ],
];

/**
 * Re-review t_19116187 (de12af6): escaped JSON quotes inside the value
 * (R1a) and auth schemes in any letter case (R1b).
 */
function jsonAtDepth(value, depth) {
  let text = JSON.stringify(value);
  for (let i = 1; i < depth; i++) text = JSON.stringify(text).slice(1, -1);
  return text;
}
const ESCAPED_QUOTE_SECRET = jsonAtDepth(
  { password: 'fixture"sensitive value' },
  2,
);
LEAKY_WARNINGS.push(
  [ESCAPED_QUOTE_SECRET, String.raw`{\"password\":[redacted]}`],
  [
    `body ${ESCAPED_QUOTE_SECRET} rejected`,
    String.raw`body {\"password\":[redacted]} rejected`,
  ],
  [
    `${jsonAtDepth({ token: 'fixture\\sensitive value' }, 2)} after`,
    String.raw`{\"token\":[redacted]} after`,
  ],
  [
    jsonAtDepth({ token: 'fixture\\"sensitive value', code: 7 }, 1),
    '{"token":[redacted],"code":7}',
  ],
  [
    jsonAtDepth({ api_key: 'fixture"sensitive \\ value', code: 7 }, 3),
    String.raw`{\\\"api_key\\\":[redacted],\\\"code\\\":7}`,
  ],
  [
    `log ${jsonAtDepth({ msg: 'Digest response="fixture\\"sensitive value"' }, 2)}`,
    String.raw`log {\"msg\":\"Digest [redacted]\"}`,
  ],
  [
    'upstream sent basic fixture-sensitive-value',
    'upstream sent Basic [redacted]',
  ],
  [
    'upstream sent BASIC fixture-sensitive-value',
    'upstream sent Basic [redacted]',
  ],
  [
    'upstream sent bEaReR fixture-sensitive-value now',
    'upstream sent Bearer [redacted] now',
  ],
  [
    'upstream sent digest username="fixture", response="sensitive value"',
    'upstream sent Digest [redacted]',
  ],
  ['upstream sent ntlm fixture-sensitive-value', 'upstream sent NTLM [redacted]'],
);

function assertNoSecret(text, label) {
  for (const fragment of SECRET_FRAGMENTS)
    assert.ok(
      !text.includes(fragment),
      `${label}: leaked "${fragment}" in ${text}`,
    );
}

test('sanitizeHealthText: quoted JSON, spaced assignments and auth schemes lose the whole secret', () => {
  for (const [input, expected] of LEAKY_WARNINGS) {
    const out = sanitizeHealthText(input);
    assertNoSecret(out, input);
    assert.equal(out, expected, input);
  }
  // Ordinary warnings keep their words.
  for (const plain of [
    'job edge-sync failed (3 consecutive failures)',
    'sentinel: new scene available, pending next timer run',
    'terrain cache 28131003 bytes, 365 files',
    'origin label unreadable (status 503)',
    'health: 2 of 3 checks active',
  ])
    assert.equal(sanitizeHealthText(plain), plain);
  // Redaction happens before the 200-character cut.
  const long = `${'x'.repeat(190)} password="fixture-sensitive value"`;
  assertNoSecret(sanitizeHealthText(long), 'truncated');
});

test('GET /basemap/health.json: no synthetic secret survives in warnings, tooltip or a down chip', async () => {
  const cases = LEAKY_WARNINGS.map(([input]) => input);
  const batches = [];
  for (let i = 0; i < cases.length; i += 5) batches.push(cases.slice(i, i + 5));
  for (const warnings of batches) {
    const edge = await healthEdge({ ...EDGE_DEGRADED, warnings });
    const gev = await front({
      GEV_BASEMAP_HEALTH_URLS: `${edge.url}/health.json`,
    });
    try {
      const res = await fetch(`${gev.url}/basemap/health.json`);
      assert.equal(res.status, 200);
      const raw = await res.text();
      assertNoSecret(raw, 'route body');
      const body = JSON.parse(raw);
      assert.equal(body.state, 'degraded');
      assert.equal(body.warnings.length, warnings.length);
      assert.equal(basemapConfigLeakCount(body), 0);
      const health = await loadBasemapHealth({
        fetchImpl: (url, init) => fetch(gev.url + url, init),
      });
      assertNoSecret(basemapDegradedReason(health), 'tooltip');
    } finally {
      await gev.close();
      await edge.close();
    }
  }

  // down: the chip text itself is served (and shown when there is no warning).
  const edge = await healthEdge({
    ...EDGE_OK,
    state: 'down',
    gev_chip:
      'UNAVAILABLE (edge error {"token":"fixture-sensitive value"}, Authorization: Basic fixture-sensitive-value)',
    warnings: [],
  });
  const gev = await front({
    GEV_BASEMAP_HEALTH_URLS: `${edge.url}/health.json`,
  });
  try {
    const raw = await (await fetch(`${gev.url}/basemap/health.json`)).text();
    assertNoSecret(raw, 'down body');
    const body = JSON.parse(raw);
    assert.equal(body.state, 'down');
    assert.equal(
      body.chip,
      'UNAVAILABLE (edge error {"token":[redacted]}, Authorization: [redacted])',
    );
    const health = await loadBasemapHealth({
      fetchImpl: (url, init) => fetch(gev.url + url, init),
    });
    const tooltip = basemapDegradedReason(health);
    assert.equal(tooltip, body.chip);
    assertNoSecret(tooltip, 'down tooltip');
  } finally {
    await gev.close();
    await edge.close();
  }
});

test('sanitizeHealthText: escaped quotes and backslashes at any JSON depth never end a value early', () => {
  const secrets = [
    'fixture"sensitive value',
    'fixture\\sensitive value',
    'fixture\\"sensitive value',
    'fixture\\\\"sensitive \'value',
    'fixture sensitive value\\',
    '"fixture" sensitive "value"',
  ];
  for (const secret of secrets)
    for (const key of ['password', 'token', 'client_secret'])
      for (const depth of [1, 2, 3, 4]) {
        const encoded = jsonAtDepth({ [key]: secret, code: 7 }, depth);
        const input = `pre ${encoded} post`;
        const out = sanitizeHealthText(input);
        const label = `depth ${depth} ${input}`;
        assertNoSecret(out, label);
        assert.ok(out.startsWith('pre {'), label);
        assert.ok(out.includes('[redacted]'), label);
        assert.ok(out.endsWith('7} post'), `${label} -> ${out}`);
        const down = composeHealth({
          state: 'down',
          gev_chip: `UNAVAILABLE ${input}`,
          warnings: [input],
        });
        assertNoSecret(down.chip, `chip ${label}`);
        assertNoSecret(down.warnings[0], `warning ${label}`);
      }
  // Auth scheme names in any case; ordinary words stay.
  for (const scheme of ['basic', 'BASIC', 'Basic', 'bAsIc', 'bearer', 'TOKEN'])
    assertNoSecret(
      sanitizeHealthText(`upstream sent ${scheme} fixture-sensitive-value`),
      scheme,
    );
  for (const plain of [
    'job edge-sync failed (3 consecutive failures)',
    'basemap edge healthy',
    'terrain tiles digested in 4 s',
    'disk 81% over guard 80%',
  ])
    assert.equal(sanitizeHealthText(plain), plain);
});

test('GET /basemap/health.json: down chip and tooltip drop escaped-quote and lower-case scheme secrets', async () => {
  for (const [secret, shown] of [
    [ESCAPED_QUOTE_SECRET, String.raw`{\"password\":[redacted]}`],
    [
      'upstream sent basic fixture-sensitive-value',
      'upstream sent Basic [redacted]',
    ],
    [
      'upstream sent BASIC fixture-sensitive-value',
      'upstream sent Basic [redacted]',
    ],
  ])
    for (const warnings of [[], [secret]]) {
      const edge = await healthEdge({
        ...EDGE_OK,
        state: 'down',
        gev_chip: `UNAVAILABLE ${secret}`,
        warnings,
      });
      const gev = await front({
        GEV_BASEMAP_HEALTH_URLS: `${edge.url}/health.json`,
      });
      try {
        const res = await fetch(`${gev.url}/basemap/health.json`);
        assert.equal(res.status, 200);
        const raw = await res.text();
        assertNoSecret(raw, `down body ${secret}`);
        const body = JSON.parse(raw);
        assert.equal(body.state, 'down');
        assert.equal(body.chip, `UNAVAILABLE ${shown}`);
        assert.deepEqual(body.warnings, warnings.length ? [shown] : []);
        assert.equal(basemapConfigLeakCount(body), 0);
        const health = await loadBasemapHealth({
          fetchImpl: (url, init) => fetch(gev.url + url, init),
        });
        const tooltip = basemapDegradedReason(health);
        assert.ok(tooltip.includes(shown), tooltip);
        assertNoSecret(tooltip, `down tooltip ${secret}`);
      } finally {
        await gev.close();
        await edge.close();
      }
    }
});

test('GET /basemap/health.json: composed from the edge, 30 s cache, browser shows the first warning', async () => {
  const edge = await healthEdge(EDGE_DEGRADED);
  const gev = await front({
    GEV_BASEMAP_HEALTH_URLS: `${edge.url}/health.json`,
  });
  try {
    const { res, body } = await getJson(`${gev.url}/basemap/health.json`, {
      headers: { cookie: 'session=1', authorization: 'Basic x' },
    });
    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get('cache-control'),
      'max-age=30, must-revalidate',
    );
    assert.match(res.headers.get('content-type'), /^application\/json/);
    assert.equal(res.headers.get('set-cookie'), null);
    assert.equal(body.state, 'degraded');
    assert.equal(basemapConfigLeakCount(body), 0);
    assert.deepEqual(edge.seen, ['/health.json']);

    // The browser side, end to end through the real proxy.
    const health = await loadBasemapHealth({
      fetchImpl: (url, init) => fetch(gev.url + url, init),
    });
    assert.equal(
      basemapDegradedReason(health),
      'terrain edge /healthz timed out (service active; busy?)',
    );
    assert.deepEqual(edge.seen, ['/health.json'], 'second read from cache');

    const head = await fetch(`${gev.url}/basemap/health.json`, {
      method: 'HEAD',
    });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    const post = await fetch(`${gev.url}/basemap/health.json`, {
      method: 'POST',
    });
    assert.equal(post.status, 405);
  } finally {
    await gev.close();
    await edge.close();
  }
});

test('health cache: 30 s when known, 10 s when unknown; concurrent misses share one fetch', async () => {
  let t = 1_000_000;
  const edge = await healthEdge(EDGE_OK);
  const gev = await front(
    { GEV_BASEMAP_HEALTH_URLS: `${edge.url}/health.json` },
    { now: () => t },
  );
  try {
    await Promise.all(
      [1, 2, 3].map(() => getJson(`${gev.url}/basemap/health.json`)),
    );
    assert.equal(edge.seen.length, 1);
    t += 29_000;
    await getJson(`${gev.url}/basemap/health.json`);
    assert.equal(edge.seen.length, 1);
    t += 2_000;
    await getJson(`${gev.url}/basemap/health.json`);
    assert.equal(edge.seen.length, 2);
  } finally {
    await gev.close();
    await edge.close();
  }
  let u = 1_000_000;
  const bad = await healthEdge('{', {});
  const gev2 = await front(
    { GEV_BASEMAP_HEALTH_URLS: `${bad.url}/health.json` },
    { now: () => u },
  );
  try {
    assert.equal(
      (await getJson(`${gev2.url}/basemap/health.json`)).body.state,
      'unknown',
    );
    u += 9_000;
    await getJson(`${gev2.url}/basemap/health.json`);
    assert.equal(bad.seen.length, 1);
    u += 2_000;
    await getJson(`${gev2.url}/basemap/health.json`);
    assert.equal(bad.seen.length, 2);
  } finally {
    await gev2.close();
    await bad.close();
  }
});

test('health failover: 5xx, bad JSON or a dead first URL -> the next one', async () => {
  const broken = await healthEdge('oops', { status: 500 });
  const junk = await healthEdge('{"state":"great"}');
  const good = await healthEdge(EDGE_DEGRADED);
  const gev = await front({
    GEV_BASEMAP_HEALTH_URLS: [
      'http://127.0.0.1:9/health.json',
      `${broken.url}/health.json`,
      `${junk.url}/health.json`,
      `${good.url}/health.json`,
    ].join(','),
  });
  try {
    const { body } = await getJson(`${gev.url}/basemap/health.json`);
    assert.equal(body.state, 'degraded');
    assert.equal(broken.seen.length, 1);
    assert.equal(junk.seen.length, 1);
    assert.equal(good.seen.length, 1);
  } finally {
    await gev.close();
    await Promise.all([broken.close(), junk.close(), good.close()]);
  }
});

test('health not configured, or every URL fails: 200 unknown, never an error', async () => {
  const unset = await front({});
  try {
    const { res, body } = await getJson(`${unset.url}/basemap/health.json`);
    assert.equal(res.status, 200);
    assert.deepEqual(body, {
      schema: 1,
      available: false,
      state: 'unknown',
      chip: null,
      warnings: [],
      generated: null,
    });
    assert.deepEqual(normalizeBasemapHealth(body), {
      state: 'unknown',
      chip: null,
      warning: null,
    });
  } finally {
    await unset.close();
  }
  const dead = await front({
    GEV_BASEMAP_HEALTH_URLS: 'http://127.0.0.1:9/health.json',
  });
  try {
    const { res, body } = await getJson(`${dead.url}/basemap/health.json`);
    assert.equal(res.status, 200);
    assert.equal(body.state, 'unknown');
    assert.ok(dead.logs.some((l) => l.includes('health unavailable')));
  } finally {
    await dead.close();
  }
});

test('a hung health edge answers unknown inside the health budget', async () => {
  const hung = await healthEdge(null, { hang: true });
  const gev = await front({
    GEV_BASEMAP_HEALTH_URLS: `${hung.url}/health.json`,
  });
  try {
    const started = Date.now();
    const { body } = await getJson(`${gev.url}/basemap/health.json`);
    const took = Date.now() - started;
    assert.equal(body.state, 'unknown');
    assert.ok(took < HEALTH_BUDGET.composeMs + 1_000, `took ${took} ms`);
  } finally {
    await gev.close();
    await hung.close();
  }
});

test('health route does not disturb the other /basemap routes', async () => {
  const gev = await front({});
  try {
    assert.equal((await fetch(`${gev.url}/basemap/health.jsonx`)).status, 404);
    const other = await fetch(`${gev.url}/health.json`);
    assert.equal(other.status, 299, 'non-/basemap paths pass through');
  } finally {
    await gev.close();
  }
});

test('check-key-exposure.mjs also asserts /basemap/health.json holds no credentials', () => {
  const source = readFileSync(
    new URL('../../../scripts/check-key-exposure.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /'\/basemap\/health\.json'/);
  assert.match(source, /'basemap health'/);
});
