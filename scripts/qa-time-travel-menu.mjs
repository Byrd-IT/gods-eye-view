#!/usr/bin/env node
/**
 * Rendered proof for the right-side Time travel menu (History + Imagery).
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
  const page = await browser.newPage();
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
  await page.waitForSelector("#gev-time-travel", { timeout: 60000 });
  await sleep(Number(process.env.QA_SETTLE_MS || 12000));
  await page.keyboard.press("Escape"); // first-run chooser
  await sleep(500);
  const probe = () =>
    page.evaluate(() => {
      const rect = (s) => {
        const e = document.querySelector(s);
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, visible: r.width > 0 && r.height > 0 };
      };
      const panel = document.querySelector("#gev-time-travel");
      return {
        menu: rect("#gev-time-travel"),
        toggle: rect("#gev-time-travel-toggle"),
        body: rect("#gev-time-travel-body"),
        hist: rect(".gev-hist"),
        wayback: rect("#gev-wayback"),
        expanded: document.querySelector("#gev-time-travel-toggle")?.getAttribute("aria-expanded"),
        histInMenu: Boolean(panel?.querySelector(".gev-hist")),
        wbInMenu: Boolean(panel?.querySelector("#gev-wayback")),
        vw: innerWidth,
        vh: innerHeight,
      };
    });
  const c = await probe();
  console.log(label, "collapsed", JSON.stringify(c));
  check(`${label}: collapsed by default`, c.expanded === "false" && !c.body?.visible);
  check(`${label}: nothing history at bottom-left`, !c.hist?.visible);
  check(`${label}: toggle on right half`, c.toggle && c.toggle.x > c.vw / 2);
  await page.screenshot({ path: path.join(outDir, `${tag}-${label}-collapsed.png`) });
  await page.click("#gev-time-travel-toggle");
  await sleep(800);
  const o = await probe();
  console.log(label, "open", JSON.stringify(o));
  check(`${label}: opens on click`, o.expanded === "true" && o.body?.visible);
  check(`${label}: history inside menu`, o.histInMenu && o.hist?.visible);
  check(`${label}: imagery inside menu`, o.wbInMenu && o.wayback?.visible);
  check(`${label}: menu within viewport`, o.menu.x >= 0 && o.menu.x + o.menu.w <= o.vw + 1 && o.menu.y + o.menu.h <= o.vh + 1);
  await page.screenshot({ path: path.join(outDir, `${tag}-${label}-open.png`) });
  await page.close();
}

try {
  await run("desktop", { width: 1440, height: 900 });
  await run("narrow", { width: 390, height: 844, isMobile: true, hasTouch: true });
} finally {
  await browser.close();
}
if (failures.length) {
  console.log(`FAILED: ${failures.length}`);
  process.exit(1);
}
console.log("OK");
