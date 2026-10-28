import { t } from '../../i18n/index.js';
import { ensureTimeTravelMenu } from '../timeTravel/menu.js';

/**
 * Map overlays panel (BASEMAP M2 follow-up): one row per overlay with a
 * checkbox and an opacity range. Hosted in the Time travel card's "Map
 * overlays" section; floats bottom-left when no card can host it.
 * Plain DOM with inline styles, text via textContent only.
 */

export const OVERLAYS_PANEL_ID = 'gev-overlays-panel';

const EMBEDDED_STYLE = Object.freeze({
  position: 'static',
  boxSizing: 'border-box',
  width: '100%',
  maxWidth: '100%',
  padding: '0',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  pointerEvents: 'auto',
});
const FLOAT_STYLE = Object.freeze({
  position: 'absolute',
  left: '8px',
  bottom: '118px',
  boxSizing: 'border-box',
  maxWidth: 'calc(100% - 16px)',
  padding: '6px 10px',
  background: 'rgba(12, 16, 22, 0.85)',
  color: '#e6edf3',
  font: '12px/1.4 system-ui, sans-serif',
  borderRadius: '6px',
  zIndex: '20',
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  pointerEvents: 'auto',
});

function el(doc, tag, parent, { text, style, attrs } = {}) {
  const node = doc.createElement(tag);
  if (text != null) node.textContent = text;
  if (style) Object.assign(node.style, style);
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
    style: embedded ? EMBEDDED_STYLE : FLOAT_STYLE,
  });
  const rows = new Map();
  for (const layer of state.layers) {
    const row = el(doc, 'div', panel, {
      attrs: { 'data-overlay': layer.id },
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        minWidth: '0',
      },
    });
    const label = el(doc, 'label', row, { text: ` ${layer.name}` });
    const box = el(doc, 'input', null, {
      attrs: { type: 'checkbox', 'aria-label': layer.name },
    });
    label.prepend(box);
    const line = el(doc, 'div', row, {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        minWidth: '0',
      },
    });
    const range = el(doc, 'input', line, {
      attrs: {
        type: 'range',
        min: '0',
        max: '100',
        step: '5',
        'aria-label': `${layer.name}: ${t('Opacity')}`,
      },
      style: { flex: '1 1 auto', minWidth: '0', margin: '0' },
    });
    const out = el(doc, 'output', line, { style: { minWidth: '3em' } });
    box.addEventListener('change', () =>
      onEnabled(layer.id, Boolean(box.checked)),
    );
    range.addEventListener('input', () =>
      onOpacity(layer.id, Number(range.value) / 100),
    );
    rows.set(layer.id, { box, range, out });
  }
  container.append(panel);
  const api = {
    element: panel,
    update(next) {
      for (const layer of next.layers) {
        const row = rows.get(layer.id);
        if (!row) continue;
        const pct = Math.round(layer.opacity * 100);
        row.box.checked = Boolean(layer.enabled);
        row.range.value = String(pct);
        row.range.disabled = !layer.enabled;
        row.range.setAttribute('aria-valuetext', `${pct}%`);
        row.out.textContent = `${pct}%`;
      }
    },
    setVisible(visible) {
      panel.hidden = !visible;
      panel.style.display = visible ? 'flex' : 'none';
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
