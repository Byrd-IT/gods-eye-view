import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { firmsProxy } from './firms.js';

const HEADER = 'latitude,longitude,acq_date,acq_time,confidence,frp\n';
const NOW = Date.UTC(2026, 8, 12, 12);

function install(plugin) {
  let handler;
  plugin.configureServer({ middlewares: { use: (_route, fn) => (handler = fn) } });
  return async (url = '/') => {
    const res = {
      headersSent: false,
      writeHead(status) {
        Object.assign(this, { status, headersSent: true });
      },
      end(body) {
        this.body = body;
      },
    };
    await handler({ url, method: 'GET', headers: {}, socket: {} }, res);
    return res;
  };
}

function isolate(t, fetchImpl) {
  const previous = process.env.FIRMS_MAP_KEY;
  t.after(() => {
    if (previous === undefined) delete process.env.FIRMS_MAP_KEY;
    else process.env.FIRMS_MAP_KEY = previous;
  });
  process.env.FIRMS_MAP_KEY = 'fixture-key';
  t.mock.method(Date, 'now', () => NOW);
  t.mock.method(fsp, 'readFile', async () => {
    throw Error('no disk cache');
  });
  t.mock.method(fsp, 'mkdir', async () => {});
  t.mock.method(fsp, 'writeFile', async () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', fetchImpl);
}

const csv = (rows) => HEADER + rows.map((row) => row.join(',')).join('\n') + '\n';
const okFetch = async (raw) =>
  new Response(String(raw).includes('VIIRS_NOAA20') ? csv([[30, -97, '2026-09-12', '1100', 'h', 10]]) : csv([]));

function spy() {
  const calls = { tap: [], failure: [] };
  return {
    calls,
    enabled: true,
    tap: (...args) => (calls.tap.push(args), { queued: 1 }),
    tapFailure: (...args) => (calls.failure.push(args), { queued: 0 }),
  };
}

test('a fresh refresh is handed to the recorder once, with the payload the client got', async (t) => {
  isolate(t, okFetch);
  const recorder = spy();
  const request = install(firmsProxy({ recorder }));
  const [a, b] = await Promise.all([request(), request()]);
  assert.equal(a.status, 200);
  assert.equal(recorder.calls.tap.length, 1, 'two waiters on one refresh record it once');
  const [feed, payload, meta] = recorder.calls.tap[0];
  assert.equal(feed, 'firms');
  assert.deepEqual(JSON.parse(a.body), payload);
  assert.equal(a.body, b.body);
  assert.equal(meta.t, NOW);
  await request();
  assert.equal(recorder.calls.tap.length, 1, 'a cache hit is not a new poll');
});

test('the response is byte-identical with recording on or off, and survives a recorder that throws', async (t) => {
  isolate(t, okFetch);
  const off = await install(firmsProxy({ recorder: { tap() {}, tapFailure() {} } }))();
  const throwing = {
    tap() {
      throw new Error('boom api_key=zzz');
    },
    tapFailure() {
      throw new Error('boom');
    },
  };
  const broken = await install(firmsProxy({ recorder: throwing }))();
  assert.equal(broken.status, 200);
  assert.equal(broken.body, off.body);
});

test('a refresh that fails everywhere is recorded as a failed poll, not as an empty one', async (t) => {
  isolate(t, async () => new Response('offline', { status: 503 }));
  const recorder = spy();
  const request = install(firmsProxy({ recorder }));
  assert.equal((await request()).status, 502);
  assert.equal(recorder.calls.tap.length, 0);
  assert.equal(recorder.calls.failure.length, 1);
});

test('serving the stale cache while upstream is down records a failed poll', async (t) => {
  let up = true;
  let now = NOW;
  isolate(t, async (raw) => (up ? okFetch(raw) : new Response('offline', { status: 503 })));
  t.mock.method(Date, 'now', () => now);
  const recorder = spy();
  const request = install(firmsProxy({ recorder }));
  await request();
  up = false;
  now += 31 * 60_000;
  const stale = await request();
  assert.equal(JSON.parse(stale.body).stale, true);
  assert.equal(recorder.calls.tap.length, 1);
  assert.equal(recorder.calls.failure.length, 1);
});

test('without a recorder the proxy records nothing and still answers', async (t) => {
  isolate(t, okFetch);
  const response = await install(firmsProxy())();
  assert.equal(response.status, 200);
});
