#!/usr/bin/env node
/**
 * GEV history B12 umbrella browser QA (card t_5aa880c7, DESIGN 4.5 / 6 B12):
 * the whole layer swap against REAL recorded data, through a TLS + Basic
 * Auth hop, in headless Chromium.
 *
 *   QA_AUTH_USER=qa QA_AUTH_PASSWORD=<pw> node scripts/qa-history-b12.mjs \
 *     --url https://127.0.0.1:15444 --out <dir> [--minutes 10] [--rate 60]
 *     [--t0 <ISO>] [--settle-ms 20000] [--gpu] [--skip-playback]
 *
 * --url is a GEV origin whose /api/history/* answers from Elasticsearch:
 * before a deploy, the QA hop (scripts/qa-history-hop.mjs, TLS + Basic
 * Auth like the public NPM host) in front of this checkout's own server
 * (scripts/qa-history-serve.mjs: standalone Vite, history API on, the
 * gev-history reader key from stdin); after a deploy, the public host.
 * No /api request is intercepted or invented here; the Basic Auth answer
 * (page.authenticate) is the only request handling.
 *
 * 1. LIVE-chip test (D5, "mixed state never silent"): EVERY registered
 *    layer is enabled, then history at t0. For every enabled layer, either
 *    the router answers it from history (a swapped adapter's layer: no LIVE
 *    chip) or a VISIBLE chip 'layer:<id>' says LIVE (or LIVE (history
 *    unavailable) for a failed feed). On LIVE no such chip is left.
 * 2. Selected aircraft (B12e): an airborne aircraft of the shown frame is
 *    selected; /api/history/track is asked and its chip shows.
 * 3. Playback (acceptance): --minutes of wall clock at --rate (60x), first
 *    half over a Texas-sized view (aircraft bbox slices), second half over
 *    a whole-globe view (aircraft global slices), with every history-capable
 *    layer enabled. Every /api/history request is timed in the browser
 *    (CDP Network: requestWillBeSent -> loadingFinished), grouped by feed
 *    and bbox. p95 must be within the B10 targets (DESIGN 3.5 / 6 B10):
 *    aircraft global < 1500 ms, aircraft bbox < 400 ms, track < 500 ms,
 *    vessels global < 2000 ms. Other feeds are reported (no target).
 *    Prefetch in flight <= 2 (D6). The shown time must advance ~rate x.
 * 4. LIVE restores live mode, no LIVE chip left; no page error.
 *
 * Screenshots after Page.bringToFront, with the world-overlay canvas
 * readback laid over the capture and saved beside it (see shot()).
 * results.json + qa-log.txt + frames.json (every timed request) in --out.
 * Exit 1 on any failed check.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(name);
const BASE = arg('--url', 'https://127.0.0.1:15444');
const OUT = path.resolve(arg('--out', 'qa-history-b12'));
const MINUTES = Number(arg('--minutes', '10'));
const RATE = Number(arg('--rate', '60'));
const SETTLE_MS = Number(arg('--settle-ms', '20000'));
const HOUR = 3_600_000;
// default t0: 30 h back on the hour, so 10 h of 60x playback ends > 20 h
// before now (recorded, not the live edge)
const T0 = Date.parse(
  arg(
    '--t0',
    new Date(Math.floor((Date.now() - 30 * HOUR) / HOUR) * HOUR).toISOString(),
  ),
);
const TEXAS = { lat: 31.1, lon: -100.0, alt: 1_250_000 };
const GLOBE = { lat: 30, lon: -60, alt: 22_000_000 };
const HASH = `#v=2&lat=${TEXAS.lat}&lon=${TEXAS.lon}&alt=${TEXAS.alt}&heading=360&pitch=-90&roll=0&map=esri-imagery`;
/** B10 performance targets (ms, p95). vessels: the B10 gate's 2 s. */
const TARGETS = {
  'aircraft-global': 1500,
  'aircraft-bbox': 400,
  track: 500,
  'vessels-global': 2000,
};
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(ms).toISOString();
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
const pct = (a, p) =>
  a.length
    ? [...a].sort((x, y) => x - y)[
        Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1)
      ]
    : null;
