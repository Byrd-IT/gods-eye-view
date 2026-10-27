/**
 * The Time travel menu: ONE collapsible panel on the right of the map that
 * hosts the History controls (timeline, play, feed chips, LIVE badge) and the
 * Esri Wayback imagery slider, so both ways of "going back in time" live in
 * one place. It is a fork module (DESIGN.md 4.1): the two hosts, History and
 * Wayback, each ask this file for a slot and mount their own DOM in it.
 *
 *   const menu = ensureTimeTravelMenu(document);
 *   const slot = menu.claim('history');   // shows the section, returns its host
 *   ... mount into slot ...
 *   menu.release('history');              // hides the section again
 *
 * Collapsed until the owner clicks the header (it is NOT remembered between
 * loads: the map always starts uncluttered). A section is shown only while a
 * host has claimed it, so with the Wayback flag off there is no Imagery
 * section, and the whole menu stays hidden until something is claimed.
 *
 * Placement: it is its own fixed panel, not a child of #right-context-rail,
 * because the rail's layout, mobile sheets and cockpit rules all enumerate
 * their own panels. Cockpit, scene playback and recording hide it (as they
 * hide the rail and its Display panel); clean view fades it with the other
 * fork controls (cleanView.css).
 */
import { t } from '../../i18n/index.js';

export const TIME_TRAVEL_ID = 'gev-time-travel';
export const TIME_TRAVEL_TOGGLE_ID = 'gev-time-travel-toggle';
export const TIME_TRAVEL_BODY_ID = 'gev-time-travel-body';
export const TIME_TRAVEL_STYLE_ID = 'gev-time-travel-style';

/** Section name -> heading. Order is the order they appear in. */
export const SECTIONS = Object.freeze([
  Object.freeze({ name: 'history', title: 'History' }),
  Object.freeze({ name: 'imagery', title: 'Imagery' }),
]);

export const TIME_TRAVEL_CSS = `
.gev-tt {
  position: fixed;
  /* right column like the DISPLAY rail, above the HUD readout and the
     bottom-right navigation control, clear of the bottom-centre dock */
  right: var(--right-rail-x, 52px);
  bottom: 200px;
  z-index: 112;
  box-sizing: border-box;
  width: var(--right-collapsed-width, 132px);
  max-width: calc(100vw - 16px);
  display: flex;
  flex-direction: column;
  align-items: stretch;
  border: 1px solid var(--glass-border, rgba(255,255,255,0.14));
  border-radius: var(--panel-radius, 14px);
  background: var(--glass-bg, rgba(10,14,20,0.72));
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.04);
  backdrop-filter: blur(24px) saturate(1.4);
  -webkit-backdrop-filter: blur(24px) saturate(1.4);
  color: var(--text-secondary, #c8d0da);
  font: 500 11px/1.35 var(--font-mono, ui-monospace, monospace);
}
.gev-tt[hidden] { display: none; }
.gev-tt[data-expanded='true'] { width: min(400px, calc(100vw - 16px)); }
.gev-tt-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 42px;
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px 8px 14px;
  border: 0;
  border-radius: inherit;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.gev-tt[data-expanded='true'] .gev-tt-toggle { min-height: 32px; border-radius: var(--panel-radius, 14px) var(--panel-radius, 14px) 0 0; }
.gev-tt-title {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 8px;
  letter-spacing: 1.4px;
  color: var(--text-dim, #8a94a0);
  text-transform: uppercase;
  white-space: nowrap;
}
.gev-tt-glyph {
  display: grid;
  width: 20px;
  height: 20px;
  place-items: center;
  border: 1px solid var(--glass-border, rgba(255,255,255,0.14));
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.03);
  color: var(--text-secondary, #c8d0da);
  font-size: 12px;
  line-height: 1;
}
.gev-tt-toggle:hover .gev-tt-glyph { border-color: var(--glass-border-hover, rgba(255,255,255,0.3)); color: var(--accent, #7fd3ff); }
.gev-tt-toggle:focus-visible { outline: 2px solid var(--text-primary, #eef3f8); outline-offset: -3px; }
.gev-tt-body {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 8px 10px 10px;
  border-top: 1px solid var(--glass-border, rgba(255,255,255,0.14));
  max-height: min(520px, calc(100vh - 280px));
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.gev-tt-body[hidden], .gev-tt-section[hidden] { display: none; }
.gev-tt-section { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.gev-tt-heading {
  margin: 0;
  font: 600 9px/1.2 var(--font-mono, ui-monospace, monospace);
  letter-spacing: 1.4px;
  text-transform: uppercase;
  color: var(--text-dim, #8a94a0);
}
.gev-tt-slot { min-width: 0; }
@media (max-width: 900px) {
  /* Phones and narrow windows: a launcher on the right edge in the free band
     under the top rails; open, a full-width sheet from the right that stops
     well above the bottom navigation control and the tab bar. */
  .gev-tt { top: 150px; bottom: auto; right: 8px; z-index: 120; }
  .gev-tt[data-expanded='true'] { left: 8px; width: auto; }
  .gev-tt-body { max-height: max(200px, calc(100dvh - 150px - 280px)); }
  .gev-tt-toggle { min-height: 44px; }
}
body:is(.cockpit-mode, .scene-playback-mode, .recording-mode) .gev-tt { display: none !important; }
@media (prefers-reduced-motion: reduce) { .gev-tt * { transition: none !important; } }
`;

