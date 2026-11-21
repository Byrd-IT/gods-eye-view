// The language picker row (#corner-actions, locale-picker.css) and the map
// navigation control (#gev-nav-control, navControl.css) share the
// bottom-right corner on wide screens. The row stands on top of the control,
// never over it. The browser check of the same geometry across 192 cases is
// `npm run qa:locale` / `npm run qa:locale:delta` (scripts/); this file holds
// the static clearances and the before/after comparison logic.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  compareRuns,
  coveredByOpenPopup,
  formatComparison,
  involvesControls,
  openedIn,
} from '../../scripts/qa-locale-delta.mjs';

const read = (file) =>
  readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const px = (text) => Number(/(-?[\d.]+)px/.exec(text)?.[1]);
/** Sum the px terms of `calc(a + b + ...)`. */
const sumCalc = (text) =>
  [...text.matchAll(/(-?[\d.]+)px/g)].reduce((s, m) => s + Number(m[1]), 0);
/** The declarations of the first rule whose selector ends with `selector {`. */
function ruleBody(css, selector, from = 0) {
  const at = css.indexOf(`${selector} {`, from);
  assert.ok(at >= 0, `rule ${selector}`);
  return css.slice(at, css.indexOf('}', at));
}

/** The nav control's outer box, in px from the viewport's bottom-right. */
function navBox(coarse) {
  const css = read('src/byrdit/navControl/navControl.css');
  const base = ruleBody(css, '.gev-nav');
  const padding = /padding: (\d+)px/.exec(base);
  const border = px(/border: ([^;]+);/.exec(base)[1]);
  let size = px(/--gev-nav-size: ([^;]+);/.exec(base)[1]);
  if (coarse) {
    const media = css.slice(css.indexOf('@media (pointer: coarse)'));
    size = px(/--gev-nav-size: ([^;]+);/.exec(media)[1]);
  }
  const bottom = px(/bottom: ([^;]+);/.exec(base)[1]);
  return {
    right: px(/right: ([^;]+);/.exec(base)[1]),
    bottom,
    top: bottom + size + 2 * Number(padding[1]) + 2 * border,
  };
}

