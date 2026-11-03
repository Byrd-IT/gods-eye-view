import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (file) =>
  readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const count = (text, needle) => text.split(needle).length - 1;

test('the Map layers card is its own collapsed rail launcher between TIME TRAVEL and DRONE FLIGHT PLAN', () => {
  const context = read('src/ui/views/ContextView.vue');
  const tag =
    context.match(/<RailPanel\s+id="map-layers-panel"[^>]*>/)?.[0] ?? '';
  assert.match(tag, /start-collapsed/);
  assert.match(tag, /\bhidden\b/, 'hidden until the overlays are on offer');
  assert.match(tag, /sideways/);
  assert.match(tag, /:title="t\(MAP LAYERS\)"/);
  assert.match(context, /id="gev-map-layers-body"/);
  const at = (id) => context.indexOf(`id="${id}"`);
  assert.ok(
    at('time-travel-panel') < at('map-layers-panel') &&
      at('map-layers-panel') < at('drone-plan-panel') &&
      at('drone-plan-panel') < at('global-context-panel'),
    'rail order: Time Travel, Map layers, Drone, Context',
  );
});

test('panel chrome, rail layout and the dock catalog know the card', () => {
  assert.equal(
    count(read('src/ui/panelChrome.js'), '\x27map-layers-panel\x27'),
    1,
  );
  assert.equal(
    count(read('src/ui/panelLayoutController.js'), '_mapLayersPanel'),
    3,
  );
  const catalog = read('src/ui/panelRailCatalog.js');
  assert.match(
    catalog,
    /\x27map-layers-panel\x27: \{ icon: \x27layers\x27, label: msg\(\x27MAP LAYERS\x27\) \}/,
  );
});

test('every rail rule written for Drone Flight Plan has its Map layers twin', () => {
  for (const file of [
    'layers.css',
    'responsive.css',
    'mobile-shell.css',
    'cyber.css',
  ]) {
    const css = read(`src/ui/styles/${file}`);
    const dp = count(css, 'drone-plan-panel');
    assert.ok(dp > 0, file);
    assert.equal(count(css, 'map-layers-panel'), dp, `${file} selector parity`);
  }
  assert.match(read('style.css'), /styles\/map-layers\.css/);
});

test('the MAP LAYERS launcher keeps the arrow inside the card and hides its body while collapsed', () => {
  const css = read('src/ui/styles/map-layers.css');
  const title = css.match(
    /#right-context-rail #map-layers-panel \.panel-title \{([^}]*)\}/,
  )?.[1];
  assert.ok(title);
  assert.match(title, /white-space: normal/);
  assert.match(title, /min-width: 0/);
  assert.match(
    css,
    /#map-layers-panel\.collapsed \.gev-ml-body \{\s*display: none !important;/,
  );
  assert.match(css, /#map-layers-panel\[hidden\]/);
});

test('phone size: search, group heads, raise/lower and the aerial shortcut are 44px targets', () => {
  const css = read('src/ui/styles/map-layers.css');
  const media = css.slice(
    css.indexOf('@media (max-width: 720px), (pointer: coarse)'),
  );
  for (const selector of [
    '.gev-ov-search-input',
    '.gev-ov-group-head',
    '.gev-ov-aerial',
    '.gev-ov-moves .data-toggle-chip',
  ])
    assert.ok(media.includes(selector), selector);
  assert.equal(count(media, 'min-height: 44px'), 4);
});

test('the overlay list moved out of Time Travel, not copied', () => {
  const menu = read('src/byrdit/timeTravel/menu.js');
  assert.doesNotMatch(menu, /name: \x27overlays\x27/);
  assert.doesNotMatch(read('src/ui/styles/time-travel.css'), /gev-ov-/);
  const panel = read('src/byrdit/basemap/overlaysPanel.js');
  assert.doesNotMatch(panel, /timeTravel/);
  assert.match(panel, /ensureMapLayersCard/);
});
