- Flights keeps working when the collector is unavailable (down or paused):
  with `GEV_BRIDGE_FLIGHTS_ES_FALLBACK=1` (plus the /api/history reader-key
  settings) /api/flights is served from the bridge's per-view last-good copy
  or a bounded read of the recorded OpenSky history (15 min lookback, valid
  viewport, newest position per aircraft) as an OpenSky-compatible
  `{time, states}` envelope, marked STALE + grey ("No data since HH:MM",
  the collector's own paused reason when it paused). An empty (paused)
  envelope is never cached or treated as data; a copy that is empty or
  older than the lookback is skipped in favour of ES, and still served if
  ES has nothing. Reuses a fresh in-memory answer; ES load is bounded
  globally (at most 2 concurrent reads, 24 collapse queries per read, an
  8 s whole-read deadline, failures cached and logged at most once a
  minute); ES errors keep the plain 503 no-snapshot and the bridge still
  never falls through to the OpenSky / adsb.lol plugins.
