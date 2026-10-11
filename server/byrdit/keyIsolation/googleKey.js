import { randomBytes } from 'node:crypto';
import { sameSiteGated } from '../../providers/common/same-site.js';
import {
  makeRateLimiter,
  clientKey,
} from '../../providers/common/rate-limit.js';
import { encodeGoogleKey } from '../../../src/byrdit/googleKeyCodec.js';

/**
 * The browser-side Google Maps key, delivered at runtime and obfuscated.
 *
 * Google Photorealistic 3D Tiles are requested straight from tile.googleapis.com
 * by the browser, so the browser must hold GOOGLE_MAPS_API_KEY (restricted to
 * this site's HTTP referrer in the Google console). This route lets it get the
 * key at runtime instead of baking it into served JS/HTML: GET returns the key
 * XOR-masked and sharded (see src/byrdit/googleKeyCodec.js), keyed by a salt
 * generated at server start plus a fresh nonce per response. It is obfuscation,
 * not secrecy: the key still shows in tile request URLs in DevTools.
 *
 * Mounted behind the same reverse-proxy basic auth as the rest of the app,
 * same-site gated, rate limited, never cached, never logged.
 */

export const GOOGLE_KEY_PATH = '/api/google/tiles-key';
export const GOOGLE_KEY_MAX_PER_MIN = 60;

export function googleBrowserKey(env = process.env) {
  return String(env.GOOGLE_MAPS_API_KEY || '').trim();
}

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(payload));
}

/**
 * @param {{env?: object, salt?: Uint8Array, nonce?: () => Uint8Array,
 *   random?: () => number, allow?: Function}} [options]
 */
export function createGoogleKeyRouteHandler({
  env = process.env,
  salt = randomBytes(16),
  nonce = () => randomBytes(12),
  random = Math.random,
  allow = makeRateLimiter({
    windowMs: 60_000,
    max: GOOGLE_KEY_MAX_PER_MIN,
    globalMax: GOOGLE_KEY_MAX_PER_MIN * 4,
  }),
} = {}) {
  return function googleKeyRoute(req, res) {
    if (req.method !== 'GET')
      return send(res, 405, { error: 'Method not allowed' });
    const key = googleBrowserKey(env);
    if (!key) return send(res, 404, { configured: false });
    if (!allow(clientKey(req)))
      return send(res, 429, { error: 'Too many requests' });
    return send(
      res,
      200,
      encodeGoogleKey(key, { salt, nonce: nonce(), random }),
    );
  };
}

export const gatedGoogleKeyRoute = (options) =>
  sameSiteGated(createGoogleKeyRouteHandler(options));
