/**
 * Headless-Chromium gate for the map's clean view and its corner eye.
 * Loads the REAL app at four device emulations (phone 412x915 portrait,
 * phone 915x412 landscape, tablet 820x1180, desktop 1440x900) and checks:
 *   A. normal mode: the eye is painted, >= 44x44, inside the screen, a
 *      focusable <button> with aria-label and aria-pressed=false, on top at
 *      its centre, and clear of the credit line, the nav control, the Sky
 *      button and every other painted control
 *   B. one tap/click on the eye enters clean view: only the globe, the eye,
 *      the complete attribution and the allowed map content stay painted
 *      (computed style audit of every element); the Clean UI button is
 *      active + aria-pressed; the camera, the layer state and the viewport
 *      do not change; no resize event and no ResizeObserver entry on any
 *      layout container (globe, both side rails and every rail panel, dock,
 *      credits, HUD, fork map controls)
 *   C. every credit Cesium puts on screen is inside the viewport, not
 *      clipped and clear of the eye
 *   D. the eye fades after ~3 s idle and comes back on input
 *   E. V, Escape, the Clean UI button and the EXIT pill stay in sync with
 *      the eye; a held V (autorepeat keydowns) toggles once
 *   F. a second tap on the eye brings every control back, with no
 *      ResizeObserver entry once the exit fade has settled
 *   G. the eye is hidden in cockpit, scene playback, recording and Sky view
 *   H. settled round trip: once the globe has loaded and the network is
 *      quiet, a baseline window, an eye enter and an eye exit (equal windows)
 *      show no layout-container resize, and every request is classified:
 *      a layer/data request in a toggle window passes only as a scheduled
 *      poll (same endpoint, on its earlier cadence); a tile already loaded
 *      before must not be requested again (new tiles = refinement, reported)
 * Screenshots: <out>/<viewport>-{normal,clean,restored}.png
 *   node scripts/qa-map-clear-view.mjs --url http://127.0.0.1:4371 --out <dir>
 *   --audit-only: no assertions; enter clean view with V and list what stays
 *   painted (use it on a build without the eye to get the before list).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { makeRedactor, urlSecrets } from './qa-map-clear-view-redact.mjs';
import {
  classifyRequest,
  classifyWindow,
} from './qa-map-clear-view-requests.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg('--url', 'http://127.0.0.1:4371');
const OUT = path.resolve(arg('--out', 'qa-map-clear-view'));
const SETTLE_MS = Number(arg('--settle-ms', '15000'));
const AUDIT_ONLY = process.argv.includes('--audit-only');
const ONLY = arg('--only', '');
fs.mkdirSync(OUT, { recursive: true });
// --url may carry credentials or tokens: mask them in every line we print or
// save, and in a crash (a refused or failed navigation echoes the URL).
const redact = makeRedactor(urlSecrets(BASE));
const fatal = (e) => {
  console.error(redact(e?.stack || e?.message || String(e)));
  process.exit(1);
};
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const say = (...p) => {
  const line = redact(
    p.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '),
  );
  log.push(line);
  console.log(line);
};
const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), detail });
  say(ok ? 'PASS' : 'FAIL', name, detail ?? '');
};

const VIEWPORTS = {
  phone: {
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
  },
  phoneLandscape: {
    width: 915,
    height: 412,
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    isLandscape: true,
  },
  tablet: {
    width: 820,
    height: 1180,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
  desktop: {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
};
// Phones (max-width 720 or max-height 520): the eye replaces the EXIT pill.
const isSmall = (vp) => vp.width <= 720 || vp.height <= 520;

/**
 * Every painted element (computed style: displayed, visible, opaque chain,
 * on screen, and drawing something), grouped by its owner: the nearest
 * ancestor-or-self with an id (or its tag.class). Elements inside an allowed
 * selector are reported separately.
 */
