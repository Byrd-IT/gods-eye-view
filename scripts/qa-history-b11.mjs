#!/usr/bin/env node
/**
 * History control (card B11) browser QA, headless Chromium against a running
 * GEV dev server:
 *
 *   node scripts/qa-history-b11.mjs --url http://127.0.0.1:4366 --out <dir>
 *        [--mode fixture|real] [--settle-ms 20000] [--hash '#v=2&lat=..']
 *
 * fixture (default): /api/history/* is answered in the browser from the
 *   known-gap fixture world (src/byrdit/historyUi/fixtures/b11Coverage.mjs),
 *   /api/military and /api/flights from canned bridge answers (grey and
 *   OpenSky-paused chips), so no upstream is called by these two routes.
 * real: /api/history/* goes to the dev server (GEV_HISTORY_API=1 + the
 *   reader key); only the scrub + console checks run.
 *
 * Checks: collapsed LIVE badge; expand -> lanes; a 24 h scrub with real
 * mouse drags (97 positions, release + snap) and 600x playback with NO
 * console/page error; the known gap is hatched and named by the HUD; `ht`
 * round trip through a reload, LIVE clears it; Space / arrows / Shift;
 * feed chips grey + paused; quiet failure ("history unavailable", globe
 * still rendering). Screenshots after Page.bringToFront. Exit 1 on failure.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import {
  coverageFixture,
  fixtureWorld,
  snapshotsFixture,
} from '../src/byrdit/historyUi/fixtures/b11Coverage.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg('--url', 'http://127.0.0.1:4366');
const OUT = path.resolve(arg('--out', 'qa-history-b11'));
const MODE = arg('--mode', 'fixture');
const SETTLE_MS = Number(arg('--settle-ms', '20000'));
// open on a 25 km top-down view so the screenshots show the map
const HASH = arg(
  '--hash',
  '#v=2&lat=30.2672&lon=-97.7431&alt=25000&heading=360&pitch=-90&roll=0&map=esri-imagery',
);
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const say = (...parts) => {
  const line = parts
    .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
    .join(' ');
  log.push(line);
  console.log(line);
};
const failures = [];
const check = (ok, what) => {
  say(ok ? 'PASS' : 'FAIL', what);
  if (!ok) failures.push(what);
};

const world = fixtureWorld(Date.now());
say(
  'mode',
  MODE,
  'fixture gap',
  new Date(world.gap.from).toISOString(),
  new Date(world.gap.to).toISOString(),
);

const browser = await puppeteer.launch({
  headless: true,
  protocolTimeout: 600000,
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--font-render-hinting=none',
  ],
});

const MIL_LAST_OK = Date.now() - 20 * 60_000;
function bridgeHeaders(extra = {}) {
  return {
    'content-type': 'application/json',
    'x-feed-source': 'collector',
    'x-feed-last-ok': String(MIL_LAST_OK),
    'x-feed-age-ms': String(Date.now() - MIL_LAST_OK),
    'x-feed-cache': 'STALE',
    'x-feed-stale-since': String(MIL_LAST_OK + 3 * 60_000),
    'x-feed-grey-until': String(MIL_LAST_OK + 63 * 60_000),
    ...extra,
  };
}

async function openPage({ history = 'fixture' } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  const errors = [];
  const historyCalls = [];
  page.on('pageerror', (e) => errors.push(`page: ${String(e).slice(0, 300)}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(`console: ${m.text().slice(0, 300)}`);
  });
  if (history !== 'real') {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = new URL(req.url());
      const json = (
        body,
        headers = { 'content-type': 'application/json' },
        status = 200,
      ) => req.respond({ status, headers, body: JSON.stringify(body) });
      if (url.pathname.startsWith('/api/history/')) {
        historyCalls.push(url.pathname + url.search);
        if (history === 'down')
          return json(
            { error: 'history_unavailable' },
            { 'content-type': 'application/json' },
            503,
          );
        const q = Object.fromEntries(url.searchParams);
        if (url.pathname === '/api/history/coverage')
          return json(
            coverageFixture(world, {
              feed: q.feed,
              from: Date.parse(q.from),
              to: Date.parse(q.to),
              bucket: q.bucket,
            }),
          );
        if (url.pathname === '/api/history/snapshots')
          return json(
            snapshotsFixture(world, {
              feed: q.feed,
              around: Date.parse(q.around),
              n: Number(q.n),
            }),
          );
        return json({ error: 'not_found' }, undefined, 404);
      }
      if (url.pathname === '/api/military')
        return json(
          {
            ac: [],
            msg: 'No error',
            now: MIL_LAST_OK,
            total: 0,
            ctime: MIL_LAST_OK,
            ptime: 1,
          },
          bridgeHeaders(),
        );
      if (url.pathname === '/api/flights')
        return json(
          { time: Math.floor(MIL_LAST_OK / 1000), states: [] },
          bridgeHeaders({ 'x-feed-reason': 'opensky_paused_until=23:30' }),
        );
      return req.continue();
    });
  } else {
    page.on('request', (req) => {
      const url = new URL(req.url());
      if (url.pathname.startsWith('/api/history/'))
        historyCalls.push(url.pathname + url.search);
    });
  }
  return { page, errors, historyCalls };
}

async function load(page, href) {
  await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__godsEyeView?.viewer, {
    timeout: 180000,
  });
  await page.waitForFunction(
    () => document.querySelector('[data-gev-history]'),
    { timeout: 120000 },
  );
  await sleep(SETTLE_MS);
  await page.keyboard.press('Escape');
}

async function shot(page, name) {
  await page.bringToFront();
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  say('screenshot', file);
}

const state = (page) =>
  page.evaluate(() => {
    const root = document.querySelector('[data-gev-history]');
    return {
      mode: root.getAttribute('data-mode'),
      expanded: root.getAttribute('data-expanded'),
      time: root.getAttribute('data-time'),
      playing: root.getAttribute('data-playing'),
      rate: root.getAttribute('data-rate'),
      unavailable: root.getAttribute('data-unavailable'),
      badge: root.querySelector('.gev-hist-badge')?.textContent,
      hud: root.querySelector('.gev-hist-hud')?.textContent,
      lanes: [...root.querySelectorAll('.gev-hist-lane')].map((l) =>
        l.getAttribute('data-lane'),
      ),
      segs: [...root.querySelectorAll('.gev-hist-seg')].map((s) => [
        s.getAttribute('data-kind'),
        s.getAttribute('data-from'),
        s.getAttribute('data-to'),
      ]),
      chips: [...root.querySelectorAll('.gev-hist-chip')].map((c) => [
        c.getAttribute('data-feed'),
        c.getAttribute('data-state'),
        c.textContent,
      ]),
      href: location.href,
    };
  });

async function scrubBox(page) {
  return page.evaluate(() => {
    const r = document.querySelector('.gev-hist-scrub').getBoundingClientRect();
    return { x: r.left, y: r.top + r.height / 2, w: r.width };
  });
}

/** Window (from/to ms) the scrub bar shows, from its edge labels' source. */
async function windowOf(page) {
  return page.evaluate(() => {
    const segs = document.querySelector('.gev-hist-edges');
    return segs ? [...segs.children].map((n) => n.textContent) : null;
  });
}

