import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG_TIMEOUT_MS,
  ES_LIVE_CONFIG_URL,
  EsLiveConfigUnavailableError,
  esLiveTarget,
  installEsLiveFetch,
  isRedirectable,
} from './clientRedirect.js';

const USGS = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';
const STATIONS = 'https://api.weather.gc.ca/collections/aqhi-stations/items?f=json&limit=500';
const OBS =
  'https://api.weather.gc.ca/collections/aqhi-observations-realtime/items?f=json&latest=true&limit=500';

/** A fetch whose config answer is `config` (a body, a status, or an Error) and which records the rest. */
function fakeTarget(config) {
  const seen = [];
  let configCalls = 0;
  const target = {
    async fetch(input) {
      const href = typeof input === 'string' ? input : (input.url ?? String(input));
      if (href === ES_LIVE_CONFIG_URL) {
        configCalls += 1;
        if (config instanceof Error) throw config;
        if (typeof config === 'number') return new Response('{}', { status: config });
        return new Response(JSON.stringify(config), { status: 200 });
      }
      seen.push(href);
      return new Response('ok');
    },
  };
  return { target, seen, configCalls: () => configCalls };
}

test('targets: only the quake and AQHI provider URLs, only when listed', () => {
  const all = new Set(['quakes', 'aqhi']);
  assert.equal(esLiveTarget(USGS, all), '/api/es-live/earthquakes');
  assert.equal(esLiveTarget(STATIONS, all), '/api/es-live/aqhi-stations');
  assert.equal(esLiveTarget(OBS, all), '/api/es-live/aqhi');
  assert.equal(esLiveTarget(USGS, new Set(['aqhi'])), null);
  assert.equal(esLiveTarget(OBS, new Set(['quakes'])), null);
  assert.equal(esLiveTarget('https://api.weather.gc.ca/collections/other/items', all), null);
  assert.equal(
    esLiveTarget('http://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson', all),
    null,
  );
  assert.equal(
    esLiveTarget('https://evil.example/earthquakes/feed/v1.0/summary/all_day.geojson', all),
    null,
  );
  assert.equal(esLiveTarget('not a url', all), null);
  assert.equal(isRedirectable(USGS) && isRedirectable(OBS) && isRedirectable(STATIONS), true);
  assert.equal(isRedirectable('/api/transit'), false);
});

test('install: listed feeds go to this server, everything else is untouched, and the server is asked once', async () => {
  const f = fakeTarget({ feeds: ['aqhi', 'quakes', 'gnss'] });
  const undo = installEsLiveFetch({ target: f.target, doc: null });
  await Promise.all([f.target.fetch(USGS), f.target.fetch(STATIONS), f.target.fetch(OBS)]);
  await f.target.fetch(USGS);
  await f.target.fetch('/api/transit');
  await f.target.fetch(new URL('https://example.org/x'));
  assert.deepEqual(f.seen.sort(), [
    '/api/es-live/aqhi',
    '/api/es-live/aqhi-stations',
    '/api/es-live/earthquakes',
    '/api/es-live/earthquakes',
    '/api/transit',
    'https://example.org/x',
  ]);
  assert.equal(f.configCalls(), 1);
  undo();
});

test('install: a page that never calls a provider never asks the server', async () => {
  const f = fakeTarget({ feeds: ['quakes'] });
  installEsLiveFetch({ target: f.target, doc: null });
  await f.target.fetch('/api/transit');
  await f.target.fetch('https://example.org/x');
  assert.equal(f.configCalls(), 0);
});

test('install: a server without the plugin (404) or with no listed feed changes nothing (flag off = old behaviour)', async () => {
  for (const config of [404, { feeds: [] }, { feeds: ['gnss'] }]) {
    const f = fakeTarget(config);
    installEsLiveFetch({ target: f.target, doc: null });
    await f.target.fetch(USGS);
    await f.target.fetch(OBS);
    assert.deepEqual(f.seen, [USGS, OBS], JSON.stringify(config));
    assert.equal(f.configCalls(), 1, 'the answer is remembered');
  }
});

test('install: one listed feed redirects only that feed', async () => {
  const f = fakeTarget({ feeds: ['quakes'] });
  installEsLiveFetch({ target: f.target, doc: null });
  await f.target.fetch(OBS);
  await f.target.fetch(USGS);
  assert.deepEqual(f.seen, [OBS, '/api/es-live/earthquakes']);
});

