import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (file) =>
  readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const count = (text, needle) => text.split(needle).length - 1;

test('the Drone Flight Plan card is a collapsed top-level rail launcher', () => {
  const context = read('src/ui/templates/context.html');
  const tag = context.match(/<div id="drone-plan-panel"[^>]*>/)?.[0] ?? '';
  assert.match(tag, /data-panel-id="drone-plan-panel"/);
  assert.match(tag, /class="panel-collapsible collapsed"/);
  assert.doesNotMatch(tag, /\bhidden\b/, 'always present on the rail');
  assert.match(context, /id="drone-plan-panel-body"/);
  const rail = context.indexOf('<aside id="right-context-rail">');
  assert.ok(rail >= 0 && rail < context.indexOf('id="drone-plan-panel"'));
  assert.ok(
    context.indexOf('id="time-travel-panel"') <
      context.indexOf('id="drone-plan-panel"') &&
      context.indexOf('id="drone-plan-panel"') <
        context.indexOf('id="global-context-panel"'),
    'the card sits between TIME TRAVEL and CONTEXT in the rail',
  );
  assert.match(
    context,
    /data-collapse-target="drone-plan-panel"/,
    'it collapses like the other cards',
  );
});

test('DISPLAY no longer carries a Drone Flight Plan entry', () => {
  const display = read('src/ui/templates/display-controls.html');
  assert.doesNotMatch(display, /drone-plan-button/);
  assert.doesNotMatch(display, /drone-plan-group/);
  assert.doesNotMatch(display, /Drone Flight Plan/);
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
