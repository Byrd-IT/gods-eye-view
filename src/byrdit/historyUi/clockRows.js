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
import { msg } from '../../i18n/index.js';

/** Router feeds, in menu order. id = the adapter id in historyEventAdapters. */
export const ROUTER_ROWS = Object.freeze([
  { id: 'flights', label: msg('Flights'), adapterIds: ['flights'], snapFeed: 'aircraft' },
  { id: 'military', label: msg('Military aircraft'), adapterIds: ['military'], snapFeed: 'military' },
  { id: 'vessels', label: msg('Vessels (AIS)'), adapterIds: ['vessels'] },
  { id: 'quakes', label: msg('Earthquakes'), adapterIds: ['quakes'] },
  { id: 'firms', label: msg('Fires (FIRMS)'), adapterIds: ['firms'] },
  { id: 'fire-perimeters', label: msg('Fire perimeters'), adapterIds: ['fire-perimeters'] },
  { id: 'cyclones', label: msg('Cyclones'), adapterIds: ['cyclones'] },
  { id: 'launches', label: msg('Rocket launches'), adapterIds: ['launches'] },
  { id: 'transit', label: msg('Transit'), adapterIds: ['transit'] },
  { id: 'bikeshare', label: msg('Bike share'), adapterIds: ['bikeshare'] },
  { id: 'wind', label: msg('Wind'), adapterIds: ['wind'] },
]);

/** Rows driven by a layer object or a window hook, in menu order. */
export const DRIVER_ROWS = Object.freeze([
  { id: 'satellites', label: msg('Satellites') },
  { id: 'weather-radar', label: msg('Weather radar') },
  { id: 'weather-lightning', label: msg('Lightning') },
  { id: 'weather-clouds', label: msg('Satellite clouds') },
  { id: 'ghostmaps', label: msg('GhostMaps') },
  { id: 'wayback', label: msg('Imagery (Wayback)') },
  { id: 'naip', label: msg('Aerial (NAIP)') },
]);

export const ALL_ROW_DEFS = Object.freeze([...ROUTER_ROWS, ...DRIVER_ROWS]);

const parseDate = (d) => {
  const ms = typeof d === 'number' ? d : Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : NaN;
};

/** Wayback: window.__gevWayback (catalog() oldest..newest, setIndex). */
export function waybackDriver(win) {
  const slot = () => win?.__gevWayback ?? null;
  return {
    available: () => Boolean(slot()?.catalog),
    releases: () =>
      (slot()?.catalog?.() ?? []).map((e) => parseDate(e.date)).filter(Number.isFinite),
    apply(ms) {
      const s = slot();
      if (!s || !Number.isFinite(ms)) return; // LIVE = leave the layer as the user set it
      const list = s.catalog().map((e) => parseDate(e.date));
      let idx = -1;
      for (let i = 0; i < list.length; i++) if (list[i] <= ms) idx = i;
      if (idx >= 0) s.setIndex(idx);
    },
  };
}

/** NAIP: window.__gevNaip (state().ticks = years, setYear). */
export function naipDriver(win) {
  const slot = () => win?.__gevNaip ?? null;
  const midYear = (y) => Date.UTC(y, 6, 1);
  return {
    available: () => Boolean(slot()?.state?.().ticks?.length),
    releases: () => (slot()?.state?.().ticks ?? []).map(midYear),
    apply(ms) {
      const s = slot();
      if (!s || !Number.isFinite(ms)) return;
      let year = null;
      for (const y of s.state().ticks) if (midYear(y) <= ms) year = y;
      if (year !== null) s.setYear(year);
    },
  };
}

/** GhostMaps: the existing ghostMapsHistory driver takes a history detail. */
export function ghostMapsDriver(ghostMaps) {
  return {
    available: () => Boolean(ghostMaps),
    apply(ms) {
      ghostMaps?.onHistory?.(
        Number.isFinite(ms)
          ? { active: true, timeMs: ms, playing: false, rate: 1 }
          : { active: false, timeMs: null, playing: false, rate: 1 },
      );
    },
  };
}