test('install: initial config failure fails CLOSED — the request is never sent to the provider', async () => {
  for (const config of [new Error('network'), 503]) {
    const f = fakeTarget(config);
    const undo = installEsLiveFetch({ target: f.target, doc: null });
    await assert.rejects(f.target.fetch(USGS), EsLiveConfigUnavailableError);
    assert.deepEqual(f.seen, [], `no provider call for ${JSON.stringify(config)}`);
    assert.equal(f.configCalls(), 1, 'the server was asked once');
    // the failed answer is not cached: the next provider call asks again
    // (and fails closed just the same, while the config stays broken)
    await assert.rejects(f.target.fetch(USGS), EsLiveConfigUnavailableError);
    assert.equal(f.configCalls(), 2, 'asked again next time');
    undo();
  }
});

test('install: a Request input for a listed URL is redirected with its method and headers', async () => {
  const seen = [];
  const target = {
    location: { href: 'https://gev.example.test/' },
    async fetch(input) {
      if (input === new URL(ES_LIVE_CONFIG_URL, target.location.href).href)
        return new Response(JSON.stringify({ feeds: ['quakes'] }));
      seen.push(input);
      return new Response('ok');
    },
  };
  installEsLiveFetch({ target, doc: { baseURI: 'https://gev.example.test/' } });
  await target.fetch(new Request(USGS, { headers: { 'x-t': '1' } }));
  assert.equal(seen[0] instanceof Request, true);
  assert.equal(seen[0].url, 'https://gev.example.test/api/es-live/earthquakes');
  assert.equal(seen[0].headers.get('x-t'), '1');
  await target.fetch(new Request('https://example.org/y'));
  assert.equal(seen[1].url, 'https://example.org/y');
});

test('install: a wrapper stacked on top (the history router) still sees the provider URL first', async () => {
  const f = fakeTarget({ feeds: ['quakes', 'aqhi'] });
  installEsLiveFetch({ target: f.target, doc: null });
  const below = f.target.fetch;
  let historyMode = true;
  // what the history router does: serve time-travel frames for the provider
  // URL, pass everything else (and live frames) to the wrapper below it
  f.target.fetch = async (input, init) =>
    historyMode && String(input) === USGS ? new Response('frame') : below(input, init);
  assert.equal(await (await f.target.fetch(USGS)).text(), 'frame');
  assert.deepEqual(f.seen, [], 'time travel: nothing reached the network layer');
  assert.equal(f.configCalls(), 0, 'and the server was not even asked');
  historyMode = false;
  await f.target.fetch(USGS);
  assert.deepEqual(f.seen, ['/api/es-live/earthquakes']);
});

test('uninstall restores the original fetch only if it is still ours', () => {
  const f = fakeTarget({ feeds: [] });
  const original = f.target.fetch;
  const undo = installEsLiveFetch({ target: f.target, doc: null });
  assert.notEqual(f.target.fetch, original);
  undo();
  assert.equal(f.target.fetch, original);
  const undo2 = installEsLiveFetch({ target: f.target, doc: null });
  const other = async () => 'x';
  f.target.fetch = other;
  undo2();
  assert.equal(f.target.fetch, other);
});

/* ---- item 6 hardening ---- */

test('hardening: the config request never hangs past the (bounded) timeout, and fails CLOSED', { timeout: 5000 }, async () => {
  const seen = [];
  const target = {
    configAnswer: null, // when set, a JSON config answer; null = hang forever
    // a fake that honours the abort signal, like real fetch does
    fetch(input, init) {
      const href = typeof input === 'string' ? input : input.url;
      if (href === ES_LIVE_CONFIG_URL) {
        if (target.configAnswer)
          return Promise.resolve(
            new Response(JSON.stringify(target.configAnswer)),
          );
        return new Promise((resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal.reason));
        });
      }
      seen.push(href);
      return Promise.resolve(new Response('ok'));
    },
  };
  installEsLiveFetch({ target, doc: null, configTimeoutMs: 30 });
  const started = Date.now();
  await assert.rejects(target.fetch(USGS), EsLiveConfigUnavailableError);
  assert.equal(Date.now() - started < 2000, true, 'the call returned instead of waiting');
  assert.deepEqual(seen, [], 'NO provider fallback after the timeout');
  // and the stale answer is dropped: the next provider call asks again
  target.configAnswer = { feeds: ['quakes'] };
  await target.fetch(USGS);
  assert.deepEqual(seen, ['/api/es-live/earthquakes'], 'recovered: redirected, still no provider call');
});