const results = { base: BASE, t0: iso(T0), minutes: MINUTES, rate: RATE };
const save = () => {
  writeFileSync(
    path.join(OUT, 'results.json'),
    JSON.stringify({ ...results, failures }, null, 2),
  );
  writeFileSync(path.join(OUT, 'qa-log.txt'), log.join('\n') + '\n');
};

const gpuArgs = flag('--gpu')
  ? [
      '--use-angle=vulkan',
      '--enable-features=Vulkan',
      '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization',
    ]
  : [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      // software 2-D canvas: the reliable overlay capture path (B12b review)
      '--disable-accelerated-2d-canvas',
    ];
const browser = await puppeteer.launch({
  headless: true,
  acceptInsecureCerts: true,
  protocolTimeout: 900000,
  args: ['--no-sandbox', '--font-render-hinting=none', ...gpuArgs],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
if (process.env.QA_AUTH_USER)
  await page.authenticate({
    username: process.env.QA_AUTH_USER,
    password: process.env.QA_AUTH_PASSWORD ?? '',
  });
const errors = [];
const diag = [];
page.on('pageerror', (e) =>
  errors.push(`page: ${String(e?.stack ?? e).slice(0, 4000)}`),
);
page.on('console', (m) => {
  if (/perimeter|cyclone|history/i.test(m.text()))
    diag.push(`${m.type()}: ${m.text().slice(0, 300)}`);
  if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
    errors.push(`console: ${m.text().slice(0, 4000)}`);
});

// ── request timing (CDP Network, browser clock) ─────────────
let phase = 'load';
const pending = new Map();
const frames = [];
const cdp = await page.createCDPSession();
await cdp.send('Network.enable');
cdp.on('Network.requestWillBeSent', (e) => {
  if (!/\/api\/history\//.test(e.request.url)) return;
  pending.set(e.requestId, {
    id: e.requestId,
    url: e.request.url,
    t0: e.timestamp,
    wall: Date.now(),
    phase,
  });
});
cdp.on('Network.responseReceived', (e) => {
  const r = pending.get(e.requestId);
  if (!r) return;
  const h = Object.fromEntries(
    Object.entries(e.response.headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  r.status = e.response.status;
  r.protocol = e.response.protocol ?? null;
  r.cache = h['x-history-cache'] ?? null;
  r.rows = h['x-history-rows'] != null ? Number(h['x-history-rows']) : null;
  r.source = h['x-history-source'] ?? null;
  r.gap = h['x-history-gap'] ?? null;
  r.truncated = h['x-history-truncated'] ?? null;
});
const finish = (e, failed) => {
  const r = pending.get(e.requestId);
  if (!r) return;
  pending.delete(e.requestId);
  r.ms = Math.round((e.timestamp - r.t0) * 1000);
  if (failed) {
    r.failed = e.errorText;
    r.canceled = Boolean(e.canceled);
  } else r.bytes = e.encodedDataLength;
  frames.push(r);
};
cdp.on('Network.loadingFinished', (e) => finish(e, false));
cdp.on('Network.loadingFailed', (e) => finish(e, true));

/**
 * 'aircraft-bbox', 'vessels-global', 'track', 'meta:coverage', ... A bbox
 * of the whole world (what the flights view sends for a globe view) is a
 * global slice.
 */
function classify(url) {
  const u = new URL(url);
  const feed = u.searchParams.get('feed') ?? '';
  if (u.pathname === '/api/history/slice') {
    const b = (u.searchParams.get('bbox') ?? '').split(',').map(Number);
    const world =
      b.length === 4 &&
      b[0] <= -179.9 &&
      b[1] <= -89 &&
      b[2] >= 179.9 &&
      b[3] >= 89;
    return `${feed}-${b.length === 4 && !world ? 'bbox' : 'global'}`;
  }
  if (u.pathname === '/api/history/track') return 'track';
  return `meta:${u.pathname.split('/').pop()}`;
}

/**
 * Page screenshot with the world-overlay canvas readback laid over it (a
 * software 2-D {desynchronized: true} canvas is not composited into page
 * screenshots; see qa-history-b12b.mjs). The readback is saved too.
 */
async function shot(name) {
  await page.bringToFront();
  const overlay = await page.evaluate(async () => {
    const c = document.getElementById('world-overlay-canvas');
    if (!c?.width) return null;
    const url = c.toDataURL('image/png');
    const img = document.createElement('img');
    img.id = 'qa-overlay-readback';
    const cs = getComputedStyle(c);
    for (const k of [
      'position',
      'left',
      'top',
      'width',
      'height',
      'zIndex',
      'transform',
      'opacity',
      'mixBlendMode',
    ])
      img.style[k] = cs[k];
    img.style.pointerEvents = 'none';
    img.src = url;
    c.after(img);
    await img.decode();
    return url;
  });
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  await page.evaluate(() =>
    document.getElementById('qa-overlay-readback')?.remove(),
  );
  if (overlay)
    writeFileSync(
      path.join(OUT, `${name}-overlay.png`),
      Buffer.from(overlay.split(',')[1], 'base64'),
    );
  say('screenshot', file, overlay ? '(+ overlay readback)' : '');
}

/** Everything the checks read, in one page round trip. */
const state = () =>
  page.evaluate(() => {
    const dm = window.__godsEyeView.dataManager;
    const swap = window.__gevHistorySwap;
    const router = swap?.router;
    const rs = router?.getState?.() ?? null;
    const enabled = [...(dm.getEnabledLayerIds?.() ?? [])];
    const adapters = (router?.adapters ?? []).map((a) => ({
      id: a.id,
      layerId: a.layerId,
      swapped: Boolean(router.isSwapped?.(a.id)),
      failed: Boolean(router.isFailed?.(a.id)),
    }));
    const root = document.querySelector('[data-gev-history]');
    const chips = [...(root?.querySelectorAll('.gev-hist-chip') ?? [])].map(
      (c) => {
        const cs = getComputedStyle(c);
        return {
          feed: c.getAttribute('data-feed'),
          state: c.getAttribute('data-state'),
          text: c.textContent,
          visible:
            c.getClientRects().length > 0 &&
            cs.visibility !== 'hidden' &&
            cs.display !== 'none' &&
            Number(cs.opacity) > 0,
        };
      },
    );
    const counts = {};
    for (const id of enabled) {
      const st = dm.layers.get(id)?.module?.getStats?.() ?? {};
      counts[id] = st.count ?? null;
    }
    const hs = swap?.handle?.getState?.() ?? {};
    return {
      mode: root?.getAttribute('data-mode') ?? null,
      timeMs: hs.timeMs ?? null,
      playing: Boolean(hs.playing),
      rate: hs.rate ?? null,
      enabled,
      adapters,
      chips,
      counts,
      router: rs
        ? {
            active: rs.active,
            swapped: rs.swapped,
            failed: rs.failed,
            stats: rs.stats,
            prefetchInFlight: rs.prefetchInFlight,
            prefetchQueued: rs.prefetchQueued,
            servedFlightsT: rs.served?.flights?.t ?? null,
            track: rs.track
              ? {
                  hex: rs.track.icao24 ?? rs.track.id ?? null,
                  points: rs.track.points ?? rs.track.count ?? null,
                }
              : null,
          }
        : null,
      tracked:
        dm.layers.get('flights')?.module?.getTrackedInfo?.()?.icao24 ?? null,
    };
  });

/** D5 invariant over every enabled layer. Returns the problems. */
function liveChipProblems(st) {
  const problems = [];
  const chipOf = (id) => st.chips.find((c) => c.feed === `layer:${id}`);
  for (const id of st.enabled) {
    const swapped = st.adapters.some((a) => a.layerId === id && a.swapped);
    const chip = chipOf(id);
    if (swapped) {
      if (chip) problems.push(`${id}: swapped but has a LIVE chip`);
    } else if (!chip) problems.push(`${id}: not swapped and no LIVE chip`);
    else if (
      chip.state !== 'unswapped' ||
      !/: LIVE( \(history unavailable\))?$/.test(chip.text)
    )
      problems.push(`${id}: chip ${chip.state} '${chip.text}'`);
    else if (!chip.visible) problems.push(`${id}: LIVE chip not visible`);
  }
  for (const a of st.adapters)
    if (st.enabled.includes(a.layerId) && a.failed) {
      const chip = chipOf(a.layerId);
      if (!/: LIVE \(history unavailable\)$/.test(chip?.text ?? ''))
        problems.push(
          `${a.layerId}: failed feed without 'history unavailable'`,
        );
    }
  return problems;
}

async function waitFor(pred, what, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  let st;
  for (;;) {
    st = await state();
    if (pred(st)) return st;
    if (Date.now() > end) {
      say('timeout waiting for', what);
      return st;
    }
    await sleep(1000);
  }
}

async function view({ lat, lon, alt }) {
  await page.evaluate(
    ({ lat, lon, alt }) => {
      const v = window.__godsEyeView.viewer;
      v.trackedEntity = undefined;
      const r = Math.PI / 180;
      v.camera.setView({
        destination: v.scene.globe.ellipsoid.cartographicToCartesian({
          longitude: lon * r,
          latitude: lat * r,
          height: alt,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
    },
    { lat, lon, alt },
  );
  await sleep(2_000);
}

// ── 0. load ──────────────────────────────────────────────────
await page.goto(`${BASE}/?welcome=0${HASH}`, {
  waitUntil: 'domcontentloaded',
  timeout: 180000,
});
await page.waitForFunction(
  () => window.__godsEyeView?.dataManager && window.__gevHistorySwap,
  { timeout: 240000 },
);
// Chromium now holds the Basic Auth credentials of this origin and sends
// them preemptively; turn the request interception that page.authenticate
// installs off again (with it on, some slice requests stalled in the
// browser for minutes in the QA runs, a Puppeteer artefact, not the app).
// A request that then gets a 401 is recorded and fails the run.
if (process.env.QA_AUTH_USER) await page.authenticate(null);
await sleep(SETTLE_MS);
await page.keyboard.press('Escape');
results.gl = await page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  const ext = gl?.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
});
say('WebGL renderer', results.gl);

// ── 1. every layer on, live ──────────────────────────────────
phase = 'live-all';
const all = await page.evaluate(() =>
  window.__godsEyeView.dataManager.getAll().map((l) => l.id),
);
const enableErrors = await page.evaluate(async (ids) => {
  const dm = window.__godsEyeView.dataManager;
  const bad = {};
  for (const id of ids) {
    try {
      await Promise.race([
        dm.setEnabled(id, true),
        new Promise((_, no) =>
          setTimeout(() => no(new Error('timeout')), 20000),
        ),
      ]);
    } catch (e) {
      bad[id] = String(e?.message ?? e).slice(0, 120);
    }
  }
  return bad;
}, all);
await sleep(15_000);
let st = await state();
results.layers = { registered: all.length, enabled: st.enabled.length };
say('layers registered', all.length, 'enabled', st.enabled.length);
say('enable errors', enableErrors);
check(st.mode === 'live', `live mode at start (${st.mode})`);
check(
  !st.chips.some((c) => c.state === 'unswapped'),
  'no LIVE chips while live',
);
await shot('01-live-every-layer');
const e0 = errors.length;
say('errors before history (app, not history):', errors.slice(0, 10));

// ── 2. history at t0: the LIVE-chip test ─────────────────────
phase = 'enter';
await page.evaluate((t) => {
  const h = window.__gevHistorySwap.handle;
  h.expand(true);
  h.seek(t, { snap: true });
}, T0);
// settle: the chip list must stop changing (every feed answered or failed)
let sig = '';
let stable = 0;
const end = Date.now() + 90_000;
while (Date.now() < end && stable < 4) {
  await sleep(2_000);
  st = await state();
  const s = JSON.stringify([st.chips, st.router?.swapped, st.router?.failed]);
  stable = s === sig && st.router?.active ? stable + 1 : 0;
  sig = s;
}
const problems = liveChipProblems(st);
const swappedLayers = st.adapters
  .filter((a) => a.swapped && st.enabled.includes(a.layerId))
  .map((a) => a.layerId);
const liveChips = st.chips.filter((c) => c.state === 'unswapped');
results.liveChipTest = {
  enabled: st.enabled.length,
  swapped: swappedLayers,
  failed: st.adapters.filter((a) => a.failed).map((a) => a.id),
  liveChips: liveChips.length,
  unavailable: liveChips
    .filter((c) => /unavailable/.test(c.text))
    .map((c) => c.feed),
  problems,
  // history requests still open at the check (url class, seconds open)
  pending: [...pending.values()].map((r) => [
    classify(r.url),
    Math.round((Date.now() - r.wall) / 1000),
  ]),
  routerFailed: st.router?.failed ?? null,
};
say('LIVE-chip test', results.liveChipTest);
check(st.mode === 'history' && st.router?.active, 'history mode active');
check(
  swappedLayers.length + liveChips.length === st.enabled.length,
  `every enabled layer is swapped or chipped (${swappedLayers.length} + ${liveChips.length} = ${st.enabled.length})`,
);
check(problems.length === 0, `LIVE-chip invariant ${JSON.stringify(problems)}`);
check(swappedLayers.includes('flights'), 'flights answered from history');
await shot('02-history-every-layer-live-chips');

// ── 3. history-capable layers only; select an aircraft ───────
phase = 'select';
// --disable a,b: leave these history layers off for the playback (diagnosis)
const DISABLE = new Set(
  (arg('--disable', '') || '').split(',').filter(Boolean),
);
const keep = new Set(
  st.adapters.map((a) => a.layerId).filter((id) => !DISABLE.has(id)),
);
await page.evaluate(
  async (ids) => {
    const dm = window.__godsEyeView.dataManager;
    for (const id of [...dm.getEnabledLayerIds()])
      if (!ids.includes(id)) await dm.setEnabled(id, false).catch(() => {});
  },
  [...keep],
);
await sleep(5_000);
/** An airborne aircraft of the newest aircraft slice the page received. */
async function aircraftOfLatestFrame(skip = new Set()) {
  const last = [...frames]
    .reverse()
    .find((f) => /feed=aircraft/.test(f.url) && f.status === 200 && f.rows > 0);
  if (!last) return null;
  try {
    const { body } = await cdp.send('Network.getResponseBody', {
      requestId: last.id,
    });
    const states = JSON.parse(body).states ?? [];
    const air = states.filter(
      (s) => s[8] === false && s[6] != null && !skip.has(s[0]),
    );
    return (air[Math.floor(air.length / 2)] ?? states[0])?.[0] ?? null;
  } catch (e) {
    say('could not read an aircraft slice body', String(e));
    return null;
  }
}
const NO_SELECT = flag('--no-select');
const selectAircraft = (h) =>
  NO_SELECT
    ? Promise.resolve(false)
    : page.evaluate(
        (hx) =>
          window.__godsEyeView.dataManager.layers
            .get('flights')
            .module.trackById(hx, { origin: 'user' }),
        h,
      );
const selected = new Set();
const hex = await aircraftOfLatestFrame();
say('selecting aircraft', hex);
const tracksBefore = frames.filter((f) => classify(f.url) === 'track').length;
if (hex) {
  selected.add(hex);
  await selectAircraft(hex);
}
st = await waitFor(
  (s) => s.chips.some((c) => c.feed === 'history-track:flights'),
  'track chip',
  30_000,
);
const trackChip = st.chips.find((c) => c.feed === 'history-track:flights');
say('track chip', trackChip);
check(Boolean(hex), 'an aircraft of the shown frame was found');
check(
  frames.filter((f) => classify(f.url) === 'track').length > tracksBefore,
  'selecting it asked /api/history/track',
);
check(
  Boolean(trackChip?.visible),
  `recorded-track chip shown (${trackChip?.text})`,
);
await view(TEXAS);
await shot('03-history-selected-track');

// ── 4. playback at RATE for MINUTES ──────────────────────────
const samples = [];
const playMs = MINUTES * 60_000;
const halves = [
  { name: 'texas', at: TEXAS },
  { name: 'globe', at: GLOBE },
];
if (!flag('--skip-playback')) {
  await page.evaluate(
    (t, rate) => {
      const h = window.__gevHistorySwap.handle;
      h.seek(t);
      h.setRate(rate);
      h.play();
    },
    T0,
    RATE,
  );
  const wall0 = Date.now();
  const hist0 = (await state()).timeMs;
  for (const half of halves) {
    phase = `play-${half.name}`;
    await view(half.at);
    const stop = wall0 + playMs * (half.name === 'texas' ? 0.5 : 1);
    let n = 0;
    while (Date.now() < stop) {
      await sleep(Math.min(15_000, Math.max(0, stop - Date.now())));
      st = await state();
      const sample = {
        phase,
        wallS: Math.round((Date.now() - wall0) / 1000),
        timeMs: st.timeMs,
        playing: st.playing,
        lagMs:
          st.router?.servedFlightsT != null && st.timeMs != null
            ? st.timeMs -
              (typeof st.router.servedFlightsT === 'number'
                ? st.router.servedFlightsT
                : Date.parse(st.router.servedFlightsT))
            : null,
        flights: st.counts.flights ?? null,
        prefetchInFlight: st.router?.prefetchInFlight ?? null,
        stats: st.router?.stats ?? null,
      };
      samples.push(sample);
      if (n++ % 4 === 0) say('sample', sample);
      results.samples = samples;
      save();
      if (!st.playing) {
        say('playback stopped by itself; resuming');
        await page.evaluate(() => window.__gevHistorySwap.handle.play());
      }
      // every ~60 s select another aircraft of the shown frame: its
      // recorded track [t-6h, t] is a timed /api/history/track request
      if (n % 4 === 0) {
        const next = await aircraftOfLatestFrame(selected);
        if (next) {
          selected.add(next);
          await selectAircraft(next);
          await view(half.at);
        }
      }
    }
    await shot(`04-playback-${half.name}`);
  }
  phase = 'after';
  st = await state();
  await page.evaluate(() => window.__gevHistorySwap.handle.pause());
  const wallS = (Date.now() - wall0) / 1000;
  const histS = (st.timeMs - hist0) / 1000;
  results.playback = {
    wallS: Math.round(wallS),
    historyS: Math.round(histS),
    speed: Math.round((histS / wallS) * 10) / 10,
    stats: st.router?.stats ?? null,
  };
  say('playback', results.playback);
  check(
    wallS >= MINUTES * 60 - 5,
    `played ${Math.round(wallS)} s of wall clock`,
  );
  check(
    histS >= wallS * RATE * 0.9,
    `shown time advanced ${results.playback.speed}x (rate ${RATE})`,
  );
  const maxInFlight = st.router?.stats?.maxInFlight ?? null;
  check(
    maxInFlight != null && maxInFlight <= 2,
    `prefetch in flight max ${maxInFlight} (<= 2)`,
  );
  check(
    (st.router?.stats?.prefetches ?? 0) > 0,
    `prefetched ${st.router?.stats?.prefetches}`,
  );
  const lags = samples.map((s) => s.lagMs).filter((v) => v != null);
  results.playback.servedLagHistoryMs = {
    p50: pct(lags, 50),
    p95: pct(lags, 95),
    max: lags.length ? Math.max(...lags) : null,
  };
  say('shown-frame lag (history ms)', results.playback.servedLagHistoryMs);
}

// frame fetch latency: every timed /api/history request of the playback,
// plus the track requests of the first selection
const played = frames.filter(
  (f) =>
    /^play-/.test(f.phase) ||
    (f.phase === 'select' && classify(f.url) === 'track'),
);
const groups = {};
for (const f of played) {
  const k = classify(f.url);
  (groups[k] ??= []).push(f);
}
results.frameFetch = {};
for (const [k, list] of Object.entries(groups).sort()) {
  const ok = list.filter((f) => !f.failed && f.status < 400);
  const miss = ok.filter((f) => f.cache === 'MISS');
  const ms = ok.map((f) => f.ms);
  const row = {
    n: list.length,
    ok: ok.length,
    canceled: list.filter((f) => f.canceled).length,
    failed: list.filter((f) => f.failed && !f.canceled).length,
    http: [...new Set(list.map((f) => f.status).filter(Boolean))],
    p50: pct(ms, 50),
    p95: pct(ms, 95),
    max: ms.length ? Math.max(...ms) : null,
    missN: miss.length,
    missP95: pct(
      miss.map((f) => f.ms),
      95,
    ),
    rowsP50: pct(
      ok.map((f) => f.rows ?? 0),
      50,
    ),
    target: TARGETS[k] ?? null,
  };
  results.frameFetch[k] = row;
  say('frame fetch', k, row);
}
writeFileSync(path.join(OUT, 'frames.json'), JSON.stringify(frames, null, 1));
results.protocols = [...new Set(frames.map((f) => f.protocol).filter(Boolean))];
say('history request protocols', results.protocols);
const unauth = frames.filter((f) => f.status === 401).length;
check(
  unauth === 0,
  `no history request was refused by the auth hop (${unauth} x 401)`,
);
if (!flag('--skip-playback')) {
  for (const [k, target] of Object.entries(TARGETS)) {
    const row = results.frameFetch[k];
    if (!row || !row.ok) {
      check(false, `${k}: no successful request during playback`);
      continue;
    }
    check(
      row.p95 < target,
      `${k} p95 ${row.p95} ms < ${target} ms (n=${row.ok}, MISS p95 ${row.missP95} n=${row.missN})`,
    );
  }
  const bad = played.filter(
    (f) => !f.canceled && (f.failed || f.status >= 500),
  );
  check(
    bad.length === 0,
    `no failed history request during playback (${bad.length}: ${JSON.stringify(bad.slice(0, 5).map((f) => [classify(f.url), f.status, f.failed]))})`,
  );
}

// diagnosis: entity polylines whose consecutive points are (near)
// antipodal (Cesium's geodesic arc refuses them: 'Rendering has stopped')
results.antipodalPolylines = await page.evaluate(() => {
  const v = window.__godsEyeView.viewer;
  const time = v.clock.currentTime;
  const out = [];
  const scan = (entities, source) => {
    for (const e of entities.values) {
      const pl = e.polyline;
      if (!pl?.positions) continue;
      let pts;
      try {
        pts = pl.positions.getValue(time) ?? [];
      } catch {
        continue;
      }
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const la = Math.hypot(a.x, a.y, a.z);
        const lb = Math.hypot(b.x, b.y, b.z);
        const cos = (a.x * b.x + a.y * b.y + a.z * b.z) / (la * lb);
        if (!(cos > -0.9999)) {
          out.push({
            source,
            id: String(e.id).slice(0, 80),
            i,
            n: pts.length,
            a: [a.x, a.y, a.z].map((x) => Math.round(x)),
            b: [b.x, b.y, b.z].map((x) => Math.round(x)),
            cos,
          });
          break;
        }
      }
    }
  };
  scan(v.entities, 'viewer');
  for (let k = 0; k < v.dataSources.length; k++) {
    const ds = v.dataSources.get(k);
    scan(ds.entities, ds.name ?? `ds${k}`);
  }
  return out.slice(0, 20);
});
say('antipodal polylines', results.antipodalPolylines);

// ── 5. LIVE ──────────────────────────────────────────────────
phase = 'live-end';
await page.click('.gev-hist-live');
st = await waitFor(
  (s) => s.mode === 'live' && !s.chips.some((c) => c.state === 'unswapped'),
  'live mode',
  30_000,
);
check(st.mode === 'live', `LIVE returns to live mode (${st.mode})`);
check(
  !st.chips.some((c) => c.state === 'unswapped'),
  'no LIVE chip left after LIVE',
);
check(!st.router?.active, 'router inactive after LIVE');
await sleep(5_000);
await shot('05-live-restored');

check(
  errors.length === e0,
  `no console/page error after the first history interaction (${JSON.stringify(errors.slice(e0, e0 + 10))})`,
);
results.errorsAfterHistory = errors.slice(e0);
results.consoleDiag = diag.slice(0, 50);
save();
await browser.close();
say(failures.length ? `QA B12 FAIL (${failures.length})` : 'QA B12 PASS');
save();
process.exit(failures.length ? 1 : 0);
