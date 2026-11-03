#!/usr/bin/env node
/**
 * Rendered proof for the Map layers rail card (grouped map overlays).
 * QA_BASE_URL (default http://127.0.0.1:4392) must serve the app with
 * GEV_BASEMAP=1, GEV_BASEMAP_OVERLAYS=1 and a reachable overlays.json.
 * Drives a real browser at desktop (1600x900) and phone (390x844) size:
 * opens the Map layers dock card, finds the Lakes group, toggles the TWDB
 * lake depth layer on with a real click, checks opacity, raise/lower, search
 * and the 44px phone targets. Screenshots go to QA_OUT_DIR
 * (default ./qa-artifacts-map-layers).
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const appUrl = process.env.QA_BASE_URL || 'http://127.0.0.1:4392';
const outDir = path.resolve(process.env.QA_OUT_DIR || 'qa-artifacts-map-layers');
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' - ' + detail : ''}`);
  if (!ok) failures.push(name);
};

const browser = await puppeteer.launch({
  headless: 'new',
  ...(process.env.PUPPETEER_EXECUTABLE_PATH
    ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
    : {}),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox'],
});

async function run(label, viewport, { touch = false } = {}) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ ...viewport, hasTouch: touch, isMobile: touch });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.getElementById('map-layers-panel') && window.__gevOverlays,
    { timeout: 240000 },
  );
  await sleep(Number(process.env.QA_SETTLE_MS || 8000));
  await page.keyboard.press('Escape');
  const mobile = await page.evaluate(() => document.body.classList.contains('mobile-shell'));
  if (mobile) {
    await page.click('.mobile-tab[data-mobile-sheet="context"]');
    await sleep(600);
  }
  // Desktop: the dock lists every right-side card as a button; the collapsed
  // card itself is not drawn. Phone: the card is a launcher in the Context sheet.
  const closed = await page.evaluate(() => {
    const card = document.getElementById('map-layers-panel');
    const dock = [...document.querySelectorAll('.gev-panel-rail--right [data-rail-item]')].map((b) => ({
      id: b.getAttribute('data-rail-item'),
      label: b.getAttribute('aria-label'),
    }));
    return { collapsed: card.classList.contains('collapsed'), dock, title: card.querySelector('.panel-title')?.textContent.trim() };
  });
  console.log(label, 'launcher', JSON.stringify(closed));
  check(`${label}: card starts collapsed, titled MAP LAYERS`, closed.collapsed && closed.title === 'MAP LAYERS', closed.title);
  if (!mobile) {
    const ids = closed.dock.map((d) => d.id);
    check(`${label}: dock button MAP LAYERS sits between TIME TRAVEL and DRONE FLIGHT PLAN`, ids.indexOf('map-layers-panel') === ids.indexOf('time-travel-panel') + 1 && ids.indexOf('drone-plan-panel') === ids.indexOf('map-layers-panel') + 1, ids.join());
    check(`${label}: the dock button is labelled MAP LAYERS`, closed.dock.find((d) => d.id === 'map-layers-panel')?.label === 'MAP LAYERS');
  }
  await page.screenshot({ path: path.join(outDir, `${label}-launcher.png`) });
  if (mobile) {
    await page.waitForSelector('#map-layers-panel', { visible: true, timeout: 30000 });
    await page.click('#map-layers-panel .panel-collapse-btn');
  } else {
    await page.click('[data-rail-item="map-layers-panel"]');
  }
  await sleep(1500);
  await page.waitForSelector('#map-layers-panel:not(.collapsed)', { visible: true, timeout: 30000 });
  const open = await page.evaluate(() => {
    const card = document.getElementById('map-layers-panel');
    const panel = document.getElementById('gev-overlays-panel');
    const vis = (n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight + 1; };
    const lakes = panel.querySelector('[data-group="lakes"]');
    const lakeRows = [...lakes.querySelectorAll('[data-overlay]')].filter((r) => r.offsetParent);
    const groups = [...panel.querySelectorAll('.gev-ov-group')].filter((g) => !g.hidden).map((g) => g.getAttribute('data-group'));
    return {
      collapsed: card.classList.contains('collapsed'),
      inCard: card.contains(panel),
      inTimeTravel: Boolean(document.querySelector('#time-travel-panel #gev-overlays-panel')),
      totalRows: panel.querySelectorAll('[data-overlay]').length,
      groups,
      lakeRows: lakeRows.map((r) => r.getAttribute('data-overlay')),
      lakeNames: lakeRows.map((r) => r.querySelector('label').textContent.trim()),
      lakeRowInView: lakeRows.length > 0 && vis(lakeRows[0]),
      hasSearch: Boolean(panel.querySelector('input[type="search"]')),
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  console.log(label, 'open', JSON.stringify(open));
  check(`${label}: card opens with the overlays in it, none left in Time Travel`, !open.collapsed && open.inCard && !open.inTimeTravel);
  check(`${label}: all 63 layers present (grouped)`, open.totalRows === 63, String(open.totalRows));
  check(`${label}: Lakes group listed first`, open.groups[0] === 'lakes', open.groups.join());
  check(`${label}: Lakes group open with 7 lake / bay depth rows incl. TWDB lake depth contours`, open.lakeRows.length === 7 && open.lakeRows.includes('lake-depth') && open.lakeNames.some((n) => /TWDB lake depth contours/.test(n)), open.lakeRows.join());
  check(`${label}: first Lakes row is on screen without scrolling the page`, open.lakeRowInView);
  check(`${label}: search box present, no horizontal overflow`, open.hasSearch && !open.overflow);
  await page.screenshot({ path: path.join(outDir, `${label}-open.png`) });

  // Real click on the TWDB lake depth contours checkbox.
  await page.evaluate(() => document.querySelector('#gev-overlays-panel [data-overlay="lake-depth"]').scrollIntoView({ block: 'center' }));
  await page.click('#gev-overlays-panel [data-overlay="lake-depth"] input[type="checkbox"]');
  await sleep(1500);
  const on = await page.evaluate(() => ({
    active: window.__gevOverlays.state().active,
    checked: document.querySelector('#gev-overlays-panel [data-overlay="lake-depth"] input[type="checkbox"]').checked,
    rangeDisabled: document.querySelector('#gev-overlays-panel [data-overlay="lake-depth"] input[type="range"]').disabled,
    count: document.querySelector('#gev-overlays-panel [data-group="lakes"] .gev-ov-group-count').textContent,
  }));
  console.log(label, 'toggled', JSON.stringify(on));
  check(`${label}: Lakes layer toggles ON (state + checkbox + opacity enabled)`, on.active.includes('lake-depth') && on.checked && !on.rangeDisabled, JSON.stringify(on));
  check(`${label}: Lakes header shows 1/7 on`, on.count === '1/7', on.count);

  // Opacity.
  await page.evaluate(() => {
    const r = document.querySelector('#gev-overlays-panel [data-overlay="lake-depth"] input[type="range"]');
    r.value = '55';
    r.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(500);
  const op = await page.evaluate(() => window.__gevOverlays.state().layers.find((l) => l.id === 'lake-depth').opacity);
  check(`${label}: opacity slider drives the layer`, Math.abs(op - 0.55) < 0.001, String(op));

  // Raise / lower: lower lake-depth one step, then raise it back.
  const stackBefore = await page.evaluate(() => window.__gevOverlays.state().stack.slice());
  await page.click('#gev-overlays-panel [data-overlay="lake-depth"] button[data-move="down"]');
  await sleep(500);
  const stackDown = await page.evaluate(() => window.__gevOverlays.state().stack.slice());
  await page.click('#gev-overlays-panel [data-overlay="lake-depth"] button[data-move="up"]');
  await sleep(500);
  const stackUp = await page.evaluate(() => window.__gevOverlays.state().stack.slice());
  check(`${label}: lower moves the layer down one step`, stackDown.indexOf('lake-depth') === stackBefore.indexOf('lake-depth') - 1, `${stackBefore.indexOf('lake-depth')} -> ${stackDown.indexOf('lake-depth')}`);
  check(`${label}: raise moves it back`, stackUp.join() === stackBefore.join());

  // Search: clear the box, then type like a person (one input event per key).
  const setSearch = async (text) => {
    await page.$eval('#gev-overlays-panel input[type="search"]', (el) => {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.focus();
    });
    if (text) await page.keyboard.type(text);
    await sleep(400);
  };
  const shownRows = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('#gev-overlays-panel [data-overlay]')]
        .filter((r) => r.offsetParent)
        .map((r) => r.getAttribute('data-overlay')),
    );
  await setSearch('hillshade');
  const hill = await shownRows();
  const lakesHidden = await page.evaluate(() => document.querySelector('#gev-overlays-panel [data-group="lakes"]').hidden);
  check(`${label}: search "hillshade" lists only hillshade layers`, hill.length >= 7 && hill.every((id) => /hillshade/.test(id)) && lakesHidden, hill.join());
  await page.screenshot({ path: path.join(outDir, `${label}-search.png`) });
  await setSearch('lake');
  const lakeSearch = await shownRows();
  check(`${label}: search "lake" lists the 7 lake / bay layers`, lakeSearch.length === 7 && lakeSearch.includes('lake-depth'), lakeSearch.join());
  await setSearch('zzz-no-such-layer');
  const none = await page.evaluate(() => ({ note: !document.querySelector('#gev-overlays-panel .gev-ov-empty').hidden, rows: [...document.querySelectorAll('#gev-overlays-panel [data-overlay]')].filter((r) => r.offsetParent).length }));
  check(`${label}: a search with no match shows the note and no rows`, none.note && none.rows === 0, JSON.stringify(none));
  await setSearch('');
  const back = await shownRows();
  check(`${label}: clearing the search restores the default view (Lakes open)`, back.length === 7, String(back.length));

  if (mobile) {
    const sizes = await page.evaluate(() => {
      const h = (sel) => { const n = document.querySelector(sel); const r = n?.getBoundingClientRect(); return r ? Math.round(r.height) : 0; };
      return {
        search: h('#gev-overlays-panel input[type="search"]'),
        groupHead: h('#gev-overlays-panel .gev-ov-group-head'),
        raise: h('#gev-overlays-panel [data-overlay="lake-depth"] button[data-move="up"]'),
        raiseW: Math.round(document.querySelector('#gev-overlays-panel [data-overlay="lake-depth"] button[data-move="up"]').getBoundingClientRect().width),
        name: h('#gev-overlays-panel [data-overlay="lake-depth"] label'),
      };
    });
    console.log(label, 'touch sizes', JSON.stringify(sizes));
    check(`${label}: phone targets are at least 44px`, sizes.search >= 44 && sizes.groupHead >= 44 && sizes.raise >= 44 && sizes.raiseW >= 44 && sizes.name >= 44, JSON.stringify(sizes));
  }
  check(`${label}: no page errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
  await page.screenshot({ path: path.join(outDir, `${label}-final.png`) });
  await context.close();
}

await run('desktop', { width: 1600, height: 900 });
await run('phone', { width: 390, height: 844 }, { touch: true });
await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} FAILED`);
  process.exit(1);
}
console.log('\nall checks passed');
