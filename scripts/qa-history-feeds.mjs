#!/usr/bin/env node
/**
 * Gate for the history recorder's feed adapters (server/history/recorder/adapters).
 * No browser and no network: for every feed group's fixtures it drives the real
 * response tee (the plugin local.js lists first), the real recorder and a real
 * SQLite file in a scratch directory.
 *
 *   npm run qa:history-feeds
 *   node scripts/qa-history-feeds.mjs --json   (machine-readable report)
 *
 * Proves, for every fixture:
 *   - the answer lands in the store, and the client's bytes are identical to a run with recording off
 *   - the same answer served again writes nothing; a later answer writes new rows; each poll is logged
 *   - a failed answer is logged as a failed poll
 *   - synthetic secrets placed in fields the adapter does not know reach no stored byte
 * and, across the board:
 *   - a heavy feed (aircraft, vessels) records only when named, never from HISTORY_RECORD=1 alone;
 *     a light one (military, cyclones, perimeters, launches) records from HISTORY_RECORD=1
 *   - with recording off the tee mounts nothing and wraps nothing
 *   - a world-sized poll is tapped within a time budget and flushed without stalling the event loop
 * Exits non-zero on the first failed check; the report names each check.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  createHistoryRuntime,
  historyResponseTee,
} from '../server/history/runtime.js';
import { ADAPTERS } from '../server/history/recorder/adapters/index.js';
import { FIXTURES } from '../server/history/recorder/feedFixtures/index.mjs';
import { request } from '../server/history/recorder/feedFixtures/http.mjs';

const SCALE =
  Number(process.env.GEV_QA_BUDGET_SCALE) > 0
    ? Number(process.env.GEV_QA_BUDGET_SCALE)
    : 1;
const TAP_BUDGET_MS = 1500 * SCALE;
const STALL_BUDGET_MS = 750 * SCALE;
const checks = [];
const json = process.argv.includes('--json');
function record(name, ok, detail) {
  checks.push({ name, ok, detail });
  if (!json)
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`,
    );
}

const nonce = randomBytes(6).toString('hex');
const SECRETS = {
  bearer: `Bearer BEARER${nonce}TAIL${nonce.slice(0, 4)}`,
  userinfo: `https://user${nonce}:pass${nonce}@example.test/`,
  queryKey: `api_key=QUERY${nonce}`,
};
const NOISE = {
  authorization: SECRETS.bearer,
  note: SECRETS.userinfo,
  link: `https://x/?${SECRETS.queryKey}`,
};

const CLOCK = Date.UTC(2026, 9, 31, 12, 0);
const body = (fixture, options) => {
  const built = fixture.build({ clock: CLOCK, ...options });
  return fixture.kind === 'text' ? built : JSON.stringify(built);
};
const reply =
  (fixture, options, status = 200) =>
  (req, res) => {
    res.writeHead(status, {
      'Content-Type':
        fixture.kind === 'text' ? 'text/plain' : 'application/json',
    });
    res.end(status === 200 ? body(fixture, options) : '{"error":"x"}');
  };
const passThrough = (req, res, next) => next();

function middlewareOf(plugin) {
  let middleware = null;
  plugin.configureServer?.({
    middlewares: { use: (_mount, fn) => (middleware = fn) },
  });
  return middleware;
}

function allBytes(directory) {
  return readdirSync(directory)
    .filter((name) => name.startsWith('h.sqlite'))
    .map((name) => readFileSync(path.join(directory, name)).toString('latin1'))
    .join('');
}

/**
 * World-sized polls of one heavy feed through the real tee. The second poll moves every
 * entity, so every entity has a prior entry (the dedup path hashes all of them).
 */