function paintAudit(allowed) {
  const vw = innerWidth;
  const vh = innerHeight;
  const globe = document.querySelector('.cesium-widget > canvas');
  const opacityOk = new Map();
  const chainOpaque = (el) => {
    if (!el || el === document.documentElement) return true;
    if (opacityOk.has(el)) return opacityOk.get(el);
    const ok =
      Number(getComputedStyle(el).opacity) > 0.01 &&
      chainOpaque(el.parentElement);
    opacityOk.set(el, ok);
    return ok;
  };
  const transparent = (c) =>
    !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c);
  const paints = (el, cs) => {
    if (/^(CANVAS|IMG|VIDEO|INPUT|SELECT|TEXTAREA|svg)$/i.test(el.tagName))
      return true;
    if (!transparent(cs.backgroundColor) || cs.backgroundImage !== 'none')
      return true;
    if (cs.maskImage && cs.maskImage !== 'none') return true;
    if (cs.webkitMaskImage && cs.webkitMaskImage !== 'none') return true;
    if (cs.boxShadow && cs.boxShadow !== 'none') return true;
    for (const side of ['Top', 'Right', 'Bottom', 'Left'])
      if (
        parseFloat(cs[`border${side}Width`]) > 0 &&
        !transparent(cs[`border${side}Color`]) &&
        cs[`border${side}Style`] !== 'none'
      )
        return true;
    return [...el.childNodes].some(
      (n) => n.nodeType === 3 && n.textContent.trim(),
    );
  };
  const owner = (el) => {
    let a = el;
    while (a && a !== document.body) {
      if (a.id) return `#${a.id}`;
      a = a.parentElement;
    }
    const cls = [...el.classList].slice(0, 2).join('.');
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`;
  };
  const out = { owners: {}, allowed: {} };
  for (const el of document.querySelectorAll('body *')) {
    if (el === globe || el.contains(globe)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility !== 'visible') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) continue;
    if (!paints(el, cs)) continue;
    if (!chainOpaque(el)) continue;
    const hit = allowed.find((sel) => el.closest(sel));
    const bucket = hit ? out.allowed : out.owners;
    const key = hit ? hit : owner(el);
    if (!bucket[key])
      bucket[key] = {
        n: 0,
        box: [r.left, r.top, r.right, r.bottom].map(Math.round),
      };
    bucket[key].n += 1;
  }
  return out;
}

/** Credit line completeness: every credit on screen, unclipped. */
function creditAudit() {
  const root = document.querySelector('#cesium-credits .cesium-widget-credits');
  if (!root) return { ok: false, why: 'no credit line' };
  const vw = innerWidth;
  const vh = innerHeight;
  const rr = root.getBoundingClientRect();
  const bad = [];
  let shown = 0;
  for (const el of root.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility !== 'visible') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    shown += 1;
    const name = `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`;
    if (
      r.left < -0.5 ||
      r.top < -0.5 ||
      r.right > vw + 0.5 ||
      r.bottom > vh + 0.5
    )
      bad.push(
        `${name} off screen ${[r.left, r.top, r.right, r.bottom].map(Math.round)}`,
      );
    if (cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1)
      bad.push(`${name} ellipsised`);
    for (
      let a = el.parentElement;
      a && a !== root.parentElement;
      a = a.parentElement
    ) {
      const acs = getComputedStyle(a);
      if (acs.overflowX !== 'visible' || acs.overflowY !== 'visible') {
        const ar = a.getBoundingClientRect();
        if (
          r.left < ar.left - 0.5 ||
          r.right > ar.right + 0.5 ||
          r.top < ar.top - 0.5 ||
          r.bottom > ar.bottom + 0.5
        )
          bad.push(
            `${name} clipped by ${a.tagName.toLowerCase()}.${[...a.classList].join('.')}`,
          );
      }
    }
  }
  return {
    ok: bad.length === 0 && shown > 0 && rr.width > 20 && rr.height > 6,
    shown,
    box: [rr.left, rr.top, rr.right, rr.bottom].map(Math.round),
    bad: bad.slice(0, 8),
  };
}

/** Eye box/state and every painted control box (for overlap checks). */
function eyeState() {
  const eye = document.getElementById('clean-view-eye');
  if (!eye) return null;
  const cs = getComputedStyle(eye);
  const r = eye.getBoundingClientRect();
  const cx = (r.left + r.right) / 2;
  const cy = (r.top + r.bottom) / 2;
  const top = document.elementFromPoint(cx, cy);
  const btn = document.getElementById('clean-view-toggle');
  const box = (el) => {
    if (!el) return null;
    const c = getComputedStyle(el);
    if (c.display === 'none' || c.visibility !== 'visible') return null;
    const q = el.getBoundingClientRect();
    return q.width < 1 || q.height < 1
      ? null
      : [q.left, q.top, q.right, q.bottom].map(Math.round);
  };
  const controls = [];
  for (const el of document.querySelectorAll(
    'button, a[href], input, select, textarea, [role=button], [tabindex]:not([tabindex="-1"]), .gev-nav, .gev-hist, #gev-naip-slider, #key-setup-chip',
  )) {
    if (el === eye || eye.contains(el)) continue;
    const b = box(el);
    if (!b) continue;
    let opaque = true;
    for (let a = el; a && a !== document.documentElement; a = a.parentElement)
      if (Number(getComputedStyle(a).opacity) <= 0.01) opaque = false;
    if (!opaque) continue;
    controls.push({
      name: el.id
        ? `#${el.id}`
        : `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 2).join('.')}`,
      box: b,
    });
  }
  return {
    box: [r.left, r.top, r.right, r.bottom].map(Math.round),
    display: cs.display,
    visibility: cs.visibility,
    opacity: Number(cs.opacity),
    pressed: eye.getAttribute('aria-pressed'),
    label: eye.getAttribute('aria-label'),
    idle: eye.getAttribute('data-idle'),
    tag: eye.tagName,
    tabIndex: eye.tabIndex,
    onTop: top === eye || eye.contains(top),
    clean: document.body.classList.contains('ui-clean-view'),
    cleanBtnActive: Boolean(btn?.classList.contains('active')),
    cleanBtnPressed: btn?.getAttribute('aria-pressed'),
    exitShown: Boolean(box(document.getElementById('clean-view-exit'))),
    credits: box(
      document.querySelector('#cesium-credits .cesium-widget-credits'),
    ),
    nav: box(document.querySelector('.gev-nav')),
    skyBtn: box(document.querySelector('.gev-sky-btn')),
    controls,
    vw: innerWidth,
    vh: innerHeight,
  };
}

