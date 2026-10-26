import assert from 'node:assert/strict';
import test from 'node:test';
import { createGhostMapsSource } from './source.js';

const SECRET = 'Bearer synth-token-9f3a7c21';
const USERINFO = 'https://user:synth-pass-77@evil.example/x';

function response(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => text,
    body: null,
  };
}

function dumped(error) {
  return [error.name, error.message, error.stack, JSON.stringify(error)].join(
    '\n',
  );
}

test('archive fetch failures do not echo the request, the body or a foreign error', async () => {
  const source = createGhostMapsSource({
    fetchImpl: async (url) => {
      if (String(url).includes('/at/file/'))
        return response(503, { error: SECRET, url: USERINFO });
      const error = new Error(`fetch failed ${url} ${USERINFO}`);
      error.cause = new Error(SECRET);
      throw error;
    },
  });
  await assert.rejects(
    source.getCatalogAt(Date.parse('2026-10-17T00:00:00Z')),
    (error) => {
      const text = dumped(error);
      assert.equal(text.includes(SECRET), false);
      assert.equal(text.includes(USERINFO), false);
      assert.equal(text.includes('synth-pass-77'), false);
      assert.equal(text.includes('9f3a7c21'), false);
      assert.match(error.message, /^GhostMaps archive unavailable$/);
      return true;
    },
  );
  await assert.rejects(
    source.getFileAt('cip', 'a'.repeat(40), 'b'.repeat(40)),
    (error) => {
      const text = dumped(error);
      assert.equal(text.includes(SECRET), false);
      assert.equal(text.includes(USERINFO), false);
      assert.match(error.message, /^GhostMaps file unavailable \(HTTP 503\)$/);
      return true;
    },
  );
});

test('a hostile catalog body is a malformed catalog, not echoed', async () => {
  const source = createGhostMapsSource({
    fetchImpl: async () => response(200, SECRET),
  });
  await assert.rejects(
    source.getCatalogAt(Date.parse('2026-10-17T00:00:00Z')),
    (error) => {
      assert.equal(dumped(error).includes(SECRET), false);
      assert.equal(dumped(error).includes('9f3a7c21'), false);
      assert.equal(error.message, 'Malformed GhostMaps catalog');
      return true;
    },
  );
});
