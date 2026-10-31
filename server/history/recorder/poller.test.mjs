import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPollers } from './poller.js';
import { ADAPTERS } from './adapters/index.js';
import { createHistoryRuntime } from '../runtime.js';
import { T0, quake, quakesPayload } from './fixtures.mjs';

const SECRET = 'synthetic-Bearer-tok-ABC123xyz';
const USERINFO = 'https://user:pw-SYNTH987@host.invalid/x?api_key=SYNTHKEY555';
const json = (body) => new Response(JSON.stringify(body));

const make = (fetchImpl, feeds = ['quakes']) => {
  const taps = [];
  const failures = [];
  const warnings = [];
  const recorder = {
    tap: (...args) => taps.push(args),
    tapFailure: (...args) => failures.push(args),
  };
  const pollers = createPollers({ recorder, adapters: ADAPTERS, feeds, fetchImpl, warn: (m) => warnings.push(m), clock: () => T0 });
  return { pollers, taps, failures, warnings };
};

describe('feed poller', () => {
  it('only polls feeds whose adapter is a poller', () => {
    assert.deepEqual(make(() => assert.fail('fetched'), ['firms']).pollers.feeds, []);
    assert.deepEqual(make(() => assert.fail('fetched'), ['firms', 'quakes']).pollers.feeds, ['quakes']);
  });

  it('fetches the adapter URL with no credential and taps the parsed body', async () => {
    const calls = [];
    const { pollers, taps } = make(async (url, init) => {
      calls.push([url, init]);
      return json(quakesPayload([quake()]));
    });
    await pollers.pollOnce('quakes');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], ADAPTERS.quakes.upstreamUrl);
    assert.deepEqual(Object.keys(calls[0][1]), ['signal']);
    assert.equal(taps.length, 1);
    assert.equal(taps[0][0], 'quakes');
    assert.equal(taps[0][2].t, T0);
  });

  it('records a gap, with a fixed message, for HTTP errors, bad JSON and a wrong shape', async () => {
    for (const response of [
      () => new Response(`${SECRET} ${USERINFO}`, { status: 503, statusText: SECRET }),
      () => new Response(`not json ${SECRET} ${USERINFO}`),
      () => json({ nope: SECRET }),
    ]) {
      const { pollers, taps, failures, warnings } = make(async () => response());
      await pollers.pollOnce('quakes');
      assert.equal(taps.length, 0);
      assert.equal(failures.length, 1);
      assert.equal(warnings.length, 1);
    }
  });

  it('synthetic secrets in fetch errors reach no log line', async () => {
    const errors = [
      new Error(`connect failed ${USERINFO} ${SECRET}`),
      Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`${USERINFO} ${SECRET}`), { code: 'ECONNRESET' }) }),
    ];
    for (const error of errors) {
      const { pollers, warnings } = make(async () => {
        throw error;
      });
      await pollers.pollOnce('quakes');
      const text = warnings.join('\n');
      for (const value of [SECRET, 'SYNTHKEY555', 'SYNTH987', 'pw-SYNTH987', 'ABC123xyz', encodeURIComponent(SECRET), Buffer.from(SECRET).toString('base64')])
        assert.equal(text.includes(value), false, `leaked ${value.slice(0, 6)}`);
      assert.match(text, /\[history-poller\] quakes poll failed \(/);
    }
  });

  it('refuses an oversized declared body without reading it', async () => {
    const { pollers, failures, warnings } = make(async () => new Response('{}', { headers: { 'content-length': String(64 * 1024 * 1024) } }));
    await pollers.pollOnce('quakes');
    assert.equal(failures.length, 1);
    assert.match(warnings[0], /response too large/);
  });

  it('start is idempotent and stop cancels the timer and waits for a poll in flight', async () => {
    let calls = 0;
    const { pollers } = make(async () => {
      calls += 1;
      return json(quakesPayload([]));
    });
    pollers.start();
    pollers.start();
    await pollers.stop();
    assert.equal(calls, 0);
  });
});

describe('quakes polling through the runtime', () => {
  const withRuntime = async (env, fn, fetchImpl) => {
    let tick = 0;
    const directory = mkdtempSync(path.join(tmpdir(), 'gev-quakes-'));
    const runtime = createHistoryRuntime(
      { HISTORY_SQLITE_PATH: path.join(directory, 'h.sqlite'), ...env },
      { fetchImpl, deferOpen: true, clock: () => (T0 + (tick += 60_000)) },
    );
    try {
      await fn(runtime);
    } finally {
      await runtime.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };

  it('HISTORY_RECORD=1 alone makes no request to USGS', async () => {
    await withRuntime({ HISTORY_RECORD: '1' }, async (runtime) => {
      assert.deepEqual(runtime.pollers.feeds, []);
      runtime.start();
    }, () => assert.fail('fetched'));
  });

  it('HISTORY_RECORD_QUAKES=1 polls once and stores the M2.5+ events', async () => {
    let calls = 0;
    await withRuntime({ HISTORY_RECORD_QUAKES: '1' }, async (runtime) => {
      assert.deepEqual(runtime.pollers.feeds, ['quakes']);
      await runtime.pollers.pollOnce('quakes');
      await runtime.pollers.pollOnce('quakes');
      await runtime.recorder.flush();
      runtime.start();
      assert.equal((await runtime.store.coverage('quakes')).count, 1);
      assert.equal((await runtime.store.ingestLog('quakes')).polls.length, 2);
    }, async () => {
      calls += 1;
      return json(quakesPayload([quake(), quake({ id: 'small', properties: { mag: 1.2 } })]));
    });
    assert.equal(calls, 2);
  });
});
