import path from 'node:path';
import { promises as fsp } from 'node:fs';
import {
  celestrakSatcatUrl,
  celestrakTleUrl,
} from '../../../src/data/spaceProviderRequests.js';

/** SATCAT RCS cache lifetime (SKYVIEW.md 4.4: one polite fetch per week). */
export const RCS_TTL_MS = 7 * 24 * 3600_000;

/** RFC 4180 CSV text -> rows of fields (quotes, doubled quotes, CRLF). */
export function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

const SATCAT_HEADER = /^OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,/;

/**
 * CelesTrak SATCAT CSV -> { rows, withRcs, rcs: { noradId: rcsM2 } } with
 * only the objects that HAVE a positive RCS (SATCAT leaves it empty for most
 * new objects; the client treats a missing id as "no estimate"). Returns null
 * when the text is not SATCAT CSV (an error page, an HTML body, ...).
 */
export function parseSatcatRcs(text) {
  if (typeof text !== 'string' || !SATCAT_HEADER.test(text)) return null;
  const rows = parseCsvRows(text);
  const header = rows.shift() || [];
  const idCol = header.indexOf('NORAD_CAT_ID');
  const rcsCol = header.indexOf('RCS');
  if (idCol < 0 || rcsCol < 0) return null;
  const rcs = {};
  let count = 0;
  let withRcs = 0;
  for (const r of rows) {
    if (r.length !== header.length) continue;
    const id = Number(r[idCol]);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    count += 1;
    const raw = r[rcsCol].trim();
    const value = raw === '' ? NaN : Number(raw);
    if (Number.isFinite(value) && value > 0) {
      rcs[id] = value;
      withRcs += 1;
    }
  }
  return count ? { rows: count, withRcs, rcs } : null;
}

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
  // Kept inside the plugin: src/proxyErrorResponses.test.mjs evaluates this
  // function body on its own.
  const USER_AGENT =
    'gods-eye-view-celestrak-proxy/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)';
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

  // --- Failure evidence (STANDARD R3/R8) ----------------------------------
  // The halt records WHAT CelesTrak answered so a human can tell a firewall
  // block from "data not updated" without asking CelesTrak again: request
  // URL, HTTP status, elapsed time and the first 300 bytes of the body with
  // markup and secret-looking values removed. A thrown request keeps only
  // its cause class/code, never its message (that can carry URLs or HTML).
  // Kept inside the plugin for the same reason as USER_AGENT above.
  const redactSnippet = (text, max = 300) =>
    String(text ?? '')
      .slice(0, 4096)
      .replace(/<[^>]*>/g, ' ')
      .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, '$1 REDACTED')
      .replace(
        /([?&](?:key|api_?key|token|access_token|secret|password|sig|signature)=)[^&\s"']*/gi,
        '$1REDACTED',
      )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max);
  const failureClass = (error) => {
    // String codes only: DOMException carries a numeric legacy `code`.
    const code =
      [error?.cause?.code, error?.code].find((c) => typeof c === 'string') ||
      '';
    if (
      error?.name === 'TimeoutError' ||
      code === 'UND_ERR_CONNECT_TIMEOUT' ||
      code === 'UND_ERR_HEADERS_TIMEOUT' ||
      code === 'ETIMEDOUT'
    )
      return code ? `timeout code=${code}` : 'timeout';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `dns code=${code}`;
    if (/^[A-Z][A-Z0-9_]{2,40}$/.test(code)) return `network code=${code}`;
    return /^[A-Za-z]{1,40}$/.test(String(error?.name)) ? error.name : 'error';
  };

  /**
   * One CelesTrak GET with timeout. Resolves to the body text of a 200;
   * otherwise throws an Error whose message is `HTTP <n>` (non-200) or
   * 'upstream request failed' (thrown request) and whose `evidence` carries
   * { url, status, elapsed_ms, body | error_class }.
   */
  async function celestrakGet(url, timeoutMs) {
    const startedAt = performance.now();
    const elapsed = () => Math.round(performance.now() - startedAt);
    let res;
    try {
      res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        // CelesTrak 403s bulk groups (e.g. `active`) unless the request
        // carries a descriptive User-Agent with a contact point.
        headers: { 'User-Agent': USER_AGENT },
      });
    } catch (err) {
      throw Object.assign(new Error('upstream request failed'), {
        evidence: {
          url,
          status: null,
          elapsed_ms: elapsed(),
          timeout_ms: timeoutMs,
          error_class: failureClass(err),
        },
      });
    }
    let body;
    try {
      body = await res.text();
    } catch (err) {
      throw Object.assign(
        new Error(res.ok ? 'upstream request failed' : `HTTP ${res.status}`),
        {
          evidence: {
            url,
            status: res.status,
            elapsed_ms: elapsed(),
            timeout_ms: timeoutMs,
            error_class: `body read ${failureClass(err)}`,
          },
        },
      );
    }
    if (!res.ok)
      throw Object.assign(new Error(`HTTP ${res.status}`), {
        evidence: {
          url,
          status: res.status,
          elapsed_ms: elapsed(),
          body: redactSnippet(body),
        },
      });
    return {
      body,
      evidence: { url, status: res.status, elapsed_ms: elapsed() },
    };
  }

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
    // `reason` stays the short label the halt-check pager and the tests
    // read: `HTTP <n>` or 'upstream request failed'. The evidence fields
    // (url, status, elapsed_ms, body | error_class) were built by
    // celestrakGet from the response itself, already redacted; a raw error
    // message is never stored or logged.
    const message = String(err?.message || err);
    const reason = /^HTTP \d+$/.test(message)
      ? message
      : 'upstream request failed';
    const ev = err && typeof err.evidence === 'object' ? err.evidence : {};
    const evidence = {};
    for (const key of [
      'url',
      'status',
      'elapsed_ms',
      'timeout_ms',
      'body',
      'error_class',
    ])
      if (ev[key] !== undefined) evidence[key] = ev[key];
    const already = haltState;
    haltState = {
      halted: true,
      at: Date.now(),
      group,
      reason,
      ...evidence,
      clear: `check https://celestrak.org, then delete ${HALT_FILE}`,
    };
    if (already) return;
    const detail = Object.entries(evidence)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v) : v}`)
      .join(' ');
    console.warn(
      `[celestrak-proxy] ${group} refresh failed (${reason})${detail ? ` ${detail}` : ''} — ALL CelesTrak requests HALTED ` +
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
    const { body, evidence } = await celestrakGet(
      celestrakTleUrl(group).toString(),
      20000,
    );
    // An upstream error page parses to zero CSV rows — treat as failure, keep
    // cache. Validate against the GP CSV header CelesTrak sends. The 200
    // body is the evidence ("data not updated" text vs an HTML block page).
    if (!isGpCsv(body))
      throw Object.assign(new Error('no GP CSV rows in response'), {
        evidence: {
          ...evidence,
          error_class: 'malformed (no GP CSV header)',
          body: redactSnippet(body),
        },
      });
    return { at: Date.now(), body };
  }

  // --- SATCAT radar cross-sections (Byrd-IT, Sky view P2b) ----------------
  // Same rules as the GP groups: fetched on demand only, cached on disk,
  // single-flight, and behind the SAME halt latch (any failure halts every
  // CelesTrak request, GP included; while halted nothing is fetched). Cached
  // for RCS_TTL_MS (7 days): one ~1.5 MB request per week at most. Served as
  // compact JSON { fetchedAt, rows, withRcs, rcs: { noradId: rcsM2 } }.
  const RCS_FILE = path.join(CACHE_DIR, 'celestrak-satcat-rcs.json');
  let rcsMem = null; // { at, rows, withRcs, rcs }
  let rcsInflight = null;

  async function readRcsDisk() {
    try {
      const parsed = JSON.parse(await fsp.readFile(RCS_FILE, 'utf8'));
      if (
        Number.isFinite(parsed?.at) &&
        parsed.rcs &&
        typeof parsed.rcs === 'object'
      )
        return parsed;
    } catch {
      /* no RCS cache yet */
    }
    return null;
  }

  async function fetchRcsUpstream() {
    const { body, evidence } = await celestrakGet(
      celestrakSatcatUrl().toString(),
      60000,
    );
    const parsed = parseSatcatRcs(body);
    if (!parsed)
      throw Object.assign(new Error('no SATCAT CSV rows in response'), {
        evidence: {
          ...evidence,
          error_class: 'malformed (no SATCAT CSV header)',
          body: redactSnippet(body),
        },
      });
    return { at: Date.now(), ...parsed };
  }

  const rcsPayload = (entry) =>
    JSON.stringify({
      fetchedAt: entry.at,
      source: 'celestrak satcat GROUP=ACTIVE',
      rows: entry.rows ?? null,
      withRcs: entry.withRcs ?? Object.keys(entry.rcs).length,
      rcs: entry.rcs,
    });

  async function handleRcs(req, res) {
    const send = (status, body, cacheStatus) => {
      if (res.headersSent) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'x-rcs-cache': cacheStatus,
      });
      res.end(body);
    };
    const rest = String(req.url || '').split('?')[0];
    if (rest !== '' && rest !== '/') {
      send(404, JSON.stringify({ error: 'unknown rcs path' }), 'NONE');
      return;
    }
    try {
      const now = Date.now();
      let entry = rcsMem;
      if (!entry || now - entry.at >= RCS_TTL_MS) {
        const fromDisk = await readRcsDisk();
        if (fromDisk && (!entry || fromDisk.at > entry.at)) entry = fromDisk;
        rcsMem = entry;
      }
      if (entry && now - entry.at < RCS_TTL_MS) {
        send(200, rcsPayload(entry), 'HIT');
        return;
      }
      if (await isHalted()) {
        if (entry) send(200, rcsPayload(entry), 'STALE-HALTED');
        else
          send(
            503,
            JSON.stringify({
              error:
                'celestrak requests halted after an upstream error; operator must clear it',
            }),
            'HALTED',
          );
        return;
      }
      if (!rcsInflight) {
        rcsInflight = fetchRcsUpstream()
          .then(async (fresh) => {
            rcsMem = fresh;
            try {
              await fsp.mkdir(CACHE_DIR, { recursive: true });
              await fsp.writeFile(RCS_FILE, JSON.stringify(fresh), 'utf8');
            } catch {
              console.warn('[celestrak-proxy] rcs cache write failed');
            }
            return fresh;
          })
          .catch(async (err) => {
            await haltOnFailure('satcat', err);
            return null;
          })
          .finally(() => {
            rcsInflight = null;
          });
      }
      const fresh = await rcsInflight;
      if (fresh) send(200, rcsPayload(fresh), 'MISS');
      else if (entry) send(200, rcsPayload(entry), 'STALE-ERROR');
      else
        send(
          502,
          JSON.stringify({
            error: 'satcat fetch failed and no cache available',
          }),
          'NONE',
        );
    } catch {
      console.error('[celestrak-proxy] rcs request failed');
      send(
        500,
        JSON.stringify({ error: 'celestrak rcs proxy error' }),
        'ERROR',
      );
    }
  }

  const installMiddleware = (server) => {
    // Registered before /api/celestrak (connect would not route
    // "/api/celestrak-rcs" there anyway: the next character is not "/").
    server.middlewares.use('/api/celestrak-rcs', handleRcs);
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
