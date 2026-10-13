// Byrd-IT: opt-in trusted reverse proxy for the same-site gate.
//
// Upstream's `admitSameSiteRequest` (src/localRequestGate.mjs) refuses every
// request that carries a reverse-proxy header (X-Forwarded-*, X-Real-IP, ...).
// GEV is served publicly through Nginx Proxy Manager on S2 (10.10.99.102),
// which always adds those headers, so every key-brokered route (Mapillary,
// Cesium ion, Google tiles key, Realtime token) answered 403 through
// https://godseyeview.byrd-it.com.
//
// GEV_TRUSTED_PROXIES is a comma list of EXACT proxy IP addresses (no CIDR, no
// hostnames). Unset or empty = upstream behaviour, byte for byte. When the TCP
// peer (`req.socket.remoteAddress`, `::ffff:` IPv4-mapped form normalised) is
// in that list:
//   - the proxy headers no longer cause a refusal;
//   - the effective protocol is X-Forwarded-Proto (exactly `http` or `https`;
//     absent = the socket's own protocol);
//   - the effective host is the Host header (NPM forwards the client's Host
//     via `proxy_set_header Host $host`; X-Forwarded-Host is ignored);
//   - Sec-Fetch-Site and exact-Origin checks still run against that
//     effective `<proto>://<host>` authority.
// A trusted peer sending a malformed X-Forwarded-Proto (a list, or any other
// value) is treated as untrusted, i.e. refused as a proxied request.
//
// Only the sameSiteGated routes use this. The credential panel
// (admitKeySetupRequest) and /mcp stay loopback-only and never read it.
// No imports, so it can sit in any package boundary.

/** Environment variable holding the comma list of trusted proxy IPs. */
export const TRUSTED_PROXIES_ENV = 'GEV_TRUSTED_PROXIES';

/**
 * Normalise a socket address for comparison: trim, lower-case, and reduce an
 * IPv4-mapped IPv6 address (`::ffff:10.0.0.1`) to its IPv4 form.
 * @param {unknown} address
 * @returns {string}
 */
export function normalizeProxyAddress(address) {
  const raw = String(address ?? '')
    .trim()
    .toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(raw);
  return mapped ? mapped[1] : raw;
}

/**
 * Parse the GEV_TRUSTED_PROXIES value into a set of normalised addresses.
 * Entries that are not a plain IPv4 or IPv6 literal (CIDR ranges, hostnames,
 * wildcards) are ignored, never widened.
 * @param {unknown} value
 * @returns {Set<string>}
 */
export function parseTrustedProxies(value) {
  const out = new Set();
  for (const part of String(value ?? '').split(',')) {
    const address = normalizeProxyAddress(part);
    if (!address) continue;
    const ipv4 =
      /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address) &&
      address.split('.').every((octet) => Number(octet) <= 255);
    const ipv6 = /^[0-9a-f:]+$/.test(address) && address.includes(':');
    if (ipv4 || ipv6) out.add(address);
  }
  return out;
}

/**
 * Transport facts for the same-site gate. For an untrusted peer (or with the
 * setting unset) this is exactly what upstream computed: the socket protocol
 * and every request header as proxy-signal input. For a trusted proxy peer it
 * is the forwarded protocol and no proxy-signal input.
 * @param {import('node:http').IncomingMessage} req
 * @param {Record<string, string|undefined>} [env]
 * @returns {{protocol: 'http:'|'https:', proxyHeaders: Record<string, unknown>}}
 */
export function sameSiteTransport(req, env = process.env) {
  const socketProtocol = req?.socket?.encrypted ? 'https:' : 'http:';
  const legacy = { protocol: socketProtocol, proxyHeaders: req?.headers || {} };
  const trusted = parseTrustedProxies(env?.[TRUSTED_PROXIES_ENV]);
  if (!trusted.size) return legacy;
  const peer = normalizeProxyAddress(req?.socket?.remoteAddress);
  if (!peer || !trusted.has(peer)) return legacy;
  const forwarded = req?.headers?.['x-forwarded-proto'];
  if (forwarded === undefined)
    return { protocol: socketProtocol, proxyHeaders: {} };
  const proto = String(forwarded).trim().toLowerCase();
  if (proto !== 'http' && proto !== 'https') return legacy;
  return { protocol: `${proto}:`, proxyHeaders: {} };
}