test('hardening: the default config timeout is about 3 seconds (bounded) and fails CLOSED', { timeout: 5000 }, async () => {
  // the ~3 s default is the shipped constant (asserted; the behaviour is
  // exercised beneath with a small injected timeout so the suite stays fast)
  assert.equal(DEFAULT_CONFIG_TIMEOUT_MS, 3000);
  const seen = [];
  const target = {
    fetch(input, init) {
      const href = typeof input === 'string' ? input : input.url;
      if (href === ES_LIVE_CONFIG_URL)
        return new Promise((resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal.reason));
        });
      seen.push(href);
      return Promise.resolve(new Response('ok'));
    },
  };
  installEsLiveFetch({ target, doc: null, configTimeoutMs: 30 });
  const started = Date.now();
  await assert.rejects(target.fetch(USGS), EsLiveConfigUnavailableError);
  assert.equal(Date.now() - started < 2000, true, `bounded timeout, took ${Date.now() - started}ms`);
  assert.deepEqual(seen, [], 'no provider call after the timeout failure');
});

test('hardening: a caller abort signal stops redirecting for that request', async () => {
  // pre-aborted caller: no request may go to the provider
  const controller = new AbortController();
  controller.abort();
  const f2 = fakeTarget({ feeds: ['quakes'] });
  const undo2 = installEsLiveFetch({ target: f2.target, doc: null });
  const wrapped = f2.target.fetch;
  assert.deepEqual(f2.seen, [], 'sanity: nothing fetched yet');
  await assert.rejects(wrapped(USGS, { signal: controller.signal }), EsLiveConfigUnavailableError);
  assert.deepEqual(f2.seen, [], 'aborted caller: nothing sent, not even to the provider');
  assert.equal(f2.configCalls(), 0, 'and the server was not asked');
  undo2();
});

test('hardening: an aborted install signal aborts the config request in flight', { timeout: 5000 }, async () => {
  const inits = [];
  const controller = new AbortController();
  const seen = [];
  const target = {
    fetch(input, init) {
      const href = typeof input === 'string' ? input : input.url;
      if (href === ES_LIVE_CONFIG_URL) {
        inits.push(init?.signal);
        // honour the given signal, like real fetch does
        return new Promise((resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal.reason));
        });
      }
      seen.push(href);
      return Promise.resolve(new Response('ok'));
    },
  };
  installEsLiveFetch({ target, doc: null, signal: controller.signal });
  const pending = target.fetch(USGS);
  controller.abort(); // while the config request is in flight
  await assert.rejects(pending, EsLiveConfigUnavailableError, 'aborted install: fail closed');
  assert.deepEqual(seen, [], 'aborted install: NO provider fallback');
  assert.equal(inits[0] instanceof AbortSignal, true);
  const abortedBeforeAnswer = inits[0].aborted;
  assert.equal(abortedBeforeAnswer, true, 'the config request observed the caller signal');
});

test('hardening: a non-JSON 200 answer is treated like a failed config (fail closed, ask again)', { timeout: 5000 }, async () => {
  for (const body of ['<html>boot loader</html>', '', '{"feeds": truncated']) {
    const seen = [];
    const configCalls = { n: 0 };
    const target = {
      async fetch(input) {
        const href = typeof input === 'string' ? input : input.url;
        if (href === ES_LIVE_CONFIG_URL) {
          configCalls.n += 1;
          return new Response(body, { status: 200 });
        }
        seen.push(href);
        return new Response('ok');
      },
    };
    installEsLiveFetch({ target, doc: null });
    await assert.rejects(target.fetch(USGS), EsLiveConfigUnavailableError, JSON.stringify(body).slice(0, 30));
    assert.deepEqual(seen, [], `no provider call for body ${JSON.stringify(body).slice(0, 30)}`);
    // the broken answer is not cached as "nothing to redirect"
    await assert.rejects(target.fetch(USGS), EsLiveConfigUnavailableError);
    assert.equal(configCalls.n, 2, 'asked again next time');
  }
});

/* ---- item 6 scope corrections: no NEW upstream calls, per-request signal bounds ---- */

/**
 * A configurable config route. `answers` is a queue consumed per config call:
 *  - a plain object or number: that answer immediately
 *  - an Error: thrown
 *  - undefined (queue empty or pushed `HANG`): hang until the caller's signal
 *    aborts (then reject) — never self-settles.
 */
