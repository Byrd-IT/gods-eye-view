// Real shell geometry QA for the bottom-right map controls (language picker,
// navigation control, Sky). Local only: no app entrypoint, network feeds or
// WebGL. It loads the real shell markup (index.html hosts, the Vue views) and
// all app CSS, then measures 192 cases: 6 viewports x LTR/RTL x fine/coarse
// pointer x cockpit off/on x Sky open/closed x picker open/closed.
//   npm run qa:locale
//   node scripts/qa-locale-placement.mjs [--root DIR] [--json FILE] [--css FILE]
// --root measures another checkout (the baseline for a before/after delta,
// scripts/qa-locale-delta.mjs); --json writes every case's findings.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  const [flag, value] = [args[i], args[i + 1]];
  if (!['--css', '--root', '--json'].includes(flag) || !value) {
    console.error(
      'Usage: node scripts/qa-locale-placement.mjs [--root DIR] [--json FILE] [--css FILE]',
    );
    process.exit(2);
  }
  options[flag.slice(2)] = value;
}
const root = options.root
  ? path.resolve(options.root) + path.sep
  : fileURLToPath(new URL('../', import.meta.url));
// A root that is not a checkout of this app stops here, before Vite (whose
// own errors would print the path) starts.
if (
  !existsSync(path.join(root, 'index.html')) ||
  !existsSync(path.join(root, 'src/ui/views/ContextView.vue'))
) {
  console.error('Not a checkout of the app: --root needs index.html and src/');
  process.exit(2);
}
let candidate = '';
try {
  if (options.css) candidate = readFileSync(options.css, 'utf8');
} catch {
  console.error('Cannot read candidate CSS');
  process.exit(2);
}
// Export existing private DOM constructors only in this transient Vite server.
// The checked-out production files remain unchanged.
const plugin = {
  name: 'qa-locale-shell',
  transform(code, id) {
    const path = id.split('?')[0];
    if (path.endsWith('/src/byrdit/navControl/navControl.js'))
      return code
        .replace('function build(doc) {', 'export function qaBuildNav(doc) {')
        .replace(/= build\(doc\);/, '= qaBuildNav(doc);');
    if (path.endsWith('/src/byrdit/skyView/skyView.js'))
      return code
        .replace(
          'function buildDom(doc) {',
          'export function qaBuildSky(doc) {',
        )
        .replace('buildDom(doc)', 'qaBuildSky(doc)');
  },
  configureServer(server) {
    server.middlewares.use('/qa-shell', (_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      // Use the actual shell hosts, excluding its WebGL/data entrypoint and loader.
      const index = readFileSync(`${root}/index.html`, 'utf8');
      const hosts = index.match(
        /<div class="gev-view" data-gev-view="scene-chrome"><\/div>[\s\S]*?<div id="gev-stories-host" class="gev-view" data-gev-view="stories"><\/div>/,
      )?.[0];
      const fonts = [
        ...index.matchAll(
          /<link href="https:\/\/fonts\.googleapis\.com\/css2\?[^"\n]+" rel="stylesheet"\s*\/>/g,
        ),
      ]
        .map((match) => match[0])
        .join('');
      if (!hosts || !fonts) {
        res.statusCode = 500;
        res.end('Shell hosts or fonts missing');
        return;
      }
      res.end(
        `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/src/ui/styles/stories.css">${fonts}</head><body>${hosts}<div id="cesium-credits"><div class="cesium-widget-credits"><span class="cesium-credit-textContainer">Imagery</span><a class="cesium-credit-expand-link" href="#">Data attribution</a></div></div><script type="module" src="/qa-shell-entry.js"></script></body></html>`,
      );
    });
    server.middlewares.use('/qa-shell-entry.js', (_req, res) => {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(`import { mountApplicationViews } from '/src/ui/views/index.js';
import { applicationPinia } from '/src/ui/vueRuntime.js';
import { useLocaleStore } from '/src/ui/stores/locale.js';
import { useDisplayStore } from '/src/ui/stores/display.js';
import { useCockpitStore } from '/src/ui/stores/cockpit.js';
import { MOBILE_TABS } from '/src/ui/mobileShell.js';
import { LOCALES } from '/src/i18n/locale.js';
import { qaBuildNav } from '/src/byrdit/navControl/navControl.js';
import { qaBuildSky } from '/src/byrdit/skyView/skyView.js';
import { PanelLayoutController } from '/src/ui/panelLayoutController.js';
import { usePanelChromeStore } from '/src/ui/stores/panelChrome.js';
import { createVoiceControl } from '/src/voice/control.js';
localStorage.setItem('gevStoriesPopSeen','1'); // established user, no onboarding overlay
const pinia = applicationPinia();
useLocaleStore(pinia).publishPicker({current:'en',onSelect:()=>{}});
useDisplayStore(pinia).publishPhoneShell({enabled:true,sheet:null,tabs:MOBILE_TABS});
createVoiceControl({panel:true});
mountApplicationViews();
const nav = qaBuildNav(document).root; document.body.append(nav);
const sky = qaBuildSky(document);
// The app mounts Sky the way skyView.js does: in the SKY rail card when the
// shell has one (no floating button), else the floating button and panel.
const skyRail = document.getElementById('sky-view-panel');
const skyBody = document.getElementById('gev-sky-body');
if (skyRail && skyBody) { sky.panel.classList.add('gev-sky-panel--rail'); skyBody.append(sky.panel); }
else document.body.append(sky.button, sky.panel);
const chrome = usePanelChromeStore(pinia);
const token = chrome.connect({toggle:()=>{},pin:()=>{}});
const layout = new PanelLayoutController({readHud:()=>({visible:false}),scheduleCockpitLayout:()=>{},presentPanel:(el,patch)=>chrome.publish(token,el.id,patch),readDisplayScrollTop:()=>0});
layout._initCommandDockTrayMetrics();
layout._initLeftPanelAdaptiveLayout();
layout._initRightPanelAdaptiveLayout();
window.qaSetup = async ({dir, mobile, cockpit, skyOpen, pickerOpen}) => {
 document.documentElement.dir=dir;
 document.body.classList.toggle('mobile-shell', mobile);
 document.body.classList.toggle('cockpit-mode', cockpit);
 useCockpitStore(pinia).publishPresence(cockpit ? {active:true,subjectKind:'aircraft'} : null);
 sky.panel.hidden=!skyOpen;
 if (skyRail && skyBody) chrome.publish(token,'sky-view-panel',{collapsed:!skyOpen});
 else sky.button.setAttribute('aria-expanded',String(skyOpen));
 const button=document.querySelector('.locale-picker-button');
 if (!!document.querySelector('#locale-picker.is-open') !== pickerOpen) button.click();
 await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
};
window.qaLocales=LOCALES; window.qaReady=true;`);
    });
  },
};
const server = await createServer({
  root,
  configFile: false,
  envFile: false,
  plugins: [plugin, vue()],
  server: { host: '127.0.0.1', port: 0, strictPort: false },
  // Silent: Vite's own messages carry paths; failures surface as the
  // harness's fixed error below.
  logLevel: 'silent',
});
let browser;
try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : {}),
    args: ['--no-sandbox'],
  });
  const rows = [];
  for (const [width, height] of [
    [1280, 720],
    [1024, 768],
    [390, 844],
    [844, 390],
    [667, 375],
    [768, 1024],
  ]) {
    for (const pointer of ['fine', 'coarse']) {
      const page = await browser.newPage();
      let shellError = false;
      page.on('pageerror', () => {
        shellError = true;
      });
      await page.setViewport({
        width,
        height,
        hasTouch: pointer === 'coarse',
        isMobile: false,
      });
      await page.goto(`http://127.0.0.1:${port}/qa-shell`, {
        waitUntil: 'networkidle0',
      });
      await page.waitForFunction('window.qaReady === true', { timeout: 30000 });
      const fontsLoaded = await page.evaluate(async () => {
        const fonts = await document.fonts.load(
          '400 20px "Material Symbols Outlined"',
          'settings',
        );
        await document.fonts.ready;
        return (
          fonts.length > 0 && fonts.every((font) => font.status === 'loaded')
        );
      });
      if (!fontsLoaded) throw Error('App icon font unavailable');
      if (candidate) await page.addStyleTag({ content: candidate });
      const actualPointer = await page.evaluate(() => ({
        coarse: matchMedia('(pointer: coarse)').matches,
        touch: navigator.maxTouchPoints > 0,
      }));
      if (
        actualPointer.coarse !== (pointer === 'coarse') ||
        actualPointer.touch !== (pointer === 'coarse')
      )
        throw Error('Pointer emulation mismatch');
      const assess = ({ width, height, pickerOpen }) => {
        const failures = [];
        const button = document.querySelector('.locale-picker-button');
        const popup = document.querySelector('#locale-picker-popup');
        if (!button || !popup) return ['missing picker'];
        if (
          document
            .querySelector('#locale-picker')
            .classList.contains('is-open') !== pickerOpen ||
          popup.hidden === pickerOpen
        )
          failures.push('picker state mismatch');
        const visible = (e) => {
          if (
            !e.checkVisibility({
              opacityProperty: true,
              visibilityProperty: true,
            }) ||
            e.closest('[hidden]')
          )
            return false;
          const r = e.getBoundingClientRect();
          let left = r.left,
            right = r.right,
            top = r.top,
            bottom = r.bottom;
          for (let p = e.parentElement; p; p = p.parentElement) {
            const s = getComputedStyle(p),
              b = p.getBoundingClientRect();
            if (/(hidden|clip|auto|scroll)/.test(s.overflowX)) {
              left = Math.max(left, b.left);
              right = Math.min(right, b.right);
            }
            if (/(hidden|clip|auto|scroll)/.test(s.overflowY)) {
              top = Math.max(top, b.top);
              bottom = Math.min(bottom, b.bottom);
            }
          }
          return (
            right > left &&
            bottom > top &&
            right > 0 &&
            bottom > 0 &&
            left < width &&
            top < height
          );
        };
        const label = (e) =>
          e.id
            ? `#${e.id}`
            : e.getAttribute('data-collapse-target')
              ? `collapse:${e.getAttribute('data-collapse-target')}`
              : e.getAttribute('data-nav')
                ? `nav:${e.getAttribute('data-nav')}`
                : e.getAttribute('data-sky')
                  ? `sky:${e.getAttribute('data-sky')}`
                  : e.getAttribute('data-mobile-sheet')
                    ? `tab:${e.getAttribute('data-mobile-sheet')}`
                    : `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`;
        const rect = button.getBoundingClientRect();
        if (!visible(button)) failures.push('picker not visible');
        const pickerHit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        if (!pickerHit || !(pickerHit === button || button.contains(pickerHit)))
          failures.push('picker centre covered');
        // Interactive controls and non-interactive surface obstacles are reported separately.
        const controls = [
          ...document.querySelectorAll(
            'button,input,select,textarea,a[href],[role="slider"]',
          ),
        ].filter((e) => !e.closest('#locale-picker') && visible(e));
        const surfaces = [
          ...document.querySelectorAll(
            '.gev-nav,.gev-sky-panel,#sky-view-panel,#command-dock,#mobile-tab-bar,.cockpit-help,#left-panel-stack,#right-context-rail,#cesium-credits,.hud-bottom-left,#clean-view-eye',
          ),
        ].filter(visible);
        const intersects = (a, b) =>
          a.left < b.right &&
          a.right > b.left &&
          a.top < b.bottom &&
          a.bottom > b.top;
        if (!pickerOpen)
          for (const el of new Set([...controls, ...surfaces]))
            if (intersects(rect, el.getBoundingClientRect()))
              failures.push(`overlap:${label(el)}`);
        // Check every visible interactive centre, including when the list is open.
        for (const el of controls) {
          const r = el.getBoundingClientRect(),
            x = r.left + r.width / 2,
            y = r.top + r.height / 2;
          const hit = document.elementFromPoint(x, y);
          if (!hit || !(hit === el || el.contains(hit)))
            failures.push(`hit:${label(el)}=>${hit ? label(hit) : 'outside'}`);
        }
        if (pickerOpen) {
          const r = popup.getBoundingClientRect();
          if (
            !visible(popup) ||
            r.left < -0.5 ||
            r.top < -0.5 ||
            r.right > width + 0.5 ||
            r.bottom > height + 0.5
          )
            failures.push('popup outside viewport');
          const options = [...popup.querySelectorAll('.locale-picker-option')];
          if (
            options.length < 13 ||
            options.length !== window.qaLocales.length ||
            new Set(options.map((e) => e.dataset.locale)).size !==
              window.qaLocales.length
          )
            failures.push(
              `locale count:${options.length}/${window.qaLocales.length}`,
            );
          const list = popup.querySelector('.locale-picker-list');
          if (!list || !options.length || list.clientHeight <= 0)
            failures.push('locale list inaccessible');
          else {
            const bounds = list.getBoundingClientRect();
            if (
              bounds.left < -0.5 ||
              bounds.top < -0.5 ||
              bounds.right > width + 0.5 ||
              bounds.bottom > height + 0.5
            )
              failures.push('list outside viewport');
            list.scrollTop = list.scrollHeight;
            const bottom = options.at(-1).getBoundingClientRect(),
              box = list.getBoundingClientRect();
            if (bottom.bottom > box.bottom + 1 || bottom.top < box.top - 1)
              failures.push('last locale unreachable');
            list.scrollTop = 0;
          }
        }
        return [...new Set(failures)];
      };
      for (const dir of ['ltr', 'rtl'])
        for (const cockpit of [false, true])
          for (const skyOpen of [false, true])
            for (const pickerOpen of [false, true]) {
              await page.evaluate((opts) => window.qaSetup(opts), {
                dir,
                mobile: width <= 720,
                cockpit,
                skyOpen,
                pickerOpen,
              });
              const result = await page.evaluate(assess, {
                width,
                height,
                pickerOpen,
              });
              if (shellError) throw Error('Shell JavaScript error');
              rows.push({
                case: `${width}x${height} ${dir} ${pointer} cockpit=${+cockpit} sky=${+skyOpen} picker=${+pickerOpen}`,
                failures: result,
              });
            }
      // Negative control: place an opaque picker directly over the nav control.
      await page.evaluate(() =>
        window.qaSetup({
          dir: 'ltr',
          mobile: false,
          cockpit: false,
          skyOpen: false,
          pickerOpen: false,
        }),
      );
      await page.evaluate(() => {
        const button = document.querySelector('.locale-picker-button'),
          nav = document.querySelector('#gev-nav-control'),
          r = nav.getBoundingClientRect();
        Object.assign(button.style, {
          position: 'fixed',
          left: `${r.left}px`,
          top: `${r.top}px`,
          width: `${r.width}px`,
          height: `${r.height}px`,
          zIndex: '999999',
        });
      });
      const negative = await page.evaluate(assess, {
        width,
        height,
        pickerOpen: false,
      });
      if (!negative.includes('overlap:#gev-nav-control'))
        throw Error('Negative control was not detected');
      await page.close();
    }
  }
  for (const row of rows)
    console.log(
      `${row.failures.length ? 'FAIL' : 'PASS'} | ${row.case} | ${row.failures.join('; ') || '-'}`,
    );
  const passed = rows.filter((r) => !r.failures.length).length;
  console.log(
    `SUMMARY ${passed} pass, ${rows.length - passed} fail, ${rows.length} total; negative control: overlap detected in 12/12`,
  );
  if (options.json) writeFileSync(options.json, JSON.stringify(rows, null, 1));
  if (passed !== rows.length) process.exitCode = 1;
} catch (error) {
  console.error(
    'Harness error: failed to load or exercise the real shell',
    `(${error?.code || error?.name || 'error'})`,
  );
  process.exitCode = 2;
} finally {
  await browser?.close();
  await server.close();
}
