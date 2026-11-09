- Flights keeps working when the collector and the bridge's per-view last-good
  copy are both unavailable: with `GEV_BRIDGE_FLIGHTS_ES_FALLBACK=1` (plus the
  /api/history reader-key settings) /api/flights is served from a bounded read
  of the recorded OpenSky history (15 min lookback, valid viewport, newest
  position per aircraft) as an OpenSky-compatible `{time, states}` envelope,
  marked STALE + grey ("No data since HH:MM", X-Feed-Reason `es_fallback`),
  reusing a fresh in-memory answer; ES errors keep the plain 503 no-snapshot
  and the bridge still never falls through to the OpenSky / adsb.lol plugins.
