// MAP STACK source chips — the always-visible replacement for the `<select>`
// that used to sit in the Map Stack panel. One chip model per stack, from
// `MapStackController.getStacks()`; the dock renders them. The approved sources
// below are the whole shipped set; keeping the allowlist explicit means a stack
// added to `MAP_STACKS` for another purpose cannot reach the tray until someone
// names it here.
//
// The chips are a control SURFACE only: selecting one calls
// `createMapSourceControls().select()`, the path `_setMapStack()` uses, and the
// active state is re-synced from controller state (never optimistically), so a
// failed or superseded switch still leaves the truly-active stack lit.

import { keySetupRequirementEnvVars } from './keySetupCore.mjs';
import { t } from './i18n/index.js';

export const PRESENTED_MAP_STACK_IDS = Object.freeze([
  'basemap-auto',
  'photoreal',
  'byrdit-open',
  'bing-aerial',
  'bing-labels',
  'esri-imagery',
  'osm',
]);

/**
 * Presentation model for one map-stack chip.
 *
 * Unavailable is NOT the same as needs-an-ion-token: `photoreal` is unavailable
 * whenever the Google tileset failed to load (the startup fallback-to-OSM
 * case), and a future stack may have its own reason. The ION badge is therefore
 * gated on the stack's own `requiresIon` flag, and the tooltip quotes the
 * controller's `unavailableReason` rather than assuming one.
 *
 * Degraded is a third state, separate from unavailable: the stack works and
 * stays selectable, but its service reported a problem (`degradedReason`,
 * the Byrd-IT Open health warning). The chip then reads "<label>
 * (degraded)" with the reason as its tooltip.
 * @param {{id: string, label: string, available?: boolean, requiresIon?: boolean, unavailableReason?: string|null, degradedReason?: string|null}} stack - Stack descriptor from `getStacks()`.
 * @param {string|null} activeId - Currently active stack id.
 * @returns {{id: string, label: string, text: string, available: boolean, degraded: boolean, degradedHint: string, active: boolean, requiresIon: boolean, requirement: string, unavailableHint: string, title: string, ariaLabel: string|null}}
 */
export function mapStackChipModel(stack, activeId) {
  const available = stack?.available !== false;
  const label = String(stack?.label ?? stack?.id ?? '');
  const requiresIon = stack?.requiresIon === true;
  // Stack labels are provider names and stay English; the sentence translates.
  const fallbackReason = requiresIon
    ? t('Needs {envVars} — add it in Provider Settings', {
        envVars: keySetupRequirementEnvVars('cesium-ion'),
      })
    : t('{label} is unavailable', {
        label: label || t('This map stack'),
      });
  const unavailableHint = available
    ? ''
    : String(stack?.unavailableReason || fallbackReason);
  const degradedHint =
    available && typeof stack?.degradedReason === 'string'
      ? stack.degradedReason.trim()
      : '';
  const degraded = Boolean(degradedHint);
  let ariaLabel = null;
  if (!available)
    ariaLabel = t('{label} unavailable: {hint}', {
      label,
      hint: unavailableHint,
    });
  else if (degraded)
    ariaLabel = t('{label} degraded: {hint}', { label, hint: degradedHint });
  return {
    id: String(stack?.id ?? ''),
    label,
    text: degraded ? `${label} (degraded)` : label,
    available,
    degraded,
    degradedHint,
    active: !!stack?.id && stack.id === activeId,
    requiresIon,
    // Dropdown parity: unavailable options read "<label> · ion key". A chip has
    // no room for that, so an ion-backed stack gets a compact badge; every
    // unavailable chip carries the real reason in its tooltip.
    requirement: !available && requiresIon ? 'ION' : '',
    unavailableHint,
    title: !available ? unavailableHint : degraded ? degradedHint : label,
    ariaLabel,
  };
}

/**
 * @param {Array<object>} stacks - `MapStackController.getStacks()` output.
 * @param {string|null} activeId - Currently active stack id.
 * @returns {Array<object>} One chip model per approved presentation id, in
 *   `PRESENTED_MAP_STACK_IDS` order; unlisted stacks stay outside this presentation.
 */
export function mapStackChipModels(stacks, activeId) {
  const stacksById = new Map(
    (Array.isArray(stacks) ? stacks : []).map((stack) => [stack?.id, stack]),
  );
  return PRESENTED_MAP_STACK_IDS.map((id) => stacksById.get(id))
    .filter(Boolean)
    .map((stack) => mapStackChipModel(stack, activeId));
}