const HANG = Symbol('hang');
const scriptedTargets = [];

function scriptedTarget(answers = []) {
  const target = {
    answers,
    seen: [],
    signals: [],
    async fetch(input, init) {
      const href = typeof input === 'string' ? input : input.url;
      if (href === ES_LIVE_CONFIG_URL) {
        target.signals.push(init?.signal ?? null);
        const answer = answers.length ? answers.shift() : HANG;
        if (answer === HANG) {
          return new Promise((resolve, reject) => {
            if (init?.signal?.aborted) { reject(init.signal.reason); return; }
            const on = () => {
              init.signal.removeEventListener('abort', on);
              reject(init.signal.reason);
            };
            init?.signal?.addEventListener('abort', on);
          });
        }
        if (answer instanceof Error) throw answer;
        if (typeof answer === 'number') return new Response('{}', { status: answer });
        return new Response(JSON.stringify(answer), { status: 200 });
      }
      target.seen.push(href);
      // the redirected route mirrors the real stale-plugin server: 404
      if (href.startsWith('/api/es-live/')) return new Response('gone', { status: 404 });
      return new Response('ok');
    },
  };
  scriptedTargets.push(target);
  return target;
}

test('item6: a redirected-route 404 with a failed re-check returns the SAME-ORIGIN 404 — no provider request', { timeout: 5000 }, async () => {
  // answers: (1) ask→listed, (2) re-check→listed (retry happens for call 1);
  // call 2 starts from the cached answer, its re-check (3) FAILS → the
  // original 404 is returned, no retry, no provider call
  const target = scriptedTarget([
    { feeds: ['quakes'] },
    { feeds: ['quakes'] },
    new Error('config down'),
  ]);
  const undo = installEsLiveFetch({ target, doc: null });
  const first = await target.fetch(USGS); // redirect ->404 -> re-check OK -> retried
  assert.equal(first.status, 404);
  assert.deepEqual(target.seen, ['/api/es-live/earthquakes', '/api/es-live/earthquakes']);
  const r = await target.fetch(USGS); // redirect ->404 -> re-check FAILS
  assert.equal(r.status, 404, 'the original same-origin 404 is returned');
  assert.deepEqual(target.seen, [
    '/api/es-live/earthquakes',
    '/api/es-live/earthquakes',
    '/api/es-live/earthquakes',
  ], 'only same-origin requests — NO provider call on the re-check-failure path');
  assert.equal(target.seen.every((h) => h.startsWith('/api/es-live/')), true, 'every request was same-origin (no provider hit)');
  undo();
});

test('item6: a redirected-route 404 with the feed no longer listed returns the SAME-ORIGIN 404 — no provider request', { timeout: 5000 }, async () => {
  // answers: (1) ask→listed, (2) re-check→listed (retry happens for call 1);
  // call 2 starts from the cached answer, its re-check (3) says UNLISTED →
  // the original 404 is returned, no retry, no provider call
  const target = scriptedTarget([
    { feeds: ['quakes'] },
    { feeds: ['quakes'] },
    { feeds: [] },
  ]);
  const undo = installEsLiveFetch({ target, doc: null });
  const first = await target.fetch(USGS);
  assert.equal(first.status, 404);
  assert.deepEqual(target.seen, ['/api/es-live/earthquakes', '/api/es-live/earthquakes']);
  const r = await target.fetch(USGS); // re-check says unlisted -> original 404, never the provider
  assert.equal(r.status, 404, 'the original 404 is surfaced, not a provider request');
  assert.deepEqual(target.seen, [
    '/api/es-live/earthquakes',
    '/api/es-live/earthquakes',
    '/api/es-live/earthquakes',
  ], 'only same-origin requests — no provider call on the unlisted re-check');
  assert.equal(target.seen.every((h) => h.startsWith('/api/es-live/')), true, 'no provider hit');
  undo();
});

