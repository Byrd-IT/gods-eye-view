import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  ACCEPTANCE,
  diagnosticReasons,
  failedHistoryRequests,
  layerEnableProblems,
  unexpectedStops,
  verdict,
} from '../../scripts/qa-history-b12-checks.mjs';

const SCRIPT = readFileSync(
  new URL('../../scripts/qa-history-b12.mjs', import.meta.url),
  'utf8',
);

// ── 1. every registered layer enabled ───────────────────────

test('enable check: control - every registered layer enabled, no error', () => {
  const ids = ['flights', 'vessels', 'quakes'];
  assert.deepEqual(
    layerEnableProblems({ registered: ids, enabled: [...ids].reverse() }),
    [],
  );
  assert.deepEqual(
    layerEnableProblems({ registered: ids, enabled: ids, enableErrors: {} }),
    [],
  );
});

test('enable check: a registered layer left disabled fails, with its error', () => {
  const problems = layerEnableProblems({
    registered: ['flights', 'vessels', 'quakes'],
    enabled: ['flights', 'quakes'],
    enableErrors: { vessels: 'timeout' },
  });
  assert.deepEqual(problems, ['vessels: registered but not enabled (timeout)']);
});

test('enable check: a silently disabled layer (no error) still fails', () => {
  assert.deepEqual(
    layerEnableProblems({ registered: ['a', 'b'], enabled: ['a'] }),
    ['b: registered but not enabled'],
  );
});

test('enable check: an enable error fails even when the layer came up', () => {
  assert.deepEqual(
    layerEnableProblems({
      registered: ['a', 'b'],
      enabled: ['a', 'b'],
      enableErrors: { b: 'boom' },
    }),
    ['b: enable error (boom)'],
  );
});

test('enable check: same count but a different set fails', () => {
  const problems = layerEnableProblems({
    registered: ['a', 'b'],
    enabled: ['a', 'ghost'],
  });
  assert.deepEqual(problems, [
    'b: registered but not enabled',
    'ghost: enabled but not registered',
  ]);
});

test('enable check: nothing registered fails closed', () => {
  assert.deepEqual(layerEnableProblems({ registered: [], enabled: [] }), [
    'no layer registered',
  ]);
  assert.deepEqual(layerEnableProblems(), ['no layer registered']);
});

// ── 2. HTTP / network failures during playback ──────────────

const ok = (status = 200, extra = {}) => ({ status, ms: 10, ...extra });

test('request check: control - 200/204/304 and own cancellations pass', () => {
  const frames = [
    ok(200),
    ok(204),
    ok(304),
    { failed: 'net::ERR_ABORTED', canceled: true },
    { status: 200, failed: 'net::ERR_ABORTED', canceled: true },
  ];
  assert.deepEqual(failedHistoryRequests(frames), []);
});

for (const status of [400, 401, 403, 404, 429, 500, 503])
  test(`request check: HTTP ${status} fails even beside successes`, () => {
    const bad = ok(status);
    const frames = [ok(), ok(), ok(), bad, ok()];
    assert.deepEqual(failedHistoryRequests(frames), [bad]);
  });

test('request check: a cancelled request already answered 4xx still fails', () => {
  const bad = { status: 404, failed: 'net::ERR_ABORTED', canceled: true };
  assert.deepEqual(failedHistoryRequests([ok(), bad]), [bad]);
});

test('request check: network failure, missing or bogus status fail closed', () => {
  const net = { failed: 'net::ERR_CONNECTION_RESET', canceled: false };
  const none = { ms: 5 };
  const zero = ok(0);
  const info = ok(101);
  assert.deepEqual(failedHistoryRequests([ok(), net, none, zero, info]), [
    net,
    none,
    zero,
    info,
  ]);
});

// ── 3. playback stopping by itself ──────────────────────────

test('stop check: control - every sample playing', () => {
  const samples = [1, 2, 3].map((i) => ({ wallS: i * 15, playing: true }));
  assert.deepEqual(unexpectedStops(samples), []);
});

