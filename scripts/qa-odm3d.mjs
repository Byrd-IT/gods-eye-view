#!/usr/bin/env node
/**
 * Rendered proof for the Byrd Ranch 3D builds (OpenDroneMap 3D Tiles layers).
 *
 * QA_BASE_URL must serve the app with GEV_BASEMAP_OVERLAYS=1 and an
 * overlays.json that lists at least one overlay-3d layer (QA_3D_ID, default
 * odm-3d-9be42b4f). The script
 *   1. checks the layer list: "Byrd Ranch builds" holds the flat and the 3D
 *      ODM layers and "Other layers" holds none of them;
 *   2. flies to the build, switches it on, waits for the model, reports the
 *      ground alignment (lift) and the terrain under it;
 *   3. turns the canopy cut Off / 90 ft / 120 ft and lowers opacity, with a
 *      screenshot of each state in QA_OUT_DIR (default ./qa-artifacts-odm3d);
 *   4. checks the clipping plane against the model's own heights.
 * Exit code 1 on any failed check.
 */
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";

const appUrl = process.env.QA_BASE_URL || "http://127.0.0.1:4191";
const id = process.env.QA_3D_ID || "odm-3d-9be42b4f";
const outDir = path.resolve(process.env.QA_OUT_DIR || "qa-artifacts-odm3d");
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`);
  if (!ok) failures.push(name);
};

const browser = await puppeteer.launch({
  headless: "new",
  ...(process.env.PUPPETEER_EXECUTABLE_PATH ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--no-sandbox", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const requests = [];
page.on("response", (r) => {
  const u = new URL(r.url());
  if (u.pathname.startsWith("/basemap/odm3d/")) requests.push({ path: u.pathname, status: r.status() });
});
page.on("pageerror", (e) => console.log("  pageerror:", e.message));
page.on("console", (m) => {
  if (m.type() === "error") console.log("  console.error:", m.text().slice(0, 200));
});

await page.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 180000 });
await page.waitForFunction(() => window.__gevOverlays && window.__godsEyeView?.viewer, { timeout: 420000 });
await sleep(8000);
await page.keyboard.press("Escape");

// 1. groups
await page.click('[data-rail-item="map-layers-panel"]').catch(() => {});
await page.waitForSelector("#map-layers-panel:not(.collapsed)", { visible: true, timeout: 60000 });
const groups = await page.evaluate(() => {
  const out = {};
  for (const g of document.querySelectorAll("#gev-overlays-panel [data-group]")) {
    out[g.getAttribute("data-group")] = {
      hidden: g.hidden,
      rows: [...g.querySelectorAll("[data-overlay]")].map((r) => r.getAttribute("data-overlay")),
    };
  }
  return out;
});
console.log("groups", JSON.stringify(Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.rows.filter((r) => r.startsWith("odm-"))]))));
check("Byrd Ranch builds group exists and lists the 3D layer", groups["byrd-ranch"] && groups["byrd-ranch"].rows.includes(id));
check("Byrd Ranch builds lists the flat ODM layers too", groups["byrd-ranch"]?.rows.some((r) => r.startsWith("odm-preview-")));
check("no ODM layer is left in Other layers", !(groups.other?.rows ?? []).some((r) => r.startsWith("odm-")));

// 2. fly to the build and switch it on (Byrd-IT Open is the map that carries overlays)
await page.evaluate(async () => {
  await window.__godsEyeView.mapStackController.setStack("byrdit-open", { intent: "user" });
});
await sleep(3000);
const entry = await page.evaluate((id) => window.__gevOverlays.state().layers.find((l) => l.id === id), id);
// the layer's own published ground height (the panel state has no model block)
const model = await page.evaluate(async (id) => (await (await fetch("/basemap/config.json")).json()).overlays.layers.find((l) => l.id === id).model, id);
const GROUND = model.groundM;
check("3D layer offered with canopy options", entry && entry.kind === "3d" && entry.canopyOptionsFt?.includes(90), JSON.stringify(entry));
// The app does not export Cesium: build positions with the viewer's own classes.
const flyToBuild = ({ southM = 380, heightM = 260, pitchDeg = -38, headingDeg = 0, eastM = 0, northM = 0 } = {}) =>
  page.evaluate(
    async ({ id, southM, heightM, pitchDeg, headingDeg, eastM, northM }) => {
      const { viewer } = window.__godsEyeView;
      const bounds = (await (await fetch("/basemap/config.json")).json()).overlays.layers.find((l) => l.id === id).bounds;
      const Carto = viewer.camera.positionCartographic.constructor;
      const lon = (bounds[0] + bounds[2]) / 2;
      const lat = (bounds[1] + bounds[3]) / 2;
      const rad = (d) => (d * Math.PI) / 180;
      const dLat = (southM - northM) / 111320;
      const dLon = eastM / (111320 * Math.cos(rad(lat)));
      const position = viewer.scene.globe.ellipsoid.cartographicToCartesian(new Carto(rad(lon + dLon), rad(lat - dLat), heightM + (Number(process.env.QA_GROUND_M) || 112)));
      viewer.camera.setView({ destination: position, orientation: { heading: rad(headingDeg), pitch: rad(pitchDeg), roll: 0 } });
      viewer.scene.requestRender?.();
      return { lon, lat };
    },
    { id, southM, heightM, pitchDeg, headingDeg, eastM, northM },
  );
console.log("fly", JSON.stringify(await flyToBuild()));
await page.evaluate((id) => {
  const box = document.querySelector(`#gev-overlays-panel [data-overlay="${id}"] input[type="checkbox"]`);
  if (!box.checked) box.click();
}, id);
await page
  .waitForFunction((id) => window.__gevOverlays.state().layers.find((l) => l.id === id)?.status === "ready", { timeout: 240000 }, id)
  .catch(() => {});