/** Camera + layer signature: must not change when clean view toggles. */
function sceneSignature() {
  const v = window.__godsEyeView?.viewer;
  const c = v?.camera;
  const round = (x) => Math.round(x * 1e6) / 1e6;
  const layers = [
    ...document.querySelectorAll(
      '[data-layer].active, [data-layer][aria-pressed="true"], .layer-toggle.active, input[type=checkbox][data-layer]:checked',
    ),
  ]
    .map((el) => el.dataset.layer || el.id)
    .sort();
  return {
    pos: c
      ? [c.positionWC.x, c.positionWC.y, c.positionWC.z].map(
          (x) => Math.round(x * 100) / 100,
        )
      : null,
    hpr: c ? [c.heading, c.pitch, c.roll].map(round) : null,
    dataSources: v?.dataSources?.length ?? null,
    imagery: v?.imageryLayers?.length ?? null,
    primitives: v?.scene?.primitives?.length ?? null,
    layers,
    url: location.search + location.hash,
  };
}

/**
 * Every painted box that touches `box` (normal mode): text, backgrounds,
 * borders and media, minus full-screen layers and the eye itself. HUD
 * decoration (#intel-hud) is flagged so it can be reported separately.
 */
function paintedAround(box) {
  const vw = innerWidth;
  const vh = innerHeight;
  const eye = document.getElementById('clean-view-eye');
  const transparent = (c) =>
    !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c);
  const hits = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el === eye || eye?.contains(el) || el.contains(eye)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility !== 'visible') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (r.width * r.height > 0.4 * vw * vh) continue; // full-screen layers
    if (!(
      r.left < box[2] &&
      box[0] < r.right &&
      r.top < box[3] &&
      box[1] < r.bottom
    ))
      continue;
    let opaque = true;
    for (let a = el; a && a !== document.documentElement; a = a.parentElement)
      if (Number(getComputedStyle(a).opacity) <= 0.01) opaque = false;
    if (!opaque) continue;
    const paints =
      /^(CANVAS|IMG|VIDEO|INPUT|SELECT|TEXTAREA|BUTTON|svg)$/i.test(
        el.tagName,
      ) ||
      !transparent(cs.backgroundColor) ||
      cs.backgroundImage !== 'none' ||
      (parseFloat(cs.borderTopWidth) > 0 && !transparent(cs.borderTopColor)) ||
      [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!paints) continue;
    let owner = el;
    while (owner && !owner.id && owner !== document.body)
      owner = owner.parentElement;
    hits.push({
      name: `${owner?.id ? `#${owner.id} ` : ''}${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 2).join('.')}`,
      box: [r.left, r.top, r.right, r.bottom].map(Math.round),
      hud: Boolean(el.closest('#intel-hud')),
    });
  }
  return hits;
}

