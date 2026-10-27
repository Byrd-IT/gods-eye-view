import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readStylesheet } from '../../testSupport/readStylesheet.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const css = readStylesheet(path.join(ROOT, 'style.css'));
const own = fs.readFileSync(
  path.join(ROOT, 'src/byrdit/cleanView/cleanView.css'),
  'utf8',
);

test('the fork clean-view rules are part of the app stylesheet', () => {
  assert.ok(css.includes(own.trim().slice(0, 200)));
});

test('clean view hides every fork map control with visibility, never display', () => {
  const m = own.match(/body\.ui-clean-view\s+:is\(([^)]*)\)\s*\{([^}]*)\}/);
  assert.ok(m, 'fork controls rule');
  const targets = m[1].split(',').map((t) => t.trim());
  assert.deepEqual(targets, [
    '#gev-naip-slider',
    '#gev-wayback',
    '#gev-naip-split-line',
    '.gev-hist',
    '.gev-nav',
    '.gev-sky-btn',
    '.gev-sky-panel',
  ]);
  assert.match(m[2], /visibility: hidden !important/);
  assert.match(m[2], /pointer-events: none !important/);
  assert.match(m[2], /transition-property: none !important/);
  // visibility, never display: boxes stay, so nothing reflows or resizes
  assert.doesNotMatch(m[2], /display:/);
});

test('no display: none rule hides a fork control in clean view (no reflow)', () => {
  // The nav control and Sky button keep display: none for the cockpit,
  // scene playback and recording only; clean view must not collapse them
  // (review t_2bb40d5a: toggling clean view must not resize any box).
  assert.match(
    css,
    /body:is\(\.cockpit-mode, \.scene-playback-mode, \.recording-mode\) \.gev-nav \{\s*display: none !important;/,
  );
  assert.match(
    css,
    /body:is\(\.cockpit-mode, \.scene-playback-mode, \.recording-mode\)\s+:is\(\.gev-sky-btn, \.gev-sky-panel\) \{\s*display: none !important;/,
  );
  for (const file of [
    'src/byrdit/navControl/navControl.css',
    'src/byrdit/skyView/skyView.css',
    'src/byrdit/cleanView/cleanView.css',
  ]) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const rule of text.matchAll(
      /([^{}]*ui-clean-view[^{}]*)\{([^}]*)\}/g,
    )) {
      if (/#clean-view-eye/.test(rule[1])) continue; // the eye itself
      assert.doesNotMatch(
        rule[2],
        /display:\s*none/,
        `${file}: ${rule[1].trim()}`,
      );
    }
  }
});

test('the map eye steps aside while Sky view is open', () => {
  assert.match(
    own,
    /body\.gev-sky-active #clean-view-eye \{\s*display: none !important;/,
  );
});

test('wide screens put the eye in the top-right corner, clear of the nav control', () => {
  const m = own.match(
    /@media \(min-width: 901px\) and \(min-height: 521px\) \{\s*#clean-view-eye \{([^}]*)\}/,
  );
  assert.ok(m);
  assert.match(
    m[1],
    /top: max\(78px, calc\(env\(safe-area-inset-top, 0px\) \+ 74px\)\)/,
  );
  assert.match(m[1], /bottom: auto/);
  // the nav control's wide placement this rule steps around
  const nav = fs.readFileSync(
    path.join(ROOT, 'src/byrdit/navControl/navControl.css'),
    'utf8',
  );
  assert.match(nav, /@media \(max-width: 900px\)/);
});

test('phones: the upstream corner row steps to the bottom-left, clear of both eyes', () => {
  const m = own.match(
    /@media \(max-width: 767\.98px\) and \(min-height: 521px\) \{\s*#corner-actions \{([^}]*)\}/,
  );
  assert.ok(m, 'phone #corner-actions rule');
  assert.match(m[1], /inset-inline-start: 10px/);
  assert.match(m[1], /inset-inline-end: auto/);
  // the upstream phone column this rule moves (same breakpoint)
  const corner = fs.readFileSync(
    path.join(ROOT, 'src/ui/styles/locale-picker.css'),
    'utf8',
  );
  assert.match(
    corner,
    /@media \(max-width: 767\.98px\) \{[\s\S]*?#corner-actions \{[^}]*flex-direction: column/,
  );
});

test('phone shell: both eyes ride above the upstream tab bar, never on its More tab', () => {
  const mobile = fs.readFileSync(
    path.join(ROOT, 'src/ui/styles/mobile-shell.css'),
    'utf8',
  );
  const sky = fs.readFileSync(
    path.join(ROOT, 'src/byrdit/skyView/skyView.css'),
    'utf8',
  );
  // the upstream facts this relies on: the bar, its height variable, and the
  // bar hiding in clean view
  assert.match(mobile, /--mobile-tab-space:/);
  assert.match(
    mobile,
    /body\.mobile-shell #mobile-tab-bar \{[^}]*position: fixed;[^}]*bottom: 0;/,
  );
  assert.match(mobile, /body\.mobile-shell\.ui-clean-view #mobile-tab-bar/);
  const shellRule = (text, selector) => {
    const media = '@media (max-width: 720px) and (min-height: 521px) {';
    const at = text.indexOf(media);
    assert.ok(at >= 0, 'phone media block');
    const rest = text.slice(at + media.length);
    const from = rest.indexOf(selector + ' {');
    assert.ok(from >= 0, selector);
    return rest.slice(from, rest.indexOf('}', from));
  };
  const bottom = /bottom: calc\(var\(--mobile-tab-space\) \+ 12px\)/;
  assert.match(shellRule(own, 'body.mobile-shell #clean-view-eye'), bottom);
  assert.match(shellRule(sky, 'body.mobile-shell .gev-sky-clear-btn'), bottom);
  // an open sheet (z 155-160) and its backdrop cover the map eye
  const sheet = shellRule(
    own,
    'body.mobile-shell[data-mobile-sheet] #clean-view-eye',
  );
  const z = Number(sheet.match(/z-index: (\d+)/)[1]);
  assert.ok(z < 155, 'below the sheet backdrop');
});