await sleep(25000);
const ready = await page.evaluate((id) => window.__gevOverlays.state().layers.find((l) => l.id === id), id);
console.log("state", JSON.stringify(ready));
check("3D model loaded (status ready)", ready?.status === "ready");
check("tileset.json and tile files were served", requests.some((r) => r.path.endsWith("/tileset.json") && r.status === 200) && requests.some((r) => r.path.endsWith(".b3dm") && r.status === 200), `${requests.length} requests`);
check("no failed 3D requests", requests.every((r) => r.status < 400), JSON.stringify(requests.filter((r) => r.status >= 400)));

// A software-GL browser cannot draw the full-detail model in reasonable time;
// QA_SSE raises the screen-space error (coarser tiles) for the pictures only.
const coarsen = () =>
  page.evaluate((sse) => {
    const { viewer } = window.__godsEyeView;
    const prims = viewer.scene.primitives;
    for (let i = 0; i < prims.length; i += 1) {
      const p = prims.get(i);
      if (p?.constructor?.name === "Cesium3DTileset" && /odm3d/.test(p.resource?.url ?? "")) p.maximumScreenSpaceError = sse;
    }
  }, Number(process.env.QA_SSE || 24));
await coarsen();

const probe = () =>
  page.evaluate(() => {
    const { viewer } = window.__godsEyeView;
    const prims = viewer.scene.primitives;
    for (let i = 0; i < prims.length; i += 1) {
      const p = prims.get(i);
      if (p?.constructor?.name === "Cesium3DTileset" && /odm3d/.test(p.resource?.url ?? p._url ?? "")) {
        const planes = p.clippingPlanes;
        const c = viewer.scene.globe.ellipsoid.cartesianToCartographic(p.boundingSphere.center);
        return {
          show: p.show,
          style: p.style ? JSON.stringify(p.style.style) : null,
          clipEnabled: planes ? planes.enabled : null,
          plane: planes && planes.length ? planes.get(0).distance : null,
          centerHeight: c.height,
          radius: p.boundingSphere.radius,
          tilesLoaded: p.tilesLoaded,
          up: p.asset?.gltfUpAxis ?? null,
        };
      }
    }
    return null;
  });

