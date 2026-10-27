// GhostMaps "as published at time t": which archived commit S2 had live at a
// History slider time. Pure and portable (the server and the tests use it);
// no i18n, no DOM, no Cesium, no git.

/** Latest slider time the archive endpoints accept (ms): year 2100. */
const MAX_TIME_MS = Date.UTC(2100, 0, 1);
/** Earliest: the first GhostMaps commit is 2025; nothing before 2000 is real. */
const MIN_TIME_MS = Date.UTC(2000, 0, 1);

const ISO_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The `t` query value of the archive endpoints: an ISO time WITH a zone
 * (the History control writes `ht` as UTC ISO) or integer epoch ms.
 * Anything else, a zoneless time included, is refused (null), never guessed.
 * @param {unknown} raw
 * @returns {?number} epoch ms
 */
export function parseHistoryTime(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 40)
    return null;
  let ms;
  if (/^\d{1,16}$/.test(raw)) ms = Number(raw);
  else if (ISO_WITH_ZONE.test(raw)) ms = Date.parse(raw);
  else return null;
  if (!Number.isFinite(ms) || ms < MIN_TIME_MS || ms > MAX_TIME_MS) return null;
  return ms;
}

/**
 * The commit that was GhostMaps' published head at `tMs`: the newest commit
 * whose committer time is at or before t (committer time is when the commit
 * landed on the branch, so it is the closest recorded "published" time).
 * Commit times need not be in order (clock skew, rebases): the newest time
 * wins, a tie goes to the commit listed first (nearest the branch head).
 *
 * `position`:
 *   'before'   t is earlier than every commit: nothing had been published
 *   'exact'    t is exactly a commit time
 *   'between'  t is between two commit times
 *   'after'    t is at or past the newest commit: the latest edition, which
 *              is also what is live (an edition stays published until the
 *              next commit replaces it)
 *   'empty'    no commits at all
 * @param {Array<{sha: string, ts: number}>} commits epoch SECONDS in `ts`
 * @param {number} tMs
 * @returns {{position: string, commit: ?{sha: string, ts: number}}}
 */
export function pickCommitAt(commits, tMs) {
  const list = Array.isArray(commits)
    ? commits.filter(
        (c) => c && typeof c.sha === 'string' && Number.isFinite(c.ts),
      )
    : [];
  if (!list.length || !Number.isFinite(tMs))
    return { position: 'empty', commit: null };
  const tSec = Math.floor(tMs / 1000);
  let best = null;
  let newest = -Infinity;
  for (const c of list) {
    if (c.ts > newest) newest = c.ts;
    if (c.ts <= tSec && (!best || c.ts > best.ts)) best = c;
  }
  if (!best) return { position: 'before', commit: null };
  if (best.ts === tSec) return { position: 'exact', commit: best };
  return { position: tSec >= newest ? 'after' : 'between', commit: best };
}
