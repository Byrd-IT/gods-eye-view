import { HISTORY_INDICES as IDX } from './historyEs.js';
import {
  COLLAPSE_CONCURRENCY,
  COLLAPSE_FANOUT,
  createCutMemo,
  latestPerKey,
  mapLimit,
} from './historyCollapse.js';
import { getTransitFeed } from '../../data/transitFeeds.js';
import { TRANSIT_LOOKBACK_MS, VESSELS_LOOKBACK_MS } from './historyParams.js';
import {
  docTimeMs,
  gbfsEnvelope,
  gbfsInfoStation,
  gbfsStatusStation,
  transitVehicle,
  vesselRow,
} from './historyRows.js';

/**
 * Latest-per-entity slices (gev-history DESIGN 4.3; card B10 items 1-2):
 * vessels (per mmsi within [t - 35 min, t]), transit (per feedId +
 * vehicleId within [t - 3 min, t]) and bike share (per station, newest
 * status within the window, default 24 h: the recorder is change-only).
 *
 * Exactness rule (B9 review R3, applied here too): the NEWEST doc per entity
 * is chosen first and only then tested against the bbox; a vessel that
 * sailed out of the box is never drawn at an older position inside it.
 * With a bbox: (1) newest per key among docs inside the box = candidates;
 * (2) newest per candidate key with NO box; keep it only if that newest
 * position is inside the box. Every key whose true newest position is in
 * the box is a candidate in (1), so nothing is lost.
 */

/** Keys per terms clause (index.max_terms_count is 65,536; 5,000 measured fastest: 15 k statics 309 ms vs 590 ms at 10,000). */
export const TERMS_CHUNK = 5_000;

const range = (field, gte, lte) => ({
  range: { [field]: { gte, lte, format: 'epoch_millis' } },
});

function geoBox(bbox) {
  if (!bbox) return [];
  return [
    {
      geo_bounding_box: {
        location: {
          top_left: { lat: bbox.n, lon: bbox.w },
          bottom_right: { lat: bbox.s, lon: bbox.e },
        },
      },
    },
  ];
}

const sourceOf = (hit) => hit?._source ?? {};

/**
 * Vessel position fields with their mapped types (field caps over
 * gev-history-vessels + -vessels-noaa, 2026-10-18; all have doc values):
 * read from doc values, not the TSDS stored _source (t_5dc0e0c3).
 */
export const VESSEL_DOC_VALUES = Object.freeze({
  mmsi: 'keyword',
  '@timestamp': 'date',
  location: 'geo_point',
  sog_kn: 'float',
  cog_deg: 'float',
  heading_deg: 'float',
  source: 'keyword',
});

export function insideBbox(doc, bbox) {
  if (!bbox) return true;
  const la = doc?.location?.lat;
  const lo = doc?.location?.lon;
  return (
    Number.isFinite(la) &&
    Number.isFinite(lo) &&
    la >= bbox.s &&
    la <= bbox.n &&
    lo >= bbox.w &&
    lo <= bbox.e
  );
}

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

const newestFirst = (a, b) =>
  (docTimeMs(sourceOf(b)) ?? 0) - (docTimeMs(sourceOf(a)) ?? 0) ||
  String(a._id).localeCompare(String(b._id));

/**
 * @param {object} options
 * @param {ReturnType<import('./historyEs.js').createHistoryEsClient>} options.es
 */
