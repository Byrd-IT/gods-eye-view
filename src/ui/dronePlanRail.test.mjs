import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (file) =>
  readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const count = (text, needle) => text.split(needle).length - 1;

test('the Drone Flight Plan card and its DISPLAY entry exist in the templates', () => {
  const context = read('src/ui/templates/context.html');
  assert.match(
    context,
    /id="drone-plan-panel"[^>]*data-panel-id="drone-plan-panel"[^>]*hidden/,
  );
  assert.match(context, /id="drone-plan-panel-body"/);
  assert.ok(
    context.indexOf('id="drone-plan-panel"') <
      context.indexOf('id="global-context-panel"'),
    'the card sits ahead of CONTEXT in the rail',
  );
  assert.match(
    read('src/ui/templates/display-controls.html'),
    /id="drone-plan-button"/,
  );
});

test('panel chrome and the rail layout know the card', () => {
  assert.equal(count(read('src/ui/panelChrome.js'), "'drone-plan-panel'"), 2);
  assert.equal(
    count(read('src/ui/panelLayoutController.js'), '_dronePlanPanel'),
    3,
  );
});

test('every rail rule written for Time travel has its Drone Flight Plan twin', () => {
  for (const file of [
    'layers.css',
    'responsive.css',
    'mobile-shell.css',
    'cyber.css',
  ]) {
    const css = read(`src/ui/styles/${file}`);
    const tt = count(
      css.replaceAll('gev-time-travel', ''),
      'time-travel-panel',
    );
    assert.ok(tt > 0, file);
    assert.equal(count(css, 'drone-plan-panel'), tt, `${file} selector parity`);
  }
  assert.match(read('style.css'), /styles\/drone-plan\.css/);
});
