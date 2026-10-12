// Byrd-IT Sky view P2b: SATCAT radar cross-section cache beside
// /api/celestrak (SKYVIEW.md 4.4). Same CelesTrak rules as the GP groups:
// on-demand only, 7-day cache, and the shared halt latch (any failure halts
// every CelesTrak request; while halted there are ZERO upstream requests).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import {
  celestrakProxy,
  parseSatcatRcs,
  RCS_TTL_MS,
} from '../../server/providers/space.js';
import { celestrakSatcatUrl } from '../data/spaceProviderRequests.js';

const CACHE = path.join(process.cwd(), '.gev-cache');
const HALT_FILE = path.join(CACHE, 'celestrak-HALT.json');
const RCS_FILE = path.join(CACHE, 'celestrak-satcat-rcs.json');
const GP_CSV =
  'OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION\r\nISS (ZARYA),1998-067A,2026-09-19T00:00:00.000000,15.5';

// Rows copied from the one verification response (2026-10-12 01:17 UTC,
// records.php?GROUP=ACTIVE&FORMAT=CSV), plus a quoted name with a comma.
const SATCAT_CSV = [
  'OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER,LAUNCH_DATE,LAUNCH_SITE,DECAY_DATE,PERIOD,INCLINATION,APOGEE,PERIGEE,RCS,DATA_STATUS_CODE,ORBIT_CENTER,ORBIT_TYPE',
  'CALSPHERE 1,1964-063C,900,PAY,+,US,1964-10-06,AFWTR,,104.60,90.22,993,958,0.0510,,EA,ORB',
  'ISS (ZARYA),1998-067A,25544,PAY,+,ISS,1998-11-20,TYMSC,,92.95,51.63,425,416,399.0524,,EA,ORB',
  'HST,1990-037B,20580,PAY,+,US,1990-04-24,AFETR,,95.07,28.47,524,520,28.0799,,EA,ORB',
  'CSS (TIANHE),2021-035A,48274,PAY,+,PRC,2021-04-29,WSC,,91.62,41.47,384,372,,,EA,ORB',
  'STARLINK-1008,2019-074B,44714,PAY,+,US,2019-11-11,AFETR,,91.92,53.15,550,545,,,EA,ORB',
  '"TEST, QUOTED ""SAT""",2026-001A,100190,PAY,+,US,2026-01-01,AFETR,,95.00,97.30,560,555,2.5,,EA,ORB',
].join('\r\n');

function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  return (route, url = '/') =>
    new Promise((resolve) => {
      const res = {
        headersSent: false,
        writeHead(status, headers) {
          Object.assign(this, { status, headers, headersSent: true });
        },
        end(body) {
          resolve({ status: this.status, headers: this.headers, body });
        },
      };
      routes.get(route)({ url, method: 'GET' }, res);
    });
}

function memoryDisk(t, files = new Map()) {
  t.mock.method(fsp, 'readFile', async (p) => {
    if (!files.has(String(p)))
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return files.get(String(p));
  });
  t.mock.method(fsp, 'writeFile', async (p, data) => {
    files.set(String(p), String(data));
  });
  t.mock.method(fsp, 'mkdir', async () => {});
  t.mock.method(fsp, 'stat', async () => {
    throw new Error('no stat');
  });
  return files;
}

function countingFetch(t, respond) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init });
    return respond(String(url));
  });
  return calls;
}

test('SATCAT URL is the documented records.php GROUP=ACTIVE CSV query', () => {
  const url = celestrakSatcatUrl();
  assert.equal(url.origin, 'https://celestrak.org');
  assert.equal(url.pathname, '/satcat/records.php');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    GROUP: 'ACTIVE',
    FORMAT: 'CSV',
  });
  assert.equal(RCS_TTL_MS, 7 * 24 * 3600_000);
});

test('parseSatcatRcs keeps positive RCS only; null RCS is omitted; quoted names parse', () => {
  const parsed = parseSatcatRcs(SATCAT_CSV);
  assert.equal(parsed.rows, 6);
  assert.equal(parsed.withRcs, 4);
  assert.deepEqual(parsed.rcs, {
    900: 0.051,
    25544: 399.0524,
    20580: 28.0799,
    100190: 2.5,
  });
  assert.ok(!('48274' in parsed.rcs), 'CSS has no RCS in SATCAT');
  assert.ok(!('44714' in parsed.rcs), 'Starlink has no RCS in SATCAT');
  assert.equal(parseSatcatRcs('<html>busy</html>'), null);
  assert.equal(parseSatcatRcs(GP_CSV), null, 'a GP CSV is not SATCAT');
  assert.equal(
    parseSatcatRcs(SATCAT_CSV.split('\r\n')[0]),
    null,
    'header only',
  );
});

