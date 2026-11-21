// Before/after gate for the bottom-right map controls (language picker,
// navigation control and tilt slider, Sky). The strict table of
// scripts/qa-locale-placement.mjs lists every collision it sees, including
// ones the shipped layout already has; this gate fails only on what a change
// ADDS. A case fails when the candidate shows a finding involving the
// language picker, the nav control or Sky that the baseline does not show in
// the same case. Findings that already exist in the baseline, and controls
// covered by a popup the case deliberately opened (the language list, the Sky
// panel), are allowed and listed.
//
//   node scripts/qa-locale-delta.mjs --base DIR [--out FILE]
//     runs the harness on DIR (a checkout of the baseline, e.g. the live
//     commit) and on this checkout, then compares them
//   node scripts/qa-locale-delta.mjs --base-json A.json --candidate-json B.json
//     compares two saved harness runs (--json output)
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Text that names the language picker, the nav control or Sky. */
const CONTROL =
  /locale-picker|#corner-actions|nav:|#gev-nav-control|\.gev-nav|sky/;

/**
 * Whether one finding involves the controls this gate owns. Every finding
 * that is not a `hit:` check is about the picker itself (its overlaps, its
 * visibility, its list); a `hit:A=>B` check counts when A or B is one of them.
 * @param {string} finding
 */
export function involvesControls(finding) {
  if (!finding.startsWith('hit:')) return true;
  return CONTROL.test(finding);
}

/**
 * Whether a finding is a control covered by a popup the case opened on
 * purpose: the open language list, or the open Sky panel.
 * @param {string} finding
 * @param {{picker: boolean, sky: boolean}} opened
 */
export function coveredByOpenPopup(finding, opened) {
  const hit = /^hit:.*=>(.*)$/.exec(finding);
  if (!hit) return false;
  const by = hit[1];
  if (opened.picker && /locale-picker/.test(by)) return true;
  if (opened.sky && /sky/.test(by)) return true;
  return false;
}

/** `{picker, sky}` from a case name such as `... sky=1 picker=0`. */
export function openedIn(caseName) {
  return {
    picker: /\bpicker=1\b/.test(caseName),
    sky: /\bsky=1\b/.test(caseName),
  };
}

/**
 * Compare a baseline run with a candidate run, case by case.
 * @param {{case: string, failures: string[]}[]} baseline
 * @param {{case: string, failures: string[]}[]} candidate
 */
export function compareRuns(baseline, candidate) {
  const before = new Map(baseline.map((row) => [row.case, row.failures]));
  const rows = [];
  const missing = [];
  for (const row of candidate) {
    const base = before.get(row.case);
    if (!base) {
      missing.push(row.case);
      continue;
    }
    const baseSet = new Set(base);
    const opened = openedIn(row.case);
    const regressions = [];
    const allowed = [];
    for (const finding of row.failures) {
      if (!involvesControls(finding)) continue;
      if (baseSet.has(finding)) allowed.push(`baseline: ${finding}`);
      else if (coveredByOpenPopup(finding, opened))
        allowed.push(`open popup: ${finding}`);
      else regressions.push(finding);
    }
    const fixed = base.filter(
      (finding) => involvesControls(finding) && !row.failures.includes(finding),
    );
    rows.push({ case: row.case, regressions, allowed, fixed });
  }
  for (const name of before.keys())
    if (!candidate.some((row) => row.case === name)) missing.push(name);
  return {
    rows,
    missing,
    regressions: rows.reduce((sum, row) => sum + row.regressions.length, 0),
    failedCases: rows.filter((row) => row.regressions.length).length,
  };
}

/** One printable line per case, then a summary. */
export function formatComparison(result) {
  const lines = result.rows.map(
    (row) =>
      `${row.regressions.length ? 'FAIL' : 'PASS'} | ${row.case} | new: ${
        row.regressions.join('; ') || '-'
      } | allowed: ${row.allowed.length} | fixed: ${row.fixed.length}`,
  );
  for (const name of result.missing)
    lines.push(`FAIL | ${name} | missing case`);
  const fixed = result.rows.reduce((sum, row) => sum + row.fixed.length, 0);
  const allowed = result.rows.reduce((sum, row) => sum + row.allowed.length, 0);
  lines.push(
    `DELTA SUMMARY ${result.rows.length - result.failedCases} pass, ${result.failedCases + result.missing.length} fail, ${result.rows.length + result.missing.length} cases; ${result.regressions} new findings, ${allowed} allowed (baseline or open popup), ${fixed} baseline findings fixed`,
  );
  return lines.join('\n');
}

function runHarness(rootDir, jsonFile) {
  const harness = fileURLToPath(
    new URL('./qa-locale-placement.mjs', import.meta.url),
  );
  const result = spawnSync(
    process.execPath,
    [harness, '--root', rootDir, '--json', jsonFile],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  // 0 = every strict case passed, 1 = strict findings (expected), 2 = error.
  if (result.status !== 0 && result.status !== 1)
    throw new Error(`harness failed on ${rootDir}`);
  return JSON.parse(readFileSync(jsonFile, 'utf8'));
}

function main(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) options[argv[i]] = argv[i + 1];
  let baseline;
  let candidate;
  if (options['--base-json'] && options['--candidate-json']) {
    baseline = JSON.parse(readFileSync(options['--base-json'], 'utf8'));
    candidate = JSON.parse(readFileSync(options['--candidate-json'], 'utf8'));
  } else if (options['--base']) {
    const work = mkdtempSync(path.join(tmpdir(), 'qa-locale-delta-'));
    baseline = runHarness(
      path.resolve(options['--base']),
      path.join(work, 'base.json'),
    );
    candidate = runHarness(
      fileURLToPath(new URL('../', import.meta.url)),
      path.join(work, 'candidate.json'),
    );
  } else {
    console.error(
      'Usage: node scripts/qa-locale-delta.mjs --base DIR [--out FILE] | --base-json A --candidate-json B',
    );
    return 2;
  }
  const result = compareRuns(baseline, candidate);
  const text = formatComparison(result);
  console.log(text);
  if (options['--out']) writeFileSync(options['--out'], `${text}\n`);
  return result.failedCases || result.missing.length ? 1 : 0;
}

const invoked = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invoked) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(String(error?.message || error).slice(0, 300));
    process.exitCode = 2;
  }
}
