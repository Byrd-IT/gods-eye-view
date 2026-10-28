#!/usr/bin/env node
/**
 * Rendered proof for the map overlay layers (Time travel card, "Map overlays"
 * section). QA_BASE_URL (default http://127.0.0.1:4392) must serve the app
 * with GEV_BASEMAP_OVERLAYS=1 and a reachable overlays.json. Flies to Wood
 * County (hires NAIP bounds), turns overlays on, checks the tile requests and
 * opacity, and screenshots to QA_OUT_DIR (default ./qa-artifacts-overlays).
 */
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";

const appUrl = process.env.QA_BASE_URL || "http://127.0.0.1:4392";
const outDir = path.resolve(process.env.QA_OUT_DIR || "qa-artifacts-overlays");
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
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--no-sandbox"],
});

async function run(label, viewport) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport(viewport);
  const tiles = [];
  page.on("response", (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/basemap/overlay/")) tiles.push({ path: u.pathname, status: r.status() });
  });
  page.on("pageerror", (e) => console.log("  pageerror:", e.message));
  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#time-travel-panel", { timeout: 90000 });
  await sleep(Number(process.env.QA_SETTLE_MS || 12000));
  await page.keyboard.press("Escape");
  await sleep(500);
  if (await page.evaluate(() => document.body.classList.contains("mobile-shell"))) {
    await page.click('.mobile-tab[data-mobile-sheet="context"]');
    await sleep(600);
  }
  await page.waitForSelector("#time-travel-panel", { visible: true, timeout: 30000 });
  await page.click("#gev-time-travel-toggle");
  await sleep(800);
  const info = await page.evaluate(() => {
    const p = document.querySelector('#time-travel-panel [data-section="overlays"] #gev-overlays-panel');
    return {
      inMenu: Boolean(p),
      heading: p?.closest("section")?.querySelector(".gev-tt-heading")?.textContent,
      rows: [...(p?.querySelectorAll("[data-overlay]") ?? [])].map((r) => ({
        id: r.getAttribute("data-overlay"),
        name: r.querySelector("label")?.textContent.trim(),
        checked: r.querySelector('input[type="checkbox"]').checked,
        rangeDisabled: r.querySelector('input[type="range"]').disabled,
      })),
      hookState: window.__gevOverlays?.state().layers.length,
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  console.log(label, JSON.stringify(info));
  check(`${label}: panel is in the Time travel card, heading "Map overlays"`, info.inMenu && info.heading === "Map overlays");
  check(`${label}: 6 overlays, all off, opacity disabled while off`, info.rows.length === 6 && info.rows.every((r) => !r.checked && r.rangeDisabled));
  check(`${label}: no horizontal page overflow`, !info.overflow);
  // Styling by computed style (not by ids): the section is the card chrome's
  // child, and its controls are the shared chip / slider / value surfaces.
  const look = await page.evaluate(() => {
    const panel = document.querySelector("#gev-overlays-panel");
    const cs = (n, ...props) => Object.fromEntries(props.map((p) => [p, getComputedStyle(n)[p]]));
    const card = panel.closest("#right-context-rail > .panel-collapsible");
    const chip = panel.querySelector("[data-move]");
    const range = panel.querySelector('input[type="range"]');
    const out = panel.querySelector("output");
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
    const probe = document.createElement("span");
    probe.style.color = accent;
    document.body.append(probe);
    const accentRgb = getComputedStyle(probe).color;
    probe.remove();
    const clone = panel.cloneNode(false);
    clone.id = "";
    clone.hidden = true;
    panel.parentNode.append(clone);
    const hiddenDisplay = getComputedStyle(clone).display;
    clone.remove();
    const pr = panel.getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    return {
      inRailCard: Boolean(card?.querySelector(":scope > * > .panel-header .panel-collapse-btn")),
      inlineStyle: panel.hasAttribute("style") || Boolean(panel.querySelector("[style]")),
      panel: cs(panel, "position", "display"),
      chip: cs(chip, "fontFamily", "fontSize", "borderTopLeftRadius", "backgroundColor", "cursor"),
      chipClass: chip.className,
      range: { ...cs(range, "appearance", "height"), cls: range.className },
      out: cs(out, "color", "fontFamily"),
      accentRgb,
      hiddenDisplay,
      insideCard: pr.left >= cr.left - 0.5 && pr.right <= cr.right + 0.5,
    };
  });
  console.log(label, "look", JSON.stringify(look));
  check(`${label}: section sits in a right-rail card with the standard header chrome`, look.inRailCard);
  check(`${label}: no inline styles in the section`, !look.inlineStyle);
  check(`${label}: panel is in-flow and inside the card`, look.panel.position === "static" && look.insideCard, JSON.stringify(look.panel));
  check(`${label}: raise/lower use the shared chip look`, /data-toggle-chip/.test(look.chipClass) && /mono|JetBrains/i.test(look.chip.fontFamily) && look.chip.borderTopLeftRadius === "3px" && look.chip.backgroundColor !== "rgb(239, 239, 239)", JSON.stringify(look.chip));
  check(`${label}: opacity is the shared themed slider`, /gev-quantitative-slider/.test(look.range.cls) && look.range.appearance === "none" && look.range.height === "18px", JSON.stringify(look.range));
  check(`${label}: opacity value uses the accent token`, look.out.color === look.accentRgb, `${look.out.color} vs ${look.accentRgb}`);
  check(`${label}: [hidden] hides the section`, look.hiddenDisplay === "none", look.hiddenDisplay);
  // Rail siblings must not paint over the open card, and on the phone sheet
  // (one scrolling column) the card keeps its content height: it used to be
  // squashed to 208 px with its own nested scrollbar.
  const fit = await page.evaluate(() => {
    const card = document.querySelector("#time-travel-panel");
    const cr = card.getBoundingClientRect();
    const scroller = card.querySelector(":scope > [data-rail-scroller]");
    const ids = [...document.querySelectorAll("#right-context-rail > .panel-collapsible")]
      .filter((n) => n !== card && getComputedStyle(n).display !== "none")
      .map((n) => ({ id: n.id, r: n.getBoundingClientRect() }))
      .filter(({ r }) => r.height > 0 && r.top < cr.bottom - 0.5 && r.bottom > cr.top + 0.5 && r.left < cr.right && r.right > cr.left)
      .map(({ id }) => id);
    return {
      ids,
      sheet: document.body.classList.contains("mobile-shell"),
      clipped: scroller.scrollHeight - scroller.clientHeight,
    };
  });
  console.log(label, "fit", JSON.stringify(fit));
  check(`${label}: no other rail card paints over the open Time travel card`, fit.ids.length === 0, fit.ids.join());
  check(`${label}: on the phone sheet the open card shows all its content (no nested scroll)`, !fit.sheet || fit.clipped <= 1, `clipped ${fit.clipped}px`);
  await page.screenshot({ path: path.join(outDir, `${label}-panel.png`) });

  // Fly to Wood County, then switch overlays on.
  const flew = await page.evaluate(async () => window.__gevImagery?.voice?.year?.({ year: 2024, county: "Wood" }));
  console.log(label, "fly", JSON.stringify(flew));
  await sleep(9000);
  for (const id of ["hillshade", "lake-depth", "contours"])
    await page.evaluate((id) => document.querySelector(`#gev-overlays-panel [data-overlay="${id}"] input[type="checkbox"]`).click(), id);
  await page.evaluate(() => {
    const r = document.querySelector('#gev-overlays-panel [data-overlay="hillshade"] input[type="range"]');
    r.value = "25";
    r.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await sleep(8000);
  const after = await page.evaluate(() => ({
    state: window.__gevOverlays?.state(),
    range: document.querySelector('#gev-overlays-panel [data-overlay="hillshade"] input[type="range"]').value,
    out: document.querySelector('#gev-overlays-panel [data-overlay="hillshade"] output').textContent,
    disabled: document.querySelector('#gev-overlays-panel [data-overlay="hillshade"] input[type="range"]').disabled,
  }));
  console.log(label, "after", JSON.stringify({ active: after.state?.active, credits: after.state?.credits, range: after.range, out: after.out }));
  check(`${label}: three layers active`, [...(after.state?.active ?? [])].sort().join() === "contours,hillshade,lake-depth", after.state?.active?.join());
  // A phone-width view frames the county from higher up: only lake depth
  // (minzoom 9) has tiles there; the 3DEP layers start at zoom 11.
  const wide = viewport.width >= 800;
  check(`${label}: credits shown for the enabled layers`, ["Texas Water Development Board", ...(wide ? ["USGS 3DEP"] : [])].every((c) => after.state?.credits?.includes(c)), after.state?.credits?.join());
  check(`${label}: hillshade opacity 25%`, after.range === "25" && after.out === "25%" && after.disabled === false);
  const byLayer = (id) => tiles.filter((t) => t.path.startsWith(`/basemap/overlay/${id}/`));
  console.log(label, "tiles", JSON.stringify(Object.fromEntries(["hillshade", "contours", "lake-depth"].map((id) => [id, byLayer(id).length]))));
  for (const id of wide ? ["hillshade", "contours", "lake-depth"] : ["lake-depth"])
    check(`${label}: ${id} tiles requested, none failed`, byLayer(id).length > 0 && byLayer(id).every((t) => t.status === 200 || t.status === 204));
  await page.screenshot({ path: path.join(outDir, `${label}-on.png`) });
  // Stacking order: rows list the top first; raise hillshade with its button.
  const rowIds = () => page.evaluate(() => [...document.querySelectorAll("#gev-overlays-panel [data-overlay]")].map((r) => r.getAttribute("data-overlay")));
  const before = await rowIds();
  check(`${label}: rows list the top of the stack first (vector above raster)`, before.join() === "lake-depth,contours,terrain-rgb,relief,hillshade,ustopo", before.join());
  for (let i = 0; i < 4; i++)
    await page.evaluate(() => document.querySelector('#gev-overlays-panel [data-overlay="hillshade"] button[data-move="up"]').click());
  await sleep(500);
  const moved = await rowIds();
  const stack = await page.evaluate(() => window.__gevOverlays?.state().stack);
  check(`${label}: raise button moves the row and the stack`, moved[0] === "hillshade" && stack?.at(-1) === "hillshade", `${moved.join()} | ${stack?.join()}`);
  const ends = await page.evaluate(() => ({
    topUp: document.querySelector('#gev-overlays-panel [data-overlay="hillshade"] button[data-move="up"]').disabled,
    bottomDown: document.querySelector('#gev-overlays-panel [data-overlay="ustopo"] button[data-move="down"]').disabled,
  }));
  check(`${label}: top row cannot go up, bottom row cannot go down`, ends.topUp && ends.bottomDown, JSON.stringify(ends));
  await page.screenshot({ path: path.join(outDir, `${label}-reordered.png`) });
  await page.evaluate(() => document.querySelector('#gev-overlays-panel [data-overlay="hillshade"] input[type="checkbox"]').click());
  await sleep(500);
  const off = await page.evaluate(() => window.__gevOverlays?.state().active);
  check(`${label}: toggling off removes the layer`, [...(off ?? [])].sort().join() === "contours,lake-depth", off?.join());
  await context.close();
}

await run("desktop", { width: 1366, height: 800 });
await run("narrow", { width: 390, height: 800 });
await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} FAILED`);
  process.exit(1);
}
console.log("\nall checks passed");