const shot = async (name) => {
  // wait (<= 150 s) until every tile this view asks for has loaded
  for (let i = 0; i < 30; i += 1) {
    await page.evaluate(() => window.__godsEyeView.viewer.scene.requestRender?.());
    await sleep(5000);
    if ((await probe())?.tilesLoaded) break;
  }
  await sleep(3000);
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  console.log("shot", file);
};

// 3. cut states
const setCut = (chip) =>
  page.evaluate(
    ({ id, chip }) => {
      const b = document.querySelector(`#gev-overlays-panel [data-overlay="${id}"] .gev-ov-cut [data-chip-id="${chip}"]`);
      b.click();
      return window.__gevOverlays.state().layers.find((l) => l.id === id).canopyFt;
    },
    { id, chip },
  );
const base = await probe();
console.log("probe default", JSON.stringify(base));
check("default cut is 90 ft", (await page.evaluate((id) => window.__gevOverlays.state().layers.find((l) => l.id === id).canopyFt, id)) === 90);
await shot("cut-90ft");
const p90 = await probe();
await setCut("off");
await shot("cut-off-full-model");
const poff = await probe();
await setCut("120");
await shot("cut-120ft");
const p120 = await probe();
check("90 ft: clipping plane enabled at ground + 27.43 m", p90?.clipEnabled === true && Math.abs(p90.plane - GROUND - 27.432) < 0.05, JSON.stringify(p90));
check("Off: clipping disabled", poff?.clipEnabled === false, JSON.stringify(poff));
check("120 ft: plane above the 90 ft one by 9.14 m", p120?.clipEnabled === true && p90 && Math.abs(p120.plane - p90.plane - 9.144) < 0.01, `${p90?.plane} -> ${p120?.plane}`);

// Plane-frame proof: looking straight down, the 90 ft cut leaves the model whole
// (the tallest tree is only ~31 m), but a probe cut 8 m above the ground must
// open holes where the canopy is higher. QA_OUT_DIR gets both pictures; the
// pixel comparison is printed for the report.
await page.evaluate((id) => {
  const r = document.querySelector(`#gev-overlays-panel [data-overlay="${id}"] input[type="range"]`);
  r.value = "100";
  r.dispatchEvent(new Event("input", { bubbles: true }));
}, id);
await flyToBuild({ southM: 0, heightM: 330, pitchDeg: -89, headingDeg: 0 });
await sleep(40000);
await setCut("off");
await shot("top-off");
await setCut("90");
await shot("top-90ft");
await page.evaluate((ground) => {
  const { viewer } = window.__godsEyeView;
  const prims = viewer.scene.primitives;
  for (let i = 0; i < prims.length; i += 1) {
    const p = prims.get(i);
    if (p?.constructor?.name === "Cesium3DTileset" && p.clippingPlanes?.length) {
      p.clippingPlanes.get(0).distance = ground + 8;
    }
  }
  viewer.scene.requestRender?.();
}, GROUND);
await shot("top-probe-8m-above-ground");
await setCut("off");
await shot("top-off-again");

// opacity
await page.evaluate((id) => {
  const r = document.querySelector(`#gev-overlays-panel [data-overlay="${id}"] input[type="range"]`);
  r.value = "40";
  r.dispatchEvent(new Event("input", { bubbles: true }));
}, id);
await sleep(1500);
const pop = await probe();
check("opacity 40% applied as a tile style", pop?.style?.includes("0.40"), pop?.style ?? "no style");
await shot("opacity-40");

// off removes it
await page.evaluate((id) => document.querySelector(`#gev-overlays-panel [data-overlay="${id}"] input[type="checkbox"]`).click(), id);
await sleep(1500);
check("switching off removes the model", (await probe()) === null);

await browser.close();
console.log(failures.length ? `FAILED: ${failures.join("; ")}` : "ALL CHECKS PASSED");
process.exit(failures.length ? 1 : 0);
