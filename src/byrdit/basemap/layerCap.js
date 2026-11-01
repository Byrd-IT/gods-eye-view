/** Shared clamp for the env-tunable config layer caps. */

/** Hard ceiling an env value can never exceed. */
export const LAYERS_CEILING = 2000;

/** Clamp a configured cap to 1..LAYERS_CEILING; anything else = fallback. */
export function layerCap(value, fallback) {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isInteger(n) && n > 0
    ? Math.min(n, LAYERS_CEILING)
    : fallback;
}
