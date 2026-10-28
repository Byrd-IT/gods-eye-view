/**
 * The Time travel menu: ONE right-rail card (#time-travel-panel in
 * #right-context-rail, a sibling of DISPLAY, CCTV, STREET LEVEL and CONTEXT)
 * that hosts the History controls (timeline, play, feed chips, LIVE badge),
 * the Esri Wayback imagery slider and the NAIP aerial year slider, so every
 * way of "going back in time" lives in one place. It is a fork module
 * (DESIGN.md 4.1): the hosts each ask this file for a slot and mount their own
 * DOM in it.
 *
 *   const menu = ensureTimeTravelMenu(document);
 *   const slot = menu.claim('history');   // shows the section, returns its host
 *   ... mount into slot ...
 *   menu.release('history');              // hides the section again
 *
 * The card's markup is static (src/ui/templates/context.html) so the standard
 * panel chrome, rail layout, themes and mobile sheets treat it like any other
 * rail card; this module ADOPTS that element. Only when a document has no such
 * element (unit-test fake DOMs, embeds) is a card built and appended to the
 * rail (or the body). Collapse/expand is the panel chrome's
 * (.panel-collapse-btn[data-collapse-target]); setOpen()/isOpen() drive and
 * read the same `collapsed` class.
 *
 * A section is shown only while a host has claimed it, so with the Wayback
 * flag off there is no Imagery section, with no NAIP offer no Aerial section,
 * and the whole card stays `hidden` until something is claimed.
 */
import { msg, t } from '../../i18n/index.js';

export const TIME_TRAVEL_ID = 'time-travel-panel';
export const TIME_TRAVEL_TOGGLE_ID = 'gev-time-travel-toggle';
export const TIME_TRAVEL_BODY_ID = 'gev-time-travel-body';
export const TIME_TRAVEL_STYLE_ID = 'gev-time-travel-style';

/** Section name -> heading. Order is the order they appear in. */
export const SECTIONS = Object.freeze([
  Object.freeze({ name: 'history', title: msg('History') }),
  Object.freeze({ name: 'imagery', title: msg('Imagery') }),
  Object.freeze({ name: 'aerial', title: msg('Aerial (NAIP)') }),
  Object.freeze({ name: 'overlays', title: msg('Map overlays') }),
]);

