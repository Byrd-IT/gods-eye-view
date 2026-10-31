import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHistoryTee, FAILED, SKIP } from './tee.js';
import { request } from './feedFixtures/http.mjs';

const recorderStub = (feeds = ['x']) => {
  const calls = [];
  return {
    calls,
    enabled: true,
    feeds,
    tap: (feed, payload, meta) =>
      calls.push({ kind: 'tap', feed, payload, meta }),
    tapFailure: (feed, meta) => calls.push({ kind: 'fail', feed, meta }),
  };
};
const route = (extra = {}) => ({
  feed: 'x',
  name: 'x',
  match: (url) => (url.pathname === '/api/x' ? { key: 'x' } : null),
  parse: 'json',
  ...extra,
});

describe('history tee', () => {
  it('passes a real chunked response through untouched and records it once', async () => {
    const recorder = recorderStub();
    const tee = createHistoryTee({ recorder, routes: [route()] });
    const server = http.createServer((req, res) =>
      tee(req, res, () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"a":');
        res.write(Buffer.from('[1,2]'));
        res.end('}');
      }),
    );
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/x`);
    assert.equal(await response.text(), '{"a":[1,2]}');
    await new Promise((resolve) => setTimeout(resolve, 20));
    server.close();
    assert.deepEqual(
      recorder.calls.map((c) => c.kind),
      ['tap'],
    );
    assert.deepEqual(recorder.calls[0].payload, { a: [1, 2] });
  });

  it('uses the route payload hook; SKIP records nothing, FAILED notes a failed poll', async () => {
    const recorder = recorderStub();
    let mode = SKIP;
    const tee = createHistoryTee({
      recorder,
      routes: [route({ payload: () => mode })],
    });
    const reply = (req, res) => {
      res.writeHead(200);
      res.end(`{"n":${Math.random()}}`);
    };
    await request(tee, '/api/x', reply);
    mode = FAILED;
    await request(tee, '/api/x', reply);
    assert.deepEqual(
      recorder.calls.map((c) => c.kind),
      ['fail'],
    );
  });

  it('skips an answer with the same pollAt, or with no pollAt the same bytes', async () => {
    const recorder = recorderStub();
    let at = 1000;
    const withPoll = createHistoryTee({
      recorder,
      routes: [route({ pollAt: () => at })],
    });
    const reply = (req, res) => {
      res.writeHead(200);
      res.end(`{"n":${Math.random()}}`);
    };
    await request(withPoll, '/api/x', reply);
    await request(withPoll, '/api/x', reply);
    at = 2000;
    await request(withPoll, '/api/x', reply);
    assert.deepEqual(
      recorder.calls.map((c) => c.meta?.t),
      [1000, 2000],
    );

    const plain = recorderStub();
    const bytes = createHistoryTee({ recorder: plain, routes: [route()] });
    const same = (req, res) => {
      res.writeHead(200);
      res.end('{"n":1}');
    };
    await request(bytes, '/api/x', same);
    await request(bytes, '/api/x', same);
    assert.equal(plain.calls.length, 1);
  });

  it('never throws into the response when the hook or the recorder throws', async () => {
    const recorder = recorderStub();
    recorder.tap = () => {
      throw new Error('boom with /secret/path');
    };
    const tee = createHistoryTee({ recorder, routes: [route()] });
    const res = await request(tee, '/api/x', (req, r) => {
      r.writeHead(200);
      r.end('{"ok":true}');
    });
    assert.equal(res.body, '{"ok":true}');
    const hooked = createHistoryTee({
      recorder: recorderStub(),
      routes: [
        route({
          payload: () => {
            throw new Error('x');
          },
        }),
      ],
    });
    const again = await request(hooked, '/api/x', (req, r) => {
      r.writeHead(200);
      r.end('{"ok":true}');
    });
    assert.equal(again.body, '{"ok":true}');
  });

  it('skips compressed bodies', async () => {
    const recorder = recorderStub();
    const tee = createHistoryTee({ recorder, routes: [route()] });
    await request(tee, '/api/x', (req, res) => {
      res.setHeader('Content-Encoding', 'gzip');
      res.writeHead(200);
      res.end('{"a":1}');
    });
    assert.equal(recorder.calls.length, 0);
  });

  it('skips a body over the cap, and still passes it to the client', async () => {
    const recorder = recorderStub();
    const tee = createHistoryTee({ recorder, routes: [route()], maxBodyBytes: 16 });
    const big = JSON.stringify({ a: 'x'.repeat(64) });
    const res = await request(tee, '/api/x', (req, r) => {
      r.writeHead(200);
      r.end(big);
    });
    assert.equal(res.body, big);
    assert.equal(recorder.calls.length, 0);
  });

  it('skips a cache replay before reading the body, and records a fresh answer', async () => {
    const recorder = recorderStub();
    let parsed = 0;
    const tee = createHistoryTee({
      recorder,
      routes: [route({
        isReplay: (res) => res.getHeader('x-cache') === 'HIT',
        payload: (p) => { parsed += 1; return p; },
      })],
    });
    const reply = (cache, n) => (req, res) => {
      res.setHeader('X-Cache', cache);
      res.writeHead(200);
      res.end(`{"n":${n}}`);
    };
    await request(tee, '/api/x', reply('MISS', 1));
    await request(tee, '/api/x', reply('HIT', 1));
    await request(tee, '/api/x', reply('HIT', 1));
    assert.equal(parsed, 1);
    assert.equal(recorder.calls.length, 1);
  });

  it('notes a failed answer even when the proxy marks it a replay, and skips a replayed good one', async () => {
    const recorder = recorderStub();
    const tee = createHistoryTee({
      recorder,
      routes: [route({ isReplay: (res) => res.getHeader('x-cache') === 'STALE' })],
    });
    const reply = (status) => (req, res) => {
      res.setHeader('X-Cache', 'STALE');
      res.writeHead(status);
      res.end('{"n":1}');
    };
    await request(tee, '/api/x', reply(200));
    assert.equal(recorder.calls.length, 0);
    await request(tee, '/api/x', reply(429));
    assert.deepEqual(recorder.calls.map((c) => c.kind), ['fail']);
  });

  it('compares an answer only with the earlier one that has the same dedupeKey', async () => {
    const recorder = recorderStub();
    const tee = createHistoryTee({
      recorder,
      routes: [
        route({
          match: (url) =>
            url.pathname === '/api/x'
              ? { key: 'x', anchor: url.searchParams.get('a') }
              : null,
          pollAt: () => 1000,
          dedupeKey: (context) => `${context.key}|${context.anchor}`,
        }),
      ],
    });
    const reply = (req, res) => {
      res.writeHead(200);
      res.end('{"n":1}');
    };
    await request(tee, '/api/x?a=1', reply);
    await request(tee, '/api/x?a=2', reply);
    await request(tee, '/api/x?a=1', reply);
    assert.equal(recorder.calls.length, 2);
  });

  it('limits FAILED answers to one a minute, and does not let them hide the next good one', async () => {
    const recorder = recorderStub();
    let mode = FAILED;
    const clock = { now: 1_000_000 };
    const tee = createHistoryTee({
      recorder,
      clock: () => clock.now,
      routes: [route({ payload: (p) => (mode === FAILED ? FAILED : p), pollAt: () => 5 })],
    });
    const reply = (req, res) => {
      res.writeHead(200);
      res.end('{"n":1}');
    };
    await request(tee, '/api/x', reply);
    await request(tee, '/api/x', reply);
    assert.deepEqual(recorder.calls.map((c) => c.kind), ['fail']);
    mode = 'ok';
    await request(tee, '/api/x', reply);
    assert.deepEqual(recorder.calls.map((c) => c.kind), ['fail', 'tap']);
    mode = FAILED;
    clock.now += 61_000;
    await request(tee, '/api/x', reply);
    assert.deepEqual(recorder.calls.map((c) => c.kind), ['fail', 'tap', 'fail']);
  });

  it('does nothing with a disabled recorder', async () => {
    const recorder = { ...recorderStub(), enabled: false };
    const tee = createHistoryTee({ recorder, routes: [route()] });
    await request(tee, '/api/x', (req, res) => {
      res.writeHead(200);
      res.end('{"a":1}');
    });
    assert.equal(recorder.calls.length, 0);
  });

  it('a route that only observes sees ok answers and never records or notes a failure', async () => {
    const recorder = recorderStub();
    const seen = [];
    const tee = createHistoryTee({
      recorder,
      routes: [route({ observe: true, payload: (p) => seen.push(p) })],
    });
    await request(tee, '/api/x', (req, res) => {
      res.writeHead(200);
      res.end('{"a":1}');
    });
    await request(tee, '/api/x', (req, res) => {
      res.writeHead(503);
      res.end('{}');
    });
    assert.equal(seen.length, 1);
    assert.equal(recorder.calls.length, 0);
  });
});
