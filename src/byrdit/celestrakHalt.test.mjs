// Byrd-IT: CelesTrak halt latch. CelesTrak policy (and Dr. Kelso, 2026-09-30):
// on ANY non-200, stop querying and report to a human. These tests pin that a
// single failure halts ALL groups, survives a restart, and only a human
// deleting the halt file re-enables upstream.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { celestrakProxy } from '../../server/providers/space.js';

const CSV = 'OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION\r\nISS (ZARYA),1998-067A,2026-09-19T00:00:00.000000,15.5';
const HALT_FILE = path.join(process.cwd(), '.gev-cache', 'celestrak-HALT.json');

function install(plugin) {
  let handler;
  plugin.configureServer({ middlewares: { use: (_p, h) => { handler = h; } } });
  return (url) => new Promise((resolve) => {
    const res = {
      headersSent: false,
      writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
      end(body) { resolve({ status: this.status, headers: this.headers, body }); },
    };
    handler({ url }, res);
  });
}

/** In-memory fs: cache files + halt file live in `files`. */
function memoryDisk(t, files = new Map()) {
  t.mock.method(fsp, 'readFile', async (p) => {
    if (!files.has(String(p))) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return files.get(String(p));
  });
  t.mock.method(fsp, 'writeFile', async (p, data) => { files.set(String(p), String(data)); });
  t.mock.method(fsp, 'mkdir', async () => {});
  t.mock.method(fsp, 'stat', async () => { throw new Error('no stat'); });
  return files;
}

test('one HTTP error halts every group; no further upstream calls', async (t) => {
  const files = memoryDisk(t);
  t.mock.method(console, 'warn', () => {});
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('busy', { status: 503 }); });
  const request = install(celestrakProxy());

  const first = await request('/stations');
  assert.equal(calls, 1);
  assert.equal(first.status, 502);
  assert.ok(files.has(HALT_FILE), 'halt file written');
  assert.equal(JSON.parse(files.get(HALT_FILE)).reason, 'HTTP 503');

  for (const group of ['stations', 'starlink', 'active', 'geo']) {
    const res = await request(`/${group}`);
    assert.equal(res.status, 503);
    assert.equal(res.headers['x-tle-cache'], 'HALTED');
  }
  assert.equal(calls, 1, 'no upstream request after the halt, for any group');
});

test('halt persists across a restart and still serves cache', async (t) => {
  const files = memoryDisk(t);
  t.mock.method(console, 'warn', () => {});
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  files.set(path.join(process.cwd(), '.gev-cache', 'celestrak-stations.json'), JSON.stringify({ at: now - 7 * 3600_000, body: CSV }));
  files.set(HALT_FILE, JSON.stringify({ halted: true, at: now, group: 'starlink', reason: 'HTTP 500' }));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(CSV); });

  const request = install(celestrakProxy()); // fresh instance = restart
  const res = await request('/stations');
  assert.equal(res.status, 200);
  assert.equal(res.body, CSV);
  assert.equal(res.headers['x-tle-cache'], 'STALE-HALTED');
  assert.equal(calls, 0, 'a restart must not clear the halt');
});

test('time passing alone never re-enables upstream; deleting the halt file does', async (t) => {
  const files = memoryDisk(t);
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'info', () => {});
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let fail = true;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (fail) throw new Error('connect ETIMEDOUT');
    return new Response(CSV);
  });
  const request = install(celestrakProxy());
  await request('/stations');
  assert.equal(calls, 1);
  assert.equal(JSON.parse(files.get(HALT_FILE)).reason, 'upstream request failed');

  now += 30 * 24 * 3600_000; // a month later
  fail = false;
  assert.equal((await request('/stations')).headers['x-tle-cache'], 'HALTED');
  assert.equal(calls, 1, 'still halted after 30 days');

  files.delete(HALT_FILE); // operator clears it
  const res = await request('/stations');
  assert.equal(res.status, 200);
  assert.equal(res.headers['x-tle-cache'], 'MISS');
  assert.equal(calls, 2);
});

test('error details never reach the halt file or logs', async (t) => {
  const files = memoryDisk(t);
  const logs = [];
  t.mock.method(console, 'warn', (...a) => logs.push(a.join(' ')));
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('https://secret.example/?token=abc <html>'); });
  await install(celestrakProxy())('/stations');
  const all = files.get(HALT_FILE) + logs.join('\n');
  assert.ok(!/secret|token=|<html>/.test(all), all);
});