test('first request fetches once (UA, URL), caches to disk; later requests HIT for 7 days', async (t) => {
  const files = memoryDisk(t);
  let now = Date.parse('2026-10-12T01:20:00Z');
  t.mock.method(Date, 'now', () => now);
  const calls = countingFetch(t, () => new Response(SATCAT_CSV));
  const request = install(celestrakProxy());

  const [a, b] = await Promise.all([
    request('/api/celestrak-rcs'),
    request('/api/celestrak-rcs'),
  ]);
  assert.equal(calls.length, 1, 'single-flight');
  assert.equal(calls[0].url, celestrakSatcatUrl().toString());
  assert.match(
    calls[0].init.headers['User-Agent'],
    /gods-eye-view-celestrak-proxy/,
  );
  assert.equal(a.status, 200);
  assert.equal(a.headers['x-rcs-cache'], 'MISS');
  assert.equal(a.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(a.body).rcs, JSON.parse(b.body).rcs);
  assert.equal(JSON.parse(a.body).rcs['25544'], 399.0524);
  assert.ok(files.has(RCS_FILE), 'disk cache written');

  now += RCS_TTL_MS - 60_000;
  assert.equal(
    (await request('/api/celestrak-rcs')).headers['x-rcs-cache'],
    'HIT',
  );
  // a restart reads the disk cache instead of fetching
  const restarted = install(celestrakProxy());
  assert.equal(
    (await restarted('/api/celestrak-rcs')).headers['x-rcs-cache'],
    'HIT',
  );
  assert.equal(calls.length, 1, 'no refetch inside 7 days');

  now += 120_000; // past 7 days
  const fresh = await request('/api/celestrak-rcs');
  assert.equal(fresh.headers['x-rcs-cache'], 'MISS');
  assert.equal(calls.length, 2);
});

test('halt latch: while latched there are ZERO upstream requests (RCS and GP), cache still served', async (t) => {
  const files = memoryDisk(t);
  t.mock.method(console, 'warn', () => {});
  const now = Date.parse('2026-10-20T00:00:00Z');
  t.mock.method(Date, 'now', () => now);
  files.set(
    HALT_FILE,
    JSON.stringify({
      halted: true,
      at: now,
      group: 'stations',
      reason: 'HTTP 500',
    }),
  );
  const calls = countingFetch(t, () => new Response(SATCAT_CSV));
  const request = install(celestrakProxy());

  const cold = await request('/api/celestrak-rcs');
  assert.equal(cold.status, 503);
  assert.equal(cold.headers['x-rcs-cache'], 'HALTED');

  files.set(
    RCS_FILE,
    JSON.stringify({
      at: now - 30 * 86400_000,
      rows: 1,
      withRcs: 1,
      rcs: { 25544: 399.0524 },
    }),
  );
  const stale = await request('/api/celestrak-rcs');
  assert.equal(stale.status, 200);
  assert.equal(stale.headers['x-rcs-cache'], 'STALE-HALTED');
  assert.equal(JSON.parse(stale.body).rcs['25544'], 399.0524);
  assert.equal((await request('/api/celestrak', '/stations')).status, 503);
  assert.equal(calls.length, 0, 'zero upstream requests while latched');
});

test('an RCS failure latches the halt for every CelesTrak request (one request, then none)', async (t) => {
  const files = memoryDisk(t);
  t.mock.method(console, 'warn', () => {});
  const calls = countingFetch(t, () => new Response('busy', { status: 500 }));
  const request = install(celestrakProxy());

  const failed = await request('/api/celestrak-rcs');
  assert.equal(failed.status, 502);
  assert.equal(calls.length, 1);
  const halt = JSON.parse(files.get(HALT_FILE));
  assert.equal(halt.halted, true);
  assert.equal(halt.group, 'satcat');
  assert.equal(halt.reason, 'HTTP 500');

  assert.equal((await request('/api/celestrak-rcs')).status, 503);
  for (const group of ['stations', 'active', 'starlink'])
    assert.equal(
      (await request('/api/celestrak', `/${group}`)).headers['x-tle-cache'],
      'HALTED',
    );
  assert.equal(calls.length, 1, 'no further upstream request of any kind');
});

test('a 200 that is not SATCAT CSV is a failure too (halt, nothing cached)', async (t) => {
  const files = memoryDisk(t);
  t.mock.method(console, 'warn', () => {});
  const calls = countingFetch(
    t,
    () => new Response('<html>maintenance</html>'),
  );
  const request = install(celestrakProxy());
  assert.equal((await request('/api/celestrak-rcs')).status, 502);
  assert.equal(calls.length, 1);
  assert.ok(files.has(HALT_FILE));
  assert.ok(!files.has(RCS_FILE));
  assert.equal(
    JSON.parse(files.get(HALT_FILE)).reason,
    'upstream request failed',
  );
});

test('only the bare path is served; anything else is 404 without an upstream request', async (t) => {
  memoryDisk(t);
  const calls = countingFetch(t, () => new Response(SATCAT_CSV));
  const request = install(celestrakProxy());
  assert.equal(
    (await request('/api/celestrak-rcs', '/../stations')).status,
    404,
  );
  assert.equal((await request('/api/celestrak-rcs', '/x')).status, 404);
  assert.equal(calls.length, 0);
});
