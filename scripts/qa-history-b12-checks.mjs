/**
 * Fail-closed verdicts of the B12 umbrella browser QA
 * (scripts/qa-history-b12.mjs, card t_5aa880c7; hardening t_3ae4aec7).
 * Pure functions over what the browser run recorded, so each check has
 * executable negative and control cases (src/tooling/historyB12Qa.test.mjs)
 * without a browser.
 */

/** The acceptance run: 10 min of wall clock at 60x (DESIGN 6 B12). */
export const ACCEPTANCE = Object.freeze({ minutes: 10, rate: 60 });

/**
 * Every registered layer must end up enabled, with no enable error. Returns
 * the problems (empty = pass). A layer that is enabled although its enable
 * call threw or timed out is still a problem: the run did not prove it.
 */
export function layerEnableProblems({
  registered = [],
  enabled = [],
  enableErrors = {},
} = {}) {
  const problems = [];
  const on = new Set(enabled);
  const known = new Set(registered);
  const errs = enableErrors ?? {};
  if (!registered.length) problems.push('no layer registered');
  for (const id of registered)
    if (!on.has(id))
      problems.push(
        `${id}: registered but not enabled${errs[id] != null ? ` (${errs[id]})` : ''}`,
      );
  for (const [id, err] of Object.entries(errs))
    if (on.has(id) || !known.has(id))
      problems.push(`${id}: enable error (${err})`);
  for (const id of on)
    if (!known.has(id)) problems.push(`${id}: enabled but not registered`);
  return problems;
}

/**
 * The timed /api/history requests that failed. Any HTTP status outside
 * 200-399 fails (a 400/403/404/429 is a failure even when its group has
 * other successes), as does a network failure or a request that finished
 * without a status. A request the page cancelled itself (a superseded
 * prefetch) is not a failure unless it had already been answered >= 400.
 */
export function failedHistoryRequests(frames = []) {
  return frames.filter((f) => {
    const status = typeof f.status === 'number' ? f.status : null;
    if (status != null && status >= 400) return true;
    if (f.canceled) return false;
    if (f.failed) return true;
    return status == null || status < 200;
  });
}

/**
 * Samples at which playback had stopped although nobody paused it. Every
 * one fails the run; the QA may resume to keep measuring, but a resumed
 * stop is still a failure.
 */
export function unexpectedStops(samples = []) {
  return samples.filter((s) => s.playing !== true);
}

/**
 * Why a run is diagnostic rather than acceptance (empty = acceptance run).
 * The flags stay usable for diagnosis, but such a run never PASSes.
 */
export function diagnosticReasons({
  skipPlayback = false,
  disable = [],
  noSelect = false,
  minutes = ACCEPTANCE.minutes,
  rate = ACCEPTANCE.rate,
} = {}) {
  const why = [];
  if (skipPlayback) why.push('--skip-playback');
  if (disable.length) why.push(`--disable ${disable.join(',')}`);
  if (noSelect) why.push('--no-select');
  if (!(minutes >= ACCEPTANCE.minutes))
    why.push(`--minutes ${minutes} (< ${ACCEPTANCE.minutes})`);
  if (rate !== ACCEPTANCE.rate)
    why.push(`--rate ${rate} (not ${ACCEPTANCE.rate})`);
  return why;
}

/**
 * The run's verdict: FAIL (exit 1) on any failed check; DIAGNOSTIC (exit 2)
 * when every check passed but a diagnostic flag was used; PASS (exit 0)
 * only for a clean acceptance run.
 */
export function verdict({ failures = [], diagnostic = [] } = {}) {
  if (failures.length)
    return {
      status: 'FAIL',
      acceptance: false,
      exitCode: 1,
      line: `QA B12 FAIL (${failures.length})${diagnostic.length ? ` [diagnostic run: ${diagnostic.join('; ')}]` : ''}`,
    };
  if (diagnostic.length)
    return {
      status: 'DIAGNOSTIC',
      acceptance: false,
      exitCode: 2,
      line: `QA B12 DIAGNOSTIC - checks passed but NOT acceptance (${diagnostic.join('; ')})`,
    };
  return { status: 'PASS', acceptance: true, exitCode: 0, line: 'QA B12 PASS' };
}