test('item6: the caller init.signal bounds its in-flight config wait (fail closed); a shared concurrent caller is untouched', { timeout: 5000 }, async () => {
  const target = scriptedTarget([]); // config hangs
  const undo = installEsLiveFetch({ target, doc: null, configTimeoutMs: 60_000 });
  const a = new AbortController();
  const b = new AbortController();
  const callerA = target.fetch(USGS, { signal: a.signal });
  const callerB = target.fetch(USGS, { signal: b.signal });
  assert.equal(target.signals.length, 1, 'one shared config ask');
  a.abort(); // while the config ask is in flight
  await assert.rejects(callerA, EsLiveConfigUnavailableError, "A's wait ends without a provider call");
  assert.deepEqual(target.seen, [], 'no provider call for the aborted caller');
  const stillPending = await Promise.race([
    callerB.then(() => 'settled'),
    new Promise((r) => setTimeout(() => r('pending'), 300)),
  ]);
  assert.equal(stillPending, 'pending', "the shared config wait still serves caller B after A's abort");
  assert.equal(target.signals[0].aborted, false, 'the SHARED config fetch was not aborted by caller A');
  b.abort();
  undo();
});

test('item6: a Request.signal bounds its own in-flight config wait, failing CLOSED', { timeout: 5000 }, async () => {
  const target = scriptedTarget([]); // config hangs
  const undo = installEsLiveFetch({ target, doc: null, configTimeoutMs: 60_000 });
  const ctl = new AbortController();
  const req = new Request(USGS, { signal: ctl.signal });
  const pending = target.fetch(req);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(target.signals.length, 1, 'the shared config ask is in flight');
  assert.equal(target.signals[0].aborted, false);
  ctl.abort(); // while the config ask is in flight — the wait must end
  const settled = await Promise.race([
    pending.then(() => 'settled', (e) => ({ rejected: e })),
    new Promise((r) => setTimeout(() => r('stuck'), 500)),
  ]);
  assert.ok(settled !== 'stuck', 'config wait not bounded by the Request signal');
  assert.ok(settled.rejected instanceof EsLiveConfigUnavailableError, 'fails closed on cancellation');
  assert.deepEqual(target.seen, [], 'no provider call on cancellation');
  undo(); // aborts the in-flight config ask its teardown path
});

test('item6: on the 404 re-check path a caller abort while the config is pending returns the original 404 — no provider call', { timeout: 5000 }, async () => {
  // config ask 1 answers "listed"; config ask 2 (the re-check after the 404) hangs
  const target = scriptedTarget([{ feeds: ['quakes'] }]);
  const undo = installEsLiveFetch({ target, doc: null, configTimeoutMs: 60_000 });
  const a = new AbortController();
  const pending = target.fetch(USGS, { signal: a.signal });
  // let the first config answer land and the redirected 404 come back
  for (let i = 0; i < 50 && target.signals.length < 2; i += 1)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(target.signals.length, 2, 'the re-check is in flight');
  assert.deepEqual(target.seen, ['/api/es-live/earthquakes']);
  a.abort(); // caller gives up while the re-check is pending
  const r = await pending;
  assert.equal(r.status, 404, 'the original 404 is returned to the caller');
  assert.deepEqual(target.seen, ['/api/es-live/earthquakes'], 'no provider call on the aborted re-check');
  undo();
});

test('item6: no unhandled rejections and no leaked timers after abort + timeout paths', { timeout: 6000 }, async () => {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  // timeout path: the only config ask hangs; the ~50ms bounded timeout aborts it
  const target = scriptedTarget([]);
  const install = new AbortController();
  const caller = new AbortController();
  installEsLiveFetch({ target, doc: null, signal: install.signal, configTimeoutMs: 50 });
  await assert.rejects(
    target.fetch(USGS, { signal: caller.signal }),
    EsLiveConfigUnavailableError,
    'fail closed after the config timeout',
  );
  assert.equal(target.signals[0].aborted, true, 'the shared config ask was aborted by its own timeout');
  // everything settled: aborting now must not re-ask or re-hit the provider
  install.abort();
  caller.abort();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(target.signals.length, 1, 'no config re-ask after settle');
  assert.deepEqual(target.seen, [], 'no provider call via fallback or after settle');
  process.off('unhandledRejection', onUnhandled);
  assert.deepEqual(unhandled, [], 'the abandoned config chain must never surface as unhandled');
});

/* ---- existing hardening test, updated to the item-6 scope ---- */

