/**
 * The rows of the History menu (card t_73beacfb): every time-capable layer.
 *
 * A row is {id, label, adapterIds?, driver?}:
 *   adapterIds  recorded feeds answered by the history router (one own time
 *               per adapter; the router already knows how to show them)
 *   driver      a layer that is not a router feed: {available(), releases(),
 *               apply(ms|null), status?()}. apply() is called with the time
 *               the row shows (or null = LIVE) whenever it changes.
 *
 * Drivers are plain objects built from the live page (window hooks and the
 * data manager) so this file needs no layer import.
 */
import { msg, t } from '../../i18n/index.js';

/**
 * Router feeds, in menu order. id = the adapter id in historyEventAdapters.
 * `since` is a conservative first day of recorded data (2026-11-01 coverage
 * audit): the slider starts there until a probe finds the real start
 * (`snapFeed`: the snapshots endpoint) or a backfill moves it earlier.
 * It is a slider bound only; the server accepts any time back to
 * HISTORY_FLOOR_MS and answers "not recorded" outside the data.
 */
export const ROUTER_ROWS = Object.freeze([
  { id: 'flights', label: msg('Flights'), adapterIds: ['flights'], snapFeed: 'aircraft' },
  { id: 'military', label: msg('Military aircraft'), adapterIds: ['military'], snapFeed: 'military' },
  { id: 'vessels', label: msg('Vessels (AIS)'), adapterIds: ['vessels'], since: '2024-10-11' },
  { id: 'quakes', label: msg('Earthquakes'), adapterIds: ['quakes'], since: '2025-07-12' },
  { id: 'firms', label: msg('Fires (FIRMS)'), adapterIds: ['firms'], since: '2026-07-14' },
  { id: 'fire-perimeters', label: msg('Fire perimeters'), adapterIds: ['fire-perimeters'], since: '2026-09-01' },
  { id: 'cyclones', label: msg('Cyclones'), adapterIds: ['cyclones'], since: '2026-09-01' },
  { id: 'launches', label: msg('Rocket launches'), adapterIds: ['launches'], since: '2026-09-01' },
  { id: 'transit', label: msg('Transit'), adapterIds: ['transit'], since: '2026-09-01' },
  { id: 'bikeshare', label: msg('Bike share'), adapterIds: ['bikeshare'], since: '2026-09-01' },
  { id: 'wind', label: msg('Wind'), adapterIds: ['wind'], since: '2026-09-01' },
]);

/** Rows driven by a layer object or a window hook, in menu order. */
export const DRIVER_ROWS = Object.freeze([
  { id: 'satellites', label: msg('Satellites'), since: '2024-11-01' },
  { id: 'weather', label: msg('Weather radar, lightning, clouds') },
  { id: 'ghostmaps', label: msg('GhostMaps') },
  { id: 'wayback', label: msg('Imagery (Wayback)') },
  { id: 'naip', label: msg('Aerial (NAIP)') },
]);

export const ALL_ROW_DEFS = Object.freeze([...ROUTER_ROWS, ...DRIVER_ROWS]);

const parseDate = (d) => {
  const ms = typeof d === 'number' ? d : Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : NaN;
};

/**
 * Wayback: window.__gevWayback (catalog() oldest..newest, setIndex, state()).
 * The release in effect before the menu first moved it is put back on LIVE.
 */
export function waybackDriver(win) {
  const slot = () => win?.__gevWayback ?? null;
  let before = null;
  return {
    available: () => Boolean(slot()?.catalog),
    releases: () =>
      (slot()?.catalog?.() ?? []).map((e) => parseDate(e.date)).filter(Number.isFinite),
    apply(ms) {
      const s = slot();
      if (!s) return;
      if (!Number.isFinite(ms)) {
        if (before !== null) s.setIndex(before);
        before = null;
        return;
      }
      const list = s.catalog().map((e) => parseDate(e.date));
      let idx = -1;
      for (let i = 0; i < list.length; i++) if (list[i] <= ms) idx = i;
      if (idx < 0) idx = 0; // before the first release: the oldest one (the menu says so)
      if (before === null) before = s.state?.().index ?? idx;
      s.setIndex(idx);
    },
  };
}

