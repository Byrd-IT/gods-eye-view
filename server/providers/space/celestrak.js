import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { celestrakTleUrl } from '../../../src/data/spaceProviderRequests.js';

/**
 * Vite plugin: CelesTrak TLE proxy.
 *
 * CelesTrak does not send CORS headers, so this middleware fetches
 * satellite TLE data server-side and forwards it to the browser.
 * Upstream URL: https://celestrak.org/NORAD/elements/gp.php
 *
 * @returns {import('vite').Plugin}
 */
/**
 * CelesTrak GP/TLE proxy with a memory + disk cache.
 * Upstream: https://celestrak.org/NORAD/elements/gp.php?GROUP=<group>&FORMAT=tle
 * CelesTrak asks clients not to re-fetch GP data more than ~every 2 h and
 * throttles offenders; every dev reload used to refetch every group. Cache TTL
 * 6 h; on upstream failure the freshest stale copy is served (a stale TLE
 * beats an empty satellites layer). Pattern mirrors openSkyProxy's
 * cache+serve-stale. Adapted from skylight's TleStore (MIT).
 */
export function celestrakProxy() {
  const TLE_TTL_MS = 6 * 3600_000;
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache');
  const mem = new Map(); // group -> { at: epochMs, body: string }
  const inflight = new Map(); // group -> Promise<{at, body}|null>

  // --- Circuit breaker (added 2026-09-07, Byrd-IT) --------------------------
  // CelesTrak's usage policy (https://celestrak.org/usage-policy.php) requires
  // M2M clients to STOP querying on any non-200 response and surface it to a
  // human; repeatedly retrying through errors gets the source IP firewalled.
  // Previously every failure only logged a warning and cleared the in-flight
  // lock, so the very next page load retried all groups — a retry storm that
  // got our egress IP blackholed. The breaker below opens on failure and
  // suppresses upstream calls for a backoff window; stale cache is still
  // served, so the satellites layer degrades rather than disappearing.
  /** Backoff after the first failure — matches CelesTrak's 2 h update cadence. */
  const BREAKER_BASE_MS = 2 * 3600_000;
  /** Ceiling on the exponential backoff. */
  const BREAKER_MAX_MS = 24 * 3600_000;
  /** A non-200 HTTP status is an explicit "back off" signal — start harder. */
  const BREAKER_HTTP_ERROR_MULTIPLIER = 2;
  /** @type {Map<string, {failures: number, openUntil: number, reason: string}>} */
  const breaker = new Map();

  /** True while the breaker is open for `group` (upstream calls suppressed). */
  function breakerOpen(group) {
    const b = breaker.get(group);
    return !!b && Date.now() < b.openUntil;
  }

  /** Opens/extends the breaker for `group` after a failed refresh. */
  function breakerTrip(group, err) {
    const prev = breaker.get(group);
    const failures = (prev?.failures || 0) + 1;
    // `HTTP <status>` failures are an explicit upstream refusal, not a blip.
    const isHttpError = /^HTTP \d+/.test(String(err?.message || err));
    const scale = isHttpError ? BREAKER_HTTP_ERROR_MULTIPLIER : 1;
    const backoff = Math.min(
      BREAKER_MAX_MS,
      BREAKER_BASE_MS * scale * 2 ** (failures - 1),
    );
    const reason = String(err?.message || err);
    breaker.set(group, { failures, openUntil: Date.now() + backoff, reason });
    // Log ONLY on the trip, not on every suppressed request — the old code
    // logged per request and buried the signal under thousands of lines.
    console.warn(
      `[celestrak-proxy] ${group} refresh failed (${reason}) — breaker OPEN for ` +
        `${Math.round(backoff / 60_000)} min (failure #${failures}); serving cache if any`,
    );
  }

  /** Clears the breaker for `group` after a successful refresh. */
  function breakerReset(group) {
    if (breaker.has(group)) {
      console.info(
        `[celestrak-proxy] ${group} refresh recovered — breaker closed`,
      );
      breaker.delete(group);
    }
  }

  /** True if `body` is GP CSV (not a legacy TLE cache written before the migration). */
  const isGpCsv = (body) => /^OBJECT_NAME,OBJECT_ID,EPOCH,/m.test(body);

  const diskPath = (group) => path.join(CACHE_DIR, `celestrak-${group}.json`);

  async function readDisk(group) {
    try {
      const parsed = JSON.parse(await fsp.readFile(diskPath(group), 'utf8'));
      if (typeof parsed?.body === 'string' && Number.isFinite(parsed?.at)) {
        // Disk caches written before the TLE->CSV migration hold TLE text,
        // which the CSV parser silently reads as zero satellites. While
        // upstream is unreachable these stale entries would be served
        // forever, so an empty layer would look permanent. Discard them: no
        // cache beats bad cache.
        if (!isGpCsv(parsed.body)) {
          console.warn(
            `[celestrak-proxy] ${group} disk cache is legacy TLE — discarding (pre-CSV-migration)`,
          );
          return null;
        }
        return parsed;
      }
    } catch {
      /* no disk cache yet */
    }
    return null;
  }

  async function writeDisk(group, entry) {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(diskPath(group), JSON.stringify(entry), 'utf8');
    } catch (err) {
      console.warn('[celestrak-proxy] cache write failed');
    }
  }

  async function fetchUpstream(group) {
    const url = celestrakTleUrl(group);
    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(20000),
      // CelesTrak 403s bulk groups (e.g. `active`) unless the request carries a
      // descriptive User-Agent with a contact point.
      headers: {
        'User-Agent':
          'gods-eye-view-celestrak-proxy/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    // An upstream error page parses to zero CSV rows — treat as failure, keep
    // cache. Validate against the GP CSV header CelesTrak sends.
    if (!isGpCsv(body)) throw new Error('no GP CSV rows in response');
    return { at: Date.now(), body };
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/celestrak', async (req, res) => {
      const group = String(req.url || '')
        .replace(/^\//, '')
        .split('?')[0];
      if (!/^[a-z0-9-]+$/i.test(group)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('invalid group');
        return;
      }
      const send = (status, body, cacheStatus) => {
        // Guard against a double-send (e.g. a throw AFTER a response already
        // went out routing into the catch's send): writeHead after headersSent
        // throws "Cannot set headers after they are sent".
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'text/plain',
          'x-tle-cache': cacheStatus,
        });
        res.end(body);
      };
      try {
        const now = Date.now();
        let entry = mem.get(group);
        if (!entry) {
          entry = await readDisk(group);
          if (entry) mem.set(group, entry);
        } else if (now - entry.at >= TLE_TTL_MS) {
          // An out-of-process writer (the Byrd-IT caching relay on S3) may
          // have refreshed this group's cache file since we last read it.
          // Without this check the in-memory copy shadows disk until a
          // restart, so relay updates would appear to do nothing while the
          // breaker kept reporting failures.
          const fromDisk = await readDisk(group);
          if (fromDisk && fromDisk.at > entry.at) {
            entry = fromDisk;
            mem.set(group, fromDisk);
            breakerReset(group);
          }
        }
        if (entry && now - entry.at < TLE_TTL_MS) {
          send(200, entry.body, 'HIT');
          return;
        }
        // Stale or missing → refresh, single-flight per group.
        // Breaker open (recent upstream failure): do NOT contact CelesTrak.
        // Serve whatever we have and let the backoff window expire first.
        if (breakerOpen(group)) {
          if (entry) {
            send(200, entry.body, 'STALE-BREAKER');
          } else {
            send(
              503,
              'celestrak upstream failing; backing off per usage policy',
              'BREAKER',
            );
          }
          return;
        }
        if (!inflight.has(group)) {
          inflight.set(
            group,
            fetchUpstream(group)
              .then(async (fresh) => {
                mem.set(group, fresh);
                await writeDisk(group, fresh);
                breakerReset(group);
                return fresh;
              })
              .catch((err) => {
                breakerTrip(group, err);
                return null;
              })
              .finally(() => inflight.delete(group)),
          );
        }
        const fresh = await inflight.get(group);
        if (fresh) {
          send(200, fresh.body, 'MISS');
        } else if (entry) {
          send(200, entry.body, 'STALE-ERROR'); // upstream down — stale beats empty
        } else {
          send(502, 'celestrak fetch failed and no cache available', 'NONE');
        }
      } catch (err) {
        console.error('[celestrak-proxy] request failed');
        send(500, 'celestrak proxy error', 'ERROR');
      }
    });
  };
  return {
    name: 'celestrak-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