async function perfChecks(perf) {
  const perfDir = mkdtempSync(path.join(tmpdir(), 'gev-qa-feeds-perf-'));
  let big = null;
  try {
    big = createHistoryRuntime({
      HISTORY_SQLITE_PATH: path.join(perfDir, 'p.sqlite'),
      HISTORY_RECORD_QUEUE_ROWS: '300000',
      [`HISTORY_RECORD_${perf.feed.toUpperCase()}`]: '1',
    });
    const bigTee = middlewareOf(historyResponseTee(big));
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    let expectedQueued = 0;
    for (const variant of [0, 1]) {
      const payload = perf.perf(CLOCK, variant);
      let worst = 0;
      let last = process.hrtime.bigint();
      const watcher = setInterval(() => {
        const now = process.hrtime.bigint();
        worst = Math.max(worst, Number(now - last) / 1e6);
        last = now;
      }, 1);
      try {
        const start = process.hrtime.bigint();
        let responseMs = 0;
        const res = await request(bigTee, perf.path, (req, response) => {
          const t0 = process.hrtime.bigint();
          response.writeHead(200);
          response.end(payload);
          responseMs = Number(process.hrtime.bigint() - t0) / 1e6;
        });
        // request() waits two ticks; wait for the tap to finish queueing.
        for (
          let i = 0;
          i < 2000 && big.recorder.health().queuedRows <= expectedQueued;
          i++
        )
          await tick();
        const tapMs = Number(process.hrtime.bigint() - start) / 1e6;
        const queued = big.recorder.health().queuedRows;
        record(
          `${perf.feed}: world poll ${variant + 1} is tapped inside the budget without stalling the event loop`,
          res.statusCode === 200 &&
            queued > expectedQueued &&
            responseMs <= TAP_BUDGET_MS &&
            tapMs <= TAP_BUDGET_MS &&
            worst <= STALL_BUDGET_MS,
          `${queued - expectedQueued} rows queued, response ${responseMs.toFixed(1)} ms, tap done after ${tapMs.toFixed(0)} ms of ${TAP_BUDGET_MS}, longest stall ${worst.toFixed(0)} ms of ${STALL_BUDGET_MS}`,
        );
        expectedQueued = queued;
      } finally {
        clearInterval(watcher);
      }
    }
    let worst = 0;
    let last = process.hrtime.bigint();
    const watcher = setInterval(() => {
      const now = process.hrtime.bigint();
      worst = Math.max(worst, Number(now - last) / 1e6);
      last = now;
    }, 1);
    let flushMs = 0;
    try {
      const flushStart = process.hrtime.bigint();
      await big.recorder.flush();
      flushMs = Number(process.hrtime.bigint() - flushStart) / 1e6;
    } finally {
      clearInterval(watcher);
    }
    const stored = (await big.store.coverage(perf.feed)).count;
    record(
      `${perf.feed}: flushing both polls yields to the event loop`,
      stored === expectedQueued && worst <= STALL_BUDGET_MS,
      `${flushMs.toFixed(0)} ms in total, longest stall ${worst.toFixed(0)} ms of ${STALL_BUDGET_MS}, ${stored} rows`,
    );
  } finally {
    await big?.close();
    rmSync(perfDir, { recursive: true, force: true });
  }
}