export function createLatestSlices({ es }) {
  const cutMemo = createCutMemo();
  /** Newest doc per key in the window, then the exact bbox rule above. */
  async function newestIn(
    index,
    {
      window,
      extra = [],
      field,
      bbox,
      _source,
      probe = false,
      docValues = null,
      lane = null,
    },
  ) {
    if (!bbox) {
      return latestPerKey(es, index, {
        filter: [...window, ...extra],
        field,
        _source,
        docValues,
        probe,
        concurrency: probe ? COLLAPSE_FANOUT : COLLAPSE_CONCURRENCY,
        // t_5dc0e0c3: a global lane starts from its learned cuts (no probe)
        memo: lane ? cutMemo.lane(lane) : null,
      });
    }
    const cand = await latestPerKey(es, index, {
      filter: [...window, ...extra, ...geoBox(bbox)],
      field,
      _source,
      docValues,
    });
    const keys = [
      ...new Set(cand.hits.map((h) => sourceOf(h)[field]).filter(Boolean)),
    ];
    if (!keys.length) return cand;
    const verified = await Promise.all(
      chunks(keys, TERMS_CHUNK).map((part) =>
        latestPerKey(es, index, {
          filter: [...window, ...extra, { terms: { [field]: part } }],
          field,
          _source,
          docValues,
        }),
      ),
    );
    return {
      hits: verified
        .flatMap((v) => v.hits)
        .filter((h) => insideBbox(sourceOf(h), bbox)),
      truncated: cand.truncated || verified.some((v) => v.truncated),
      queries: cand.queries + verified.reduce((n, v) => n + v.queries, 0),
    };
  }

  /** Newest vessel-static record per mmsi at or before t. */
  async function vesselStatics(mmsis, t) {
    if (!mmsis.length) return new Map();
    const parts = await Promise.all(
      chunks(mmsis, TERMS_CHUNK).map((part) =>
        latestPerKey(es, IDX.vesselStatic, {
          filter: [
            range('@timestamp', undefined, t),
            { terms: { mmsi: part } },
          ],
          field: 'mmsi',
          _source: [
            'mmsi',
            'name',
            'imo',
            'ship_type',
            'destination',
            '@timestamp',
          ],
        }),
      ),
    );
    const out = new Map();
    for (const p of parts)
      for (const h of p.hits) out.set(sourceOf(h).mmsi, sourceOf(h));
    return out;
  }

  /** feed=vessels: live /api/vessels body as of t. */
  async function sliceVessels({ t, bbox, maxRows }) {
    const res = await newestIn(IDX.vessels, {
      window: [range('@timestamp', t - VESSELS_LOOKBACK_MS, t)],
      field: 'mmsi',
      bbox,
      // ~32 k vessels in 35 min (2026-10-14): never one page
      probe: true,
      // t_5dc0e0c3: doc values (every field below has them; TSDS stored
      // _source is the slow read) and learned cuts for the global lane
      docValues: VESSEL_DOC_VALUES,
      lane: 'vessels',
      _source: [
        'mmsi',
        '@timestamp',
        'location',
        'sog_kn',
        'cog_deg',
        'heading_deg',
        'source',
      ],
    });
    // newest first, like live aisStreamRows (sorted by update time)
    const sorted = [...res.hits].sort(newestFirst);
    const truncated = res.truncated || sorted.length > maxRows;
    const kept = sorted.slice(0, maxRows);
    const statics = await vesselStatics(
      kept.map((h) => sourceOf(h).mmsi).filter(Boolean),
      t,
    );
    const rows = kept
      .map((h) => vesselRow(sourceOf(h), statics.get(sourceOf(h).mmsi)))
      .filter(Boolean);
    const sources = [...new Set(rows.map((r) => r.source).filter(Boolean))]
      .sort()
      .join(',');
    return {
      body: {
        rows,
        source: 'history',
        status: 'history',
        error: null,
        refreshing: false,
        newestPositionAt: rows[0]?.last_position_UTC ?? null,
        lastMessageAt: null,
        silentForMs: null,
        reconnectAttempt: null,
        nextAttemptAt: null,
        staleAfterMs: VESSELS_LOOKBACK_MS,
        watchdog: null,
      },
      headers: {
        'X-History-Source': sources || 'none',
        'X-History-Window-Ms': String(VESSELS_LOOKBACK_MS),
        'X-History-Rows': String(rows.length),
        ...(truncated ? { 'X-History-Truncated': '1' } : {}),
        ...(rows.length ? {} : { 'X-History-Gap': '1' }),
      },
    };
  }

  /** feed=transit: one live-shaped snapshot per GTFS-RT feed as of t. */
  async function sliceTransit({ t, bbox, maxRows }) {
    const window = [range('@timestamp', t - TRANSIT_LOOKBACK_MS, t)];
    const feedsJson = await es.search(IDX.transit, {
      size: 0,
      query: { bool: { filter: window } },
      aggs: { f: { terms: { field: 'feed_id', size: 64 } } },
    });
    const feedIds = (feedsJson?.aggregations?.f?.buckets ?? [])
      .map((b) => b.key)
      .filter((k) => typeof k === 'string' && k)
      .sort();
    const perFeed = await mapLimit(feedIds, COLLAPSE_CONCURRENCY, (feedId) =>
      newestIn(IDX.transit, {
        window,
        extra: [{ term: { feed_id: feedId } }],
        field: 'vehicle_id',
        bbox,
        _source: [
          'feed_id',
          'vehicle_id',
          '@timestamp',
          'location',
          'bearing_deg',
          'speed_ms',
          'route_id',
          'trip_id',
          'direction_id',
          'label',
          'stop_id',
          'status',
        ],
      }),
    );
    let budget = maxRows;
    let truncated = false;
    const feeds = [];
    feedIds.forEach((feedId, i) => {
      const res = perFeed[i];
      const vehicles = [...res.hits]
        .sort(newestFirst)
        .map((h) => transitVehicle(sourceOf(h)))
        .filter(Boolean);
      const kept = vehicles.slice(0, Math.max(0, budget));
      budget -= kept.length;
      const cut = res.truncated || kept.length < vehicles.length;
      truncated ||= cut;
      if (!vehicles.length) return;
      feeds.push({
        feedId,
        name: getTransitFeed(feedId)?.name ?? feedId,
        fetchedAt: t,
        feedTimestamp: null,
        version: null,
        entityCount: vehicles.length,
        truncated: cut,
        count: kept.length,
        vehicles: kept,
      });
    });
    const rows = feeds.reduce((n, f) => n + f.count, 0);
    return {
      body: { fetchedAt: t, feeds },
      headers: {
        'X-History-Source': rows ? 'gtfs-rt' : 'none',
        'X-History-Window-Ms': String(TRANSIT_LOOKBACK_MS),
        'X-History-Rows': String(rows),
        ...(truncated ? { 'X-History-Truncated': '1' } : {}),
        ...(rows ? {} : { 'X-History-Gap': '1' }),
      },
    };
  }

  /**
   * feed=bikeshare: per system, GBFS 2.x station_information (newest
   * version per station at or before t) + station_status (newest change per
   * station within [t - window, t]). Stations do not move, so the bbox is
   * applied to the as-of station_information location; status is kept for
   * stations whose information lies in the box.
   */
  async function sliceBikeshare({ t, bbox, maxRows, windowMs }) {
    const sysJson = await es.search(IDX.bikeshareStations, {
      size: 0,
      query: { bool: { filter: [range('@timestamp', undefined, t)] } },
      aggs: { s: { terms: { field: 'system_id', size: 200 } } },
    });
    const systemIds = (sysJson?.aggregations?.s?.buckets ?? [])
      .map((b) => b.key)
      .filter((k) => typeof k === 'string' && k)
      .sort();
    const infos = await mapLimit(systemIds, COLLAPSE_CONCURRENCY, (systemId) =>
      latestPerKey(es, IDX.bikeshareStations, {
        filter: [
          range('@timestamp', undefined, t),
          { term: { system_id: systemId } },
        ],
        field: 'station_id',
        _source: [
          'station_id',
          'name',
          'location',
          'capacity',
          'region_id',
          '@timestamp',
        ],
      }),
    );
    const inBox = systemIds
      .map((systemId, i) => ({
        systemId,
        info: infos[i].hits
          .map(sourceOf)
          .filter((d) => insideBbox(d, bbox))
          .map(gbfsInfoStation)
          .filter(Boolean)
          .sort((a, b) => a.station_id.localeCompare(b.station_id)),
        truncated: infos[i].truncated,
      }))
      .filter((s) => s.info.length);
    const statuses = await mapLimit(inBox, COLLAPSE_CONCURRENCY, (s) =>
      latestPerKey(es, IDX.bikeshare, {
        filter: [
          range('@timestamp', t - windowMs, t),
          { term: { system_id: s.systemId } },
        ],
        field: 'station_id',
        _source: [
          'station_id',
          '@timestamp',
          'last_reported',
          'num_bikes_available',
          'num_docks_available',
          'num_ebikes_available',
          'is_installed',
          'is_renting',
          'is_returning',
        ],
      }),
    );
    let budget = maxRows;
    let truncated = false;
    const systems = [];
    inBox.forEach((s, i) => {
      const ids = new Set(s.info.map((x) => x.station_id));
      const status = statuses[i].hits
        .map(sourceOf)
        .filter((d) => ids.has(d.station_id))
        .map(gbfsStatusStation)
        .filter(Boolean)
        .sort((a, b) => a.station_id.localeCompare(b.station_id));
      const info = s.info.slice(0, Math.max(0, budget));
      budget -= info.length;
      const keep = new Set(info.map((x) => x.station_id));
      truncated ||=
        s.truncated || statuses[i].truncated || info.length < s.info.length;
      if (!info.length) return;
      systems.push({
        systemId: s.systemId,
        station_information: gbfsEnvelope(info, t),
        station_status: gbfsEnvelope(
          status.filter((x) => keep.has(x.station_id)),
          t,
        ),
      });
    });
    const rows = systems.reduce(
      (n, s) => n + s.station_information.data.stations.length,
      0,
    );
    const withStatus = systems.reduce(
      (n, s) => n + s.station_status.data.stations.length,
      0,
    );
    return {
      body: { fetchedAt: t, systems },
      headers: {
        'X-History-Source': rows ? 'gbfs' : 'none',
        'X-History-Window-Ms': String(windowMs),
        'X-History-Rows': String(rows),
        'X-History-Status-Rows': String(withStatus),
        ...(truncated ? { 'X-History-Truncated': '1' } : {}),
        ...(rows ? {} : { 'X-History-Gap': '1' }),
      },
    };
  }

  return { sliceVessels, sliceTransit, sliceBikeshare };
}
