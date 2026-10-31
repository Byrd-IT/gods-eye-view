import { t } from '../../i18n/index.js';
import { WAYBACK_PANEL_ID } from './model.js';
import { createDiscreteSlider } from '../timeTravel/timeSlider.js';

/**
 * The Time travel panel (Esri Wayback). Plain DOM, inline styles (like the
 * NAIP slider), text only through textContent.
 *
 *   [x] Time travel
 *   [<]  |----o----------|  [>]  [Latest]
 *   2023-04-12
 *   Wayback release 2023-04-12 · captured 2023-02-02 · 0.5 m · Vivid / Vantor
 *
 * The slider is the shared time slider (timeTravel/timeSlider.js, the same
 * control as History, NAIP and Sky view): an index into the releases, oldest
 * at the left and the newest at the right, with step, play / pause (one
 * release per tick, 1x / 2x / 4x), a date picker (nearest release) and
 * Latest. Arrow keys step, PageUp / PageDown move 10, Home / End jump. Keys
 * are kept inside the panel (stopPropagation) so the globe's own bindings
 * (WASD, V, ...) never see them. Touch targets grow to 44 px on coarse
 * pointers (the shared CSS).
 */

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
 *   dates?: string[] (ISO date of each release, oldest first: tick marks, the
 *   edge labels and the date picker), doc?: object, embedded?: boolean}} options `embedded`: the container (the Time travel
 *   menu) owns placement and the glass, so the panel flows in it instead of
 *   floating top centre on the globe.
 */
export function createWaybackPanel({
  container,
  count,
  onToggle,
  onIndex,
  dates: dateList = null,
  embedded = false,
  doc = container?.ownerDocument ?? globalThis.document,
}) {
  if (!doc?.createElement || !container) return null;
  const panel = el(doc, 'div', null, {
    attrs: {
      id: WAYBACK_PANEL_ID,
      role: 'group',
      'aria-label': embedded ? t('Esri Wayback imagery') : t('Time travel'),
    },
    style: embedded
      ? {
          // In the Time travel menu: normal flow, the menu is the card.
          position: 'static',
          boxSizing: 'border-box',
          width: '100%',
          minWidth: '0',
          padding: '0',
          color: 'inherit',
          // Same look as the Aerial rows beside it: the card's own font.
          font: 'inherit',
          display: 'flex',
          flexDirection: 'column',
          gap: '4px',
          pointerEvents: 'auto',
        }
      : {
          position: 'absolute',
          // Top centre, just under the toolbar icons: the bottom edge is
          // taken by the dock, the credits and the NAIP slider.
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
  });

  const top = el(doc, 'div', panel, {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: embedded ? '4px 8px' : '12px',
      // The floating panel keeps a 44 px touch row; in the menu the label
      // is the click target and the row matches the Aerial rows.
      minHeight: embedded ? '0' : '44px',
    },
  });
  const head = el(doc, 'label', top, {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      minHeight: embedded ? '0' : '44px',
      cursor: 'pointer',
    },
  });
  // In the Time travel menu the title is the menu's; this switch is the
  // Esri Wayback layer's own.
  const title = embedded ? t('Esri Wayback imagery') : t('Time travel');
  const toggle = el(doc, 'input', head, {
    attrs: { type: 'checkbox', 'aria-label': title },
    // In the menu: the browser's default box, like Aerial and Compare.
    style: embedded ? {} : { width: '22px', height: '22px', margin: '0' },
  });
  el(doc, 'span', head, { text: title });
  toggle.addEventListener('change', () => onToggle(Boolean(toggle.checked)));

  const label = el(doc, 'output', top, {
    attrs: { 'aria-live': 'polite', class: 'gev-wayback-date' },
    style: {
      fontWeight: '600',
      fontSize: embedded ? 'inherit' : '16px',
      whiteSpace: 'nowrap',
    },
  });
  const body = el(doc, 'div', panel, {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      minWidth: '0',
    },
  });
  const dates = Array.isArray(dateList) ? dateList : [];
  const items = Array.from({ length: Math.max(0, count) }, (_, i) => {
    const date = dates[i] ?? '';
    const ms = Date.parse(`${date}T00:00:00Z`);
    return { value: i, label: date, ms: Number.isFinite(ms) ? ms : NaN };
  });
  const slider = createDiscreteSlider({
    document: doc,
    parent: body,
    ariaLabel: t('Imagery date'),
    items,
    index: Math.max(0, count - 1),
    rates: [1, 2, 4],
    picker: items.some((it) => Number.isFinite(it.ms))
      ? { kind: 'date', zone: 'utc', label: `${t('Imagery date')} (UTC)` }
      : null,
    latestLabel: t('Latest'),
    labels: {
      back: t('Older imagery'),
      fwd: t('Newer imagery'),
      play: t('Play'),
      pause: t('Pause'),
      rates: t('Speed'),
    },
    attrs: {
      back: { 'aria-label': t('Older imagery') },
      fwd: { 'aria-label': t('Newer imagery') },
      latest: { 'aria-label': t('Latest imagery') },
    },
    onChange: (index) => onIndex(index),
  });
  const range = slider.scrub;
  const older = slider.back;
  const newer = slider.fwd;
  const latest = slider.latest;
  const detail = el(doc, 'div', body, {
    attrs: { class: 'gev-wayback-detail' },
    style: { opacity: '0.8', fontSize: '12px', overflowWrap: 'anywhere' },
  });
  const notice = el(doc, 'div', panel, {
    attrs: { role: 'status', class: 'gev-wayback-notice' },
    style: { color: '#ffd479', fontSize: '12px' },
  });

  container.append(panel);

  // Phones: the layer rails fill the top and the bottom of the screen; the
  // free band is between the HUD summary line and the Display rail.
  const media = doc.defaultView?.matchMedia?.('(max-width: 767.98px)') ?? null;
  const place = () => {
    if (embedded) return;
    const phone = Boolean(media?.matches);
    panel.style.top = phone ? '256px' : '80px';
  };
  place();
  media?.addEventListener?.('change', place);

  return {
    element: panel,
    controls: { toggle, range, older, newer, latest, slider },
    update(next) {
      toggle.checked = Boolean(next.on);
      body.style.display = next.on ? 'flex' : 'none';
      label.style.display = next.on ? '' : 'none';
      if (!embedded)
        panel.style.width = next.on
          ? 'min(460px, calc(100% - 16px))'
          : 'max-content';
      slider.setIndex(next.index);
      slider.setValueText(next.label ?? '');
      if (!next.on) slider.stop();
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
      slider.destroy();
      panel.remove();
    },
  };
}
