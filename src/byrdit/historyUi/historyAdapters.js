/**
 * Per-feed adapters of the history fetch router (gev-history DESIGN 4.5,
 * card B12a; shared decisions D1-D7 on the B12 umbrella t_5aa880c7).
 *
 * While history is active, a GET on a history-capable live route is
 * answered from /api/history/slice?feed=<f>&t=<ISO>. An adapter says how:
 *
 *   sliceParams(liveUrl, ctx)
 *                         the slice questions (bbox / maxRows) for that
 *                         live request; more than one when a view crosses
 *                         the antimeridian (the slice API takes w < e only).
 *                         ctx.viewBox() = the camera view box (FIRMS, D7)
 *   adapt(answers, {t, nowMs, url})
 *                         the slice answers -> the EXACT live body + the
 *                         headers the live source reads, so the existing
 *                         parsers (src/sources/live/*) run unchanged
 *
 * D2 time semantics: the motion feeds judge freshness on the browser clock
 * (aircraft.js: stale after 120 s; flights motion.js dead-reckons from the
 * fix time). Their record and poll times are REBASED by delta = nowMs - t,
 * so relative ages stay true and the layer draws time t as current. No
 * X-Feed-Age-Ms and no X-Feed-Cache: STALE is sent for them.
 *
 * Vessels (D2 check, see the B12a card): the vessels layer reads the per-row
 * position time ONLY to print it as an absolute clock ("POS: 14:03:22Z" in
 * the AIS HUD and on the canvas-drawn vessel card); no vessel freshness rule
 * reads it. Rebasing it would print a wrong clock time, so the per-row
 * times stay as recorded and only the poll-level times (newestPositionAt,
 * lastMessageAt -> the layer's "updated ... ago") are rebased.
 *
 * D3: a gap or an empty slice becomes an EMPTY live answer (nothing drawn);
 * nothing is invented, interpolated or taken from another time.
 *
 * The registry is the extension point: B12b adds the event feeds in
 * historyEventAdapters.js (ALL_HISTORY_ADAPTERS = this list + those).
 */

/** Live route -> slice: the B9/B10 slice API caps every answer here. */
export const SLICE_MAX_ROWS = 15_000;
/** The live /api/vessels default (src/sources/live/standalone.js). */
export const VESSELS_DEFAULT_ROWS = 12_000;
const KM_PER_DEG = 111.32;

/** A history answer's source label (X-Feed-Source is cut at 80 chars). */
const SOURCE_NAMES = Object.freeze({
  adsblol: 'adsb.lol',
  'adsb.lol': 'adsb.lol',
  opensky: 'OpenSky',
  aisstream: 'AISStream',
  marinecadastre: 'MarineCadastre',
  'noaa-marinecadastre': 'MarineCadastre',
});

export function historySourceLabel(sources, extra = '') {
  const names = [
    ...new Set(
      String(sources ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s && s !== 'none')
        .map((s) => SOURCE_NAMES[s.toLowerCase()] ?? s),
    ),
  ];
  const label = `History${names.length ? `: ${names.join(' + ')}` : ''}${extra}`;
  return label.slice(0, 80);
}

// ── rebase arithmetic (D2) ────────────────────────────────

/** delta = nowMs - t: what is added to a recorded time to show it as now. */
export function rebaseDelta(t, nowMs) {
  return nowMs - t;
}

/** An epoch-ms number moved by delta; anything else is kept as it is. */
export function rebaseMs(value, deltaMs) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value + deltaMs
    : value;
}

/**
 * An epoch-SECONDS number moved by delta, kept to the millisecond (the live
 * parser reads seconds x 1000 and accepts a fraction). Whole seconds would
 * shift a re-served frame by up to 0.5 s against the motion clock, which
 * dead-reckons from the frame's apply time (historyRefresh.js): a paused
 * aircraft would hop up to ~125 m at each poll. Anything else is kept.
 */
export function rebaseSec(value, deltaMs) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value * 1000 + deltaMs) / 1000
    : value;
}

/** An ISO time moved by delta; an unparsable value is kept as it is. */
export function rebaseIso(value, deltaMs) {
  if (typeof value !== 'string' || !value) return value;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms + deltaMs).toISOString() : value;
}

// ── parameters (D7) ───────────────────────────────────────

const VIEW_RE =
  /^(-?\d{1,3}(?:\.\d+)?),(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?),(-?\d{1,2}(?:\.\d+)?)$/;

const fmt = (v) => {
  const x = Math.round(v * 10_000) / 10_000;
  return String(Object.is(x, -0) ? 0 : x);
};

function boxParam(w, s, e, n) {
  return `${fmt(w)},${fmt(s)},${fmt(e)},${fmt(n)}`;
}

/**
 * B20 view=w,s,e,n (flightView.js normalizeViewBox: w > e = crosses the
 * antimeridian) -> slice bbox values. The slice API refuses w >= e, so a
 * crossing view becomes two boxes. No / bad view -> [null] (whole globe).
 */
