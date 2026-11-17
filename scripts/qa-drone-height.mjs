#!/usr/bin/env node
/**
 * Rendered check of the drone plan Height mode (Flat / Above ground), the
 * terrain points on timed lines, the takeoff-relative height lines and the
 * no-takeoff warning, at phone (390x844, touch) and desktop (1280x900).
 * Uses Brandon's saved plan "Byrd New 200 Down Shop and house" (timed grid,
 * 200 ft, no takeoff point).
 *   QA_BASE_URL  app to test     QA_SHOT_DIR  screenshots (optional)
 *   QA_PLAN      saved plan JSON (v/1.json)
 *   QA_KMZ=1     also build each mission's waylines.wpml in the page (dev server only)
 */
import { readFileSync } from 'node:fs';
import puppeteer from 'puppeteer';

const BASE_URL = process.env.QA_BASE_URL || 'http://127.0.0.1:5235';
const SHOTS = process.env.QA_SHOT_DIR || '';
const KMZ = process.env.QA_KMZ === '1';
const PLAN = JSON.parse(readFileSync(process.env.QA_PLAN, 'utf8'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, msg) => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${msg}`);
  if (!ok) failures.push(msg);
};

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
});

const box = PLAN.areas?.[0]?.box ?? PLAN.box;
const VIEW = {
  lon: (box.west + box.east) / 2,
  lat: (box.south + box.north) / 2,
  height: 1200,
};

async function boot(page, viewport) {
  await page.setViewport(viewport);
  await page.goto(`${BASE_URL}/?welcome=0`, {
    waitUntil: 'domcontentloaded',
    timeout: 240_000,
  });
  await page.waitForFunction(
    () =>
      window.__gevDronePlan &&
      window.__godsEyeView &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 240_000 },
  );
  await page.evaluate((view) => {
    const viewer = window.__godsEyeView.viewer;
    viewer.camera.cancelFlight?.();
    viewer.camera.setView({
      destination: viewer.scene.globe.ellipsoid.cartographicToCartesian({
        longitude: (view.lon * Math.PI) / 180,
        latitude: (view.lat * Math.PI) / 180,
        height: view.height,
      }),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
  }, VIEW);
  await wait(5000);
}

const ready = (page) =>
  page.waitForFunction(
    () => {
      const p = document.getElementById('drone-plan-panel');
      const s = window.__gevDronePlan.getState();
      return p?.dataset.state === 'ready' && !s.dirty;
    },
    { timeout: 180_000 },
  );

const read = (page, kmz) =>
  page.evaluate(async (kmz) => {
    const panel = document.getElementById('drone-plan-panel');
    const s = window.__gevDronePlan.getState();
    const r = window.__gevDronePlan.getResult();
    const stats = {};
    for (const dt of panel.querySelectorAll('dt'))
      stats[dt.textContent] = dt.nextElementSibling?.textContent;
    const role = (n) => panel.querySelector(`[data-role=${n}]`);
    const vis = (n) => !!n && n.offsetParent !== null && !n.hidden;
    const sel = (label) =>
      [...panel.querySelectorAll('select')].find(
        (n) => n.getAttribute('aria-label') === label,
      );
    const warn = panel.querySelector('li[data-code=takeoff-unset]');
    const wps = (r?.missions ?? []).flatMap(
      (m) => m.waypoints ?? m.legs.flatMap((l) => l.waypoints),
    );
    const rel = [
      ...new Set(wps.map((w) => w.relHeightM).filter((x) => x != null)),
    ];
    let kmzHeights = null;
    if (kmz && r?.missions?.length) {
      const wpml = await import('/src/byrdit/dronePlan/wpml.js');
      kmzHeights = [];
      for (const m of r.missions) {
        const { waylinesWpml } = wpml.buildMissionFiles(m, r.plan);
        for (const x of waylinesWpml.matchAll(/<wpml:executeHeight>([^<]+)</g))
          kmzHeights.push(Number(x[1]));
      }
    }
    const hm = sel('Height mode');
    for (const n0 of [hm, warn, role('terrain-step')])
      for (let p = n0; p; p = p.parentElement)
        if (p.tagName === 'DETAILS') p.open = true;
    hm?.scrollIntoView({ block: 'center' });
    await new Promise((r) => setTimeout(r, 300));
    const hb = hm?.getBoundingClientRect();
    const pb = panel.getBoundingClientRect();
    return {
      heightMode: s.options.heightMode,
      terrainStepM: s.options.terrainStepM,
      capture: s.options.captureMode,
      takeoff: !!s.takeoff,
      selectValue: hm?.value,
      selectVisible: vis(hm),
      selectInside: hb
        ? hb.left >= pb.left - 0.5 && hb.right <= pb.right + 0.5
        : null,
      selectHit: hb
        ? document.elementFromPoint(
            hb.left + hb.width / 2,
            hb.top + hb.height / 2,
          ) === hm
        : null,
      overflowX: panel.scrollWidth - panel.clientWidth,
      stepVisible: vis(role('terrain-step')),
      stepNote: role('terrain-step-note')?.textContent,
      heightLabel: panel
        .querySelector('input[type=range][aria-label^="Height above"]')
        ?.getAttribute('aria-label'),
      warnVisible: vis(warn),
      warnText: warn?.textContent ?? null,
      stats: {
        mode: stats['Height mode'],
        agl: stats['Above ground'],
        dji: stats['DJI Fly shows'],
        added: stats['Terrain points added'],
      },
      heights: r?.heights,
      added: r?.plan?.terrainPoints?.added ?? null,
      waypoints: r?.totals?.waypointCount,
      missions: r?.missions?.length,
      rel,
      kmzHeights,
    };
  }, kmz);

const pickSelect = async (page, label, value) => {
  const handle = await page.evaluateHandle((label) => {
    const n = [...document.querySelectorAll('#drone-plan-panel select')].find(
      (x) => x.getAttribute('aria-label') === label,
    );
    for (let p = n; p; p = p.parentElement)
      if (p.tagName === 'DETAILS') p.open = true;
    n.scrollIntoView({ block: 'center' });
    return n;
  }, label);
  await wait(200);
  await handle.select(value);
  await wait(600);
};

const shot = async (page, name, anchor) => {
  if (!SHOTS) return;
  await page.evaluate((a) => {
    const n = [
      ...document.querySelectorAll(
        '#drone-plan-panel select, #drone-plan-panel dt, #drone-plan-panel li',
      ),
    ].find(
      (x) =>
        x.getAttribute('aria-label') === a ||
        x.textContent === a ||
        x.dataset?.code === a,
    );
    n?.scrollIntoView({ block: 'start' });
  }, anchor);
  await wait(400);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

const near = (a, b, tol) => Math.abs(a - b) <= tol;
// The desktop panel already scrolled 18 px sideways on the live build before
// this change (7acf50ebf, same plan); the check is that it gets no worse.
const OVERFLOW_BEFORE = { 'phone-390': 0, 'desktop-1280': 18 };

async function exercise(page, label) {
  await page.evaluate(async (doc) => {
    window.__gevDronePlan.open({ draw: false });
    await window.__gevDronePlan.loadPlan(doc);
  }, PLAN);
  await wait(800);
  await ready(page);
  // On the phone shell the panel's rail stayed display:none after a scripted
  // loadPlan in this check; open() shows it, as the Context tab does.
  await page.evaluate(() => window.__gevDronePlan.open({ draw: false }));
  await wait(600);
  let r = await read(page, KMZ);
  console.log(`${label}: opened ${JSON.stringify(r)}`);
  check(
    r.heightMode === 'terrain' && r.selectValue === 'terrain',
    `${label}: saved plan opens as Above ground`,
  );
  check(
    r.selectVisible && r.selectInside && r.selectHit,
    `${label}: Height mode select visible, inside the panel, not covered`,
  );
  check(
    r.overflowX <= OVERFLOW_BEFORE[label],
    `${label}: no more sideways overflow than before (${r.overflowX} px, live before: ${OVERFLOW_BEFORE[label]} px)`,
  );
  check(
    r.capture === 'timed' && r.stepVisible,
    `${label}: timed plan shows Terrain points on lines`,
  );
  check(
    /only at the line ends/.test(r.stepNote ?? ''),
    `${label}: Off note says line ends only`,
  );
  check(
    !r.takeoff && r.warnVisible && /box centre/.test(r.warnText ?? ''),
    `${label}: no-takeoff warning shown`,
  );
  check(
    /^Above ground/.test(r.stats.mode ?? ''),
    `${label}: stats Height mode "${r.stats.mode}"`,
  );
  check(
    !!r.stats.agl && !!r.stats.dji,
    `${label}: stats Above ground "${r.stats.agl}", DJI Fly shows "${r.stats.dji}"`,
  );
  check(
    r.heights &&
      r.rel.length > 0 &&
      near(Math.min(...r.rel), r.heights.relMinM, 0.11) &&
      near(Math.max(...r.rel), r.heights.relMaxM, 0.11),
    `${label}: DJI Fly range ${r.heights?.relMinM}..${r.heights?.relMaxM} m matches the waypoints ${Math.min(...r.rel)}..${Math.max(...r.rel)}`,
  );
  check(
    r.heights && r.heights.relMinM < 60.96 - 3,
    `${label}: Above ground from box centre: some waypoints under 200 ft in DJI Fly (min ${r.heights?.relMinM} m) - the reported 180 ft`,
  );
  if (KMZ)
    check(
      r.kmzHeights.length > 0 &&
        near(Math.min(...r.kmzHeights), r.heights.relMinM, 0.11),
      `${label}: KMZ heights min ${Math.min(...r.kmzHeights)} = shown`,
    );
  await shot(page, `height-terrain-${label}`, 'Height mode');
  const before = r.waypoints;

  // Terrain points every first choice.
  const firstStep = await page.evaluate(() =>
    [
      ...[...document.querySelectorAll('#drone-plan-panel select')].find(
        (x) => x.getAttribute('aria-label') === 'Terrain points on lines',
      ).options,
    ]
      .map((o) => o.value)
      .find((v) => v),
  );
  await pickSelect(page, 'Terrain points on lines', firstStep);
  await ready(page);
  r = await read(page, KMZ);
  console.log(
    `${label}: terrain points ${JSON.stringify({ ...r, rel: r.rel.length, kmzHeights: r.kmzHeights?.length })}`,
  );
  check(
    r.terrainStepM === Number(firstStep) && r.added > 0,
    `${label}: every ${firstStep} m adds ${r.added} points`,
  );
  check(
    r.stats.added === String(r.added) ||
      r.stats.added === r.added.toLocaleString(),
    `${label}: stats Terrain points added "${r.stats.added}"`,
  );
  check(
    r.waypoints >= before + r.added,
    `${label}: waypoint count ${before} -> ${r.waypoints}`,
  );
  check(
    new RegExp(`^${r.added}`).test(r.stepNote?.replace(/,/g, '') ?? ''),
    `${label}: note names the added count`,
  );
  if (KMZ)
    check(
      r.kmzHeights.length >= r.waypoints,
      `${label}: KMZ has ${r.kmzHeights.length} heights for ${r.waypoints} waypoints`,
    );
  await shot(page, `height-points-${label}`, 'Terrain points on lines');

  // Flat.
  await pickSelect(page, 'Height mode', 'flat');
  await ready(page);
  r = await read(page, KMZ);
  console.log(
    `${label}: flat ${JSON.stringify({ ...r, rel: r.rel, kmzHeights: r.kmzHeights && [...new Set(r.kmzHeights)] })}`,
  );
  check(
    r.heightMode === 'flat' && !r.stepVisible,
    `${label}: Flat hides terrain points`,
  );
  check(
    r.heightLabel === 'Height above takeoff',
    `${label}: height slider reads "${r.heightLabel}"`,
  );
  check(
    r.rel.length === 1 && near(r.rel[0], 60.96, 0.11),
    `${label}: Flat waypoints all ${JSON.stringify(r.rel)} m above takeoff`,
  );
  check(
    /^200 ft to 200 ft above takeoff$/.test(r.stats.dji ?? ''),
    `${label}: DJI Fly shows "${r.stats.dji}"`,
  );
  check(
    r.added == null || r.added === 0,
    `${label}: no terrain points in Flat (${r.added})`,
  );
  check(
    r.heights.aglMinM < r.heights.aglMaxM,
    `${label}: Above ground varies ${r.heights.aglMinM}..${r.heights.aglMaxM} m ("${r.stats.agl}")`,
  );
  if (KMZ)
    check(
      new Set(r.kmzHeights).size === 1 && near(r.kmzHeights[0], 60.96, 0.11),
      `${label}: KMZ executeHeight all ${[...new Set(r.kmzHeights)]}`,
    );
  check(
    r.overflowX <= OVERFLOW_BEFORE[label],
    `${label}: no more sideways overflow in Flat (${r.overflowX} px)`,
  );
  await shot(page, `height-flat-${label}`, 'Height mode');
  await shot(page, `height-flat-stats-${label}`, 'DJI Fly shows');

  // Takeoff set at the NE corner: warning goes.
  await page.evaluate(
    (b) =>
      window.__gevDronePlan.setTakeoff({
        lon: b.east - 0.0002,
        lat: b.north - 0.0002,
      }),
    box,
  );
  await wait(600);
  await ready(page);
  r = await read(page, false);
  check(
    r.takeoff && !r.warnVisible,
    `${label}: setting a takeoff point removes the warning`,
  );
}

for (const [label, vp] of [
  [
    'phone-390',
    {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    },
  ],
  ['desktop-1280', { width: 1280, height: 900 }],
]) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log(`${label} pageerror: ${e.message}`));
  try {
    await page.evaluateOnNewDocument(() => localStorage.clear());
    await boot(page, vp);
    await exercise(page, label);
  } catch (e) {
    console.log(`[FAIL] ${label}: ${e.message}`);
    failures.push(`${label}: ${e.message}`);
  }
  await page.close();
}
await browser.close();
console.log(
  failures.length
    ? `FAILED ${failures.length}: ${failures.join('; ')}`
    : 'ALL PASS',
);
process.exit(failures.length ? 1 : 0);