// ── 1. main page ─────────────────────────────────────────
const main = await openPage({ history: MODE === 'real' ? 'real' : 'fixture' });
await load(main.page, `${BASE}/${HASH}`);
const startErrors = main.errors.length;
say(
  'errors before history interaction (app, not history):',
  main.errors.slice(0, 10),
);
let st = await state(main.page);
check(
  st.mode === 'live' && st.expanded === 'false' && st.badge === 'LIVE',
  'collapsed control shows the LIVE badge',
);
await shot(main.page, '01-collapsed-live');

await main.page.click('.gev-hist-badge');
await sleep(2500);
st = await state(main.page);
check(st.expanded === 'true', 'badge expands the control');
check(
  JSON.stringify(st.lanes) ===
    JSON.stringify(['adsblol', 'opensky', 'military']),
  `ribbon lanes ${JSON.stringify(st.lanes)}`,
);
await shot(main.page, '02-expanded-live-24h');

// ── 2. 24 h scrub with real mouse drags ─────────────────────
const box = await scrubBox(main.page);
say('scrub box', box, 'window', await windowOf(main.page));
const scrubErrors0 = main.errors.length;
const times = [];
await main.page.mouse.move(box.x + 2, box.y);
await main.page.mouse.down();
for (let i = 0; i <= 96; i++) {
  await main.page.mouse.move(box.x + 2 + ((box.w - 4) * i) / 96, box.y, {
    steps: 2,
  });
  if (i % 8 === 0) times.push((await state(main.page)).time);
}
await main.page.mouse.up();
await sleep(1500);
st = await state(main.page);
check(st.mode === 'history', 'scrub entered history mode');
const uniq = new Set(times.filter(Boolean));
check(
  uniq.size >= 10,
  `scrub moved the time across 24 h (${uniq.size} distinct samples, first ${times[0]}, last ${times.at(-1)})`,
);
// release + snap at 12 positions
for (let i = 1; i <= 12; i++) {
  const x = box.x + 2 + ((box.w - 4) * i) / 13;
  await main.page.mouse.click(x, box.y);
  await sleep(700);
}
st = await state(main.page);
check(
  /ht=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ/.test(st.href),
  `ht in the address: ${st.href}`,
);
// 600x playback for 5 s
await main.page.click('[data-rate="600"]');
const before600 = Date.parse((await state(main.page)).time);
await main.page.click('.gev-hist-play');
await sleep(5000);
const after600 = Date.parse((await state(main.page)).time);
await main.page.click('.gev-hist-play');
check(
  after600 - before600 > 25 * 60_000,
  `600x playback advanced ${Math.round((after600 - before600) / 60000)} min in ~5 s`,
);
const scrubErrors = main.errors.slice(scrubErrors0);
check(
  scrubErrors.length === 0,
  `no console/page error during the 24 h scrub + playback (${JSON.stringify(scrubErrors)})`,
);
await shot(main.page, '03-history-after-scrub');