export function viewToBboxes(view) {
  const m = VIEW_RE.exec(String(view ?? ''));
  if (!m) return [null];
  const [w, s, e, n] = m.slice(1).map(Number);
  if (
    !(s < n) ||
    s < -90 ||
    n > 90 ||
    Math.abs(w) > 180 ||
    Math.abs(e) > 180 ||
    w === e
  )
    return [null];
  if (w < e) return [boxParam(w, s, e, n)];
  const out = [];
  if (w < 180) out.push(boxParam(w, s, 180, n));
  if (-180 < e) out.push(boxParam(-180, s, e, n));
  return out.length ? out : [null];
}

/**
 * The live vessels area (lat, lon, radius_km) -> one slice bbox, or null
 * (whole globe) when it is absent, bad or crosses the antimeridian / a pole.
 */
export function areaToBbox(lat, lon, radiusKm) {
  const la = Number(lat),
    lo = Number(lon),
    r = Number(radiusKm);
  if (
    ![la, lo, r].every(Number.isFinite) ||
    r <= 0 ||
    Math.abs(la) > 90 ||
    Math.abs(lo) > 180
  )
    return null;
  const dLat = r / KM_PER_DEG;
  const cos = Math.cos((la * Math.PI) / 180);
  if (cos < 0.05) return null;
  const dLon = r / (KM_PER_DEG * cos);
  const s = la - dLat,
    n = la + dLat,
    w = lo - dLon,
    e = lo + dLon;
  if (s < -90 || n > 90 || w < -180 || e > 180) return null;
  return boxParam(w, s, e, n);
}

function clampRows(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(SLICE_MAX_ROWS, Math.floor(n));
}

// ── answers ───────────────────────────────────────────────

const JSON_TYPE = 'application/json; charset=utf-8';

/** The history headers worth keeping on the adapted answer (QA, chips). */
export function passHeaders(answers) {
  const out = {};
  const rows = answers.reduce(
    (sum, a) => sum + (Number(a.headers['x-history-rows']) || 0),
    0,
  );
  out['X-History-Rows'] = String(rows);
  if (answers.some((a) => a.headers['x-history-truncated'] === '1'))
    out['X-History-Truncated'] = '1';
  const fallback = answers.find((a) => a.headers['x-history-fallback']);
  if (fallback)
    out['X-History-Fallback'] = fallback.headers['x-history-fallback'];
  const snap = answers.find((a) => a.headers['x-history-snap']);
  if (snap) out['X-History-Snap'] = snap.headers['x-history-snap'];
  return out;
}

const allSources = (answers) =>
  answers.map((a) => a.headers['x-history-source'] ?? '').join(',');

function adaptFlights(answers, { t, nowMs }) {
  const delta = rebaseDelta(t, nowMs);
  // two boxes of a crossing view may both hold an aircraft on the line:
  // keep the newest contact per icao24 (one row per aircraft, like live)
  const byId = new Map();
  let time = null;
  for (const a of answers) {
    const body = a.body ?? {};
    if (Number.isFinite(body.time)) time = Math.max(time ?? 0, body.time);
    for (const row of Array.isArray(body.states) ? body.states : []) {
      if (!Array.isArray(row)) continue;
      const id = String(row[0] ?? '');
      const prev = byId.get(id);
      if (!prev || (Number(row[4]) || 0) > (Number(prev[4]) || 0))
        byId.set(id, row);
    }
  }
  const states = [...byId.values()].map((row) => {
    const out = row.slice();
    out[3] = rebaseSec(row[3], delta); // time_position
    out[4] = rebaseSec(row[4], delta); // last_contact
    return out;
  });
  const gap = states.length === 0;
  return {
    body: {
      time: rebaseSec(time ?? Math.round(t / 1000), delta),
      states,
    },
    headers: {
      'Content-Type': JSON_TYPE,
      'X-Feed-Source': historySourceLabel(allSources(answers)),
      'X-Flight-Coverage': 'recorded history',
      ...passHeaders(answers),
      ...(gap ? { 'X-History-Gap': '1' } : {}),
    },
  };
}

/**
 * The seconds a recorded row is older at t than at its snapshot: the slice
 * answers the snapshot at or before t (body.now = the snap ms), so every
 * age relative to the snapshot grows by t - snap at t.
 */
export function snapLagSec(t, snapMs) {
  return Number.isFinite(snapMs) && snapMs < t
    ? Math.round(t - snapMs) / 1000
    : 0;
}

/** A relative readsb age (seconds) grown by lag; anything else kept. */
function ageBy(value, lagS) {
  return typeof value === 'number' && Number.isFinite(value) && lagS
    ? Math.round((value + lagS) * 1000) / 1000
    : value;
}

