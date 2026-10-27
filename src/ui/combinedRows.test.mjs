import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMBINED_ROWS,
  CombinedSelection,
  combinedChips,
  combinedRowOf,
  combinedRowState,
  planChipToggle,
  planRowSwitch,
} from './combinedRows.js';

const row = COMBINED_ROWS.find(({ id }) => id === 'usgs-water');
const IDS = [
  'local-usgs-water',
  'local-usgs-wells',
  'local-usgs-lakes',
  'local-usgs-springs',
];
const enabledSet = (...ids) => {
  const set = new Set(ids);
  return { set, isEnabled: (id) => set.has(id) };
};

test('USGS Water row covers the four unchanged layer ids with colours', () => {
  assert.deepEqual(
    row.members.map(({ id }) => id),
    IDS,
  );
  assert.ok(row.members.every(({ color }) => /^#[0-9a-f]{6}$/i.test(color)));
  for (const id of IDS) assert.equal(combinedRowOf(id), row);
  assert.equal(combinedRowOf('earthquakes'), null);
});

test('row state: all-on, partial, all-off', () => {
  assert.deepEqual(combinedRowState(row, enabledSet(...IDS).isEnabled), {
    enabled: true,
    selected: IDS,
    all: true,
    partial: false,
  });
  const partial = combinedRowState(
    row,
    enabledSet('local-usgs-lakes', 'local-usgs-water').isEnabled,
  );
  assert.equal(partial.enabled, true);
  assert.equal(partial.partial, true);
  assert.deepEqual(partial.selected, ['local-usgs-water', 'local-usgs-lakes']);
  const off = combinedRowState(row, enabledSet().isEnabled);
  assert.equal(off.enabled, false);
  assert.equal(off.all, false);
  assert.equal(off.partial, false);
});

test('restore from URL tokens: state comes from the layers, not a flag', () => {
  // Only springs restored from a saved link: row reads on with one chip.
  const { isEnabled } = enabledSet('local-usgs-springs');
  const state = combinedRowState(row, isEnabled);
  assert.equal(state.enabled, true);
  const chips = combinedChips(row, isEnabled);
  assert.deepEqual(
    chips.map(({ id, active }) => [id, active]),
    [
      ['local-usgs-water', false],
      ['local-usgs-wells', false],
      ['local-usgs-lakes', false],
      ['local-usgs-springs', true],
    ],
  );
  assert.ok(chips.every(({ color }) => color));
});

test('switch on from nothing enables all four the first time', () => {
  const selection = new CombinedSelection();
  assert.deepEqual(
    planRowSwitch(row, enabledSet().isEnabled, selection),
    IDS.map((id) => [id, true]),
  );
});

test('switch off disables only the enabled categories; switch on restores them', () => {
  const selection = new CombinedSelection();
  const live = enabledSet('local-usgs-water', 'local-usgs-lakes');
  const off = planRowSwitch(row, live.isEnabled, selection);
  assert.deepEqual(off, [
    ['local-usgs-water', false],
    ['local-usgs-lakes', false],
  ]);
  live.set.clear();
  assert.deepEqual(planRowSwitch(row, live.isEnabled, selection), [
    ['local-usgs-water', true],
    ['local-usgs-lakes', true],
  ]);
});

test('chip toggles one category; last chip off leaves the row off and remembered', () => {
  const selection = new CombinedSelection();
  const live = enabledSet(...IDS);
  assert.deepEqual(
    planChipToggle(row, 'local-usgs-wells', live.isEnabled, selection),
    [['local-usgs-wells', false]],
  );
  live.set.delete('local-usgs-wells');
  assert.equal(combinedRowState(row, live.isEnabled).partial, true);
  // Turn the rest off, one at a time.
  for (const id of ['local-usgs-water', 'local-usgs-lakes']) {
    planChipToggle(row, id, live.isEnabled, selection);
    live.set.delete(id);
  }
  planChipToggle(row, 'local-usgs-springs', live.isEnabled, selection);
  live.set.delete('local-usgs-springs');
  assert.equal(combinedRowState(row, live.isEnabled).enabled, false);
  // Switching back on restores the last remaining selection.
  assert.deepEqual(planRowSwitch(row, live.isEnabled, selection), [
    ['local-usgs-springs', true],
  ]);
  // Chip on while off enables just that layer.
  live.set.clear();
  assert.deepEqual(
    planChipToggle(row, 'local-usgs-lakes', live.isEnabled, selection),
    [['local-usgs-lakes', true]],
  );
  assert.deepEqual(planChipToggle(row, 'bogus', live.isEnabled, selection), []);
});

test('layer panel renders one USGS Water row; switch and chips drive the member layers', async () => {
  const { LayerPanel } = await import('./layerPanel.js');
  const { railFixture } = await import('./railTestFixture.mjs');
  const f = railFixture();
  const previousDocument = globalThis.document;
  // The fixture's style object has no setProperty (chip colours use it).
  const createElement = f.document.createElement.bind(f.document);
  f.document.createElement = (tag) => {
    const node = createElement(tag);
    node.style.setProperty = (key, value) => (node.style[key] = value);
    node.style.removeProperty = (key) => delete node.style[key];
    return node;
  };
  globalThis.document = f.document;
  const on = new Set();
  const layers = IDS.map((id) => ({
    id,
    name: id,
    icon: '💧',
    source: 'USGS',
    showInTogglePanel: true,
    stats: {},
    get enabled() {
      return on.has(id);
    },
  }));
  const calls = [];
  const panel = new LayerPanel({
    getLayers: () => layers,
    isEnabled: (id) => on.has(id),
    setEnabled: async (id, enabled) => {
      calls.push([id, enabled]);
      if (enabled) on.add(id);
      else on.delete(id);
    },
    setLayerParams: () => {},
    hasRowControls: () => false,
    subscribeRowControls: () => null,
    getRowControls: () => null,
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  try {
    panel.mount(f.container);
    const rows = f.container.children.filter((n) =>
      n.className?.includes('data-toggle-row'),
    );
    assert.equal(rows.length, 1);
    const el = rows[0];
    assert.equal(el.dataset.combinedRow, 'usgs-water');
    const controls = el.querySelector('.data-toggle-controls');
    assert.equal(controls.hidden, true);
    el.querySelector('.data-toggle-btn').click();
    await settle();
    assert.equal(on.size, 4);
    assert.equal(controls.hidden, false);
    assert.equal(controls.children.length, 4);
    assert.ok(
      controls.children.every((c) => c.className.includes('chip-active')),
    );
    // Chip: turn Wells off.
    controls.children[1].click();
    await settle();
    assert.equal(on.has('local-usgs-wells'), false);
    assert.equal(controls.children[1].className.includes('chip-idle'), true);
    // Switch off, then on: restores the three, not four.
    el.querySelector('.data-toggle-btn').click();
    await settle();
    assert.equal(on.size, 0);
    assert.equal(controls.hidden, true);
    el.querySelector('.data-toggle-btn').click();
    await settle();
    assert.deepEqual([...on].sort(), [
      'local-usgs-lakes',
      'local-usgs-springs',
      'local-usgs-water',
    ]);
    // External change (voice / URL restore) is reflected on refresh.
    on.clear();
    on.add('local-usgs-springs');
    panel._refreshTogglePanel();
    assert.equal(controls.hidden, false);
    assert.equal(controls.children[3].className.includes('chip-active'), true);
    assert.equal(controls.children[0].className.includes('chip-active'), false);
  } finally {
    panel.destroy();
    globalThis.document = previousDocument;
  }
});
