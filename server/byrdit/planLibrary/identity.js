// Byrd-IT: who is asking the plan library?
//
// The ONLY identity source is the X-GEV-User header that Nginx Proxy Manager
// (S2/S3) sets from the basic-auth login. S4 port 4173 is reachable on the LAN,
// so the header counts only when the TCP peer (req.socket.remoteAddress) is in
// GEV_TRUSTED_PROXIES (server/byrdit/trustedProxy.js: the one copy of that
// rule). From any other peer the header is ignored and there is no library.
//
// A malformed name is REFUSED (no identity), never repaired: repairing
// "byrdit/../x" into something path-safe would map two different people onto
// one folder. The name is lower-cased: NPM logins are case-insensitive to us,
// and a case-insensitive file system must not merge or split folders.

import { isTrustedProxyPeer } from '../trustedProxy.js';

/** The header NPM sets. Node lower-cases incoming header names. */
export const USER_HEADER = 'x-gev-user';
/** Environment variable naming the read-only admin. */
export const ADMIN_ENV = 'GEV_ADMIN_USER';
export const DEFAULT_ADMIN = 'byrdit';
const USER_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * A safe user name, or null.
 * @param {unknown} raw
 * @returns {string|null}
 */
export function cleanUserName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().toLowerCase();
  return USER_NAME.test(name) ? name : null;
}

/** The admin's user name (env, default byrdit). */
export function adminName(env = process.env) {
  return cleanUserName(env?.[ADMIN_ENV]) ?? DEFAULT_ADMIN;
}

/**
 * The library identity of a request, or null when there is none.
 * @param {import('node:http').IncomingMessage} req
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ user: string, admin: boolean } | null}
 */
export function libraryIdentity(req, env = process.env) {
  if (!isTrustedProxyPeer(req, env)) return null;
  const header = req?.headers?.[USER_HEADER];
  // A duplicated header arrives as one comma-joined string (or an array for
  // some names): neither is a single login name.
  const user = cleanUserName(header);
  if (!user) return null;
  return { user, admin: user === adminName(env) };
}
