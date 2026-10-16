import { createImagerySplit } from '../../ui/imagerySplit.js';

/**
 * The NAIP year slider panel (BASEMAP N6): a small bar at the bottom centre
 * of the globe (above the credits line and the dock), shown only while the
 * Byrd-IT Open stack is on screen.
 *
 *   [x] Aerial   1939 ... 2018 2024   <range>   "2024: NAIP 2024"
 *   [ ] Compare  <range B>                       "2018: ..."
 *
 * Ticks are exactly the years attachNaip() was given (discovered from
 * config.json). The range is an index into the ticks, so every stop is a
 * real year. Keyboard: ArrowLeft/ArrowDown older, ArrowRight/ArrowUp newer,
 * Home oldest, End newest (handled here, so the step is one tick and the
 * globe's own key bindings never see the key).
 *
 * Narrow screens (t_37cf1f79): the panel is never wider than its container
 * (max-width calc(100% - 16px), centred), the rows wrap and the year range
 * shrinks to fit, so the panel cannot push the page wider than a phone (an
 * 824 px panel on a 412 px phone grew the mobile layout viewport to 618 px).
 * Sky view hides the panel (skyView.css, body.gev-sky-active).
 *
 * Plain DOM with inline styles (no stylesheet), text via textContent only.
 */

const KEYS = Object.freeze({
  ArrowLeft: -1,
  ArrowDown: -1,
  ArrowRight: 1,
  ArrowUp: 1,
});

export const NAIP_SLIDER_ID = 'gev-naip-slider';

/** A panel row: wraps (label above the range) when the screen is narrow. */
const ROW_STYLE = Object.freeze({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '4px 8px',
  minWidth: '0',
});

function el(doc, tag, parent, { text, style, attrs } = {}) {
  const node = doc.createElement(tag);
  if (text != null) node.textContent = text;
  if (style) Object.assign(node.style, style);
  for (const [k, v] of Object.entries(attrs ?? {})) node.setAttribute(k, v);
  parent?.append(node);
  return node;
}

/** One year range (index into ticks) + its label; keyboard steps by tick. */
function yearRange(doc, parent, { ticks, label, onYear, showTicks = false }) {
  const row = el(doc, 'div', parent, {
    style: {
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: '4px 8px',
      flex: '1 1 auto',
      minWidth: '0',
      maxWidth: '100%',
    },
  });
  // preferred width; shrinks to the panel on narrow screens
  const width = `${Math.max(160, Math.min(520, ticks.length * 40))}px`;
  const column = el(doc, 'div', row, {
    style: {
      display: 'flex',
      flexDirection: 'column',
      width,
      maxWidth: '100%',
      minWidth: '0',
      flex: '0 1 auto',
    },
  });
  const range = el(doc, 'input', column, {
    attrs: {
      type: 'range',
      min: '0',
      max: String(Math.max(0, ticks.length - 1)),
      step: '1',
      'aria-label': label,
    },
    style: { width: '100%', minWidth: '0', margin: '0' },
  });
  if (showTicks) {
    // One label per stop, spread like the range's stops.
    const marks = el(doc, 'div', column, {
      attrs: { 'aria-hidden': 'true', class: 'gev-naip-ticks' },
      style: {
        display: 'flex',
        justifyContent: 'space-between',
        gap: '2px',
        overflow: 'hidden',
        opacity: '0.75',
        fontSize: '10px',
      },
    });
    for (const year of ticks) el(doc, 'span', marks, { text: String(year) });
  }
  const out = el(doc, 'output', row, {
    style: {
      maxWidth: 'min(340px, 100%)',
      minWidth: '0',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    },
  });
  let year = null;
  const pick = (index) => {
    const y = ticks[Math.max(0, Math.min(ticks.length - 1, index))];
    if (y !== undefined && y !== year) onYear(y);
  };
  range.addEventListener('input', () => pick(Number(range.value)));
  range.addEventListener('keydown', (event) => {
    let index = ticks.indexOf(year);
    if (event.key in KEYS) index += KEYS[event.key];
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = ticks.length - 1;
    else return;
    event.preventDefault?.();
    event.stopPropagation?.();
    pick(index);
  });
  return {
    row,
    range,
    update(y, text) {
      year = y;
      const i = ticks.indexOf(y);
      if (i >= 0) range.value = String(i);
      range.setAttribute('aria-valuetext', String(y ?? ''));
      out.textContent = text;
      out.setAttribute('title', text);
    },
  };
}

