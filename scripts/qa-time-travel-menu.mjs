#!/usr/bin/env node
/**
 * Rendered proof for the right-rail Time travel card (#time-travel-panel:
 * History, Imagery, Aerial). It must measure the same as the collapsed
 * Context card, and the NAIP slider must live in its Aerial section.
 * QA_BASE_URL (default http://127.0.0.1:5199) must serve the app; the Wayback
 * releases API is stubbed so the Imagery section can be exercised offline.
 * Screenshots go to QA_OUT_DIR (default ./qa-artifacts-tt).
 */
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";

const appUrl = process.env.QA_BASE_URL || "http://127.0.0.1:5199";
const outDir = path.resolve(process.env.QA_OUT_DIR || "qa-artifacts-tt");
const tag = process.env.QA_TAG || "tt";
// QA_WAYBACK=0 renders the page as if GEV_BYRDIT_WAYBACK were off
const waybackFlag = process.env.QA_WAYBACK === "0" ? "0" : "1";
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  headless: "new",
  ...(process.env.PUPPETEER_EXECUTABLE_PATH
    ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
    : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--no-sandbox"],
});
const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`);
  if (!ok) failures.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(label, viewport) {
  // a fresh profile per viewport: collapsed state is remembered like any rail card
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport(viewport);
  await page.setRequestInterception(true);
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname === "/api/byrdit/wayback/releases") {
      r.respond({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          releases: [
            { release: 1, date: "2014-02-20" },
            { release: 2, date: "2020-01-01" },
            { release: 3, date: "2025-01-01" },
          ],
        }),
      });
    } else r.continue();
  });
  await page.evaluateOnNewDocument((process_flag) => {
    // the real page carries this meta when GEV_BYRDIT_WAYBACK=1
    const add = () => {
      if (!document.head) return false;
      const m = document.createElement("meta");
      m.name = "gev-wayback";
      m.content = process_flag;
      document.head.appendChild(m);
      return true;
    };
    if (!add()) {
      const mo = new MutationObserver(() => add() && mo.disconnect());
      mo.observe(document, { childList: true, subtree: true });
    }
  }, waybackFlag);
  page.on("pageerror", (e) => console.log("  pageerror:", e.message));
  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#time-travel-panel", { timeout: 60000 });
  await sleep(Number(process.env.QA_SETTLE_MS || 12000));
  await page.keyboard.press("Escape"); // first-run chooser
  await sleep(500);
  if (await page.evaluate(() => document.body.classList.contains("mobile-shell"))) {
    // phones: rail cards live in sheets; Time travel is in the Context sheet
    await page.click(".mobile-tab[data-mobile-sheet=\"context\"]");
    await sleep(600);
  }
  await page.waitForSelector("#time-travel-panel", { visible: true, timeout: 30000 });
  const rects = () =>
    page.evaluate(() => {
      const rect = (s) => {
        const e = document.querySelector(s);
        if (!e) return null;
        const r = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        return {
          x: r.x,
          y: r.y,
          w: r.width,
          h: r.height,
          right: r.right,
          bottom: r.bottom,
          radius: cs.borderTopLeftRadius,
          font: cs.fontFamily + " " + cs.fontSize,
          visible: r.width > 0 && r.height > 0,
        };
      };
      const inner = (id) => rect(`#${id} > [data-rail-scroller]`);
      return {
        vw: innerWidth,
        vh: innerHeight,
        tt: rect("#time-travel-panel"),
        ttInner: inner("time-travel-panel"),
        ctx: rect("#global-context-panel"),
        ctxInner: inner("global-context-panel"),
        sl: rect("#street-level-panel"),
        slInner: inner("street-level-panel"),
        ttTitle: rect("#time-travel-panel .panel-title"),
        ctxTitle: rect("#global-context-panel .panel-title"),
        ttHidden: document.querySelector("#time-travel-panel")?.hidden,
        collapsed: document.querySelector("#time-travel-panel")?.classList.contains("collapsed"),
        btnText: document.querySelector("#gev-time-travel-toggle")?.textContent,
        floating: Boolean(document.querySelector("#gev-time-travel")),
      };
    });
  const probe = () =>
    page.evaluate(() => {
      const rect = (s) => {
        const e = document.querySelector(s);
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, visible: r.width > 0 && r.height > 0 };
      };
      const panel = document.querySelector("#time-travel-panel");
      return {
        menu: rect("#time-travel-panel"),
        toggle: rect("#gev-time-travel-toggle"),
        body: rect("#gev-time-travel-body"),
        hist: rect(".gev-hist"),
        wayback: rect("#gev-wayback"),
        aerial: rect("#naip-slider, #gev-naip-slider"),
        floatingNaip: document.querySelector("body > #gev-naip-slider, #cesiumContainer #gev-naip-slider") !== null,
        expanded: document.querySelector("#gev-time-travel-toggle")?.getAttribute("aria-expanded"),
        histInMenu: Boolean(panel?.querySelector(".gev-hist")),
        wbInMenu: Boolean(panel?.querySelector("#gev-wayback")),
        aerialInMenu: Boolean(panel?.querySelector('[data-section="aerial"] #gev-naip-slider')),
        headings: [...(panel?.querySelectorAll(".gev-tt-section:not([hidden]) .gev-tt-heading") ?? [])].map((h) => h.textContent),
        vw: innerWidth,
        vh: innerHeight,
      };
    });
  const c = await probe();
  const r = await rects();
  console.log(label, "collapsed", JSON.stringify(c));
  console.log(label, "rects", JSON.stringify(r));
  check(`${label}: no floating #gev-time-travel box`, !r.floating);
  check(`${label}: collapsed by default`, r.collapsed === true && !c.body?.visible);
  check(`${label}: nothing history at bottom-left`, !c.hist?.visible);
  const phone = label === "narrow"; // sheet layout: full-width cards, Context is open
  check(`${label}: card visible`, r.tt?.visible);
  check(`${label}: collapsed card is 50px tall`, Math.abs(r.tt.h - 50) < 0.6, `${r.tt.h}`);
  if (!phone) check(`${label}: card right-aligned in viewport`, r.tt.right > r.vw - 120 && r.tt.right <= r.vw, `${r.tt.right}`);
  if (r.ctx?.visible) {
    check(`${label}: same width as collapsed CONTEXT`, Math.abs(r.tt.w - r.ctx.w) < 0.6, `${r.tt.w} vs ${r.ctx.w}`);
    if (!phone) check(`${label}: same height as collapsed CONTEXT`, Math.abs(r.tt.h - r.ctx.h) < 0.6, `${r.tt.h} vs ${r.ctx.h}`);
    check(`${label}: right-aligned with CONTEXT`, Math.abs(r.tt.right - r.ctx.right) < 0.6, `${r.tt.right} vs ${r.ctx.right}`);
    check(`${label}: same inner radius`, r.ttInner?.radius === r.ctxInner?.radius, `${r.ttInner?.radius} vs ${r.ctxInner?.radius}`);
    check(`${label}: same title font`, r.ttTitle?.font === r.ctxTitle?.font, `${r.ttTitle?.font} vs ${r.ctxTitle?.font}`);
    const gap = r.ctx.y - r.tt.bottom;
    check(`${label}: 8px gap to CONTEXT`, Math.abs(gap - 8) < 0.6, `${gap}`);
  } else console.log("  (CONTEXT card not visible at this size)");
  await page.screenshot({ path: path.join(outDir, `${tag}-${label}-collapsed.png`) });
  await page.click("#gev-time-travel-toggle");
  await sleep(800);
  // The NAIP year slider as the real Byrd-IT Open stack would mount it
  await page.evaluate(async () => {
    const { createNaipMenuSlider } = await import("/src/byrdit/basemap/naipSlider.js");
    const state = { ticks: [2012, 2016, 2020, 2024], year: 2024, yearB: 2016, enabled: true, compare: false, label: "2024: NAIP 2024", labelB: "" };
    window.__qaNaip = createNaipMenuSlider({
      container: document.body, state, onYear() {}, onYearB() {}, onEnabled() {}, onCompare() {},
    });
    window.__qaNaip.setVisible(true);
  });
  await sleep(500);
  const o = await probe();
  console.log(label, "open", JSON.stringify(o));
  check(`${label}: opens on click`, o.expanded === "true" && o.body?.visible);
  check(`${label}: history inside menu`, o.histInMenu && o.hist?.visible);
  if (waybackFlag === "1") check(`${label}: imagery inside menu`, o.wbInMenu && o.wayback?.visible);
  check(`${label}: aerial inside menu`, o.aerialInMenu && o.aerial?.visible);
  check(`${label}: no floating NAIP bar`, !o.floatingNaip);
  console.log(label, "headings", JSON.stringify(o.headings));
  // The three check boxes (Esri Wayback, Aerial, Compare) must look alike.
  const boxes = await page.evaluate(() => {
    const m = (e) => {
      if (!e) return null;
      const r = e.getBoundingClientRect();
      const row = e.closest("label");
      const cs = row ? getComputedStyle(row) : null;
      return { w: r.width, h: r.height, font: cs ? cs.fontFamily.split(",")[0] + " " + cs.fontSize : null };
    };
    const nb = [...document.querySelectorAll("#gev-naip-slider input[type=checkbox]")];
    return { wayback: m(document.querySelector("#gev-wayback input[type=checkbox]")), aerial: m(nb[0]), compare: m(nb[1]) };
  });
  console.log(label, "checkboxes", JSON.stringify(boxes));
  if (waybackFlag === "1") {
    check(`${label}: Esri box is the same size as the Aerial box - ${boxes.wayback?.w}x${boxes.wayback?.h} vs ${boxes.aerial?.w}x${boxes.aerial?.h}`, boxes.wayback && boxes.aerial && boxes.wayback.w === boxes.aerial.w && boxes.wayback.h === boxes.aerial.h);
    check(`${label}: Esri box is the same size as the Compare box`, boxes.wayback && boxes.compare && boxes.wayback.w === boxes.compare.w && boxes.wayback.h === boxes.compare.h);
    check(`${label}: Esri label font matches the Aerial label - ${boxes.wayback?.font} vs ${boxes.aerial?.font}`, boxes.wayback && boxes.aerial && boxes.wayback.font === boxes.aerial.font);
  }
  check(`${label}: menu within viewport`, o.menu.x >= 0 && o.menu.x + o.menu.w <= o.vw + 1 && o.menu.y + o.menu.h <= o.vh + 1);
  await page.screenshot({ path: path.join(outDir, `${tag}-${label}-open.png`) });
  await page.evaluate(() => window.__qaNaip.setVisible(false));
  await sleep(200);
  const g = await probe();
  check(`${label}: Aerial hides when NAIP is not on screen`, !g.headings.includes("Aerial (NAIP)"));
  await page.close();
  await context.close();
}

try {
  await run("desktop", { width: 1440, height: 900 });
  await run("narrow-desktop", { width: 800, height: 900 });
  await run("narrow", { width: 390, height: 844, isMobile: true, hasTouch: true });
} finally {
  await browser.close();
}
if (failures.length) {
  console.log(`FAILED: ${failures.length}`);
  process.exit(1);
}
console.log("OK");
