#!/usr/bin/env node
/**
 * Gate for the history recorder (server/history/recorder). No browser and no
 * network: it drives the real /api/firms handler with a stubbed upstream, the
 * real recorder and a real SQLite file in a scratch directory.
 *
 *   npm run qa:history-recorder
 *   node scripts/qa-history-recorder.mjs --json   (machine-readable report)
 *
 * Proves:
 *   1. off by default: no HISTORY_RECORD, no store opened, no file created
 *   2. the tee end to end: a refresh through /api/firms lands in the store, and
 *      the client's response is byte-identical to the one with recording off
 *   3. a repeat refresh of the same detections writes no new rows but is logged
 *   4. a failing store never reaches the response, and a dead upstream is logged
 *      as a failed poll
 *   5. tapping a world-sized payload (130k detections) stays within a time budget
 *      and a full queue drops the oldest poll and counts it
 *   5b. a 130k-detection flush into the real store never stalls the event loop for long
 *   6. a synthetic secret (the FIRMS key, a bearer token, userinfo, a query
 *      key) appears in no stored byte, no warning and no response
 *   7. unsupported settings stop the boot before a file is created
 * Exits non-zero on the first failed check; the report names each check.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createHistoryRuntime } from '../server/history/runtime.js';
import { firmsProxy } from '../server/providers/firms.js';
import { NOOP_RECORDER, createRecorder } from '../server/history/recorder/index.js';
import { ADAPTERS } from '../server/history/recorder/adapters/index.js';

const SCALE = Number(process.env.GEV_QA_BUDGET_SCALE) > 0 ? Number(process.env.GEV_QA_BUDGET_SCALE) : 1;
const TAP_BUDGET_MS = 1500 * SCALE;
const STALL_BUDGET_MS = 750 * SCALE;
const checks = [];
const json = process.argv.includes('--json');
function record(name, ok, detail) {
  checks.push({ name, ok, detail });
  if (!json) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
}

const nonce = randomBytes(6).toString('hex');
const SECRETS = {
  mapKey: `FIRMSKEY${nonce}`,
  bearer: `Bearer BEARER${nonce}TAIL${nonce.slice(0, 4)}`,
  userinfo: `https://user${nonce}:pass${nonce}@example.test/`,
  queryKey: `api_key=QUERY${nonce}`,
};

const realNow = Date.now.bind(Date);
let clock = realNow();
Date.now = () => clock;

// Detections keep their acquisition time across refreshes, as the real feed does.
const ACQUIRED = new Date(clock - 3600_000);

function csvAt(count, offset = 0, extra = '') {
  const when = ACQUIRED;
  const date = when.toISOString().slice(0, 10);
  const time = String(when.getUTCHours()) + String(when.getUTCMinutes()).padStart(2, '0');
  const lines = ['latitude,longitude,acq_date,acq_time,confidence,frp,satellite,instrument'];
  for (let i = 0; i < count; i += 1) {
    const n = offset + i;
    const lat = ((n * 7919) % 17000) / 100 - 85;
    const lon = (Math.floor(n / 17000) * 11 + ((n * 104729) % 35000) / 100) % 179;
    lines.push(`${lat.toFixed(4)},${(lon - 89).toFixed(4)},${date},${time},h,${(n % 50) + 1},N20,VIIRS${extra}`);
  }
  return `${lines.join('\n')}\n`;
}

let upstream = () => new Response('offline', { status: 503 });
const urls = [];
globalThis.fetch = async (raw) => {
  urls.push(String(raw));
  return upstream(String(raw));
};

function handlerFor(plugin) {
  let handler;
  plugin.configureServer({ middlewares: { use: (_route, fn) => (handler = fn) } });
  return async (url = '/') => {
    const res = {
      headersSent: false,
      writeHead(status) {
        Object.assign(this, { status, headersSent: true });
      },
      end(body) {
        this.body = body;
      },
    };
    await handler({ url, method: 'GET', headers: {}, socket: {} }, res);
    return res;
  };
}

/** A new proxy starts from the previous one's disk cache unless that is cleared. */
function freshProxy(directory, recorder) {
  rmSync(path.join(directory, '.gev-cache'), { recursive: true, force: true });
  return handlerFor(firmsProxy({ recorder }));
}

function allBytes(directory) {
  return readdirSync(directory)
    .filter((name) => name.startsWith('h.sqlite'))
    .map((name) => readFileSync(path.join(directory, name)).toString('latin1'))
    .join('');
}