/**
 * NAIP: window.__gevNaip (state().ticks = years, setYear). The year in effect
 * before the menu first moved it is put back on LIVE.
 */
export function naipDriver(win) {
  const slot = () => win?.__gevNaip ?? null;
  const midYear = (y) => Date.UTC(y, 6, 1);
  let before = null;
  return {
    available: () => Boolean(slot()?.state?.().ticks?.length),
    releases: () => (slot()?.state?.().ticks ?? []).map(midYear),
    apply(ms) {
      const s = slot();
      if (!s) return;
      const st = s.state();
      if (!Number.isFinite(ms)) {
        if (before !== null) s.setYear(before);
        before = null;
        return;
      }
      let year = null;
      for (const y of st.ticks) if (midYear(y) <= ms) year = y;
      if (year === null) year = st.ticks[0]; // before the first: the oldest
      if (before === null) before = st.year ?? year;
      s.setYear(year);
    },
  };
}

/**
 * GhostMaps: the existing ghostMapsHistory driver takes a history detail.
 * A row that follows the shared time passes the main control's own detail
 * through (playing / rate included), so GhostMaps behaves as before.
 */
export function ghostMapsDriver(ghostMaps) {
  return {
    /** apply() reads the shared detail (rate, error, play state) */
    usesDetail: true,
    available: () => Boolean(ghostMaps),
    apply(ms, { detail = null } = {}) {
      ghostMaps?.onHistory?.(
        detail ??
          (Number.isFinite(ms)
            ? { active: true, timeMs: ms, playing: false, rate: 1 }
            : { active: false, timeMs: null, playing: false, rate: 1 }),
      );
    },
  };
}

/**
 * The satellites layer: setHistoryTime(ms|null) propagates the recorded
 * element sets at that time (src/layers/satellites/history.js).
 */
export function layerDriver(getDataManager, layerId) {
  const mod = () => {
    try {
      return getDataManager()?.layers?.get?.(layerId)?.module ?? null;
    } catch {
      return null;
    }
  };
  return {
    available: () => typeof mod()?.setHistoryTime === 'function',
    apply(ms) {
      return mod()?.setHistoryTime?.(Number.isFinite(ms) ? ms : null);
    },
  };
}

/**
 * Weather radar, lightning and satellite clouds share ONE clock
 * (src/layers/weather/clock.js) that only knows what the provider still
 * serves. setTarget() picks, per product, the newest frame at or before the
 * time within that product's max gap; outside that the product shows no frame
 * (a gap), never a wrong one. status(ms) names that gap for the menu.
 */
export function weatherDriver(getClock) {
  // The radar loop's state before the menu first moved the clock. Only that
  // state resumes on LIVE; a loop the user starts during history is not restored.
  let wasPlaying = null;
  const clock = () => {
    try {
      return getClock() ?? null;
    } catch {
      return null;
    }
  };
  const timelineMs = () =>
    (clock()?.getTimeline?.() ?? []).map((x) => Date.parse(x)).filter(Number.isFinite);
  return {
    available: () => typeof clock()?.setTarget === 'function',
    /** The provider only serves what its timeline still lists. */
    earliest: () => timelineMs()[0] ?? null,
    apply(ms) {
      const c = clock();
      if (!c) return;
      if (!Number.isFinite(ms)) {
        const resume = wasPlaying;
        wasPlaying = null;
        const out = c.latest?.();
        // a radar loop the user had playing before history plays again
        if (resume) Promise.resolve(out).then(() => c.play?.(), () => {});
        return out;
      }
      if (wasPlaying === null) wasPlaying = Boolean(c.getState?.().playing);
      c.pause?.(); // a playing radar loop would run past the history time
      return c.setTarget(new Date(ms).toISOString());
    },
    /** Text for the row, or '' when a frame exists for the time. */
    status(ms) {
      const c = clock();
      const tl = timelineMs();
      if (!c || !Number.isFinite(ms) || !tl.length) return '';
      const shown = c.getState?.().products?.filter((p) => !p.suspended) ?? [];
      if (shown.length && shown.every((p) => p.selected === null))
        return t('No imagery (provider serves {time} on)', {
          time: `${new Date(tl[0]).toISOString().slice(0, 16).replace('T', ' ')}Z`,
        });
      return '';
    },
  };
}
