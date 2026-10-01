/**
 * Byrd-IT fork: layer ids this fork registers on top of upstream God's Eye View.
 * Upstream tests assert exact layer counts; they add this count so a new
 * upstream layer still fails loudly instead of being masked by a ">=" check.
 */
export const BYRDIT_FORK_LAYER_TOKENS = Object.freeze({
  // 'local-usgs-water' is Rivers & Streams (kept id/token so old links still work).
  'local-usgs-water': 'zz',
  'local-usgs-wells': 'zy',
  'local-usgs-lakes': 'zx',
  'local-usgs-springs': 'zw',
});
export const BYRDIT_FORK_LAYER_IDS = Object.freeze(Object.keys(BYRDIT_FORK_LAYER_TOKENS));
/** Characters the fork adds to a fully-enabled `l=` share field ('.' + token each). */
export const BYRDIT_FORK_L_FIELD_CHARS = Object.values(BYRDIT_FORK_LAYER_TOKENS)
  .reduce((n, token) => n + 1 + token.length, 0);
export const BYRDIT_FORK_LAYER_COUNT = BYRDIT_FORK_LAYER_IDS.length;