if (MODE !== 'real') {
  // ── 3. known gap: hatched + HUD ─────────────────────────
  const gapMid = (world.gap.from + world.gap.to) / 2;
  await main.page.evaluate(() =>
    document.querySelector('[data-preset="24h"]').click(),
  );
  await sleep(1500);
  const edges = await windowOf(main.page);
  say('24 h window edges', edges);
  const win = await main.page.evaluate(() => {
    const segs = [
      ...document.querySelectorAll(
        '.gev-hist-lane[data-lane="military"] .gev-hist-seg',
      ),
    ];
    // every segment knows its from/to and its left/width % -> the window
    const s = segs.find((x) => x.style.width && parseFloat(x.style.width) > 1);
    const from = Date.parse(s.getAttribute('data-from'));
    const to = Date.parse(s.getAttribute('data-to'));
    const left = parseFloat(s.style.left) / 100;
    const width = parseFloat(s.style.width) / 100;
    const span = (to - from) / width;
    return { from: from - left * span, to: from - left * span + span };
  });
  const box2 = await scrubBox(main.page);
  const fx = (gapMid - win.from) / (win.to - win.from);
  await main.page.mouse.click(box2.x + box2.w * fx, box2.y);
  await sleep(2500);
  st = await state(main.page);
  const gapSeg = st.segs.find(
    (s) =>
      s[0] === 'gap' &&
      Date.parse(s[1]) === world.gap.from &&
      Date.parse(s[2]) === world.gap.to,
  );
  check(
    Boolean(gapSeg),
    `hatched gap segment ${new Date(world.gap.from).toISOString()}..${new Date(world.gap.to).toISOString()}`,
  );
  const t = Date.parse(st.time);
  check(
    t >= world.gap.from && t < world.gap.to,
    `time is inside the gap (${st.time})`,
  );
  const hh = (ms) => new Date(ms).toISOString().slice(11, 16);
  const want = `No recording at this time (gap ${hh(world.gap.from)}-${hh(world.gap.to)} UTC)`;
  check(st.hud.includes(want), `HUD names the gap: "${st.hud}"`);
  await shot(main.page, '04-known-gap-hatched-hud');
  const hatched = await main.page.evaluate(() => {
    const s = document.querySelector('.gev-hist-seg-gap');
    return s ? getComputedStyle(s).backgroundImage : null;
  });
  check(
    /repeating-linear-gradient/.test(hatched ?? ''),
    `gap is drawn hatched (${String(hatched).slice(0, 60)})`,
  );

  // ── 4. keyboard ────────────────────────────────────────
  await main.page.evaluate(() => document.activeElement?.blur?.());
  await main.page.click('canvas').catch(() => {});
  const k0 = Date.parse((await state(main.page)).time);
  await main.page.keyboard.press('ArrowRight');
  await sleep(1200);
  const k1 = Date.parse((await state(main.page)).time);
  check(
    k1 > k0,
    `ArrowRight steps forward (${new Date(k0).toISOString()} -> ${new Date(k1).toISOString()})`,
  );
  await main.page.keyboard.down('Shift');
  await main.page.keyboard.press('ArrowLeft');
  await main.page.keyboard.up('Shift');
  await sleep(1200);
  const k2 = Date.parse((await state(main.page)).time);
  check(
    k2 < k1,
    `Shift+ArrowLeft steps back 10 (${Math.round((k1 - k2) / 60000)} min)`,
  );
  await main.page.keyboard.press('Space');
  await sleep(300);
  check((await state(main.page)).playing === 'true', 'Space starts playback');
  await main.page.keyboard.press('Space');
  await sleep(300);
  check((await state(main.page)).playing === 'false', 'Space pauses');

  // ── 5. feed chips (canned bridge answers) ───────────────
  await main.page.evaluate(() => fetch('/api/military').then((r) => r.status));
  await main.page.evaluate(() =>
    fetch('/api/flights?lat=29.7&lon=-95.3').then((r) => r.status),
  );
  await sleep(500);
  st = await state(main.page);
  const mil = st.chips.find((c) => c[0] === 'military');
  const fl = st.chips.find((c) => c[0] === 'flights');
  check(
    mil?.[1] === 'grey' && /No data since \d\d:\d\d/.test(mil?.[2] ?? ''),
    `military chip grey: ${JSON.stringify(mil)}`,
  );
  check(
    fl?.[1] === 'paused' &&
      /OpenSky paused until 23:30 UTC/.test(fl?.[2] ?? ''),
    `flights chip paused: ${JSON.stringify(fl)}`,
  );
  await shot(main.page, '05-chips-grey-paused');

  // ── 6. ht round trip through a reload ───────────────────
  st = await state(main.page);
  const htHref = st.href;
  const htValue = new URL(htHref).searchParams.get('ht');
  await main.page.reload({ waitUntil: 'domcontentloaded' });
  await main.page.waitForFunction(
    () => document.querySelector('[data-gev-history]'),
    { timeout: 180000 },
  );
  await sleep(3000);
  st = await state(main.page);
  check(
    st.mode === 'history' &&
      st.time &&
      Date.parse(st.time) === Date.parse(htValue),
    `reload restores ht ${htValue} -> ${st.time}`,
  );
  // after a reload the "Restoring shared view" splash can still cover the
  // page: wait until the LIVE button is the element under its own centre
  await main.page
    .waitForFunction(
      () => {
        const b = document.querySelector('.gev-hist-live');
        if (!b) return false;
        const r = b.getBoundingClientRect();
        const hit = document.elementFromPoint(
          r.left + r.width / 2,
          r.top + r.height / 2,
        );
        return Boolean(hit && (hit === b || b.contains(hit)));
      },
      { timeout: 180000 },
    )
    .catch(() => say('LIVE button still covered after 180 s'));
  await shot(main.page, '06-reload-restores-ht');
  await main.page.click('.gev-hist-live');
  await sleep(500);
  st = await state(main.page);
  check(
    st.mode === 'live' && !new URL(st.href).searchParams.has('ht'),
    'LIVE returns to live and clears ht',
  );
}
check(
  main.errors.length === startErrors,
  `no console/page error after the first history interaction (${JSON.stringify(main.errors.slice(startErrors))})`,
);
say('history API calls (main page):', main.historyCalls.length);

