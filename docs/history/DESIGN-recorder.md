# History recorder design

How the optional history recorder fills the history store (`server/history/store`). The recorder is off by default.

## Decision: tee, do not poll
The app already fetches each source for its live layer. The recorder taps the normalised payload at the point where the
route handler returns it to the client (after the existing cache and dedupe) and calls `store.append(feed, records)`. It never
makes a request of its own. That adds no load on rate-limited public APIs, needs no second set of credentials, and makes the
history match what users saw. The cost is that nothing is recorded while nobody is looking at a layer, unless the feed has a
server-side refresh loop. Each feed adapter declares one of:
- `server-polled`: the feed refreshes on a server timer; every refresh is recorded.
- `view-driven`: the feed refreshes only while a client views it; each upstream fetch is recorded, and gaps are real and shown by coverage.
- `bulk-archive`: backfill from the source's own archive (a later backend class).

## Modules
- `server/history/recorder/index.js`: `createRecorder({ store, config, adapters })` with `tap(feed, payload, meta)`, `tapFailure`, `flush`, `close`, `health`.
  A tap on a feed that is not recording returns at once. `NOOP_RECORDER` is what a disabled recorder is.
- `server/history/recorder/adapters/<feed>.js`: a pure `toRecords(payload) -> [{ id, t, lat, lon, props }]`, plus `feed`, `source`, `mode`, `cadenceMs`, `fields`, `entityKey`. No I/O.
- `server/history/recorder/config.js`: validation of the `HISTORY_RECORD*` and `HISTORY_MIN_INTERVAL_S*` settings.
- `server/history/runtime.js`: opens the store only when recording is on; owns the flush and retention timers and shutdown.

## Behaviour
- **Backpressure.** A tap never waits for the store. Records go to a bounded in-memory queue, written in batches on a timer
  (default 5 s) and at shutdown. A full queue drops the oldest poll and counts it. A store error never reaches the live response.
- **Dedupe.** The key of a row is the store's `(feed, t, key)`, where `key` is the feed's entity key and `t` the observation time.
  `append` is idempotent. An unchanged entity seen again within `HISTORY_MIN_INTERVAL_S[_<FEED>]` (default: the feed's cadence) is skipped,
  so a frequent refresh of a slow feed does not store many copies.
- **Ingest log.** One `recordIngest(feed, { t, ok, count })` row per poll, written after its rows. Coverage uses it to tell a gap from an empty answer.
  A failed upstream refresh is logged `ok: false`; a poll dropped from a full queue leaves no row and reads as a gap.
- **Retention.** The SQLite backend prunes with `HISTORY_RETENTION_DAYS[_<FEED>]` on a daily timer. A backend with its own lifecycle management (for example index lifecycle policies) is not pruned by the recorder.
- **Privacy.** Payloads are public-source data. Each adapter keeps a whitelist of fields: no request headers, no API keys, no client addresses.
  Tests push synthetic secrets through the handler, the adapter, the store and the log paths and require zero hits.
- **Start-up validation.** Unsupported feed and backend combinations and unknown `HISTORY_*` names fail at boot with every problem listed, without quoting a value.

## Interface the recorder depends on
`append(feed, records)`, `recordIngest(feed, record)`, `prune(feed, olderThan)` and `close()`. Backends that cannot take `append` are refused at start-up when recording is on.

## Feeds
FIRMS fires (`/api/firms`) is the first feed. Earthquakes are fetched by the browser directly and that stays as it is, so there is no handler to tee. The quakes
feed is an opt-in poller (`mode: 'poller'`, `optIn: true`): only `HISTORY_RECORD_QUAKES=1` starts it, `HISTORY_RECORD=1` alone does not, and it makes one request to
the USGS all_day feed every 5 minutes (`server/history/recorder/poller.js`), taps the parsed body like a route would, and logs a failed poll as a gap. A quakes row is
one version of an event: key = USGS event id, time = the `updated` stamp (origin time if absent); only M2.5+ events and the fields `mag`, `magType`, `place`,
`depthKm`, `time`, `updated`, `status` are kept. Later feed groups (aircraft, vessels, cyclones, launches, satellites, transit) add one adapter each.

## Choices made in the first implementation
- The queue holds 200,000 rows by default (`HISTORY_RECORD_QUEUE_ROWS`, 1,000 to 2,000,000): one world-wide FIRMS refresh holds up to about 130,000 detections.
- The FIRMS key is the instrument, satellite and position (4 decimals); its time is the acquisition time.
- The Elasticsearch template and optional lifecycle policy belong with the Elasticsearch backend, and merging `recorder.health()` into a health endpoint belongs with the history API.