test('stop check: one stopped sample fails even if playback resumed after', () => {
  const stopped = { wallS: 30, playing: false };
  const samples = [
    { wallS: 15, playing: true },
    stopped,
    { wallS: 45, playing: true },
  ];
  assert.deepEqual(unexpectedStops(samples), [stopped]);
});

test('stop check: an unknown playing state fails closed', () => {
  const unknown = { wallS: 15 };
  assert.deepEqual(unexpectedStops([unknown, { playing: true }]), [unknown]);
});

// ── diagnostic runs are never acceptance ────────────────────

test('diagnostic: control - the default 10 min at 60x is acceptance', () => {
  assert.deepEqual(ACCEPTANCE, { minutes: 10, rate: 60 });
  assert.deepEqual(diagnosticReasons(), []);
  assert.deepEqual(diagnosticReasons({ minutes: 12, rate: 60 }), []);
  assert.deepEqual(verdict({ failures: [], diagnostic: [] }), {
    status: 'PASS',
    acceptance: true,
    exitCode: 0,
    line: 'QA B12 PASS',
  });
});

test('diagnostic: every diagnostic flag is named and blocks PASS', () => {
  const why = diagnosticReasons({
    skipPlayback: true,
    disable: ['vessels', 'firms'],
    noSelect: true,
    minutes: 2,
    rate: 120,
  });
  assert.deepEqual(why, [
    '--skip-playback',
    '--disable vessels,firms',
    '--no-select',
    '--minutes 2 (< 10)',
    '--rate 120 (not 60)',
  ]);
  for (const one of [
    { skipPlayback: true },
    { disable: ['x'] },
    { noSelect: true },
    { minutes: 9.9 },
    { minutes: Number.NaN },
    { rate: 30 },
    { rate: Number.NaN },
  ]) {
    const d = diagnosticReasons(one);
    assert.equal(d.length, 1, JSON.stringify(one));
    const v = verdict({ failures: [], diagnostic: d });
    assert.equal(v.status, 'DIAGNOSTIC');
    assert.equal(v.acceptance, false);
    assert.notEqual(v.exitCode, 0);
    assert.match(v.line, /NOT acceptance/);
  }
});

test('verdict: failures win over a diagnostic run and exit 1', () => {
  const v = verdict({ failures: ['x'], diagnostic: ['--no-select'] });
  assert.equal(v.status, 'FAIL');
  assert.equal(v.acceptance, false);
  assert.equal(v.exitCode, 1);
  assert.match(v.line, /^QA B12 FAIL \(1\) \[diagnostic run: --no-select\]$/);
  assert.equal(verdict({ failures: ['a', 'b'] }).line, 'QA B12 FAIL (2)');
});

// ── the browser QA actually uses these checks ───────────────

test('wiring: qa-history-b12.mjs gates on all three checks and the verdict', () => {
  assert.match(SCRIPT, /from '\.\/qa-history-b12-checks\.mjs'/);
  assert.match(SCRIPT, /layerEnableProblems\(\{/);
  assert.match(SCRIPT, /failedHistoryRequests\(played\)/);
  assert.match(SCRIPT, /unexpectedStops\(samples\)/);
  assert.match(SCRIPT, /diagnosticReasons\(\{/);
  assert.match(SCRIPT, /process\.exit\(outcome\.exitCode\)/);
  // the old >= 500-only filter and the bare pass/fail exit are gone
  assert.doesNotMatch(SCRIPT, /status >= 500/);
  assert.doesNotMatch(SCRIPT, /process\.exit\(failures\.length/);
});

test('wiring: recorded percentiles, bringToFront and canvas readback kept', () => {
  assert.match(SCRIPT, /p95: pct\(ms, 95\)/);
  assert.match(SCRIPT, /missP95: pct\(/);
  assert.match(SCRIPT, /await page\.bringToFront\(\);/);
  assert.match(SCRIPT, /getElementById\('world-overlay-canvas'\)/);
  assert.match(SCRIPT, /c\.toDataURL\('image\/png'\)/);
  assert.match(SCRIPT, /-overlay\.png/);
});
