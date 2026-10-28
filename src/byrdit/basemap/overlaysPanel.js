import { t } from '../../i18n/index.js';
import { ensureTimeTravelMenu } from '../timeTravel/menu.js';
import { syncChipGroup } from '../../ui/chipGroup.js';
import { createSlider } from '../../ui/slider.js';

/**
 * Map overlays panel (BASEMAP M2 follow-up): one row per overlay with a
 * checkbox, an opacity range and raise/lower buttons; rows are listed top of
 * the stack first. Hosted in the Time travel card's "Map
 * overlays" section; floats bottom-left when no card can host it.
 * Plain DOM, text via textContent only.
 */

export const OVERLAYS_PANEL_ID = 'gev-overlays-panel';

// All look and layout is CSS (src/ui/styles/time-travel.css, .gev-ov-*) on the
// shared tokens; raise/lower are the shared .data-toggle-chip (chipGroup.js)
// and the opacity range is the shared .gev-quantitative-slider (ui/slider.js).

function el(doc, tag, parent, { text, cls, attrs } = {}) {
  const node = doc.createElement(tag);
  if (text != null) node.textContent = text;
  if (cls) node.className = cls;
  for (const [k, v] of Object.entries(attrs ?? {})) node.setAttribute(k, v);
  parent?.append(node);
  return node;
}

/**
 * @param {{container: object, state: {layers: object[]}, onEnabled: Function,
 *   onOpacity: Function, embedded?: boolean, doc?: object}} options
 */
export function createOverlaysPanel({
  container,
  state,
  onEnabled,
  onOpacity,
  onMove = () => {},
  embedded = false,
  doc = container?.ownerDocument ?? globalThis.document,
}) {
  if (!doc?.createElement || !container) return null;
  const panel = el(doc, 'div', null, {
    attrs: {
      id: OVERLAYS_PANEL_ID,
      role: 'group',
      'aria-label': t('Map overlays'),
      ...(embedded ? { 'data-embedded': 'true' } : {}),
    },
    cls: embedded ? 'gev-ov-panel' : 'gev-ov-panel gev-ov-float',
  });
  const rows = new Map();
  for (const layer of state.layers) {
    const row = el(doc, 'div', panel, {
      cls: 'gev-ov-row',
      attrs: { 'data-overlay': layer.id },
    });
    const head = el(doc, 'div', row, { cls: 'gev-ov-head' });
    const label = el(doc, 'label', head, {
      text: ` ${layer.name}`,
      cls: 'gev-ov-name',
    });
    const box = el(doc, 'input', null, {
      attrs: { type: 'checkbox', 'aria-label': layer.name },
    });
    label.prepend(box);
    const moves = el(doc, 'span', head, { cls: 'gev-ov-moves' });
    const moveSpecs = [
      ['up', '\u25B2', t('Raise layer')],
      ['down', '\u25BC', t('Lower layer')],
    ];
    syncChipGroup(
      moves,
      moveSpecs.map(([direction, glyph, text]) => ({
        id: direction,
        label: glyph,
        title: text,
      })),
    );
    const [up, down] = [...moves.children];
    moveSpecs.forEach(([direction, , text], i) => {
      const button = [up, down][i];
      button.setAttribute('data-move', direction);
      button.setAttribute('aria-label', `${text}: ${layer.name}`);
      // Actions, not toggles: drop the pressed/busy state chips carry.
      button.removeAttribute?.('aria-pressed');
      button.removeAttribute?.('aria-busy');
      button.addEventListener('click', () => onMove(layer.id, direction));
    });
    const line = el(doc, 'div', row, { cls: 'gev-ov-line' });
    const range = createSlider({
      documentRef: doc,
      min: '0',
      max: '100',
      step: '5',
      ariaLabel: `${layer.name}: ${t('Opacity')}`,
    });
    line.append(range);
    const out = el(doc, 'output', line, { cls: 'gev-slider-value' });
    box.addEventListener('change', () =>
      onEnabled(layer.id, Boolean(box.checked)),
    );
    range.addEventListener('input', () =>
      onOpacity(layer.id, Number(range.value) / 100),
    );
    rows.set(layer.id, { row, box, range, out, up, down });
  }
  container.append(panel);
  let shownOrder = state.layers.map((layer) => layer.id).join();
  const api = {
    element: panel,
    update(next) {
      const nextOrder = next.layers.map((layer) => layer.id);
      // Reorder rows only for a full, changed ordering (append moves a node).
      if (
        nextOrder.length === rows.size &&
        nextOrder.every((id) => rows.has(id)) &&
        nextOrder.join() !== shownOrder
      ) {
        shownOrder = nextOrder.join();
        for (const id of nextOrder) panel.append(rows.get(id).row);
      }
      next.layers.forEach((layer, index) => {
        const row = rows.get(layer.id);
        if (!row) return;
        const pct = Math.round(layer.opacity * 100);
        row.box.checked = Boolean(layer.enabled);
        row.range.value = String(pct);
        row.range.disabled = !layer.enabled;
        row.range.setAttribute('aria-valuetext', `${pct}%`);
        row.out.textContent = `${pct}%`;
        if (nextOrder.length === rows.size) {
          row.up.disabled = index === 0;
          row.down.disabled = index === nextOrder.length - 1;
        }
      });
    },
    setVisible(visible) {
      panel.hidden = !visible; // .gev-ov-panel[hidden] in time-travel.css
    },
    destroy() {
      panel.remove();
    },
  };
  api.update(state);
  return api;
}

/** createPanel for attachOverlays(): the Time travel card's section, else float. */
export function createOverlaysMenuPanel(
  options,
  { ensureMenu = ensureTimeTravelMenu, create = createOverlaysPanel } = {},
) {
  const doc =
    options.doc ?? options.container?.ownerDocument ?? globalThis.document;
  const menu = ensureMenu(doc);
  const host = menu?.slot('overlays') ?? null;
  if (!host) return create(options);
  const panel = create({ ...options, container: host, embedded: true, doc });
  if (!panel) return null;
  let claimed = false;
  const release = () => {
    if (!claimed) return;
    claimed = false;
    menu.release('overlays');
  };
  return {
    element: panel.element,
    update: (next) => panel.update(next),
    setVisible(visible) {
      panel.setVisible(visible);
      if (visible && !claimed) {
        claimed = true;
        menu.claim('overlays');
      } else if (!visible) release();
    },
    destroy() {
      release();
      panel.destroy();
    },
  };
}
