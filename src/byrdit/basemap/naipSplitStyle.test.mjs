import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Regression for t_862ba336: the NAIP compare divider has to keep a
 * stylesheet. Its line is rendered later by ImagerySplitView (a Teleport from
 * the imagery split store), so the inline style the old createNaipSplit wrote
 * found no element and the divider collapsed to a 21 px strip. A rebase or
 * merge that drops naipSplit.css (or its import in style.css) fails here.
 */
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const css = fs.readFileSync(here('./naipSplit.css'), 'utf8');
const style = fs.readFileSync(here('../../../style.css'), 'utf8');
const view = fs.readFileSync(
  here('../../ui/views/panels/ImagerySplitView.vue'),
  'utf8',
);

const rule = (selector) => {
  const at = css.indexOf(`${selector} {`);
  assert.ok(at >= 0, `naipSplit.css has a rule for ${selector}`);
  return css.slice(at, css.indexOf('}', at));
};

test('style.css imports the naip split stylesheet', () => {
  assert.match(
    style,
    /@import\s+['"]\.\/src\/byrdit\/basemap\/naipSplit\.css['"];/,
  );
});

test('the line spans the screen from the split property', () => {
  const line = rule('#gev-naip-split-line');
  assert.match(line, /position:\s*fixed/);
  assert.match(line, /top:\s*0/);
  assert.match(line, /bottom:\s*0/);
  assert.match(line, /left:\s*var\(--gev-naip-split,\s*50%\)/);
  assert.match(line, /z-index:\s*1[1-9]\d/);
});

test('the handle is a visible, grabbable circle above the rails', () => {
  const handle = rule('#gev-naip-split-line .gev-naip-split-handle');
  assert.match(handle, /pointer-events:\s*auto/);
  assert.match(handle, /width:\s*36px/);
  assert.match(handle, /touch-action:\s*none/);
});

test('the view still renders the id, the labels and a handle button', () => {
  assert.match(view, /:id="optional\(split\.view\.id\)"/);
  assert.match(view, /:class="optional\(split\.view\.handleClass\)"/);
  assert.match(view, /class="before"/);
  assert.match(view, /class="after"/);
});
