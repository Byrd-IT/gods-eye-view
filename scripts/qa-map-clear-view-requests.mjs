/**
 * Request classification for scripts/qa-map-clear-view.mjs section H: proves
 * a clean-view toggle refetches nothing. Records carry only the endpoint
 * (host + path) and a hash of the full URL, never the query.
 */
const ASSET_TYPES = new Set([
  'script',
  'stylesheet',
  'font',
  'document',
  'manifest',
]);
const TILE_PATH =
  /\/(terrain|imagery|tiles?|wmts|3dtiles)(\/|$)|\/basemap\/v\/|\/\d+\/\d+\/\d+(\.\w+)?$|\.(png|jpe?g|webp|terrain|glb|b3dm|pnts|i3dm|cmpt|subtree)$/i;
/** asset | tile | layer | beacon for one request. */
export function classifyRequest(type, url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return 'other';
  }
  const p = u.pathname;
  if (u.protocol === 'data:' || u.protocol === 'blob:') return 'asset';
  if (
    ASSET_TYPES.has(type) ||
    /^\/(cesium|src|node_modules|@vite|@id|@fs|assets)\//.test(p) ||
    /\.(svg|css|m?js|woff2?|ttf|ico|map)$/i.test(p)
  )
    return 'asset';
  if (type === 'ping') return 'beacon';
  if (type === 'image' || TILE_PATH.test(p)) return 'tile';
  return 'layer';
}
/**
 * Verdict for every request in [from, to): a layer request must be a
 * scheduled poll (>= 2 earlier requests to the endpoint and a gap since the
 * last one of at least 0.8 x its shortest earlier gap); a tile must not be one
 * that was already requested before the window. Everything else is counted.
 */
export function classifyWindow(all, from, to) {
  const win = all.filter((r) => r.t >= from && r.t < to);
  const counts = {};
  const refetch = [];
  const polls = [];
  let newTiles = 0;
  for (const r of win) {
    counts[r.cls] = (counts[r.cls] || 0) + 1;
    const before = all.filter((q) => q.t < r.t);
    if (r.cls === 'layer') {
      const prior = before.filter((q) => q.ep === r.ep).map((q) => q.t);
      const gaps = prior.slice(1).map((t, i) => t - prior[i]);
      const minGap = gaps.length ? Math.min(...gaps) : 0;
      const since = prior.length ? r.t - prior[prior.length - 1] : null;
      if (prior.length >= 2 && minGap > 0 && since >= 0.8 * minGap)
        polls.push({ ep: r.ep, since, minGap });
      else refetch.push({ cls: r.cls, ep: r.ep, prior: prior.length, since });
    } else if (r.cls === 'tile') {
      if (before.some((q) => q.id === r.id))
        refetch.push({ cls: r.cls, ep: r.ep, again: true });
      else newTiles += 1;
    }
  }
  return { counts, refetch, polls, newTiles, total: win.length };
}
