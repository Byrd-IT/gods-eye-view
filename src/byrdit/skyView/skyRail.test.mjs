// Sky is a card in the right-hand rail of panels (ContextView.vue
// #sky-view-panel), wired like SOLUNAR; the floating Sky button is gone from
// the app shell. Behaviour of the card (open/close, voice, following) is in
// skyView.test.mjs; this file checks the wiring and the stylesheets.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { SKY_RAIL_BODY_ID, SKY_RAIL_ID } from './skyView.js';

const read = (file) =>
  readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
const count = (text, needle) => text.split(needle).length - 1;

test('the SKY card is a collapsed rail launcher between SOLUNAR and DRONE FLIGHT PLAN', () => {
  assert.equal(SKY_RAIL_ID, 'sky-view-panel');
  assert.equal(SKY_RAIL_BODY_ID, 'gev-sky-body');
  const context = read('src/ui/views/ContextView.vue');
  const tag =
    context.match(/<RailPanel\s+id="sky-view-panel"[^>]*>/)?.[0] ?? '';
  assert.match(tag, /start-collapsed/);
  assert.doesNotMatch(tag, /\bhidden\b/, 'the menu item is always on offer');
  assert.match(tag, /sideways/);
  assert.match(tag, /rail-scroller/);
  assert.match(tag, /:title="t\('SKY'\)"/);
  assert.match(context, /id="gev-sky-body"/);
  const at = (id) => context.indexOf(`id="${id}"`);
  assert.ok(
    at('solunar-panel') < at('sky-view-panel') &&
      at('sky-view-panel') < at('drone-plan-panel'),
  );
});

test('panel chrome, rail layout and the dock catalog know the card', () => {
  const chrome = read('src/ui/panelChrome.js');
  assert.equal(count(chrome, "'sky-view-panel'"), 1);
  // Cockpit folds it like the other launchers.
  const cockpit = chrome.slice(
    chrome.indexOf('COCKPIT_ENTRY_COLLAPSE_PANEL_IDS'),
  );
  assert.ok(cockpit.indexOf("'sky-view-panel'") < cockpit.indexOf(']'));
  const layout = read('src/ui/panelLayoutController.js');
  assert.equal(
    count(layout, '_skyViewPanel'),
    count(layout, '_solunarPanel'),
    'the rail lays out and watches the SKY card wherever it does SOLUNAR',
  );
  assert.match(
    read('src/ui/panelRailCatalog.js'),
    /'sky-view-panel': \{ icon: 'star', label: msg\('SKY'\) \}/,
  );
  assert.match(read('index.html'), /icon_names=[^"&]*\bstar\b/);
});

test('every rail rule written for SOLUNAR has its SKY twin', () => {
  for (const file of ['layers.css', 'responsive.css', 'mobile-shell.css']) {
    const css = read(`src/ui/styles/${file}`);
    assert.ok(count(css, 'solunar-panel') > 0, `${file} has rail rules`);
    assert.equal(
      count(css, 'sky-view-panel'),
      count(css, 'solunar-panel'),
      `${file} selector parity`,
    );
  }
});

test('the card hides its body while collapsed; the panel flows in the card', () => {
  const css = read('src/byrdit/skyView/skyView.css');
  assert.match(
    css,
    /#sky-view-panel\.collapsed \.gev-sky-body \{\s*display: none !important;/,
  );
  const rail = css.match(
    /\.gev-sky-panel\.gev-sky-panel--rail \{([^}]*)\}/,
  )?.[1];
  assert.ok(rail);
  assert.match(rail, /position: static/);
  assert.match(
    css,
    /\.gev-sky-panel--rail \.gev-sky-close \{\s*display: none;/,
  );
});

test('clean view and Sky mode hide the whole right rail, the SKY card with it', () => {
  assert.match(
    read('src/byrdit/cleanView/cleanView.css'),
    /body\.ui-clean-view\s*:is\([^)]*#sky-view-panel[^)]*\)/,
  );
  assert.match(
    read('src/ui/styles/layers.css'),
    /body\.ui-clean-view #right-context-rail > \[data-panel-id\]/,
  );
  assert.match(
    read('src/byrdit/skyView/skyView.css'),
    /body\.gev-sky-active #right-context-rail \{\s*display: none !important;/,
  );
});

test('the app mounts Sky into the rail card: no floating Sky button in the shell', () => {
  const sky = read('src/byrdit/skyView/skyView.js');
  const mount = sky.slice(sky.indexOf('const railCard'));
  // The floating button is appended only on the no-rail path.
  assert.match(
    mount,
    /if \(rail\) \{[\s\S]*?rail\.body\.append\(dom\.panel\);\s*host\.append\(dom\.bar, satDom\.root\);\s*\} else \{\s*host\.append\(dom\.button, dom\.panel, dom\.bar, satDom\.root\);/,
  );
});
