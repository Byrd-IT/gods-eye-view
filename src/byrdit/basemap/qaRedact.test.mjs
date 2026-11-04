import assert from 'node:assert/strict';
import test from 'node:test';
import { makeNaipRedactors, safeUrl } from '../../../scripts/qa-naip-compare-redact.mjs';

const TOKEN = 'sk_synthetic_Zq81mXw4';
const PASS = 'p4ssSynth9';
const BASE = `https://qauser:${PASS}@host.example:4173/?api_key=${TOKEN}`;
const leaks = (text) =>
  [TOKEN, PASS, TOKEN.slice(0, 8), TOKEN.slice(-6), encodeURIComponent(TOKEN)].filter(
    (v) => String(text).includes(v),
  );

test('a navigation error that echoes the --url is masked, whole and in part', () => {
  const { scrub, redact } = makeNaipRedactors(BASE);
  const err = new Error(`net::ERR_CONNECTION_REFUSED at ${BASE}/ (token ${TOKEN})`);
  assert.deepEqual(leaks(scrub(err.message)), []);
  assert.deepEqual(leaks(redact(err.stack)), []);
});

test('page errors lose headers, bearer tokens and bare tokens', () => {
  const { redact } = makeNaipRedactors('http://127.0.0.1:4392');
  const out = redact(
    `Error: Authorization: Bearer ${TOKEN}\nX-Api-Key: ${TOKEN}\nfetch https://u:${PASS}@h.example/p?key=${TOKEN}#t=${TOKEN} ${TOKEN}`,
  );
  assert.deepEqual(leaks(out), []);
});

test('our own lines keep long selectors readable', () => {
  const { scrub } = makeNaipRedactors('http://127.0.0.1:4392');
  assert.equal(scrub('#gev-naip-split-line spans'), '#gev-naip-split-line spans');
});

test('safeUrl keeps origin and path only', () => {
  const out = safeUrl(`https://u:${PASS}@host.example/a/b?api_key=${TOKEN}#${TOKEN}`);
  assert.equal(out, 'https://host.example/a/b');
  assert.equal(safeUrl('not a url'), '(unparsable url)');
});