const menus = new WeakMap();

function el(doc, tag, { cls, attrs, text } = {}) {
  const node = doc.createElement(tag);
  if (cls) node.setAttribute('class', cls);
  for (const [k, v] of Object.entries(attrs ?? {})) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

function ensureStyle(doc) {
  if (doc.getElementById?.(TIME_TRAVEL_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.setAttribute('id', TIME_TRAVEL_STYLE_ID);
  style.textContent = TIME_TRAVEL_CSS;
  (doc.head ?? doc.body).append(style);
}

/**
 * Get (or build) the one Time travel menu of a document.
 * @param {Document} doc
 * @returns {{root: object, toggle: object, body: object,
 *   claim: (name: string) => object, release: (name: string) => void,
 *   slot: (name: string) => object, isOpen: () => boolean,
 *   setOpen: (open: boolean) => void, destroy: () => void,
 *   destroyed: boolean}|null} null when the document cannot host it
 */
export function ensureTimeTravelMenu(doc = globalThis.document) {
  if (!doc?.createElement || !doc.body) return null;
  const existing = menus.get(doc);
  if (existing && !existing.destroyed) return existing;

  ensureStyle(doc);
  const root = el(doc, 'aside', {
    cls: 'gev-tt',
    attrs: {
      id: TIME_TRAVEL_ID,
      'data-expanded': 'false',
      'aria-label': t('Time travel'),
    },
  });
  root.hidden = true; // until a host claims a section
  const toggle = el(doc, 'button', {
    cls: 'gev-tt-toggle',
    attrs: {
      id: TIME_TRAVEL_TOGGLE_ID,
      type: 'button',
      'aria-expanded': 'false',
      'aria-controls': TIME_TRAVEL_BODY_ID,
      title: t('Expand Time travel'),
    },
  });
  const title = el(doc, 'span', { cls: 'gev-tt-title', text: t('Time travel') });
  const glyph = el(doc, 'span', {
    cls: 'gev-tt-glyph',
    attrs: { 'aria-hidden': 'true' },
    text: '◀',
  });
  toggle.append(title, glyph);
  const body = el(doc, 'div', {
    cls: 'gev-tt-body',
    attrs: { id: TIME_TRAVEL_BODY_ID, role: 'group', 'aria-label': t('Time travel') },
  });
  body.hidden = true;

  const sections = new Map();
  for (const { name, title: heading } of SECTIONS) {
    const section = el(doc, 'section', {
      cls: 'gev-tt-section',
      attrs: { 'data-section': name, 'aria-label': t(heading) },
    });
    section.hidden = true;
    const h = el(doc, 'h3', { cls: 'gev-tt-heading', text: t(heading) });
    const slot = el(doc, 'div', {
      cls: 'gev-tt-slot',
      attrs: { 'data-slot': name },
    });
    section.append(h, slot);
    body.append(section);
    sections.set(name, { section, slot, claimed: false });
  }
  root.append(toggle, body);
  doc.body.append(root);

  let open = false;
  const menu = {
    root,
    toggle,
    body,
    destroyed: false,
    isOpen: () => open,
    setOpen(next) {
      open = Boolean(next);
      root.setAttribute('data-expanded', String(open));
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute(
        'title',
        open ? t('Collapse Time travel') : t('Expand Time travel'),
      );
      glyph.textContent = open ? '▶' : '◀';
      body.hidden = !open;
    },
    /** The host element of a section, whether claimed or not. */
    slot(name) {
      return sections.get(name)?.slot ?? null;
    },
    /** Show a section and return its host element. */
    claim(name) {
      const entry = sections.get(name);
      if (!entry) throw new RangeError(`Unknown Time travel section: ${name}`);
      entry.claimed = true;
      entry.section.hidden = false;
      root.hidden = false;
      return entry.slot;
    },
    /** Hide a section again (its host unmounted). */
    release(name) {
      const entry = sections.get(name);
      if (!entry) return;
      entry.claimed = false;
      entry.section.hidden = true;
      root.hidden = ![...sections.values()].some((e) => e.claimed);
    },
    destroy() {
      if (menu.destroyed) return;
      menu.destroyed = true;
      toggle.removeEventListener('click', onToggle);
      root.removeEventListener('keydown', onKey);
      root.remove();
      if (menus.get(doc) === menu) menus.delete(doc);
    },
  };
  const onToggle = () => menu.setOpen(!open);
  // Escape closes the menu and gives the focus back to its header
  const onKey = (event) => {
    if (event?.key !== 'Escape' || !open) return;
    menu.setOpen(false);
    toggle.focus?.();
  };
  toggle.addEventListener('click', onToggle);
  root.addEventListener('keydown', onKey);
  menus.set(doc, menu);
  return menu;
}
