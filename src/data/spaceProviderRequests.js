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

export function launchLibraryRecentUrl(end) {
  const start = new Date(end.getTime() - 30 * 86400000);
  const url = new URL('https://ll.thespacedevs.com/2.3.0/launches/');
  url.searchParams.set('net__gte', start.toISOString());
  url.searchParams.set('net__lte', end.toISOString());
  url.searchParams.set('limit', '100');
  url.searchParams.set('mode', 'detailed');
  return url;
}
