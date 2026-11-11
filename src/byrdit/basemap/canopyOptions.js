/**
 * The 3D canopy-cut heights the panel offers (feet above local ground).
 * The owner-approved presets are pinned and can never be squeezed out by a
 * manifest with many heights of its own: the low cut the owner asked for
 * (60 ft), the historic default cut (90 ft) and the top cut (120 ft, whose
 * chip the panel pairs with "Full model"). Preserve the manifest's default
 * when choosing its one extra option. Idempotent:
 * options are deduped and sorted ascending, still capped at 4 (the pinned
 * three plus at most one manifest extra, lowest first), so the chip row
 * never bloats. Pure, no imports, so the node-side proxies and the browser
 * config can both use it.
 */

export const CANOPY_DEFAULT_LOW_FT = 60;
export const CANOPY_HISTORIC_DEFAULT_FT = 90;
export const CANOPY_MAX_CUT_FT = 120;

/** Pinned cut heights, ascending; `withCanopyLow` always keeps all three. */
export const CANOPY_PINNED_FT = Object.freeze([
  CANOPY_DEFAULT_LOW_FT,
  CANOPY_HISTORIC_DEFAULT_FT,
  CANOPY_MAX_CUT_FT,
]);

/**
 * @param {number[]} options - Valid feet values already capped to 120.
 * @returns {number[]} Ascending, deduped, 60/90/120 always kept (max 4).
 */
export function withCanopyLow(options, preferred = null) {
  const pinned = [...CANOPY_PINNED_FT];
  const extras = [
    ...new Set(
      (Array.isArray(options) ? options : []).filter(
        (v) =>
          typeof v === 'number' && Number.isFinite(v) && !pinned.includes(v),
      ),
    ),
  ].sort((a, b) => a - b);
  // Final sort: the pinned heights are not contiguous; an extra can land
  // inside the band (70 between 60 and 90) and must be ordered by height.
  const chosen = extras.includes(preferred) ? [preferred] : extras.slice(0, 1);
  return [...pinned, ...chosen].sort((a, b) => a - b);
}
