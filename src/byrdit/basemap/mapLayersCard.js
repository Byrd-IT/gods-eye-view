/**
 * The Map layers card: ONE right-rail card (#map-layers-panel in
 * #right-context-rail, a sibling of DISPLAY, CCTV, STREET LEVEL, TIME TRAVEL,
 * DRONE FLIGHT PLAN and CONTEXT) that hosts the map overlay layers (lake depth
 * contours, hillshade, topo, contours ...), grouped, with a search box. It is
 * a fork module (DESIGN.md 4.1). The card's markup is static
 * (src/ui/views/ContextView.vue) so the standard panel chrome, rail layout,
 * themes and mobile sheets treat it like any other rail card; this module
 * ADOPTS that element and only shows it while the overlays are on offer.
 * A document without the card (unit-test fake DOMs, embeds) gets null and the
 * panel floats instead.
 */
export const MAP_LAYERS_ID = 'map-layers-panel';
export const MAP_LAYERS_BODY_ID = 'gev-map-layers-body';

/**
 * @param {Document} doc
 * @returns {{root: object, body: object, show: () => void, hide: () => void,
 *   isOpen: () => boolean}|null}
 */
export function ensureMapLayersCard(doc = globalThis.document) {
  const root = doc?.getElementById?.(MAP_LAYERS_ID) ?? null;
  const body = doc?.getElementById?.(MAP_LAYERS_BODY_ID) ?? null;
  if (!root || !body) return null;
  return {
    root,
    body,
    show() {
      root.hidden = false;
    },
    hide() {
      root.hidden = true;
    },
    isOpen: () => !(root.classList?.contains('collapsed') ?? true),
  };
}