function adaptMilitary(answers, { t, nowMs }) {
  const body = answers[0]?.body ?? {};
  const headers = answers[0]?.headers ?? {};
  // The live military source ignores body.now: it takes the fix time as
  // receipt time minus seen_pos (no X-Feed-Age-Ms, D2). So the ages are
  // made relative to t itself: seen / seen_pos grow by t - snap, and the
  // poll times (now, ctime) become t, rebased to the browser now.
  const lagS = snapLagSec(t, Number(body.now));
  const ac = (Array.isArray(body.ac) ? body.ac : []).map((row) =>
    lagS && row && typeof row === 'object'
      ? {
          ...row,
          seen: ageBy(row.seen, lagS),
          seen_pos: ageBy(row.seen_pos, lagS),
        }
      : row,
  );
  return {
    body: {
      ...body,
      ac,
      total: ac.length,
      now: nowMs,
      ctime: nowMs,
    },
    headers: {
      'Content-Type': JSON_TYPE,
      'X-Feed-Source': historySourceLabel(
        headers['x-history-source'],
        headers['x-history-fallback'] ? ' archive' : '',
      ),
      ...passHeaders(answers),
      ...(ac.length ? {} : { 'X-History-Gap': '1' }),
    },
  };
}

function adaptVessels(answers, { t, nowMs }) {
  const delta = rebaseDelta(t, nowMs);
  const body = answers[0]?.body ?? {};
  const rows = Array.isArray(body.rows) ? body.rows : [];
  // newest recorded position, else the slice time itself, as "now"
  const newest =
    rebaseIso(body.newestPositionAt, delta) ||
    new Date(t + delta).toISOString();
  const newestMs = Date.parse(newest);
  return {
    body: {
      ...body,
      rows,
      source: 'history',
      // 'live' (not the recorder's own 'history'): the vessels layer reads a
      // status outside live/open/connecting as a transport failure and then
      // KEEPS the old rows on an empty answer; 'live' + a message time lets
      // a recorded gap clear the layer (D3), as an empty live feed does
      status: 'live',
      error: null,
      refreshing: false,
      newestPositionAt: newest,
      lastMessageAt: Number.isFinite(newestMs) ? newestMs : nowMs,
      silentForMs: null,
      reconnectAttempt: null,
      nextAttemptAt: null,
    },
    headers: {
      'Content-Type': JSON_TYPE,
      'X-Feed-Source': historySourceLabel(
        answers[0]?.headers?.['x-history-source'],
      ),
      ...passHeaders(answers),
      ...(rows.length ? {} : { 'X-History-Gap': '1' }),
    },
  };
}

/**
 * The registry. Fields:
 *   id           adapter id = the B11 chip feed id (feedChips BRIDGED_FEEDS)
 *   layerId      the data-manager layer id it swaps
 *   sliceFeed    /api/history/slice?feed=
 *   snapFeed     /api/history/snapshots feed for playback frames, or null
 *   quantumMs    playback frame step when there is no snapFeed
 *   trackMatch   the feed's LIVE track route, refused while the feed is
 *                answered from history (historyRouter.js, D3)
 *   rebased      D2: record/poll times are rebased (motion feed)
 */
export const HISTORY_ADAPTERS = Object.freeze([
  Object.freeze({
    id: 'flights',
    layerId: 'flights',
    sliceFeed: 'aircraft',
    snapFeed: 'aircraft',
    quantumMs: 60_000,
    rebased: true,
    match: /^\/api\/flights\/?$/,
    trackMatch: /^\/api\/flights\/track\/?$/,
    sliceParams(url) {
      return viewToBboxes(url.searchParams.get('view')).map((bbox) =>
        bbox ? { bbox } : {},
      );
    },
    adapt: adaptFlights,
  }),
  Object.freeze({
    id: 'military',
    layerId: 'military',
    sliceFeed: 'military',
    snapFeed: 'military',
    quantumMs: 60_000,
    rebased: true,
    match: /^\/api\/military\/?$/,
    trackMatch: /^\/api\/military\/track\/?$/,
    sliceParams() {
      return [{}];
    },
    adapt: adaptMilitary,
  }),
  Object.freeze({
    id: 'vessels',
    layerId: 'ais-live-vessels',
    sliceFeed: 'vessels',
    snapFeed: null,
    quantumMs: 60_000,
    rebased: true,
    match: /^\/api\/vessels\/?$/,
    trackMatch: /^\/api\/vessels\/track\/?$/,
    sliceParams(url) {
      const q = url.searchParams;
      const bbox = areaToBbox(q.get('lat'), q.get('lon'), q.get('radius_km'));
      return [
        {
          maxRows: String(clampRows(q.get('maxRows'), VESSELS_DEFAULT_ROWS)),
          ...(bbox ? { bbox } : {}),
        },
      ];
    },
    adapt: adaptVessels,
  }),
]);

/** The adapter of a request path, or null. */
export function adapterForPath(path, adapters = HISTORY_ADAPTERS) {
  return adapters.find((a) => a.match.test(path)) ?? null;
}

/** /api/history/slice URL (path + query) of one slice question at t. */
export function sliceUrl(adapter, params, t, base = '/api/history') {
  const q = new URLSearchParams({
    feed: adapter.sliceFeed,
    t: new Date(t).toISOString(),
  });
  for (const key of Object.keys(params ?? {}).sort())
    q.set(key, String(params[key]));
  return `${base}/slice?${q}`;
}
