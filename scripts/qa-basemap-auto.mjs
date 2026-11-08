#!/usr/bin/env node
/**
 * Rendered proof for the map source chips, Auto in particular.
 *
 * QA_BASE_URL must serve the app (GEV_BASEMAP=1). Clicks the real chips in
 * the command dock and reads what the map controller shows:
 *   Open -> Auto (close in)   expect Google 3D ('photoreal') within ~12 s
 *   Auto, camera >= 8 km      expect Byrd-IT Open within ~12 s
 *   Auto, camera <= 5 km      expect Google again
 *   Esri / OSM chips, then Auto again: back on Google 3D (close in); this is the
 *     case that broke: after a map change the globe's terrain height was
 *     nonsense and Auto chose Open.
 *   Google / Open / Esri / OSM chips still switch.
 * The lit chip always follows the map that is shown (never the Auto mode
 * itself), so the checks read the controller. Exit code 1 on any failed check.
 */
import puppeteer from "puppeteer";

const appUrl = process.env.QA_BASE_URL || "http://127.0.0.1:4191";
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
// The Google key is restricted to the public hostname. QA_GOOGLE_REFERER (e.g.
// https://gev.byrd-it.com/) makes Google requests carry it, as they do for a real visitor.
if (process.env.QA_GOOGLE_REFERER) {
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    let host = "";
    try {
      host = new URL(req.url()).hostname;
    } catch {
      /* not a URL */
    }
    if (/(^|\.)googleapis\.com$/.test(host)) req.continue({ headers: { ...req.headers(), referer: process.env.QA_GOOGLE_REFERER } });
    else req.continue();
  });
}
page.on("pageerror", (e) => console.log("  pageerror:", e.message));
page.on("console", (m) => {
  const t = m.text();
  if (/basemap|switch|auto|google/i.test(t) && m.type() !== "log") console.log("  console." + m.type() + ":", t.slice(0, 160));
});
await page.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 180000 });
await page.waitForFunction(() => window.__godsEyeView?.mapStackController && document.querySelector("#map-stack-chips .map-stack-chip"), { timeout: 420000 });
await sleep(8000);

const state = () =>
  page.evaluate(() => {
    const c = window.__godsEyeView.mapStackController;
    const chips = [...document.querySelectorAll("#map-stack-chips .map-stack-chip")].map((n) => ({
      id: n.getAttribute("data-stack-id"),
      lit: n.classList.contains("active") || n.getAttribute("aria-pressed") === "true",
      off: n.getAttribute("aria-disabled") === "true",
    }));
    const v = window.__godsEyeView.viewer;
    return {
      active: c.getActiveId(),
      lastError: c.getState().lastError ?? null,
      lit: chips.filter((x) => x.lit).map((x) => x.id),
      unavailable: chips.filter((x) => x.off).map((x) => x.id),
      camM: Math.round(v.camera.positionCartographic.height),
    };
  });
const click = (id) => page.evaluate((id) => document.querySelector(`#map-stack-chips [data-stack-id="${id}"]`)?.click(), id);
const waitActive = async (want, ms = 30000) => {
  const end = Date.now() + ms;
  let s;
  while (Date.now() < end) {
    s = await state();
    if (s.active === want) return s;
    await sleep(1000);
  }
  return s;
};
const setHeight = (h) =>
  page.evaluate((h) => {
    const { viewer } = window.__godsEyeView;
    const Carto = viewer.camera.positionCartographic.constructor;
    const p = viewer.camera.positionCartographic;
    viewer.camera.setView({
      destination: viewer.scene.globe.ellipsoid.cartographicToCartesian(new Carto(p.longitude, p.latitude, h)),
      orientation: { heading: 0, pitch: (-89 * Math.PI) / 180, roll: 0 },
    });
    viewer.scene.requestRender?.();
  }, h);

console.log("start", JSON.stringify(await state()));
await setHeight(1500);
await sleep(3000);
await click("byrdit-open");
let s = await waitActive("byrdit-open", 20000);
check("Open chip pins Byrd-IT Open", s.active === "byrdit-open", JSON.stringify(s));
check("Google chip available in this run", !s.unavailable.includes("photoreal"), JSON.stringify(s.unavailable));

await click("basemap-auto");
s = await waitActive("photoreal", 40000);
console.log("after Auto click, camera 1.5 km", JSON.stringify(s));
check("Auto from Open, camera below 5 km: Google 3D", s.active === "photoreal", JSON.stringify(s));

await setHeight(20000);
s = await waitActive("byrdit-open", 40000);
check("Auto, camera above 8 km: Byrd-IT Open", s.active === "byrdit-open", JSON.stringify(s));

await setHeight(1500);
s = await waitActive("photoreal", 40000);
check("Auto, camera below 5 km again: Google 3D", s.active === "photoreal", JSON.stringify(s));

for (const id of ["byrdit-open", "photoreal", "esri-imagery", "osm", "basemap-auto", "esri-imagery", "basemap-auto", "byrdit-open", "basemap-auto"]) {
  await click(id);
  await sleep(1000);
  // Auto is a mode: from another map at 1.5 km it must land on Google 3D.
  const want = id === "basemap-auto" ? "photoreal" : id;
  s = await waitActive(want, 40000);
  check(`chip ${id} works`, s.active === want, JSON.stringify(s));
}

await browser.close();
console.log(failures.length ? `FAILED: ${failures.join("; ")}` : "ALL CHECKS PASSED");
process.exit(failures.length ? 1 : 0);
