#!/usr/bin/env node
// Run against a local Vite server: QA_BASE_URL=http://127.0.0.1:4572 node scripts/qa-context-panel-flex.mjs
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

let url;
try {
  url = new URL(process.env.QA_BASE_URL || 'http://127.0.0.1:4173/');
} catch {
  throw new Error('QA_BASE_URL must be a local HTTP origin without credentials or parameters');
}
if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
  throw new Error('QA_BASE_URL must be a local HTTP origin without credentials or parameters');
}
const browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox'],
});
const failures = [];
try {
  for (const [width, height] of [[360, 640], [390, 844], [320, 568]]) {
    const page = await browser.newPage();
    try {
      await page.setViewport({ width, height, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        const target = new URL(request.url());
        if (['127.0.0.1', 'localhost'].includes(target.hostname) || target.protocol === 'data:' || target.protocol === 'blob:') request.continue();
        else request.abort();
      });
      await page.goto(url.href, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.mobile-tab[data-mobile-sheet="context"]', { timeout: 120000 });
      await new Promise((resolve) => setTimeout(resolve, 8000));
      await page.keyboard.press('Escape');
      await page.click('.mobile-tab[data-mobile-sheet="context"]');
      await page.waitForFunction(() => document.body.dataset.mobileSheet === 'context');
      await page.evaluate(() => {
        for (const id of ['weather-panel', 'recent-imagery-panel']) {
          const panel = document.getElementById(id);
          panel.hidden = false;
          panel.classList.remove('collapsed');
          const body = document.getElementById(`${id}-body`);
          body.replaceChildren(...Array.from({ length: 14 }, (_, index) => {
            const button = document.createElement('button');
            button.textContent = `control ${index}`;
            button.style.cssText = 'display:block;width:100%;height:40px';
            return button;
          }));
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const metrics = await page.evaluate(async () => {
        const result = { overflow: document.documentElement.scrollWidth - innerWidth, panels: {} };
        for (const id of ['weather-panel', 'recent-imagery-panel']) {
          const panel = document.getElementById(id);
          const body = document.getElementById(`${id}-body`);
          const panelRect = panel.getBoundingClientRect();
          const contentRect = body.getBoundingClientRect();
          const last = body.lastElementChild;
          last.scrollIntoView({ block: 'center' });
          await new Promise((resolve) => setTimeout(resolve, 200));
          const rect = last.getBoundingClientRect();
          result.panels[id] = {
            height: panelRect.height,
            contentHeight: contentRect.bottom - panelRect.top,
            hit: document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === last,
          };
        }
        return result;
      });
      console.log(`${width}x${height} ${JSON.stringify(metrics)}`);
      try {
        assert.equal(metrics.overflow, 0, 'horizontal page overflow');
        for (const [id, panel] of Object.entries(metrics.panels)) {
          assert.ok(panel.height + 0.5 >= panel.contentHeight, `${id} is squashed`);
          assert.ok(panel.hit, `${id} last control is not hit-testable`);
        }
      } catch (error) {
        failures.push(`${width}x${height}: ${error.message}`);
      }
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
assert.deepEqual(failures, [], failures.join('\n'));
console.log('PASS: all 3 phone viewports');
