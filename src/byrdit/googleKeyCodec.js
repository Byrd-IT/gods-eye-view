/**
 * Obfuscated transport for the browser-side Google Maps key.
 *
 * THIS IS OBFUSCATION, NOT SECRECY. Google Photorealistic 3D Tiles are fetched
 * by the browser, so the key necessarily appears in tile.googleapis.com request
 * URLs (DevTools > Network). What this codec buys is that the key is never a
 * literal in any served JS/HTML/JSON file and never sits in a window global:
 * a `grep` of the bundle or a casual "view source" finds nothing. The real
 * protection is Google-side: HTTP-referrer restriction, an API restriction to
 * Map Tiles API (+ Geocoding API) and a daily quota cap.
 *
 * Wire format (JSON), produced per request by encodeGoogleKey and consumed by
 * decodeGoogleKey:
 *   { v: 1, s: <per-boot salt b64>, n: <per-response nonce b64>, c: <shard count>,
 *     p: [ { i: <shard index>, d: <b64 of masked bytes> }, ... shuffled ] }
 * The UTF-8 key bytes are XOR-masked with a stream derived from salt + nonce,
 * split into 3-5 shards and shuffled. Pure functions; no I/O; no logging.
 */

const VERSION = 1;
const MIN_SHARDS = 3;
const MAX_SHARDS = 5;

const toBase64 = (bytes) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const fromBase64 = (text) => {
  const binary = atob(String(text));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

/** Mask byte for position i, derived from the per-boot salt and the nonce. */
function maskByte(salt, nonce, i) {
  return (
    salt[i % salt.length] ^
    nonce[(i * 7 + 3) % nonce.length] ^
    ((i * 31 + salt[(i * 5) % salt.length]) & 0xff)
  );
}

/**
 * @param {string} key
 * @param {{salt: Uint8Array, nonce: Uint8Array, random?: () => number}} options
 *   salt: per-boot random bytes; nonce: per-response random bytes;
 *   random: [0,1) source for shard sizes/order (Math.random when omitted).
 */
export function encodeGoogleKey(
  key,
  { salt, nonce, random = Math.random } = {},
) {
  const text = String(key ?? '');
  if (!text) throw new Error('No key to encode');
  if (!salt?.length || !nonce?.length)
    throw new Error('A salt and a nonce are required');
  const bytes = new TextEncoder().encode(text);
  const masked = bytes.map((byte, i) => byte ^ maskByte(salt, nonce, i));
  const shardCount = Math.min(
    MIN_SHARDS + Math.floor(random() * (MAX_SHARDS - MIN_SHARDS + 1)),
    masked.length,
  );
  // Random cut points: shardCount - 1 distinct positions inside the key.
  const cuts = new Set();
  while (cuts.size < shardCount - 1)
    cuts.add(1 + Math.floor(random() * (masked.length - 1)));
  const bounds = [0, ...[...cuts].sort((a, b) => a - b), masked.length];
  const shards = [];
  for (let i = 0; i < bounds.length - 1; i += 1)
    shards.push({ i, d: toBase64(masked.slice(bounds[i], bounds[i + 1])) });
  // Fisher-Yates shuffle so wire order does not reveal the key order.
  for (let i = shards.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [shards[i], shards[j]] = [shards[j], shards[i]];
  }
  return {
    v: VERSION,
    s: toBase64(salt),
    n: toBase64(nonce),
    c: shards.length,
    p: shards,
  };
}

/**
 * Rebuild the key in memory. Returns '' for any malformed payload (the caller
 * treats that as "no Google key"); never throws.
 * @param {unknown} payload
 * @returns {string}
 */
export function decodeGoogleKey(payload) {
  try {
    if (!payload || payload.v !== VERSION || !Array.isArray(payload.p))
      return '';
    const salt = fromBase64(payload.s);
    const nonce = fromBase64(payload.n);
    if (!salt.length || !nonce.length) return '';
    const ordered = [...payload.p].sort((a, b) => a.i - b.i);
    // A dropped shard (including the last one) must not decode to a truncated key.
    if (ordered.length !== payload.c) return '';
    if (ordered.some((shard, index) => shard.i !== index)) return '';
    const parts = ordered.map((shard) => fromBase64(shard.d));
    const masked = new Uint8Array(
      parts.reduce((n, part) => n + part.length, 0),
    );
    let offset = 0;
    for (const part of parts) {
      masked.set(part, offset);
      offset += part.length;
    }
    const bytes = masked.map((byte, i) => byte ^ maskByte(salt, nonce, i));
    const key = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return /^[\x21-\x7e]{8,256}$/.test(key) ? key : '';
  } catch {
    return '';
  }
}