const overlaps = (a, b) =>
  Boolean(a && b) && a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

function recordRequests(page) {
  const list = [];
  page.on('request', (r) => {
    let ep = '?';
    try {
      const u = new URL(r.url());
      ep = `${u.host}${u.pathname}`.slice(0, 120);
    } catch {}
    list.push({
      t: Date.now(),
      cls: classifyRequest(r.resourceType(), r.url()),
      type: r.resourceType(),
      ep,
      id: createHash('sha256').update(r.url()).digest('hex').slice(0, 16),
    });
  });
  return list;
}
// Layout containers watched for ResizeObserver entries (B, F, H).
const LAYOUT_CONTAINERS = [
  '.cesium-widget',
  '#left-panel-stack',
  '#right-context-rail',
  '#left-panel-stack > [data-panel-id]',
  '#right-context-rail > [data-panel-id]',
  '#pp-toggles',
  '#command-dock',
  '#cesium-credits',
  '#intel-hud',
  '#title-bar',
  '#location-bar',
  '#gev-naip-slider',
  '.gev-nav',
  '.gev-hist',
  '.gev-sky-btn',
];
// Leaving clean view holds the rails until the 0.4 s fade is over (capped at
// 2 s, panelLayoutController.js); sample after that.
const RELEASE_SETTLE_MS = 2600;

const browser = await puppeteer.launch({
  headless: true,
  protocolTimeout: 600000,
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
  ],
});
const errors = [];

async function openMap(vp) {
  const page = await browser.newPage();
  page.__qaRequests = recordRequests(page);
  await page.setViewport(vp);
  page.on('pageerror', (e) => errors.push(redact(String(e)).slice(0, 300)));
  await page.goto(`${BASE}/`, {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  });
  await page.waitForFunction(() => window.__godsEyeView?.viewer, {
    timeout: 180000,
  });
  await sleep(SETTLE_MS);
  await page.keyboard.press('Escape'); // the first-launch chooser
  await sleep(800);
  // Pause the camera's own motion (auto-orbit etc.) so a toggle is the only
  // thing that could move it between two signatures.
  await page.evaluate((containers) => {
    const v = window.__godsEyeView.viewer;
    window.__qaResizes = 0;
    window.addEventListener('resize', () => (window.__qaResizes += 1));
    window.__qaRo = 0;
    window.__qaRoNames = [];
    const ro = new ResizeObserver((entries) => {
      if (!window.__qaRoArmed) return;
      window.__qaRo += entries.length;
      for (const e of entries)
        window.__qaRoNames.push(
          `${e.target.id || e.target.className} ${Math.round(e.contentRect.width)}x${Math.round(e.contentRect.height)}`,
        );
    });
    const watched = new Set();
    for (const sel of containers)
      document.querySelectorAll(sel).forEach((el) => watched.add(el));
    watched.forEach((el) => ro.observe(el));
    window.__qaRoWatched = [...watched].map(
      (el) => el.id || String(el.className).split(' ')[0],
    );
    window.__qaRoArmed = false;
    v.clock.shouldAnimate = v.clock.shouldAnimate; // no-op, keeps v alive
  }, LAYOUT_CONTAINERS);
  return page;
}

/** Wait until no CSS transition is running (panels fade in/out). */
async function settle(page, minMs = 300) {
  await sleep(minMs);
  await page
    .waitForFunction(
      () =>
        document
          .getAnimations()
          .filter(
            (a) =>
              a.playState === 'running' &&
              a.constructor.name === 'CSSTransition',
          ).length === 0,
      { timeout: 10000, polling: 100 },
    )
    .catch(() => {});
}

/** Re-arm the ResizeObserver tally (and the resize-event count). */
const armChurn = (page) =>
  page.evaluate(() => {
    window.__qaResizes = 0;
    window.__qaRo = 0;
    window.__qaRoNames = [];
    window.__qaRoArmed = true;
  });