/** The picker row's wide-screen LTR placement, fine and coarse pointers. */
function pickerPlacement() {
  const css = read('src/ui/styles/locale-picker.css');
  const fineAt = css.indexOf('@media (min-width: 901px) {');
  const coarseAt = css.indexOf(
    '@media (min-width: 901px) and (pointer: coarse) {',
  );
  assert.ok(fineAt >= 0 && coarseAt > fineAt);
  const fine = css.slice(fineAt, coarseAt);
  const coarse = css.slice(coarseAt, css.indexOf('}\n}', coarseAt));
  for (const block of [fine, coarse]) {
    assert.match(block, /:root:not\(\[dir='rtl'\]\)/);
    assert.match(
      block,
      /body:not\(\.cockpit-mode, \.scene-playback-mode, \.recording-mode\)/,
    );
    assert.match(block, /#corner-actions \{/);
  }
  return {
    right: px(/right: ([^;]+);/.exec(fine)[1]),
    fineBottom: sumCalc(/bottom: ([^;]+);/.exec(fine)[1]),
    coarseBottom: sumCalc(/bottom: ([^;]+);/.exec(coarse)[1]),
  };
}

test('wide screens: the picker row stands on the nav control with an 8px gap, right edges aligned', () => {
  const picker = pickerPlacement();
  const fine = navBox(false);
  const coarse = navBox(true);
  assert.equal(fine.top, 116, 'nav: 14 + 84 + 2 x 8 padding + 2 x 1 border');
  assert.equal(coarse.top, 128, 'coarse nav: 14 + 96 + 18');
  assert.equal(picker.right, fine.right);
  assert.equal(picker.fineBottom - fine.top, 8);
  assert.equal(picker.coarseBottom - coarse.top, 8);
});

test('the nav control keeps its corner and the right rail stops above the picker row', () => {
  const nav = navBox(false);
  assert.deepEqual([nav.right, nav.bottom], [36, 14]);
  const layout = read('src/ui/panelLayoutController.js');
  const start = layout.indexOf('RIGHT_STACK_OBSTACLE_SELECTOR');
  const list = layout.slice(start, layout.indexOf("].join(', ')", start));
  assert.ok(list.includes("'#gev-nav-control'"));
  assert.ok(list.includes("'#corner-actions'"));
});

test('the old floating Sky button spot (right 36px, bottom 124px) is free for the row', () => {
  // Sky is a rail card now (skyRail.test.mjs); the row reuses the corner
  // slot above the nav control the button had.
  assert.match(
    read('src/byrdit/skyView/skyView.js'),
    /rail\.body\.append\(dom\.panel\)/,
  );
  assert.equal(pickerPlacement().fineBottom, 124);
});

test('delta: only findings about the picker, nav control or Sky count', () => {
  assert.equal(involvesControls('overlap:#gev-nav-control'), true);
  assert.equal(involvesControls('outside viewport'), true);
  assert.equal(
    involvesControls(
      'hit:#gev-nav-control [data-nav=zoom-in]=>#corner-actions',
    ),
    true,
  );
  assert.equal(involvesControls('hit:collapse:sky-view-panel=>outside'), true);
  assert.equal(involvesControls('hit:#hStories=>outside'), false);
});

test('delta: a control covered by a popup the case opened is allowed', () => {
  const opened = openedIn('1280x720 ltr fine cockpit=0 sky=1 picker=1');
  assert.deepEqual(opened, { picker: true, sky: true });
  assert.equal(
    coveredByOpenPopup('hit:.gev-nav=>#locale-picker-option-fr', opened),
    true,
  );
  assert.equal(
    coveredByOpenPopup('hit:.gev-nav=>#locale-picker-option-fr', {
      picker: false,
      sky: false,
    }),
    false,
  );
  assert.equal(coveredByOpenPopup('overlap:#gev-nav-control', opened), false);
  // The open Sky panel in its rail card meets or covers the picker.
  assert.equal(coveredByOpenPopup('overlap:#sky-view-panel', opened), true);
  assert.equal(
    coveredByOpenPopup('picker centre covered=>div.gev-sky-panel', opened),
    true,
  );
  const closed = { picker: false, sky: false };
  assert.equal(coveredByOpenPopup('overlap:#sky-view-panel', closed), false);
  assert.equal(
    coveredByOpenPopup('picker centre covered=>div.gev-sky-panel', closed),
    false,
  );
});

test('delta: baseline findings are allowed, new ones fail, fixed ones are counted', () => {
  const name = '1280x720 ltr fine cockpit=0 sky=0 picker=0';
  const baseline = [
    {
      case: name,
      failures: ['overlap:#gev-nav-control', 'hit:#hStories=>outside'],
    },
    { case: 'gone', failures: [] },
  ];
  const candidate = [
    {
      case: name,
      failures: [
        'hit:.gev-nav=>.locale-picker-button',
        'hit:#hStories=>outside',
      ],
    },
  ];
  const result = compareRuns(baseline, candidate);
  assert.equal(result.failedCases, 1);
  assert.deepEqual(result.rows[0].regressions, [
    'hit:.gev-nav=>.locale-picker-button',
  ]);
  assert.deepEqual(result.rows[0].fixed, ['overlap:#gev-nav-control']);
  assert.deepEqual(result.missing, ['gone'], 'a case that vanished fails');
  const text = formatComparison(result);
  assert.match(text, /^FAIL \| 1280x720/m);
  assert.match(text, /^FAIL \| gone \| missing case$/m);

  const same = compareRuns(baseline.slice(0, 1), baseline.slice(0, 1));
  assert.equal(same.failedCases, 0);
  assert.equal(same.rows[0].allowed.length, 1);
});
