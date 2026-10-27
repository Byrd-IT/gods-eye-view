import assert from 'node:assert/strict';
import test from 'node:test';
import {
  makeRedactor,
  urlSecrets,
} from '../../../scripts/qa-map-clear-view-redact.mjs';

// Synthetic values only.
const PASS = 'qaFakePass_ZZ9QX7';
const TOKEN = 'qaFakeToken_K3J8W2';
const KEY = 'qaFakeKey_P0M5N1';

test('qa-map-clear-view masks --url userinfo and query values everywhere', () => {
  const url = `https://qauser:${PASS}@127.0.0.1:4999/?api_key=${KEY}&t=${TOKEN}`;
  const redact = makeRedactor(urlSecrets(url));
  const crash = `Error: net::ERR_CONNECTION_REFUSED at ${url}\n  detail ${JSON.stringify({ k: KEY, t: encodeURIComponent(TOKEN), p: PASS })}`;
  const out = redact(crash);
  for (const secret of [PASS, TOKEN, KEY]) {
    assert.ok(!out.includes(secret), 'verbatim');
    assert.ok(!out.includes(secret.slice(0, 8)), 'prefix');
    assert.ok(!out.includes(secret.slice(-6)), 'suffix');
  }
  assert.match(out, /\/\/\*\*\*@127\.0\.0\.1:4999\/\?\*\*\*/);
});

test('qa-map-clear-view keeps the map hash state readable', () => {
  const redact = makeRedactor(urlSecrets('http://127.0.0.1:4371'));
  const hash = '#v=2&lat=30.2672&lon=-97.7431&alt=600';
  assert.equal(redact(hash), hash);
  assert.deepEqual(urlSecrets('not a url'), []);
});
