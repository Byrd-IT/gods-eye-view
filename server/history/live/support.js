/**
 * Which feeds can answer a history question without keeping anything.
 *
 * Two backends keep no history of their own:
 *
 *   live-api   ask the source's own history API when someone scrubs back.
 *              Offered only for a feed whose source has such an API (below).
 *   live-only  no history at all; the time slider is not offered for the feed.
 *
 * This file is the one place that says which feeds may use live-api. The
 * settings check it at boot, the adapters are built from it, and
 * `npm run history:support` prints it, so the three cannot disagree. A feed
 * with no entry in LIVE_API_SUPPORT is live-only (or stored) and the entry in
 * NO_SOURCE_HISTORY says why. Both tables are checked against HISTORY_FEEDS by
 * the tests, so a new feed cannot be added without being classified.
 *
 * Each claim was checked against the source on 2026-10-31 (see `checked`).
 * Pure data and pure functions: nothing here reads the environment or touches
 * the network.
 */

const DAY = 24 * 3600 * 1000;

/**
 * Feeds whose source has an on-demand history query.
 *
 *   source        who answers
 *   reach         how far back it answers (a limit of this build, not a promise)
 *   needs         what the deployment must have
 *   env           the environment variable that must be set, when one must
 *   maxWindowMs   widest slice window one question may ask for
 *   maxPerHour    questions per hour this build will send to the source
 *   stepMs        a question's time is snapped down to a multiple of this, so a
 *                 slider drag becomes a few questions, not one per pixel
 *   checked       what was verified against the live source
 */
export const LIVE_API_SUPPORT = Object.freeze({
  quakes: Object.freeze({
    source: 'USGS Earthquake Hazards Program (FDSN event query)',
    reach: 'all recorded earthquakes, no time limit',
    needs: 'nothing (no key)',
    maxWindowMs: 31 * DAY,
    maxPerHour: 120,
    stepMs: 60 * 1000,
    checked:
      'earthquake.usgs.gov/fdsnws/event/1/query with starttime and endtime answered with GeoJSON; limit is capped at 20000',
  }),
  firms: Object.freeze({
    source: 'NASA FIRMS area API (VIIRS S-NPP near real time)',
    reach:
      'the last 60 days (the near-real-time product; older data is in the standard-processing product, not used)',
    needs:
      'FIRMS_MAP_KEY, the same key the live layer uses; every question needs a bounding box of at most 3000 square degrees (a whole-world day is tens of megabytes)',
    env: 'FIRMS_MAP_KEY',
    maxWindowMs: 9 * DAY,
    maxPerHour: 120,
    stepMs: 5 * 60 * 1000,
    checked:
      'FIRMS area API documents /api/area/csv/[KEY]/[SOURCE]/[AREA]/[DAY_RANGE 1-5]/[DATE]; the near-real-time retention of 60 days is a conservative bound, not read from the data_availability endpoint (that needs a key)',
  }),
  water: Object.freeze({
    source: 'USGS National Water Information System (instantaneous values)',
    reach:
      'about the last 120 days at 5 to 60 minute steps, one bounding box of up to 25 square degrees',
    needs:
      'a bounding box on every question (the service refuses an unbounded one)',
    maxWindowMs: 6 * 3600 * 1000,
    maxPerHour: 120,
    stepMs: 5 * 60 * 1000,
    checked:
      'waterservices.usgs.gov/nwis/iv with bBox, startDT and endDT answered with a time series per site',
  }),
  launches: Object.freeze({
    source: 'The Space Devs Launch Library 2',
    reach: 'all launches on record',
    needs:
      'nothing (anonymous quota is 15 requests an hour, so this build sends at most 10)',
    maxWindowMs: 366 * DAY,
    maxPerHour: 10,
    stepMs: 15 * 60 * 1000,
    checked:
      'll.thespacedevs.com/2.3.0/launches with net__gte and net__lte answered; mode=normal carries the pad position',
  }),
});

/** Why a feed cannot use live-api. Static sentences: safe to print anywhere. */
export const NO_SOURCE_HISTORY = Object.freeze({
  aircraft:
    'OpenSky answers a past time only to a signed-in client, only for the last hour, and each question spends the shared daily credit budget; adsb.lol publishes only daily archives (multi-gigabyte GitHub releases), with no query API. Keep aircraft history with the recorder or an importer.',
  military:
    'adsb.lol serves the live military list only; its history is the daily archive, with no query API.',
  vessels:
    'AISStream is a live stream with no history query. Keep vessel history with the recorder.',
  transit:
    'Transit agencies publish live GTFS-Realtime feeds with no history query. Keep history with the recorder.',
  bikeshare:
    'GBFS publishes the current state only, with no history query. Keep history with the recorder.',
  perimeters:
    'The NIFC perimeter service used is the "Current" layer: it has no time information or edit tracking, so it cannot answer a past time.',
  cyclones:
    'The National Hurricane Center publishes past storms as yearly archive files, with no time query.',
});

/** @param {string} feed */
export function supportsLiveApi(feed) {
  return Object.hasOwn(LIVE_API_SUPPORT, feed);
}

/** Feeds that may use live-api, in a stable order. */
export function liveApiFeeds() {
  return Object.keys(LIVE_API_SUPPORT);
}

/**
 * The sentence that explains why `feed` has no live-api. Empty when it has one.
 * @param {string} feed
 */
export function liveApiRefusal(feed) {
  if (supportsLiveApi(feed)) return '';
  return Object.hasOwn(NO_SOURCE_HISTORY, feed)
    ? NO_SOURCE_HISTORY[feed]
    : 'Its source has no history query this build knows of.';
}

/**
 * What each feed does under a loaded configuration: the answer the settings
 * screen and the time slider need.
 *
 *   mode          stored | live-api | live-only
 *   history       the kind of history the slider gets: recorded | source | none
 *   slider        available | hidden
 *   liveApiOffer  whether live-api is a choice for this feed
 *   note          why, in one sentence
 *
 * @param {{ feeds: Record<string, {store: string}> }} config from loadHistoryConfig
 */
export function describeSupport(config) {
  const rows = [];
  for (const [feed, setting] of Object.entries(config.feeds)) {
    const offer = supportsLiveApi(feed);
    let mode = 'stored';
    let history = 'recorded';
    let slider = 'available';
    let note = `History is recorded in ${setting.store}.`;
    if (setting.store === 'live-only') {
      mode = 'live-only';
      history = 'none';
      slider = 'hidden';
      note = offer
        ? 'No history is kept. The source has a history API; choose live-api to use it.'
        : `No history is kept. ${liveApiRefusal(feed)}`;
    } else if (setting.store === 'live-api') {
      mode = 'live-api';
      history = 'source';
      const entry = LIVE_API_SUPPORT[feed];
      note = `Nothing is stored; the slider asks ${entry.source} (${entry.reach}).`;
    }
    rows.push({
      feed,
      store: setting.store,
      mode,
      history,
      slider,
      liveApiOffer: offer,
      note,
    });
  }
  return rows;
}