export const TIME_TRAVEL_CSS = `
/* The card itself (position, width, glass, header) is rail CSS:
   layers.css and time-travel.css. Only the sections are styled here. */
.gev-tt-body {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  color: var(--text-secondary, #c8d0da);
  font: 500 11px/1.35 var(--font-mono, ui-monospace, monospace);
}
.gev-tt-body[hidden], .gev-tt-section[hidden] { display: none; }
.gev-tt-section { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.gev-tt-section + .gev-tt-section:not([hidden]) {
  padding-top: 8px;
  border-top: 1px solid var(--glass-border, rgba(255,255,255,0.14));
}
.gev-tt-heading {
  margin: 0;
  font: 600 9px/1.2 var(--font-mono, ui-monospace, monospace);
  letter-spacing: 1.4px;
  text-transform: uppercase;
  color: var(--text-dim, #8a94a0);
}
.gev-tt-slot { min-width: 0; }
@media (prefers-reduced-motion: reduce) { #time-travel-panel * { transition: none !important; } }
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

const RAIL_ID = 'right-context-rail';
const CONTEXT_PANEL_ID = 'global-context-panel';

function hasClass(node, name) {
  return (node.getAttribute('class') ?? '').split(/\s+/).includes(name);
}

function setClass(node, name, on) {
  const names = (node.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
  const next = names.filter((n) => n !== name);
  if (on) next.push(name);
  node.setAttribute('class', next.join(' '));
}

/** The card for a document that has no static one (tests, embeds). */
function buildCard(doc) {
  const root = el(doc, 'div', {
    cls: 'panel-collapsible collapsed',
    attrs: { id: TIME_TRAVEL_ID, 'data-panel-id': TIME_TRAVEL_ID },
  });
  const inner = el(doc, 'div', {
    cls: 'time-travel-panel-inner',
    attrs: { 'data-rail-scroller': '' },
  });
  const header = el(doc, 'div', { cls: 'panel-header' });
  header.append(
    el(doc, 'span', { cls: 'panel-title', text: t('TIME TRAVEL') }),
    el(doc, 'span', { cls: 'panel-divider' }),
  );
  const toggle = el(doc, 'button', {
    cls: 'panel-collapse-btn',
    attrs: {
      id: TIME_TRAVEL_TOGGLE_ID,
      type: 'button',
      'data-collapse-target': TIME_TRAVEL_ID,
      title: t('Expand panel'),
    },
    text: '◀',
  });
  header.append(toggle);
  const body = el(doc, 'div', {
    cls: 'gev-tt-body',
    attrs: {
      id: TIME_TRAVEL_BODY_ID,
      role: 'group',
      'aria-label': t('Time travel'),
    },
  });
  inner.append(header, body);
  root.append(inner);
  root.hidden = true;
  const rail = doc.getElementById?.(RAIL_ID);
  const before = rail ? doc.getElementById?.(CONTEXT_PANEL_ID) : null;
  if (rail && before?.parentNode === rail && rail.insertBefore)
    rail.insertBefore(root, before);
  else (rail ?? doc.body).append(root);
  return { root, toggle, body };
}

/**
 * Get (or adopt/build) the one Time travel menu of a document.
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
  let root = doc.getElementById?.(TIME_TRAVEL_ID) ?? null;
  const adopted = Boolean(root);
  let toggle;
  let body;
  if (adopted) {
    toggle =
      doc.getElementById?.(TIME_TRAVEL_TOGGLE_ID) ??
      root.querySelector?.('.panel-collapse-btn') ??
      null;
    body = doc.getElementById?.(TIME_TRAVEL_BODY_ID) ?? null;
    if (!toggle || !body) {
      // a card without the expected parts: treat it as absent
      root = null;
    }
  }
  const built = root ? null : buildCard(doc);
  if (built) ({ root, toggle, body } = built);
  const created = Boolean(built);
  body.replaceChildren?.();
  toggle.setAttribute('aria-controls', TIME_TRAVEL_BODY_ID);

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

  const isOpen = () => !hasClass(root, 'collapsed');
  /** What the panel chrome does on a state change, for when it is not there. */
  const syncControls = () => {
    const open = isOpen();
    toggle.textContent = open ? '▶' : '◀';
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute(
      'title',
      open ? t('Collapse panel') : t('Expand panel'),
    );
  };
  const menu = {
    root,
    toggle,
    body,
    destroyed: false,
    isOpen,
    setOpen(next) {
      const want = Boolean(next);
      if (want === isOpen()) return;
      // Let the panel chrome do it (persistence, rail accordion, ARIA) ...
      if (!created) toggle.click?.();
      // ... and do it here when the chrome is not bound (fake DOMs, embeds).
      if (want !== isOpen()) {
        setClass(root, 'collapsed', !want);
        syncControls();
      }
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
      if (created) toggle.removeEventListener('click', onToggle);
      root.removeEventListener('keydown', onKey);
      if (created) root.remove();
      else {
        // the static card stays; it just empties and hides again
        for (const { section } of sections.values()) section.remove();
        root.hidden = true;
      }
      if (menus.get(doc) === menu) menus.delete(doc);
    },
  };
  // without the panel chrome the header button has no handler of its own
  const onToggle = () => menu.setOpen(!isOpen());
  // Escape closes the card and gives the focus back to its header button
  const onKey = (event) => {
    if (event?.key !== 'Escape' || !isOpen()) return;
    menu.setOpen(false);
    toggle.focus?.();
  };
  if (created) toggle.addEventListener('click', onToggle);
  root.addEventListener('keydown', onKey);
  syncControls();
  menus.set(doc, menu);
  return menu;
}
