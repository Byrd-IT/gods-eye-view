import { createImagerySplit } from '../../ui/imagerySplit.js';
import { t } from '../../i18n/index.js';
import { ensureTimeTravelMenu } from '../timeTravel/menu.js';
import { createDiscreteSlider } from '../timeTravel/timeSlider.js';

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
 * real year. The control is the shared time slider (timeTravel/timeSlider.js):
 * arrows step one tick, PageUp / PageDown ten, Home oldest, End newest (the
 * globe's own key bindings never see the key), plus play / pause through the
 * years and the 1x / 2x / 4x speed group.
 *
 * Narrow screens (t_37cf1f79): the panel is never wider than its container
 * (max-width calc(100% - 16px), centred), the rows wrap and the year range
 * shrinks to fit, so the panel cannot push the page wider than a phone (an
 * 824 px panel on a 412 px phone grew the mobile layout viewport to 618 px).
 * Sky view hides the panel (skyView.css, body.gev-sky-active).
 *
 * Embedded mode (`embedded: true`): the slider is mounted in the Time travel
 * card's Aerial section (createNaipMenuSlider below) instead of floating over
 * the globe: no absolute positioning or own background, full card width, the
 * theme's colours and font. Floating stays the fallback when no card can host
 * it.
 *
 * Plain DOM with inline styles (no stylesheet), text via textContent only.
 */

export const NAIP_SLIDER_ID = 'gev-naip-slider';

/** In the Time travel card: flows in its section and takes the card's look. */
const EMBEDDED_STYLE = Object.freeze({
  position: 'static',
  boxSizing: 'border-box',
  width: '100%',
  maxWidth: '100%',
  padding: '0',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  borderRadius: '0',
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  pointerEvents: 'auto',
});

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

/**
 * One year slider over the ticks: the shared discrete time slider
 * (timeTravel/timeSlider.js) plus its label. `transport` adds play / pause
 * (one year per tick) and the speed group; the Compare slider is scrub and
 * step only.
 */
function yearRange(
  doc,
  parent,
  { ticks, label, onYear, showTicks = false, transport = false },
) {
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
  const width = `${Math.max(220, Math.min(520, ticks.length * 40))}px`;
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
  const items = ticks.map((year) => {
    const ms = Date.UTC(Number(year), 0, 1);
    return {
      value: year,
      label: String(year),
      ms: Number.isFinite(ms) ? ms : NaN,
    };
  });
  let year = null;
  const slider = createDiscreteSlider({
    document: doc,
    parent: column,
    ariaLabel: label,
    items,
    tickLabels: showTicks,
    steps: true,
    play: transport,
    rates: transport ? [1, 2, 4] : [],
    labels: { back: t('Older imagery'), fwd: t('Newer imagery') },
    attrs: {
      back: { 'aria-label': t('Older imagery') },
      fwd: { 'aria-label': t('Newer imagery') },
    },
    onChange: (index) => {
      const y = ticks[index];
      if (y !== undefined && y !== year) onYear(y);
    },
  });
  const out = el(doc, 'output', row, {
    style: {
      maxWidth: 'min(340px, 100%)',
      minWidth: '0',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    },
  });
  return {
    row,
    range: slider.scrub,
    slider,
    update(y, text) {
      year = y;
      const i = ticks.indexOf(y);
      if (i >= 0) slider.setIndex(i);
      slider.setValueText(String(y ?? ''));
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
  embedded = false,
  doc = container?.ownerDocument ?? globalThis.document,
}) {
  if (!doc?.createElement || !container) return null;
  const { ticks } = state;
  const panel = el(doc, 'div', null, {
    attrs: {
      id: NAIP_SLIDER_ID,
      role: 'group',
      'aria-label': t('Aerial imagery year'),
      ...(embedded ? { 'data-embedded': 'true' } : {}),
    },
    style: embedded
      ? EMBEDDED_STYLE
      : {
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
  const toggleLabel = el(doc, 'label', top, { text: ` ${t('Aerial')}` });
  const toggle = el(doc, 'input', null, { attrs: { type: 'checkbox' } });
  toggleLabel.prepend(toggle);
  toggle.addEventListener('change', () => onEnabled(Boolean(toggle.checked)));
  const a = yearRange(doc, top, {
    ticks,
    label: t('Aerial imagery year'),
    onYear,
    showTicks: true,
    transport: true,
  });
  const bottom = el(doc, 'div', panel, {
    style: ROW_STYLE,
  });
  const compareLabel = el(doc, 'label', bottom, { text: ` ${t('Compare')}` });
  const compare = el(doc, 'input', null, { attrs: { type: 'checkbox' } });
  compareLabel.prepend(compare);
  compare.addEventListener('change', () => onCompare(Boolean(compare.checked)));
  const b = yearRange(doc, bottom, {
    ticks,
    label: t('Compare with year (right side)'),
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
      a.slider.destroy();
      b.slider.destroy();
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

/**
 * createSlider for attachNaip(): host the slider in the Time travel card's
 * Aerial section when the document has the card, else float it as before.
 * The section is claimed only while the slider is visible (setVisible(true)),
 * so the card shows Aerial only when NAIP is offered and on screen, and a
 * card with nothing claimed stays hidden.
 */
export function createNaipMenuSlider(
  options,
  { ensureMenu = ensureTimeTravelMenu, create = createNaipSlider } = {},
) {
  const doc =
    options.doc ?? options.container?.ownerDocument ?? globalThis.document;
  const menu = ensureMenu(doc);
  const host = menu?.slot('aerial') ?? null;
  if (!host) return create(options);
  const slider = create({ ...options, container: host, embedded: true, doc });
  if (!slider) return null;
  let claimed = false;
  const release = () => {
    if (!claimed) return;
    claimed = false;
    menu.release('aerial');
  };
  return {
    element: slider.element,
    update: (next) => slider.update(next),
    setVisible(visible) {
      slider.setVisible(visible);
      if (visible && !claimed) {
        claimed = true;
        menu.claim('aerial');
      } else if (!visible) release();
    },
    destroy() {
      release();
      slider.destroy();
    },
  };
}