test('hardening: a 404 from the redirected route makes the config be re-asked (and re-checked)', { timeout: 5000 }, async () => {
  let configFeeds = ['quakes'];
  const seen = [];
  const configCalls = { n: 0 };
  const target = {
    async fetch(input) {
      const href = typeof input === 'string' ? input : input.url;
      if (href === ES_LIVE_CONFIG_URL) {
        configCalls.n += 1;
        return new Response(JSON.stringify({ feeds: configFeeds }));
      }
      seen.push(href);
      return new Response('gone', { status: 404 });
    },
  };
  installEsLiveFetch({ target, doc: null });
  await target.fetch(USGS);
  assert.equal(configCalls.n, 2, 'config re-checked after a redirected 404');
  assert.deepEqual(seen, ['/api/es-live/earthquakes', '/api/es-live/earthquakes'], 'still listed, retried against fresh config, still 404');
  // server changed its mind: the re-check of this call sees feeds [] → the
  // ORIGINAL 404 is surfaced; a provider request must NOT go out
  configFeeds = [];
  const r = await target.fetch(USGS);
  assert.equal(configCalls.n, 3, 'the 404 dropped the cache and re-checked (cached ask + re-check)');
  assert.equal(r.status, 404, 'the original same-origin 404 is returned');
  assert.equal(seen.length, 3, 'only the redirected 404 re-check happened — no provider call');
});

/* ---- fail-closed sanitizer: no raw exception text ever reaches the caller ---- */

test('hardening: config-failure rejections never leak a raw exception message', { timeout: 5000 }, async () => {
  const rawTexts = ['network', 'config down', 'boot loader', 'Unexpected token', 'timeout exploded'];
  for (const config of [
    new Error('network'),
    503,
    '<html>boot loader</html>', // non-JSON 200
    { timeout: true },
    { abort: true },
  ]) {
    const target = {
      async fetch(input, init) {
        const href = typeof input === 'string' ? input : input.url;
        if (href === ES_LIVE_CONFIG_URL) {
          if (config.timeout || config.abort) {
            return new Promise((_, reject) => {
              init?.signal?.addEventListener('abort', () =>
                reject(
                  config.timeout
                    ? new Error('internal timeout exploded')
                    : new Error('caller reason exploded'),
                ),
              );
            });
          }
          if (typeof config === 'number') return new Response('{}', { status: config });
          return new Response(config, { status: 200 });
        }
        throw new Error('the provider must never be reached on this path');
      },
    };
    const undo = installEsLiveFetch({ target, doc: null, configTimeoutMs: 40 });
    await assert.rejects(target.fetch(USGS), (error) => {
      assert.ok(
        error instanceof EsLiveConfigUnavailableError,
        `expected the sanitized error, got ${error?.constructor?.name}: ${error?.message}`,
      );
      const text = `${error.name}: ${error.message}`;
      for (const s of rawTexts)
        assert.equal(text.includes(s), false, `leaked "${s}" in ${text}`);
      return true;
    });
    undo();
  }
});

test('item6: malformed JSON config shapes fail closed and are not cached', async () => {
  for (const body of [{}, { feeds: null }, { feeds: 'quakes' }, { feeds: [null] }, { feeds: ['quakes', false] }, null]) {
    let calls = 0; const seen = [];
    const target = { async fetch(input) {
      const href = typeof input === 'string' ? input : input.url;
      if (href === ES_LIVE_CONFIG_URL) { calls++; return new Response(JSON.stringify(body)); }
      seen.push(href); return new Response('unexpected');
    } };
    const undo = installEsLiveFetch({ target, doc: null });
    await assert.rejects(target.fetch(USGS), EsLiveConfigUnavailableError);
    await assert.rejects(target.fetch(USGS), EsLiveConfigUnavailableError);
    assert.equal(calls, 2); assert.deepEqual(seen, []); undo();
  }
});

test('redirected POST 404 gets the original same-origin 404 straight away: no recheck, no replay', async () => {
  const seen = []; let configCalls = 0;
  const target = { location: { href: 'http://localhost/' }, async fetch(input) {
    const href = typeof input === 'string' ? input : (input?.url ?? String(input));
    if (href === new URL(ES_LIVE_CONFIG_URL, target.location.href).href) { configCalls++; return new Response(JSON.stringify({ feeds: ['quakes'] })); }
    seen.push({ url: href, body: await input.text() }); return new Response('', { status: 404 });
  } };
  const undo = installEsLiveFetch({ target, doc: null });
  const req = new Request(USGS, { method: 'POST', body: 'fixture-payload' });
  const response = await target.fetch(req);
  assert.equal(response.status, 404);
  // a non-idempotent request is never replayed, so the re-check outcome
  // cannot change its answer: no second config ask on this request
  assert.equal(configCalls, 1, 'only the initial config ask (no recheck for POST)');
  assert.deepEqual(seen, [{ url: 'http://localhost/api/es-live/earthquakes', body: 'fixture-payload' }],
    'redirected once, body sent once, never replayed');
  undo();
});

