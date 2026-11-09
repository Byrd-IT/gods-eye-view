/**
 * The 3D canopy-cut heights the panel offers (feet above local ground). The
 * owner-approved low cut (60 ft) is always included next to whatever heights
 * an upstream manifest lists; the 90 ft default stays. Idempotent: options are
 * deduped and sorted ascending, still capped, so a manifest with many
 * options never bloats the chip row. Pure, no imports, so the node-side
 * proxies and the browser config can both use it.
 */

export const CANOPY_DEFAULT_LOW_FT = 60;

/**
 * @param {number[]} options - Valid feet values already capped to 120.
 * @returns {number[]} Ascending, deduped, with 60 ft included (max 4).
 */
export function withCanopyLow(options) {
  return [...new Set([...options, CANOPY_DEFAULT_LOW_FT])]
    .sort((a, b) => a - b)
    .slice(0, 4);
}