const readChurn = (page) =>
  page.evaluate(() => ({
    resizes: window.__qaResizes,
    ro: window.__qaRo,
    names: window.__qaRoNames.slice(0, 40),
    watched: window.__qaRoWatched.length,
  }));

/**
 * Settled: the globe reports every tile loaded and no tile or layer request
 * has started for `quietMs`. Capped so a busy feed shows up as a failure.
 */
async function waitQuiet(page, quietMs = 2500, capMs = 45000) {
  const t0 = Date.now();
  for (;;) {
    const tilesLoaded = await page.evaluate(
      () => window.__godsEyeView?.viewer?.scene?.globe?.tilesLoaded === true,
    );
    const last = page.__qaRequests
      .filter((r) => r.cls === 'tile' || r.cls === 'layer')
      .reduce((m, r) => Math.max(m, r.t), 0);
    const quietFor = Date.now() - last;
    if (tilesLoaded && quietFor >= quietMs)
      return { ok: true, waitedMs: Date.now() - t0, tilesLoaded, quietFor };
    if (Date.now() - t0 > capMs)
      return { ok: false, waitedMs: Date.now() - t0, tilesLoaded, quietFor };
    await sleep(250);
  }
}

async function pressEye(page, vp) {
  const box = await page.evaluate(() => {
    const r = document.getElementById('clean-view-eye').getBoundingClientRect();
    return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
  });
  if (vp.hasTouch) await page.touchscreen.tap(box.x, box.y);
  else await page.mouse.click(box.x, box.y);
}

// Allowed in clean view. The globe canvas is skipped by the audit itself.
//  - the eye; the complete attribution (and Cesium's credit list);
//  - #toast: status messages;
//  - map content, not controls: world-anchored labels and the selected
//    entity's tracking card (#world-overlay-root), detection boxes and the
//    scope mask (visual effects the user turned on), the user's own screen
//    drawings (.gev-screen-whiteboard);
//  - #scene-runtime.active: a running scene's own caption (upstream rule).
const ALLOWED_BASE = [
  '#clean-view-eye',
  '#cesium-credits',
  '.cesium-credit-lightbox-overlay',
  '#toast',
  '#world-overlay-root',
  '#world-overlay-detection-surface',
  '#scope-mask',
  '.gev-screen-whiteboard',
  '#scene-runtime.active',
];

