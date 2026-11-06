#!/usr/bin/env node
/**
 * Rendered check of WHERE the Drone Flight Plan draws the aircraft: waypoint
 * markers and the apex of the 3D-check camera pyramid must sit at the planned
 * aircraft position (ground height under it + its height above ground),
 * while ground footprints stay on the surface.
 *
 *   QA_BASE_URL   app to test (default http://127.0.0.1:4291)
 *   QA_SHOT_DIR   screenshots and the JSON report (default qa-shots/drone-elevation)
 *   QA_LON/QA_LAT site (default: a hilly spot near Austin, TX)
 *   QA_AGL_M      height above ground to plan, metres (default 120)
 *
 * It measures, it does not assume: every number the report needs is read back
 * from the live Cesium scene, and the process exits 1 if an apex or marker is
 * off the planned position by more than the tolerance.
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const BASE_URL = process.env.QA_BASE_URL || 'http://127.0.0.1:4291';
const SHOT_DIR = path.resolve(
  process.env.QA_SHOT_DIR || 'qa-shots/drone-elevation',
);
const TOL_M = Number(process.env.QA_TOL_M ?? 1.5);
const AGL_M = Number(process.env.QA_AGL_M ?? 120);
const VIEW = {
  lon: Number(process.env.QA_LON ?? -97.7729),
  lat: Number(process.env.QA_LAT ?? 30.2663),
  height: 700,
};
fs.mkdirSync(SHOT_DIR, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

const browser = await puppeteer.launch({
  headless: 'new',
  ...(process.env.PUPPETEER_EXECUTABLE_PATH
    ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
    : {}),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
});

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.setViewport({ width: 1280, height: 860 });
  await page.goto(`${BASE_URL}/?welcome=0`, {
    waitUntil: 'domcontentloaded',
    timeout: 180_000,
  });
  await page.waitForFunction(
    () =>
      window.__gevDronePlan &&
      window.__godsEyeView &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 180_000 },
  );
  const flyTo = (view) =>
    page.evaluate((v) => {
      const viewer = window.__godsEyeView.viewer;
      const C3 = viewer.camera.position.constructor;
      viewer.camera.cancelFlight?.();
      viewer.scene.tweens?.removeAll?.();
      viewer.camera.setView({
        destination: C3.fromDegrees(v.lon, v.lat, v.height),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      viewer.scene.requestRender();
    }, view);
  await flyTo(VIEW);
  await wait(Number(process.env.QA_SETTLE_MS || 9000));

  // QA_UNSAMPLED=1 reproduces a terrain that cannot be sampled (a timeout, a
  // rate limit, a keyless fallback): the planner then plans on flat ground at
  // height 0 while the globe still draws the real surface.
  if (process.env.QA_UNSAMPLED === '1') {
    await page.evaluate(() => {
      const viewer = window.__godsEyeView.viewer;
      // The planner's sampler sees a provider with no tile geometry (so it
      // reports terrain "unknown"), while the globe keeps drawing real terrain.
      Object.defineProperty(viewer, 'terrainProvider', {
        configurable: true,
        get: () => ({}),
      });
    });
  }
  const env = await page.evaluate(() => {
    const viewer = window.__godsEyeView.viewer;
    const tp = viewer.terrainProvider ?? viewer.scene.globe.terrainProvider;
    return {
      terrainProvider: tp?.constructor?.name,
      hasRequestTileGeometry: typeof tp?.requestTileGeometry === 'function',
      globeShow: viewer.scene.globe.show,
      primitives: viewer.scene.primitives.length,
    };
  });
  console.log('environment:', JSON.stringify(env));

  // The right rail lists launchers; the Drone Flight Plan one opens the card.
  const launcher = await page.evaluateHandle(() =>
    [...document.querySelectorAll('#right-context-rail *, #right-rail *')]
      .filter((n) => n.children.length === 0 || n.tagName === 'BUTTON')
      .find((n) => /^\s*DRONE FLIGHT PLAN\s*$/i.test(n.textContent)),
  );
  if (launcher.asElement()) await launcher.asElement().click();
  await wait(800);
  await page
    .waitForFunction(
      () =>
        document.getElementById('drone-plan-panel')?.getBoundingClientRect()
          .width > 0,
      { timeout: 30_000 },
    )
    .catch(async (e) => {
      console.log(
        'panel probe:',
        JSON.stringify(
          await page.evaluate(() => {
            const p = document.getElementById('drone-plan-panel');
            const r = p?.getBoundingClientRect();
            return {
              exists: Boolean(p),
              hidden: p?.hidden,
              cls: p?.className,
              parent: p?.parentElement?.id,
              rect: r && [r.x, r.y, r.width, r.height],
              ariaHidden: p?.getAttribute('aria-hidden'),
              rail: document.getElementById('right-context-rail')?.className,
            };
          }),
        ),
      );
      await page.screenshot({ path: path.join(SHOT_DIR, 'panel-probe.jpg') });
      throw e;
    });
  const collapsed = await page.evaluate(() =>
    document.getElementById('drone-plan-panel').classList.contains('collapsed'),
  );
  if (collapsed) {
    await page.click('#drone-plan-panel .panel-collapse-btn');
    await wait(400);
  }
  // Opening claims the pointer for the box drag; Escape then draw again, as
  // the main drone-plan QA does.
  await page.keyboard.press('Escape');
  await wait(250);
  await page.click(
    '#drone-plan-panel button[data-action="draw-box"]',
  );
  await wait(250);
  await page.mouse.move(420, 260);
  await page.mouse.down();
  await page.mouse.move(600, 360, { steps: 6 });
  await page.mouse.move(760, 520, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction(
    () => document.getElementById('drone-plan-panel')?.dataset.state === 'ready',
    { timeout: 120_000 },
  );
  // Plan at the requested height through the same entry the voice tool uses.
  await page.evaluate(async (agl) => {
    await window.__gevDronePlan.voice.options({ aglM: agl });
  }, AGL_M);
  await wait(6000);
  await page.waitForFunction(
    () => document.getElementById('drone-plan-panel')?.dataset.state === 'ready',
    { timeout: 120_000 },
  );

  // Everything below is measured in the page from the live scene.
  const measure = () =>
    page.evaluate(async () => {
      const viewer = window.__godsEyeView.viewer;
      const handle = window.__gevDronePlan;
      const time = viewer.clock.currentTime;
      const C3 = viewer.camera.position.constructor;
      const Carto = viewer.scene.globe.ellipsoid.cartesianToCartographic(
        viewer.camera.position,
      ).constructor;
      const deg = (r) => (r * 180) / Math.PI;
      const hOf = (cart) =>
        viewer.scene.globe.ellipsoid.cartesianToCartographic(cart);
      const surface = async (lonDeg, latDeg) => {
        const c = Carto.fromDegrees(lonDeg, latDeg);
        const globeH = viewer.scene.globe.getHeight(c);
        let tilesH = null;
        try {
          const [s] = await viewer.scene.sampleHeightMostDetailed([
            Carto.fromDegrees(lonDeg, latDeg),
          ]);
          tilesH = Number.isFinite(s?.height) ? s.height : null;
        } catch {
          tilesH = null;
        }
        return {
          globeH: Number.isFinite(globeH) ? globeH : null,
          tilesH,
        };
      };
      const result = handle.getResult();
      const wp0 = result.missions[0].waypoints[0];
      const tk = result.plan.takeoff;
      const takeoffGlobeH = viewer.scene.globe.getHeight(
        Carto.fromDegrees(tk.lon, tk.lat),
      );
      const plan = {
        takeoffGlobeM: Number.isFinite(takeoffGlobeH) ? takeoffGlobeH : null,
        takeoffGroundM: result.ground?.takeoffM ?? null,
        groundKnown: result.ground?.known ?? null,
        wp0: {
          lon: wp0.lon,
          lat: wp0.lat,
          aglM: wp0.aglM,
          groundM: wp0.groundM,
          relHeightM: wp0.relHeightM,
        },
        // Terrain read: ground + height above it. Terrain not read: the plan is
        // flat at the takeoff, so the aircraft is the globe surface there plus
        // its height above the takeoff.
        plannedEllipsoidalM:
          result.ground?.known === true
            ? (wp0.groundM ?? 0) + wp0.aglM
            : (Number.isFinite(takeoffGlobeH) ? takeoffGlobeH : 0) + wp0.aglM,
      };
      const ds = viewer.dataSources.getByName('gev-drone-plan')[0];
      const ents = ds.entities.values;
      // Waypoint markers: points of the single plan.
      const markers = ents
        .filter((e) => e.point && e.position && !e.name)
        .slice(0, 3)
        .map((e) => {
          const p = e.position.getValue(time);
          const c = hOf(p);
          return {
            lon: deg(c.longitude),
            lat: deg(c.latitude),
            positionHeightM: c.height,
            heightReference: String(e.point.heightReference?.getValue(time)),
          };
        });
      // Camera pyramid: the edges polyline is base0..base3, then apex lines.
      const edges = ents.find(
        (e) => (e.name || '').startsWith('3D check view') && e.polyline,
      );
      let pyramid = null;
      if (edges) {
        const pts = edges.polyline.positions.getValue(time).map(hOf);
        const apex = pts[5];
        const base = pts.slice(0, 4);
        pyramid = {
          apex: {
            lon: deg(apex.longitude),
            lat: deg(apex.latitude),
            heightM: apex.height,
          },
          baseHeightsM: base.map((b) => b.height),
        };
      }
      const surf = await surface(plan.wp0.lon, plan.wp0.lat);
      const apexSurf = pyramid
        ? await surface(pyramid.apex.lon, pyramid.apex.lat)
        : null;
      return { plan, markers, pyramid, surf, apexSurf };
    });

  const m = await measure();
  fs.writeFileSync(
    path.join(SHOT_DIR, 'measure.json'),
    JSON.stringify({ env, ...m }, null, 2),
  );
  console.log('measure:', JSON.stringify(m, null, 2));

  const planned = m.plan.plannedEllipsoidalM;
  const markerH = m.markers[0]?.positionHeightM;
  check(
    'the planned aircraft position exists in the report',
    Number.isFinite(planned),
    `planned ${planned}`,
  );
  console.log(
    `apex above the globe surface under it: ${(m.pyramid.apex.heightM - m.surf.globeH).toFixed(1)} m (planned height above ground ${AGL_M} m)`,
  );
  check(
    'camera pyramid apex is at the planned aircraft height (ground + height above ground)',
    m.pyramid && Math.abs(m.pyramid.apex.heightM - planned) <= TOL_M,
    `apex ${m.pyramid?.apex.heightM} vs planned ${planned}`,
  );
  check(
    'waypoint marker is at the planned aircraft height, not clamped to the ground',
    m.markers.length > 0 &&
      m.markers.every((k) => !/CLAMP/i.test(k.heightReference)) &&
      Math.abs(markerH - planned) <= TOL_M,
    `marker ${markerH} (${m.markers[0]?.heightReference}) vs planned ${planned}`,
  );
  check(
    'pyramid base stays on the surface under the aircraft (footprint)',
    m.pyramid &&
      m.pyramid.baseHeightsM.every(
        (h) =>
          Math.abs(
            h -
              (m.plan.groundKnown === true
                ? (m.plan.wp0.groundM ?? 0)
                : m.surf.globeH),
          ) <= TOL_M * 4,
      ),
    JSON.stringify(m.pyramid?.baseHeightsM),
  );

  // Pictures: top view, then a side view level with the aircraft.
  await page.screenshot({
    path: path.join(SHOT_DIR, '1-top.jpg'),
    type: 'jpeg',
    quality: 85,
  });
  const side = async (name, headingDeg, pitchDeg, rangeM) => {
    await page.evaluate(
      (o) => {
        const viewer = window.__godsEyeView.viewer;
        const C3 = viewer.camera.position.constructor;
        viewer.camera.lookAt(C3.fromDegrees(o.lon, o.lat, o.h), {
          heading: (o.heading * Math.PI) / 180,
          pitch: (o.pitch * Math.PI) / 180,
          range: o.range,
        });
        viewer.scene.requestRender();
      },
      {
        lon: m.pyramid?.apex.lon ?? m.plan.wp0.lon,
        lat: m.pyramid?.apex.lat ?? m.plan.wp0.lat,
        h: planned,
        heading: headingDeg,
        pitch: pitchDeg,
        range: rangeM,
      },
    );
    await wait(5000);
    await page.screenshot({
      path: path.join(SHOT_DIR, name),
      type: 'jpeg',
      quality: 85,
    });
  };
  await side('2-side-south.jpg', 0, -8, 260);
  await side('3-side-east.jpg', 90, -8, 260);
  await side('4-oblique.jpg', 30, -30, 380);

  // ------------------------------------------------------------ import --
  // Export the generated mission as a KMZ, clear the panel plan, import the
  // file again and read where its waypoints and camera pyramid are drawn. A
  // KMZ does not record the takeoff point: heights are above the START point,
  // which GEV takes as the ground under the first waypoint (documented).
  if (process.env.QA_IMPORT !== '0') {
    const prepared = await page.evaluate(async () => {
      const handle = window.__gevDronePlan;
      const wpml = await import('/src/byrdit/dronePlan/wpml.js');
      const r = handle.getResult();
      const mission = r.missions[0];
      const bytes = wpml.buildKmz(mission, r.plan);
      window.__qaKmz = Array.from(bytes);
      for (const a of [...handle.getState().areas]) handle.removeArea(a.id);
      return {
        count: mission.waypoints.length,
        rel: mission.waypoints.map((w) => w.relHeightM),
        first: { lon: mission.waypoints[0].lon, lat: mission.waypoints[0].lat },
      };
    });
    await page.waitForFunction(
      () => !window.__gevDronePlan.getResult(),
      { timeout: 60_000 },
    );
    await page.evaluate(() => {
      const input = document.querySelector(
        '#drone-plan-panel input[data-role="library-import"]',
      );
      const file = new File([new Uint8Array(window.__qaKmz)], 'qa-import.kmz');
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(
      () => {
        const viewer = window.__godsEyeView.viewer;
        const ds = viewer.dataSources.getByName('gev-drone-plan')[0];
        return ds.entities.values.some((e) => /waypoint$/.test(e.name || ''));
      },
      { timeout: 90_000 },
    );
    await wait(4000);
    const imp = await page.evaluate((first) => {
      const viewer = window.__godsEyeView.viewer;
      const time = viewer.clock.currentTime;
      const Carto = viewer.scene.globe.ellipsoid.cartesianToCartographic(
        viewer.camera.position,
      ).constructor;
      const ds = viewer.dataSources.getByName('gev-drone-plan')[0];
      const hOf = (cart) =>
        viewer.scene.globe.ellipsoid.cartesianToCartographic(cart).height;
      const markers = ds.entities.values
        .filter((e) => /waypoint$/.test(e.name || '') && e.point)
        .map((e) => hOf(e.position.getValue(time)));
      const clamped = ds.entities.values.filter(
        (e) => e.point && !e.name && e.position,
      ).length;
      const edges = ds.entities.values.find(
        (e) => (e.name || '').startsWith('3D check view') && e.polyline,
      );
      const apex = edges
        ? hOf(edges.polyline.positions.getValue(time)[5])
        : null;
      const startSurface = viewer.scene.globe.getHeight(
        Carto.fromDegrees(first.lon, first.lat),
      );
      return { markers, clamped, apex, startSurface };
    }, prepared.first);
    fs.writeFileSync(
      path.join(SHOT_DIR, 'import-measure.json'),
      JSON.stringify({ prepared, imp }, null, 2),
    );
    console.log('import measure:', JSON.stringify({ n: imp.markers.length, clamped: imp.clamped, apex: imp.apex, startSurface: imp.startSurface }));
    check(
      'imported file: every waypoint is drawn in the air (none clamped to the ground)',
      imp.markers.length === prepared.count && imp.clamped === 0,
      `${imp.markers.length}/${prepared.count} markers, ${imp.clamped} clamped`,
    );
    const worst = Math.max(
      ...imp.markers.map((h, i) =>
        Math.abs(h - (imp.startSurface + prepared.rel[i])),
      ),
    );
    check(
      'imported file: aircraft = start surface + file height above the start point',
      worst <= 3,
      `worst difference ${worst.toFixed(2)} m`,
    );
    check(
      'imported file: camera pyramid apex is at an imported waypoint height',
      imp.apex !== null &&
        imp.markers.some((h) => Math.abs(h - imp.apex) <= 3),
      `apex ${imp.apex}`,
    );
    await page.evaluate((o) => {
      const viewer = window.__godsEyeView.viewer;
      const C3 = viewer.camera.position.constructor;
      viewer.camera.lookAt(C3.fromDegrees(o.lon, o.lat, o.h), {
        heading: Math.PI / 3,
        pitch: -0.5,
        range: 380,
      });
      viewer.scene.requestRender();
    }, {
      lon: prepared.first.lon,
      lat: prepared.first.lat,
      h: imp.startSurface + prepared.rel[0],
    });
    await wait(5000);
    await page.screenshot({
      path: path.join(SHOT_DIR, '5-import-oblique.jpg'),
      type: 'jpeg',
      quality: 85,
    });
  }
} finally {
  await browser.close();
}
console.log(failures.length ? `FAILED: ${failures.length}` : 'ALL PASS');
process.exit(failures.length ? 1 : 0);