// ── 7. quiet failure ─────────────────────────────────────
if (MODE !== 'real') {
  const down = await openPage({ history: 'down' });
  await load(down.page, `${BASE}/${HASH}`);
  const e0 = down.errors.length;
  await down.page.click('.gev-hist-badge');
  await sleep(2000);
  const box3 = await scrubBox(down.page);
  await down.page.mouse.click(box3.x + box3.w * 0.5, box3.y);
  await sleep(1500);
  const sd = await state(down.page);
  check(
    sd.unavailable === 'true' && sd.hud === 'history unavailable',
    `quiet failure: "${sd.hud}"`,
  );
  const alive = await down.page.evaluate(() => {
    const v = window.__godsEyeView.viewer;
    return {
      destroyed: v.isDestroyed(),
      canvas: Boolean(document.querySelector('canvas')),
    };
  });
  check(!alive.destroyed && alive.canvas, 'globe keeps running');
  check(
    down.errors.length === e0,
    `no console/page error while history is down (${JSON.stringify(down.errors.slice(e0))})`,
  );
  await shot(down.page, '07-history-unavailable');
}

const results = { mode: MODE, base: BASE, failures, log };
writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
writeFileSync(path.join(OUT, 'qa-log.txt'), log.join('\n') + '\n');
await browser.close();
say(failures.length ? `QA B11 FAIL (${failures.length})` : 'QA B11 PASS');
process.exit(failures.length ? 1 : 0);
