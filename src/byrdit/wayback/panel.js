import { t } from '../../i18n/index.js';
import { WAYBACK_PANEL_ID } from './model.js';

/**
 * The Time travel panel (Esri Wayback). Plain DOM, inline styles (like the
 * NAIP slider), text only through textContent.
 *
 *   [x] Time travel
 *   [<]  |----o----------|  [>]  [Latest]
 *   2023-04-12
 *   Wayback release 2023-04-12 · captured 2023-02-02 · 0.5 m · Vivid / Vantor
 *
 * The range is an index into the releases, oldest at the left and the
 * newest at the right. Native arrow keys, Home and End step it; PageUp and
 * PageDown move 10. Keys are kept inside the panel (stopPropagation) so the
 * globe's own bindings (WASD, V, ...) never see them. Every control is at
 * least 44 px so it works with a thumb.
 */

const KEY_STEP = Object.freeze({ PageUp: 10, PageDown: -10 });
const BUTTON_STYLE = Object.freeze({
  minWidth: '44px',
  minHeight: '44px',
  padding: '0 10px',
  border: '1px solid rgba(255,255,255,0.35)',
  borderRadius: '6px',
  background: 'rgba(255,255,255,0.08)',
  color: 'inherit',
  font: 'inherit',
  cursor: 'pointer',
  touchAction: 'manipulation',
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
 * @param {{container: object, count: number,
 *   onToggle: (on: boolean) => void, onIndex: (index: number) => void,
 *   onStep: (delta: number) => void, onLatest: () => void, doc?: object}} options
 */
export function createWaybackPanel({
  container,
  count,
  onToggle,
  onIndex,
  onStep,
  onLatest,
  doc = container?.ownerDocument ?? globalThis.document,
}) {
  if (!doc?.createElement || !container) return null;
  const panel = el(doc, 'div', null, {
    attrs: {
      id: WAYBACK_PANEL_ID,
      role: 'group',
      'aria-label': t('Time travel'),
    },
    style: {
      position: 'absolute',
      // Top centre, just under the toolbar icons: the bottom edge is taken
      // by the dock, the credits and the NAIP slider.
      left: '50%',
      top: '80px',
      transform: 'translateX(-50%)',
      boxSizing: 'border-box',
      width: 'max-content',
      maxWidth: 'calc(100% - 16px)',
      padding: '6px 10px',
      background: 'rgba(12, 16, 22, 0.88)',
      color: '#e6edf3',
      font: '13px/1.4 system-ui, sans-serif',
      borderRadius: '6px',
      zIndex: '21',
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      pointerEvents: 'auto',
    },
  });
  // Keys typed here are for this control only.
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Tab' || event.key === 'Escape') return;
    event.stopPropagation?.();
    if (event.key in KEY_STEP) {
      event.preventDefault?.();
      onStep(KEY_STEP[event.key]);
    }
  });

  const top = el(doc, 'div', panel, {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '12px',
      minHeight: '44px',
    },
  });
  const head = el(doc, 'label', top, {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      minHeight: '44px',
      cursor: 'pointer',
    },
  });
  const toggle = el(doc, 'input', head, {
    attrs: { type: 'checkbox', 'aria-label': t('Time travel') },
    style: { width: '22px', height: '22px', margin: '0' },
  });
  el(doc, 'span', head, { text: t('Time travel') });
  toggle.addEventListener('change', () => onToggle(Boolean(toggle.checked)));

  const label = el(doc, 'output', top, {
    attrs: { 'aria-live': 'polite', class: 'gev-wayback-date' },
    style: { fontWeight: '600', fontSize: '16px', whiteSpace: 'nowrap' },
  });
  const body = el(doc, 'div', panel, {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      minWidth: '0',
    },
  });
  const controls = el(doc, 'div', body, {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      flexWrap: 'wrap',
      minWidth: '0',
    },
  });
  const older = el(doc, 'button', controls, {
    text: '◀',
    attrs: { type: 'button', 'aria-label': t('Older imagery') },
    style: BUTTON_STYLE,
  });
  const range = el(doc, 'input', controls, {
    attrs: {
      type: 'range',
      min: '0',
      max: String(Math.max(0, count - 1)),
      step: '1',
      'aria-label': t('Imagery date'),
    },
    style: {
      flex: '1 1 160px',
      minWidth: '120px',
      minHeight: '44px',
      margin: '0',
      touchAction: 'pan-y',
    },
  });
  const newer = el(doc, 'button', controls, {
    text: '▶',
    attrs: { type: 'button', 'aria-label': t('Newer imagery') },
    style: BUTTON_STYLE,
  });
  const latest = el(doc, 'button', controls, {
    text: t('Latest'),
    attrs: { type: 'button', 'aria-label': t('Latest imagery') },
    style: BUTTON_STYLE,
  });
  const detail = el(doc, 'div', body, {
    attrs: { class: 'gev-wayback-detail' },
    style: { opacity: '0.8', fontSize: '12px', overflowWrap: 'anywhere' },
  });
  const notice = el(doc, 'div', panel, {
    attrs: { role: 'status', class: 'gev-wayback-notice' },
    style: { color: '#ffd479', fontSize: '12px' },
  });

  range.addEventListener('input', () => onIndex(Number(range.value)));
  older.addEventListener('click', () => onStep(-1));
  newer.addEventListener('click', () => onStep(1));
  latest.addEventListener('click', () => onLatest());
  container.append(panel);

  // Phones: the layer rails fill the top and the bottom of the screen; the
  // free band is between the HUD summary line and the Display rail.
  const media = doc.defaultView?.matchMedia?.('(max-width: 767.98px)') ?? null;
  const place = () => {
    const phone = Boolean(media?.matches);
    panel.style.top = phone ? '256px' : '80px';
  };
  place();
  media?.addEventListener?.('change', place);

  return {
    element: panel,
    controls: { toggle, range, older, newer, latest },
    update(next) {
      toggle.checked = Boolean(next.on);
      body.style.display = next.on ? 'flex' : 'none';
      label.style.display = next.on ? '' : 'none';
      panel.style.width = next.on
        ? 'min(460px, calc(100% - 16px))'
        : 'max-content';
      range.value = String(next.index);
      range.setAttribute('aria-valuetext', next.label ?? '');
      older.disabled = next.index <= 0;
      newer.disabled = next.index >= count - 1;
      latest.disabled = next.index >= count - 1;
      label.textContent = next.label ?? '';
      detail.textContent = next.detail ?? '';
      notice.textContent = next.notice ?? '';
    },
    setVisible(visible) {
      panel.hidden = !visible;
      panel.style.display = visible ? 'flex' : 'none';
    },
    destroy() {
      media?.removeEventListener?.('change', place);
      panel.remove();
    },
  };
}
