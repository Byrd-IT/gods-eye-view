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

  // --- Halt latch (Byrd-IT; replaces the 2026-09-07 backoff breaker) ------
  // CelesTrak's usage policy (https://celestrak.org/usage-policy.php) and Dr.
  // Kelso's 2026-09-30 email: on ANY non-200 response, stop querying and
  // report to a human. A timed backoff still retries on its own, and since
  // their 2026-09 firewall overhaul an automatic retry during their outage
  // can get the egress IP firewalled within seconds.
  //
  // So the first failed refresh LATCHES a halt that covers every group (the
  // firewall is per-IP, not per-group). While halted we never contact
  // CelesTrak; cached data is still served. The halt survives restarts via
  // HALT_FILE and is only cleared by a human deleting that file after
  // checking https://celestrak.org. S4 cron `celestrak-halt-check` pages
  // Telegram while the file exists.
  const HALT_FILE = path.join(CACHE_DIR, 'celestrak-HALT.json');
  /** @type {{at: number, group: string, reason: string} | null} */
  let haltState = null;

  /** Halt marker on disk, or null. Unreadable/foreign content = not halted. */
  async function readHalt() {
    try {
      const parsed = JSON.parse(await fsp.readFile(HALT_FILE, 'utf8'));
      if (parsed && parsed.halted === true) return parsed;
    } catch {
      /* no halt file */
    }
    return null;
  }

  /**
   * True if upstream calls are forbidden. The in-memory latch is cleared only
   * when the file is gone, i.e. a human removed it.
   */
  async function isHalted() {
    const onDisk = await readHalt();
    if (onDisk) {
      haltState = onDisk;
      return true;
    }
    if (haltState) {
      console.info(
        '[celestrak-proxy] halt file removed by operator — upstream re-enabled',
      );
      haltState = null;
    }
    return false;
  }

  /** Latches the halt after a failed refresh and logs it once. */
  async function haltOnFailure(group, err) {
    // Upstream error text can contain request URLs, tokens, or an HTML body.
    // Keep only the safe HTTP status; everything else collapses to a label.
    const message = String(err?.message || err);
    const reason = /^HTTP \d+$/.test(message)
      ? message
      : 'upstream request failed';
    const already = haltState;
    haltState = { halted: true, at: Date.now(), group, reason };
    if (already) return;
    console.warn(
      `[celestrak-proxy] ${group} refresh failed (${reason}) — ALL CelesTrak requests HALTED ` +
        `until an operator deletes ${HALT_FILE}; serving cache if any`,
    );
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(HALT_FILE, JSON.stringify(haltState), 'utf8');
    } catch {
      console.warn(
        '[celestrak-proxy] halt file write failed — halted in memory only',
      );
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
          // An out-of-process writer (e.g. a manual cache refresh) may
          // have refreshed this group's cache file since we last read it.
          // Without this check the in-memory copy shadows disk until a
          // restart, so relay updates would appear to do nothing.
          const fromDisk = await readDisk(group);
          if (fromDisk && fromDisk.at > entry.at) {
            entry = fromDisk;
            mem.set(group, fromDisk);
          }
        }
        if (entry && now - entry.at < TLE_TTL_MS) {
          send(200, entry.body, 'HIT');
          return;
        }
        // Stale or missing → refresh, single-flight per group.
        // Halted (a previous refresh failed): do NOT contact CelesTrak until a
        // human clears the halt. Serve whatever we have.
        if (await isHalted()) {
          if (entry) {
            send(200, entry.body, 'STALE-HALTED');
          } else {
            send(
              503,
              'celestrak requests halted after an upstream error; operator must clear it',
              'HALTED',
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
                return fresh;
              })
              .catch(async (err) => {
                await haltOnFailure(group, err);
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