test('redirected GET 404 retry cancels the dropped 404 body before the replay', { timeout: 5000 }, async () => {
  const firstForties = [];
  let configCalls = 0;
  const target = { async fetch(input) {
    const href = typeof input === 'string' ? input : input.url;
    if (href === ES_LIVE_CONFIG_URL) {
      configCalls += 1;
      return new Response(JSON.stringify({ feeds: ['quakes'] }));
    }
    if (!firstForties.length) {
      // a tracked body so the retry path can be observed cancelling it
      const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('gone')); c.close(); } });
      const res = new Response(stream, { status: 404 });
      firstForties.push(res);
      return res;
    }
    return new Response('ok');
  } };
  const undo = installEsLiveFetch({ target, doc: null });
  const retried = await target.fetch(USGS);
  assert.equal(retried.status, 200, 'the request was replayed against the fresh config');
  assert.equal(configCalls, 2, 'the 404 rechecked the config');
  // the same caller then consumed nothing of the dropped 404 either way:
  // its body was cancelled, not left dangling
  const first = firstForties[0];
  assert.equal(first.bodyUsed, true, 'the dropped 404 body was used (cancelled) before the retry');
  await first.body.cancel().catch(() => {});
  undo();
});

test('uninstall aborts every concurrent config harness, not only the latest one', { timeout: 5000 }, async () => {
  // ask 1 answers "listed"; two concurrent 404 rechecks share one ask that hangs;
  // uninstall must abort the shared hung harness
  const target = scriptedTarget([
    { feeds: ['quakes'] },
    HANG,
  ]);
  const undo = installEsLiveFetch({ target, doc: null, configTimeoutMs: 60_000 });
  const a = target.fetch(USGS);
  const b = target.fetch(USGS);
  // wait until both recheck asks are in flight
  for (let i = 0; i < 100 && target.signals.length < 2; i += 1)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(target.signals.length, 2, 'concurrent rechecks share a single config ask');
  undo(); // aborts every in-flight harness
  await Promise.allSettled([a, b]);
  assert.deepEqual(
    target.signals.map((s) => s.aborted),
    [false, true],
    'uninstall aborted all still-active config harnesses, not just the latest',
  );
});

test('a failed shared refresh is not cached for the next request', async () => {
  let calls = 0;
  const target = { async fetch(input) {
    const href = typeof input === 'string' ? input : input.url;
    if (href === ES_LIVE_CONFIG_URL) {
      calls++;
      if (calls === 2) throw new Error('refresh failed');
      return new Response(JSON.stringify({feeds:['quakes']}));
    }
    return new Response('gone', {status:404});
  }};
  const undo = installEsLiveFetch({target, doc:null});
  assert.equal((await target.fetch(USGS)).status, 404);
  assert.equal(calls, 2);
  assert.equal((await target.fetch(USGS)).status, 404);
  assert.equal(calls, 4);
  undo();
});

test('a 404 returned after config recheck failure retains its body', async () => {
  let calls = 0;
  const target = { async fetch(input) {
    if (input === ES_LIVE_CONFIG_URL) {
      if (++calls === 1) return new Response(JSON.stringify({feeds:['quakes']}));
      throw new Error('offline');
    }
    return new Response('original body', {status:404});
  }};
  const undo = installEsLiveFetch({target, doc:null});
  const response = await target.fetch(USGS);
  assert.equal(response.status,404);
  assert.equal(await response.text(),'original body');
  assert.equal(calls,2);
  undo();
});


test('a non-idempotent redirected 404 invalidates the cached config for the next request', async () => {
  let configCalls = 0;
  const target = { async fetch(input) {
    const href = typeof input === 'string' ? input : input.url;
    if (href === ES_LIVE_CONFIG_URL) {
      configCalls++;
      return new Response(JSON.stringify({ feeds: ['quakes'] }));
    }
    return new Response('gone', { status: 404 });
  }};
  const undo = installEsLiveFetch({target, doc:null});
  await target.fetch(USGS, {method:'POST'});
  assert.equal(configCalls, 1);
  await target.fetch(USGS, {method:'POST'});
  assert.equal(configCalls, 2);
  undo();
});