/**
 * @param {{container: object, state: object, onYear: Function, onYearB: Function,
 *   onEnabled: Function, onCompare: Function, doc?: object}} options
 */
export function createNaipSlider({
  container,
  state,
  onYear,
  onYearB,
  onEnabled,
  onCompare,
  doc = container?.ownerDocument ?? globalThis.document,
}) {
  if (!doc?.createElement || !container) return null;
  const { ticks } = state;
  const panel = el(doc, 'div', null, {
    attrs: {
      id: NAIP_SLIDER_ID,
      role: 'group',
      'aria-label': 'Aerial imagery year',
    },
    style: {
      position: 'absolute',
      left: '50%',
      bottom: '118px',
      transform: 'translateX(-50%)',
      boxSizing: 'border-box',
      width: 'max-content',
      maxWidth: 'calc(100% - 16px)',
      padding: '6px 10px',
      background: 'rgba(12, 16, 22, 0.85)',
      color: '#e6edf3',
      font: '12px/1.4 system-ui, sans-serif',
      borderRadius: '6px',
      zIndex: '20',
      display: 'flex',
      flexDirection: 'column',
      gap: '4px',
      pointerEvents: 'auto',
    },
  });
  const top = el(doc, 'div', panel, {
    style: ROW_STYLE,
  });
  const toggleLabel = el(doc, 'label', top, { text: ' Aerial' });
  const toggle = el(doc, 'input', null, { attrs: { type: 'checkbox' } });
  toggleLabel.prepend(toggle);
  toggle.addEventListener('change', () => onEnabled(Boolean(toggle.checked)));
  const a = yearRange(doc, top, {
    ticks,
    label: 'Aerial imagery year',
    onYear,
    showTicks: true,
  });
  const bottom = el(doc, 'div', panel, {
    style: ROW_STYLE,
  });
  const compareLabel = el(doc, 'label', bottom, { text: ' Compare' });
  const compare = el(doc, 'input', null, { attrs: { type: 'checkbox' } });
  compareLabel.prepend(compare);
  compare.addEventListener('change', () => onCompare(Boolean(compare.checked)));
  const b = yearRange(doc, bottom, {
    ticks,
    label: 'Compare with year (right side)',
    onYear: onYearB,
  });
  container.append(panel);

  const api = {
    element: panel,
    update(next) {
      toggle.checked = Boolean(next.enabled);
      compare.checked = Boolean(next.compare);
      a.update(next.year, next.label);
      b.row.style.display = next.compare ? 'flex' : 'none';
      b.update(next.yearB, next.labelB);
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

/**
 * The compare divider: the shared imagerySplit.js control (pointer, keyboard,
 * ARIA, scene.splitPosition) with its line styled inline.
 */
export function createNaipSplit(options, create = createImagerySplit) {
  const doc = options.parent?.ownerDocument ?? globalThis.document;
  const split = create({
    ...options,
    id: 'gev-naip-split-line',
    handleClass: 'gev-naip-split-handle',
    cssProperty: '--gev-naip-split',
  });
  const line = doc?.getElementById?.('gev-naip-split-line');
  if (line)
    Object.assign(line.style, {
      position: 'absolute',
      top: '0',
      bottom: '0',
      left: 'var(--gev-naip-split, 50%)',
      width: '2px',
      marginLeft: '-1px',
      background: 'rgba(255, 255, 255, 0.85)',
      zIndex: '19',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '6px',
      color: '#fff',
      font: '11px system-ui, sans-serif',
      textShadow: '0 0 3px #000',
    });
  return split;
}
