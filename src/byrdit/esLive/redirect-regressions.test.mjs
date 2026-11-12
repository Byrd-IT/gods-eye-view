import test from 'node:test';
import assert from 'node:assert/strict';
import { installEsLiveFetch } from './clientRedirect.js';
const source =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
test('config and redirected requests ignore a cross-origin base element', async () => {
  const seen = [];
  const target = {
    location: { href: 'https://gev.example/page' },
    async fetch(input) {
      const url = typeof input === 'string' ? input : input.url;
      const resolved = new URL(url, 'https://evil.example/').href;
      seen.push(resolved);
      if (resolved.endsWith('/config'))
        return new Response(JSON.stringify({ feeds: ['quakes'] }));
      return new Response('ok');
    },
  };
  const undo = installEsLiveFetch({
    target,
    doc: { baseURI: 'https://evil.example/' },
  });
  await target.fetch(source);
  await target.fetch(new Request(source));
  assert.deepEqual(seen, [
    'https://gev.example/api/es-live/config',
    'https://gev.example/api/es-live/earthquakes',
    'https://gev.example/api/es-live/earthquakes',
  ]);
  undo();
});
test('simultaneous 404s share a single refresh and late 404 cannot invalidate newer config', async () => {
  let asks = 0,
    routes = 0;
  const delayed = deferred();
  const refresh = deferred();
  const target = {
    async fetch(input) {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/config')) {
        asks++;
        if (asks === 2) await refresh.promise;
        return new Response(JSON.stringify({ feeds: ['quakes'] }));
      }
      routes++;
      if (routes === 1) await delayed.promise;
      if (routes <= 3) return new Response('gone', { status: 404 });
      return new Response('ok');
    },
  };
  const undo = installEsLiveFetch({ target, doc: null });
  const one = target.fetch(source);
  while (routes < 1) await new Promise((r) => setTimeout(r, 1));
  const two = target.fetch(source);
  const three = target.fetch(source);
  while (asks < 2) await new Promise((r) => setTimeout(r, 1));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(asks, 2, 'concurrent 404s must coalesce');
  refresh.resolve();
  await Promise.all([two, three]);
  delayed.resolve();
  await one;
  assert.equal(asks, 2, 'late old 404 must reuse current config');
  undo();
});