async function main() {
  const directory = mkdtempSync(path.join(tmpdir(), 'gev-qa-feeds-'));
  const file = path.join(directory, 'h.sqlite');
  const feeds = [...new Set(FIXTURES.map((fixture) => fixture.feed))];
  const naming = Object.fromEntries(
    feeds.map((feed) => [`HISTORY_RECORD_${feed.toUpperCase()}`, '1']),
  );
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try {
    // Heavy feeds are opt-in by name.
    const heavy = Object.entries(ADAPTERS)
      .filter(([, adapter]) => adapter.defaultOn === false)
      .map(([feed]) => feed);
    const globalOnly = createHistoryRuntime({
      HISTORY_SQLITE_PATH: path.join(directory, 'g.sqlite'),
      HISTORY_RECORD: '1',
    });
    record(
      'a heavy feed does not record from HISTORY_RECORD=1 alone',
      heavy.every((feed) => !globalOnly.recorder.feeds.includes(feed)),
      `heavy feeds: ${heavy.join(', ') || 'none'}`,
    );
    // The small, low-rate feeds (cyclones, perimeters, launches) follow HISTORY_RECORD=1.
    const light = [...new Set(FIXTURES.map((fixture) => fixture.feed))].filter(
      (feed) => ADAPTERS[feed]?.defaultOn !== false,
    );
    record(
      'a light feed records from HISTORY_RECORD=1 alone',
      light.length > 0 &&
        light.every((feed) => globalOnly.recorder.feeds.includes(feed)),
      `light feeds: ${light.join(', ')}`,
    );
    await globalOnly.close();

    // Recording off: nothing registered, nothing wrapped.
    const off = createHistoryRuntime({ HISTORY_SQLITE_PATH: file });
    const offPlugin = historyResponseTee(off);
    const mounted = [];
    const server = { middlewares: { use: (...args) => mounted.push(args) } };
    offPlugin.configureServer(server);
    offPlugin.configurePreviewServer(server);
    record(
      'with recording off the tee mounts nothing (both hooks present)',
      mounted.length === 0 && typeof offPlugin.configureServer === 'function',
    );

    const runtime = createHistoryRuntime({
      HISTORY_SQLITE_PATH: file,
      HISTORY_MIN_INTERVAL_S: '60',
      ...naming,
    });
    const tee = middlewareOf(historyResponseTee(runtime));
    record(
      'every fixture feed has an adapter and a recording runtime',
      feeds.every((feed) => runtime.recorder.feeds.includes(feed)),
      feeds.join(', '),
    );

    for (const fixture of FIXTURES) {
      const label = `${fixture.feed} ${fixture.path}`;
      const plain = await request(
        passThrough,
        fixture.path,
        reply(fixture, {}),
      );
      const first = await request(tee, fixture.path, reply(fixture, {}));
      await runtime.recorder.flush();
      const coverage = await runtime.store.coverage(fixture.feed);
      record(
        `${label}: answer lands in the store, client bytes unchanged`,
        first.body === plain.body &&
          first.statusCode === 200 &&
          coverage.count === fixture.expectedRows,
        `${coverage.count} rows from one poll`,
      );

      await request(tee, fixture.path, reply(fixture, {}));
      await runtime.recorder.flush();
      const afterRepeat = await runtime.store.coverage(fixture.feed);
      const pollsAfterRepeat = (await runtime.store.ingestLog(fixture.feed))
        .polls.length;
      record(
        `${label}: the same answer served again writes nothing`,
        afterRepeat.count === coverage.count && pollsAfterRepeat === 1,
        `${afterRepeat.count} rows, ${pollsAfterRepeat} poll`,
      );

      await request(tee, fixture.path, reply(fixture, { variant: 1 }));
      await runtime.recorder.flush();
      const afterLater = await runtime.store.coverage(fixture.feed);
      const pollsAfterLater = (await runtime.store.ingestLog(fixture.feed))
        .polls.length;
      record(
        `${label}: a later answer writes new rows and is logged`,
        afterLater.count === fixture.expectedRows * 2 && pollsAfterLater === 2,
        `${afterLater.count} rows, ${pollsAfterLater} polls`,
      );

      await request(tee, fixture.path, reply(fixture, {}, 503));
      await runtime.recorder.flush();
      const last = (await runtime.store.ingestLog(fixture.feed)).polls.at(-1);
      record(
        `${label}: a failed answer is logged as a failed poll`,
        last && last.ok === false && last.count === 0,
      );

      if (fixture.notLive) {
        // Its own runtime: the failed-poll limit is per route, and the check above used it.
        const idle = createHistoryRuntime({
          HISTORY_SQLITE_PATH: path.join(directory, 'n.sqlite'),
          [`HISTORY_RECORD_${fixture.feed.toUpperCase()}`]: '1',
        });
        try {
          const idleTee = middlewareOf(historyResponseTee(idle));
          const down = await request(
            idleTee,
            fixture.path,
            reply(fixture, fixture.notLive),
          );
          await idle.recorder.flush();
          const polls = (await idle.store.ingestLog(fixture.feed)).polls;
          record(
            `${label}: an answer served while the feed is not live is a failed poll and stores nothing`,
            down.statusCode === 200 &&
              polls.length === 1 &&
              polls[0].ok === false &&
              (await idle.store.coverage(fixture.feed)).count === 0,
          );
        } finally {
          await idle.close();
        }
      }

      const noisy = await request(
        tee,
        fixture.path,
        reply(fixture, { variant: 2, noise: NOISE }),
      );
      await runtime.recorder.flush();
      const withNoise = await runtime.store.coverage(fixture.feed);
      record(
        `${label}: an answer carrying synthetic secrets was recorded, so the secret check is not vacuous`,
        noisy.statusCode === 200 &&
          withNoise.count === fixture.expectedRows * 3,
        `${withNoise.count} rows`,
      );
    }

    // Secrets placed in fields no adapter knows.
    const hay = [allBytes(directory), warnings.join('\n')].join('\n');
    const leaks = Object.entries(SECRETS).flatMap(([name, value]) => {
      const forms = [
        value,
        encodeURIComponent(value),
        Buffer.from(value).toString('base64'),
        value.slice(0, 10),
        value.slice(-8),
      ];
      return forms.some((form) => hay.includes(form)) ? [name] : [];
    });
    record(
      'synthetic secrets in unknown fields reach no stored byte or warning',
      leaks.length === 0,
      leaks.length
        ? `LEAK: ${leaks.join(', ')}`
        : '0 hits in stored bytes and warnings',
    );
    await runtime.close();

    // Budget: world-sized polls of each heavy feed through the real tee.
    for (const perf of FIXTURES.filter((fixture) => fixture.perf))
      await perfChecks(perf);
  } finally {
    console.warn = originalWarn;
    rmSync(directory, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  record('gate ran to completion', false, `${error?.name}: ${error?.message}`);
}
const failed = checks.filter((check) => !check.ok);
if (json)
  console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2));
else
  console.log(
    `\n${checks.length - failed.length}/${checks.length} checks passed`,
  );
process.exit(failed.length ? 1 : 0);