const report = {};
const requestReport = {};
for (const [label, vp] of Object.entries(VIEWPORTS)) {
  if (ONLY && ONLY !== label) continue;
  say(`\n== ${label} ${vp.width}x${vp.height}`);
  const page = await openMap(vp);
  const allowed = isSmall(vp)
    ? ALLOWED_BASE
    : [...ALLOWED_BASE, '#clean-view-exit'];
  const normalPaint = await page.evaluate(paintAudit, []);
  await page.screenshot({ path: path.join(OUT, `${label}-normal.png`) });

  if (AUDIT_ONLY) {
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press('v');
    await sleep(3000);
    const clean = await page.evaluate(paintAudit, allowed);
    const credits = await page.evaluate(creditAudit);
    await page.screenshot({ path: path.join(OUT, `${label}-clean.png`) });
    report[label] = {
      normal: Object.keys(normalPaint.owners),
      cleanLeft: clean.owners,
      cleanAllowed: Object.keys(clean.allowed),
      credits,
    };
    say('normal painted owners', Object.keys(normalPaint.owners));
    say('NOT hidden in clean view', clean.owners);
    say('allowed', Object.keys(clean.allowed), 'credits', credits);
    await page.close();
    continue;
  }

  // A. normal mode
  const e0 = await page.evaluate(eyeState);
  check(
    `${label} A eye present and painted`,
    e0 &&
      e0.display !== 'none' &&
      e0.visibility === 'visible' &&
      e0.opacity >= 0.5,
    e0 && { display: e0.display, opacity: e0.opacity },
  );
  if (!e0) {
    await page.close();
    continue;
  }
  const [x0, y0, x1, y1] = e0.box;
  check(
    `${label} A eye >= 44x44 inside the screen`,
    x1 - x0 >= 44 &&
      y1 - y0 >= 44 &&
      x0 >= 0 &&
      y0 >= 0 &&
      x1 <= e0.vw &&
      y1 <= e0.vh,
    e0.box,
  );
  check(
    `${label} A eye is a focusable button with aria`,
    e0.tag === 'BUTTON' &&
      e0.tabIndex >= 0 &&
      e0.pressed === 'false' &&
      Boolean(e0.label),
    { label: e0.label, pressed: e0.pressed },
  );
  check(`${label} A eye on top at its centre`, e0.onTop);
  const clash = e0.controls.filter((c) => overlaps(c.box, e0.box));
  check(
    `${label} A eye clear of credits/nav/Sky button/controls`,
    !overlaps(e0.box, e0.credits) &&
      !overlaps(e0.box, e0.nav) &&
      !overlaps(e0.box, e0.skyBtn) &&
      clash.length === 0,
    { eye: e0.box, credits: e0.credits, nav: e0.nav, clash },
  );
  // Nothing else painted under the eye either (labels, chips, text). The
  // HUD is a decorative full-screen overlay whose edge text runs down the
  // screen sides; touching it is reported, not failed.
  const under = await page.evaluate(paintedAround, e0.box);
  const hudUnder = under.filter((h) => h.hud);
  check(
    `${label} A nothing painted under the eye (HUD edge text reported)`,
    under.filter((h) => !h.hud).length === 0,
    { under: under.filter((h) => !h.hud), hud: hudUnder.map((h) => h.name) },
  );
  await page.focus('#clean-view-eye');
  const focused = await page.evaluate(() => document.activeElement?.id);
  check(
    `${label} A eye takes keyboard focus`,
    focused === 'clean-view-eye',
    focused,
  );
  await page.evaluate(() => document.activeElement?.blur?.());

  // B. one tap on the eye
  const sig0 = await page.evaluate(sceneSignature);
  await armChurn(page);
  await pressEye(page, vp);
  await sleep(300);
  const e1 = await page.evaluate(eyeState);
  await settle(page, 300);
  check(
    `${label} B eye tap enters clean view, all controls in sync`,
    e1.clean &&
      e1.pressed === 'true' &&
      e1.cleanBtnActive &&
      e1.cleanBtnPressed === 'true',
    {
      clean: e1.clean,
      eye: e1.pressed,
      cleanBtn: [e1.cleanBtnActive, e1.cleanBtnPressed],
    },
  );
  check(
    `${label} B EXIT pill ${isSmall(vp) ? 'replaced by the eye' : 'kept'}`,
    e1.exitShown === !isSmall(vp),
    e1.exitShown,
  );
  const cleanPaint = await page.evaluate(paintAudit, allowed);
  check(
    `${label} B only globe, eye, attribution and map content painted`,
    Object.keys(cleanPaint.owners).length === 0,
    { left: cleanPaint.owners, allowed: Object.keys(cleanPaint.allowed) },
  );
  check(
    `${label} B eye still painted and on top`,
    e1.visibility === 'visible' && e1.onTop && e1.opacity > 0.5,
    e1.opacity,
  );
  const credits = await page.evaluate(creditAudit);
  check(
    `${label} C attribution complete (on screen, not clipped)`,
    credits.ok,
    credits,
  );
  check(
    `${label} C attribution clear of the eye`,
    !overlaps(credits.box, e1.box),
    { credits: credits.box, eye: e1.box },
  );
  await page.screenshot({ path: path.join(OUT, `${label}-clean.png`) });
  const sig1 = await page.evaluate(sceneSignature);
  const churn = await readChurn(page);
  check(
    `${label} B camera and layers unchanged`,
    JSON.stringify(sig0) === JSON.stringify(sig1),
    { before: sig0, after: sig1 },
  );
  // Every watched layout container, the side rails and their panels
  // included: clean view hides with visibility and holds the rail layout.
  check(
    `${label} B no resize event, no ResizeObserver entry on any layout container`,
    churn.resizes === 0 && churn.ro === 0 && churn.watched >= 5,
    churn,
  );

  // D. fade after ~3 s, wake on input
  await page.keyboard.press('Shift'); // input: restarts the idle clock
  await sleep(150);
  const e2a = await page.evaluate(eyeState);
  check(`${label} D eye awake right after input`, e2a.idle === null, e2a.idle);
  await sleep(3600);
  await settle(page, 0); // the 0.4 s fade itself
  const e2 = await page.evaluate(eyeState);
  check(
    `${label} D eye fades after 3 s idle`,
    e2.idle === 'true' && e2.opacity <= 0.25,
    { idle: e2.idle, opacity: e2.opacity },
  );
  // A slow emulated tap can take seconds, so count the wake-ups themselves
  // (data-idle removed) instead of sampling the button once.
  await page.evaluate(() => {
    window.__qaWakes = 0;
    window.__qaWakeObs?.disconnect();
    window.__qaWakeObs = new MutationObserver((records) => {
      for (const r of records)
        if (r.oldValue === 'true' && !r.target.hasAttribute('data-idle'))
          window.__qaWakes += 1;
    });
    window.__qaWakeObs.observe(document.getElementById('clean-view-eye'), {
      attributes: true,
      attributeFilter: ['data-idle'],
      attributeOldValue: true,
    });
  });
  const t0 = Date.now();
  if (vp.hasTouch)
    await page.touchscreen.tap(
      Math.round(vp.width / 2),
      Math.round(vp.height / 3),
    );
  else await page.keyboard.press('Shift');
  await sleep(550);
  const e3 = await page.evaluate(eyeState);
  const wakes = await page.evaluate(() => window.__qaWakes);
  const dt = Date.now() - t0;
  check(
    `${label} D ${vp.hasTouch ? 'a touch' : 'a key'} wakes the eye`,
    wakes >= 1 &&
      e3.clean &&
      (dt > 2900 || (e3.idle === null && e3.opacity >= 0.7)),
    { wakes, idle: e3.idle, opacity: e3.opacity, clean: e3.clean, ms: dt },
  );

  // E. V / Escape / Clean UI / EXIT stay in sync
  const st = () => page.evaluate(eyeState);
  const synced = (s, on) =>
    s.clean === on &&
    s.pressed === String(on) &&
    s.cleanBtnActive === on &&
    s.cleanBtnPressed === String(on);
  await page.keyboard.press('v');
  await sleep(300);
  check(
    `${label} E V exits, eye + Clean UI in sync`,
    synced(await st(), false),
  );
  await page.keyboard.press('v');
  await sleep(300);
  check(
    `${label} E V enters, eye + Clean UI in sync`,
    synced(await st(), true),
  );
  await page.keyboard.press('Escape');
  await sleep(300);
  check(
    `${label} E Escape restores, eye + Clean UI in sync`,
    synced(await st(), false),
  );
  await page.keyboard.press('Escape');
  await sleep(200);
  check(
    `${label} E Escape outside clean view does not enter it`,
    synced(await st(), false),
  );
  await page.evaluate(() =>
    document.getElementById('clean-view-toggle').click(),
  );
  await sleep(300);
  check(
    `${label} E Clean UI button enters, eye in sync`,
    synced(await st(), true),
  );
  if (isSmall(vp))
    await page.evaluate(() =>
      document.getElementById('clean-view-exit').click(),
    );
  else await page.click('#clean-view-exit');
  await sleep(300);
  check(
    `${label} E EXIT pill restores, eye in sync`,
    synced(await st(), false),
  );
  await page.keyboard.down('v');
  for (let i = 0; i < 8; i += 1) {
    await sleep(40);
    await page.keyboard.down('v'); // autorepeat: event.repeat = true
  }
  await page.keyboard.up('v');
  await sleep(300);
  check(`${label} E held V toggles once`, synced(await st(), true));

  // F. eye tap brings everything back
  const sigF0 = await page.evaluate(sceneSignature);
  await armChurn(page);
  await pressEye(page, vp);
  await settle(page, 600);
  const eF = await st();
  const backPaint = await page.evaluate(paintAudit, []);
  // #hud-rec-dot blinks (CSS animation), so it may be dark at either sample.
  const missing = Object.keys(normalPaint.owners).filter(
    (k) => !backPaint.owners[k] && k !== '#hud-rec-dot',
  );
  check(
    `${label} F eye tap restores every control`,
    synced(eF, false) && missing.length === 0,
    { missing },
  );
  const sigF1 = await page.evaluate(sceneSignature);
  check(
    `${label} F camera and layers unchanged on restore`,
    JSON.stringify(sigF0) === JSON.stringify(sigF1),
    { before: sigF0, after: sigF1 },
  );
  await page.screenshot({ path: path.join(OUT, `${label}-restored.png`) });
  await sleep(RELEASE_SETTLE_MS);
  const churnF = await readChurn(page);
  check(
    `${label} F no resize event, no ResizeObserver entry on any layout container when leaving`,
    churnF.resizes === 0 && churnF.ro === 0,
    churnF,
  );

  // H. settled round trip: layout stability and request-classified no refetch
  const quiet = await waitQuiet(page);
  check(
    `${label} H map settled (tiles loaded, network quiet)`,
    quiet.ok,
    quiet,
  );
  const WIN = RELEASE_SETTLE_MS + 1400;
  await armChurn(page);
  const tBase = Date.now();
  await sleep(WIN);
  const churnBase = await readChurn(page);
  const sigH0 = await page.evaluate(sceneSignature);
  await armChurn(page);
  const tEnter = Date.now();
  await pressEye(page, vp);
  await sleep(WIN);
  const churnEnter = await readChurn(page);
  const enteredH = (await st()).clean;
  await armChurn(page);
  const tExit = Date.now();
  await pressEye(page, vp);
  await sleep(WIN);
  const churnExit = await readChurn(page);
  const tEnd = Date.now();
  const sigH1 = await page.evaluate(sceneSignature);
  const reqs = page.__qaRequests;
  const wBase = classifyWindow(reqs, tBase, tEnter);
  const wEnter = classifyWindow(reqs, tEnter, tExit);
  const wExit = classifyWindow(reqs, tExit, tEnd);
  check(
    `${label} H eye round trip (enter then exit) completed`,
    enteredH && !(await st()).clean,
  );
  check(
    `${label} H no ResizeObserver entry: baseline, enter, exit`,
    churnBase.ro + churnEnter.ro + churnExit.ro === 0 &&
      churnBase.resizes + churnEnter.resizes + churnExit.resizes === 0,
    {
      baseline: churnBase.names,
      enter: churnEnter.names,
      exit: churnExit.names,
      watched: churnEnter.watched,
    },
  );
  check(
    `${label} H camera and layers unchanged over the round trip`,
    JSON.stringify(sigH0) === JSON.stringify(sigH1),
    { before: sigH0, after: sigH1 },
  );
  check(
    `${label} H no refetch: toggle-window layer requests are scheduled polls, no loaded tile requested again`,
    // The recorder must have seen the page load, or empty windows prove nothing.
    reqs.length > 0 &&
      wEnter.refetch.length === 0 &&
      wExit.refetch.length === 0,
    {
      recorded: reqs.length,
      windowMs: WIN,
      baseline: wBase,
      enter: wEnter,
      exit: wExit,
    },
  );
  requestReport[label] = {
    windowMs: WIN,
    quiet,
    baseline: wBase,
    enter: wEnter,
    exit: wExit,
  };

  // G. hidden while another mode owns the screen
  for (const mode of [
    'cockpit-mode',
    'scene-playback-mode',
    'recording-mode',
    'gev-sky-active',
  ]) {
    const d = await page.evaluate((m) => {
      document.body.classList.add(m);
      const v = getComputedStyle(
        document.getElementById('clean-view-eye'),
      ).display;
      document.body.classList.remove(m);
      return v;
    }, mode);
    check(`${label} G eye hidden in ${mode}`, d === 'none', d);
  }
  report[label] = {
    normal: Object.keys(normalPaint.owners),
    cleanAllowed: Object.keys(cleanPaint.allowed),
    cleanLeft: cleanPaint.owners,
    credits,
    eye: e0.box,
  };
  await page.close();
}

await browser.close();
const failed = checks.filter((c) => !c.ok);
check('no page errors', errors.length === 0, errors.slice(0, 5));
fs.writeFileSync(
  path.join(OUT, 'report.json'),
  redact(JSON.stringify({ checks, report, requestReport, errors }, null, 2)),
);
fs.writeFileSync(path.join(OUT, 'log.txt'), log.join('\n'));
if (AUDIT_ONLY) process.exit(0);
const total = checks.length;
const bad = checks.filter((c) => !c.ok).length;
say(`\nQA map clear view ${bad ? 'FAIL' : 'PASS'} ${total - bad}/${total}`);
process.exit(bad || failed.length ? 1 : 0);
