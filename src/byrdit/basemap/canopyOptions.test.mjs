import test from 'node:test';
import assert from 'node:assert/strict';
import {
  withCanopyLow,
  CANOPY_DEFAULT_LOW_FT,
  CANOPY_HISTORIC_DEFAULT_FT,
  CANOPY_MAX_CUT_FT,
} from './canopyOptions.js';

// A manifest shipping four options of its own must not squeeze any of the
// pinned presets (60 / 90 / 120) out at the cap — the old implementation
// sorted everything together and sliced, dropping 120 (and 90) in this case.
test('withCanopyLow keeps 60/90/120 pinned when the manifest offers four of its own', () => {
  assert.deepEqual(withCanopyLow([70, 80, 100, 110]), [60, 70, 90, 120]);
  assert.deepEqual(withCanopyLow([100, 110, 115, 120]), [60, 90, 100, 120]);
  // At most one manifest extra survives: lowest first, sorted ascending.
  assert.deepEqual(withCanopyLow([80, 100]), [60, 80, 90, 120]);
});

test('withCanopyLow already containing presets: deduped, ascending, still capped', () => {
  assert.deepEqual(withCanopyLow([90, 60, 120]), [60, 90, 120]);
  assert.deepEqual(withCanopyLow([60, 70, 90, 120, 110]), [60, 70, 90, 120]);
  assert.deepEqual(withCanopyLow([]), [60, 90, 120]);
  assert.deepEqual(withCanopyLow(null), [60, 90, 120]);
  assert.deepEqual(withCanopyLow('nope'), [60, 90, 120]);
});

test('withCanopyLow constants match the owner-approved band', () => {
  assert.equal(CANOPY_DEFAULT_LOW_FT, 60);
  assert.equal(CANOPY_HISTORIC_DEFAULT_FT, 90);
  assert.equal(CANOPY_MAX_CUT_FT, 120);
});
