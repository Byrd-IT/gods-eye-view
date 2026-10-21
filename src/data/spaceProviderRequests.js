/** Fixed upstream request URLs; callers own validation, credentials and transport. */
export function celestrakTleUrl(group) {
  const url = new URL('https://celestrak.org/NORAD/elements/gp.php');
  url.searchParams.set('GROUP', group);
  // FORMAT=tle is dead: objects cataloged after 2026-07-11 carry 6-digit
  // NORAD numbers that cannot fit the fixed-width TLE format. CSV (GP/OMM
  // columns) is CelesTrak's replacement; the client parses it with
  // satellite.js' json2satrec().
  url.searchParams.set('FORMAT', 'csv');
  return url;
}

/**
 * CelesTrak SATCAT for the active payloads, CSV (documented query form,
 * https://celestrak.org/satcat/satcat-format.php). Verified once on
 * 2026-10-12 01:17 UTC from S4: HTTP 200, 17,210 rows, 1.52 MB, RCS column
 * present (filled for 880 rows only; null for Starlink and most new objects).
 */
export function celestrakSatcatUrl() {
  const url = new URL('https://celestrak.org/satcat/records.php');
  url.searchParams.set('GROUP', 'ACTIVE');
  url.searchParams.set('FORMAT', 'CSV');
  return url;
}

export function launchLibraryRecentUrl(end) {
  // Stable minute boundaries let different installations share LL2's cache.
  const roundedEnd = new Date(Math.floor(end.getTime() / 60000) * 60000);
  const start = new Date(roundedEnd.getTime() - 30 * 86400000);
  const url = new URL('https://ll.thespacedevs.com/2.3.0/launches/');
  url.searchParams.set('net__gte', start.toISOString());
  url.searchParams.set('net__lte', roundedEnd.toISOString());
  url.searchParams.set('limit', '100');
  url.searchParams.set('mode', 'detailed');
  return url;
}
