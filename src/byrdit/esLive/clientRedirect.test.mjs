import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ES_LIVE_CONFIG_URL,
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
  for (const config of [404, { feeds: [] }, { feeds: ['gnss'] }, { nope: 1 }]) {
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

test('install: if the server cannot be asked the request goes to the provider and the question is repeated', async () => {
  for (const config of [new Error('network'), 503]) {
    const f = fakeTarget(config);
    installEsLiveFetch({ target: f.target, doc: null });
    await f.target.fetch(USGS);
    await f.target.fetch(USGS);
    assert.deepEqual(f.seen, [USGS, USGS]);
    assert.equal(f.configCalls(), 2, 'asked again next time');
  }
});

test('install: a Request input for a listed URL is redirected with its method and headers', async () => {
  const seen = [];
  const target = {
    async fetch(input) {
      if (input === ES_LIVE_CONFIG_URL)
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