async function main() {
  const directory = mkdtempSync(path.join(tmpdir(), 'gev-qa-recorder-'));
  const home = process.cwd();
  process.chdir(directory); // firmsProxy writes its disk cache under the working directory
  process.env.FIRMS_MAP_KEY = SECRETS.mapKey;
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try {
    const file = path.join(directory, 'h.sqlite');
    const sqliteEnv = { HISTORY_SQLITE_PATH: file };

    // 1. off by default
    const off = createHistoryRuntime(sqliteEnv);
    record('off by default', off.recorder === NOOP_RECORDER && off.store === null && !existsSync(file), 'no store opened, no file created');

    // 2. tee end to end, response identical to the non-recording one
    upstream = (url) => new Response(url.includes('VIIRS_NOAA20') ? csvAt(500) : csvAt(0));
    const plain = await freshProxy(directory, NOOP_RECORDER)();
    const on = createHistoryRuntime({ ...sqliteEnv, HISTORY_RECORD: '1' });
    const request = freshProxy(directory, on.recorder);
    const first = await request();
    await on.recorder.flush();
    const coverage = await on.store.coverage('firms');
    const slice = await on.store.slice('firms', { t: clock, windowMs: 6 * 3600_000 });
    const identical = JSON.stringify({ ...JSON.parse(first.body), fetchedAt: 0 }) === JSON.stringify({ ...JSON.parse(plain.body), fetchedAt: 0 });
    record('tee end to end', first.status === 200 && coverage.count === 500 && slice.observations.length === 500, `${coverage.count} detections stored from one refresh`);
    record('response identical with recording on or off', identical);

    // 3. repeat refresh
    clock += 31 * 60_000;
    await request();
    await on.recorder.flush();
    const after = await on.store.coverage('firms');
    const polls = (await on.store.ingestLog('firms')).polls;
    record('repeat refresh adds no rows but is logged', after.count === 500 && polls.length === 2 && polls.every((p) => p.ok), `${after.count} rows, ${polls.length} polls`);

    // 4. store failure and dead upstream
    const broken = createRecorder({
      store: { async append() { throw Object.assign(new Error('disk full /srv/x'), { code: 'BACKEND' }); }, async recordIngest() {} },
      config: { feeds: { firms: { record: true, minIntervalMs: 0 } }, queueRows: 10_000, flushMs: 5000 },
      adapters: ADAPTERS,
      warn: (message) => warnings.push(message),
    });
    clock += 31 * 60_000;
    // Fresh plugin: its own cache, so this is a real refresh.
    const withBroken = freshProxy(directory, broken);
    const brokenResponse = await withBroken();
    await broken.flush();
    record('store failure never reaches the response', brokenResponse.status === 200 && broken.health().failedFlushes === 1);
    clock += 31 * 60_000;
    upstream = () => new Response('offline', { status: 503 });
    const stale = await request();
    await on.recorder.flush();
    const lastPoll = (await on.store.ingestLog('firms')).polls.at(-1);
    record('dead upstream is logged as a failed poll', JSON.parse(stale.body).stale === true && lastPoll.ok === false && lastPoll.count === 0);

    // 5. world-sized payload and overflow
    const payload = { fires: JSON.parse(JSON.stringify(Array.from({ length: 130_000 }, (_, i) => ({ lat: ((i * 7919) % 17000) / 100 - 85, lon: ((i * 104729) % 35000) / 100 - 175, frp: i % 50, confidence: 'h', brightness: 300, brightnessTi5: 290, daynight: 'D', acqDate: '2026-10-31', acqTime: '1130', satellite: 'N20', instrument: 'VIIRS' })))) };
    const big = createRecorder({
      store: { async append() {}, async recordIngest() {} },
      config: { feeds: { firms: { record: true, minIntervalMs: 0 } }, queueRows: 200_000, flushMs: 5000 },
      adapters: ADAPTERS,
      warn() {},
    });
    const start = process.hrtime.bigint();
    const result = big.tap('firms', payload);
    const took = Number(process.hrtime.bigint() - start) / 1e6;
    record('tap of 130k detections within budget', took <= TAP_BUDGET_MS && result.queued > 0, `${took.toFixed(0)} ms of ${TAP_BUDGET_MS}, ${result.queued} rows queued`);
    const small = createRecorder({
      store: { async append() {}, async recordIngest() {} },
      config: { feeds: { firms: { record: true, minIntervalMs: 0 } }, queueRows: 1_000, flushMs: 5000 },
      adapters: ADAPTERS,
      warn() {},
    });
    const tenth = { fires: payload.fires.slice(0, 600) };
    const other = { fires: payload.fires.slice(600, 1200) };
    small.tap('firms', tenth);
    small.tap('firms', other);
    record('a full queue drops the oldest poll and counts it', small.health().dropped === 600 && small.health().queueRows === 600, `${small.health().dropped} dropped`);

    // 5b. a world-sized flush into the real store must not stall the event loop
    const flushDir = mkdtempSync(path.join(tmpdir(), 'gev-qa-flush-'));
    const flushRuntime = createHistoryRuntime({ HISTORY_RECORD: '1', HISTORY_SQLITE_PATH: path.join(flushDir, 'f.sqlite'), HISTORY_RECORD_QUEUE_ROWS: '200000' });
    flushRuntime.recorder.tap('firms', payload);
    let worst = 0;
    let last = process.hrtime.bigint();
    const watcher = setInterval(() => {
      const now = process.hrtime.bigint();
      worst = Math.max(worst, Number(now - last) / 1e6);
      last = now;
    }, 1);
    const flushStart = process.hrtime.bigint();
    await flushRuntime.recorder.flush();
    const flushMs = Number(process.hrtime.bigint() - flushStart) / 1e6;
    clearInterval(watcher);
    const stored = (await flushRuntime.store.coverage('firms')).count;
    await flushRuntime.close();
    rmSync(flushDir, { recursive: true, force: true });
    record('flush of 130k detections yields to the event loop', stored > 0 && worst <= STALL_BUDGET_MS, `${flushMs.toFixed(0)} ms in total, longest stall ${worst.toFixed(0)} ms of ${STALL_BUDGET_MS}, ${stored} rows stored`);

    // 6. synthetic secrets
    upstream = (url) =>
      new Response(url.includes('VIIRS_NOAA20') ? csvAt(5, 100000, `,${SECRETS.bearer},${SECRETS.queryKey}`) : csvAt(0));
    clock += 31 * 60_000;
    const secretRequest = freshProxy(directory, on.recorder);
    const secretResponse = await secretRequest();
    await on.recorder.flush();
    await on.recorder.tap('firms', { fires: [{ lat: 1, lon: 2, acqDate: '2026-10-31', acqTime: '1100', satellite: 'N20', instrument: 'VIIRS', note: SECRETS.userinfo, url: `https://x/?${SECRETS.queryKey}`, auth: SECRETS.bearer }] });
    await on.recorder.flush();
    const hay = [allBytes(directory), warnings.join('\n'), secretResponse.body].join('\n');
    const leaks = Object.entries(SECRETS).flatMap(([name, value]) => {
      const forms = [value, encodeURIComponent(value), Buffer.from(value).toString('base64'), value.slice(0, 10), value.slice(-8)];
      return forms.some((form) => hay.includes(form)) ? [name] : [];
    });
    record('synthetic secrets appear in no stored byte, warning or response', leaks.length === 0 && urls.some((u) => u.includes(SECRETS.mapKey)), leaks.length ? `LEAK: ${leaks.join(', ')}` : '0 hits in stored bytes, warnings and responses');
    await on.close();

    // 7. boot validation
    const bootFile = path.join(directory, 'boot.sqlite');
    const errors = [];
    for (const env of [{ HISTORY_RECORD: '1', HISTORY_RECORD_FIRM: '1' }, { HISTORY_RECORD: 'maybe' }, { HISTORY_RECORD_WATER: '1' }]) {
      try {
        createHistoryRuntime({ ...env, HISTORY_SQLITE_PATH: bootFile });
        errors.push('accepted');
      } catch (error) {
        errors.push(error.name);
      }
    }
    record('unsupported settings stop the boot before a file is created', errors.every((e) => e === 'HistoryConfigError') && !existsSync(bootFile), errors.join(', '));
  } finally {
    console.warn = originalWarn;
    Date.now = realNow;
    process.chdir(home);
    rmSync(directory, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  record('gate ran to completion', false, `${error?.name}: ${error?.message}`);
}
const failed = checks.filter((check) => !check.ok);
if (json) console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2));
else console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
