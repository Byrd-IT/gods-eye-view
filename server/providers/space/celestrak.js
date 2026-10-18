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
  // Halt-file writes in flight (the latch write and the evidence update).
  // While one runs, the file can briefly be empty or half-written, so the
  // admission check trusts the in-memory latch and does not read the disk.
  let haltWrites = 0;

  // --- Failure evidence (STANDARD R3/R8) ----------------------------------
  // The halt records WHAT CelesTrak answered so a human can tell a firewall
  // block from "data not updated" without asking CelesTrak again: request
  // URL, HTTP status, elapsed time and the first 300 bytes of the body with
  // markup and secret-looking values removed. A thrown request keeps only
  // its cause class/code, never its message (that can carry URLs or HTML).
  // Kept inside the plugin for the same reason as USER_AGENT above.
  /**
   * Log-safe upstream body snippet (b12, STANDARD R3). In order:
   * 1. the request's own secrets/inputs (`secrets`) are masked literally, in
   *    raw, JSON-escaped and URL-encoded form, wherever the upstream echoed them;
   * 2. markup is stripped, `\/` is unescaped, and URL userinfo, Bearer/Basic
   *    credentials, JSON / query / header style secret fields (key, token,
   *    secret, password, auth, credential, sig, session, cookie ...) in plain or
   *    escaped JSON, and well-known key shapes (sk-, AIza, ghp_, xox?-, JWT) are
   *    masked;
   * 3. whitespace is collapsed and the result is cut to at most `maxBytes`
   *    UTF-8 bytes without splitting a code point.
   * The same text is copied into every b12 provider file (there is no shared
   * runtime module); src/byrdit/providerErrorLogging.test.mjs checks that the
   * copies stay identical and attacks each one.
   */
  function redactSnippet(text, secrets = [], maxBytes = 300) {
    let s = String(text ?? '');
    for (const secret of secrets) {
      const raw = String(secret ?? '');
      if (raw.length < 4) continue;
      const forms = new Set([raw, JSON.stringify(raw).slice(1, -1)]);
      try {
        forms.add(encodeURIComponent(raw));
      } catch {
        /* lone surrogate: raw + JSON forms only */
      }
      for (const form of forms) s = s.split(form).join('REDACTED');
    }
    s = s
      .slice(0, 65536)
      .replace(/<[^>]*>/g, ' ')
      .replace(/\\+\//g, '/')
      .replace(
        /\b([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/?#@"'<>]*@/gi,
        '$1REDACTED@',
      )
      .replace(/\b(Bearer|Basic|Token)\s+[^\s"'\\,;]+/gi, '$1 REDACTED')
      .replace(
        /((?:\\*["'])?(?<![\w.-])[\w.-]{0,40}(?:key|token|secret|passw(?:or)?d|pwd|pass|auth|credential|signature|sig|session|cookie)[\w.-]{0,40}(?:\\*["'])?\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*"?|\\+"[\s\S]*?(?:\\+"(?=\s*[,}\]])|$)|'[^']*'?|[^\s,&;}\]"'<>]+)/gi,
        '$1REDACTED',
      )
      .replace(
        /\b(?:sk-[\w*.-]{4,}|AIza[\w-]{10,}|gh[pousr]_\w{10,}|xox[abprs]-[\w-]{10,}|eyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]*)/g,
        'REDACTED',
      )
      .replace(/\s+/g, ' ')
      .trim();
    const encoder = new TextEncoder();
    if (encoder.encode(s).length <= maxBytes) return s;
    let out = '';
    let bytes = 0;
    for (const ch of s) {
      const size = encoder.encode(ch).length;
      if (bytes + size > maxBytes) break;
      out += ch;
      bytes += size;
    }
    return out;
  }
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
   * One CelesTrak GET with timeout. Resolves to { body, evidence } for a 200.
   * Otherwise throws an Error whose message is `HTTP <n>` (non-200) or
   * 'upstream request failed' (thrown request / unreadable 200 body) and
   * whose `evidence` carries { url, status, elapsed_ms, body | error_class }.
   *
   * A non-200 LATCHES THE HALT AS SOON AS ITS HEADERS ARRIVE, before any of
   * its body is read (the old code threw on the status line; a stalled error
   * body must not keep the halt open and let another group's request out).
   * The bounded body evidence is collected afterwards and written into that
   * same latch (see enrichHalt); such errors carry `latched: true` so the
   * caller does not latch them a second time.
   */
  async function celestrakGet(url, timeoutMs, group) {
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
    if (!res.ok) {
      const err = Object.assign(new Error(`HTTP ${res.status}`), {
        latched: true,
        evidence: { url, status: res.status, elapsed_ms: elapsed() },
      });
      const latch = await haltOnFailure(group, err);
      const { text, note } = await readBodyEvidence(res);
      await enrichHalt(latch, {
        body: redactSnippet(text),
        ...(note ? { body_note: note } : {}),
      });
      throw err;
    }
    let body;
    try {
      body = await res.text();
    } catch (err) {
      throw Object.assign(new Error('upstream request failed'), {
        evidence: {
          url,
          status: res.status,
          elapsed_ms: elapsed(),
          timeout_ms: timeoutMs,
          error_class: `body read ${failureClass(err)}`,
        },
      });
    }
    return {
      body,
      evidence: { url, status: res.status, elapsed_ms: elapsed() },
    };
  }

  /** Longest wait for a refused response's body once the halt is latched (ms). */
  const BODY_EVIDENCE_MS = 5000;

  /**
   * What a refused response's body yields within BODY_EVIDENCE_MS (at most
   * ~4 KiB), then cancel it. Never throws: a read failure becomes `note`.
   */
  async function readBodyEvidence(res) {
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), BODY_EVIDENCE_MS);
      timer.unref?.();
    });
    let reader = null;
    let text = '';
    let note = '';
    try {
      reader = res.body?.getReader?.() || null;
      if (reader) {
        const decoder = new TextDecoder();
        while (text.length < 4096) {
          const step = await Promise.race([reader.read(), deadline]);
          if (step.timedOut) {
            note = `body read cut at ${BODY_EVIDENCE_MS} ms evidence deadline`;
            break;
          }
          if (step.done) break;
          text += decoder.decode(step.value, { stream: true });
        }
      } else {
        const step = await Promise.race([
          Promise.resolve(res.text()).then((t) => ({ t })),
          deadline,
        ]);
        if (step.timedOut)
          note = `body read cut at ${BODY_EVIDENCE_MS} ms evidence deadline`;
        else text = String(step.t ?? '');
      }
    } catch (err) {
      note = `body read ${failureClass(err)}`;
    } finally {
      clearTimeout(timer);
      reader?.cancel().catch(() => {});
    }
    return { text, note };
  }

  /** Log-safe errno-style code of an I/O error ('unknown' if none). */
  const ioCode = (error) =>
    typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(error.code)
      ? error.code
      : 'unknown';

  /** Evidence keys enrichment may add; the latch's own fields never change. */
  const EVIDENCE_KEYS = ['body', 'body_note'];

  /**
   * Add the body evidence to the latch `haltOnFailure` just made.
   *
   * - Never re-creates the file: it is opened 'r+', which fails if an
   *   operator already deleted it, and a write through that handle after a
   *   later delete lands on the unlinked inode, not on a new file.
   * - Rewrites only while the file still holds that same latch (halted, same
   *   `at`, `group` and `reason`); a newer or different latch is left alone.
   *   Only `body`/`body_note` are added: `halted/at/group/reason/clear` never
   *   change, so the S3 celestrak-latch-routine (event key host|kind|at|reason)
   *   sees the same event.
   * - Never empties the latch: the new text is written over the old one in
   *   place (no truncate-to-zero first) and the file is shortened only after
   *   that, to the new length, if it shrank. A failed or short write puts the
   *   original bytes back. While the update runs, `haltWrites` makes the
   *   admission check use the in-memory latch, so no request ever sees a
   *   half-written file. If even the restore fails, the latch is held in
   *   memory (`diskDamaged`) until an operator deletes the file.
   * - Logs what really happened, with the errno code of any I/O failure.
   *
   * `latch` is null when the halt was already latched before this request:
   * nothing to enrich.
   */
  async function enrichHalt(latch, rawFields) {
    if (!latch) return;
    const fields = {};
    for (const key of EVIDENCE_KEYS)
      if (rawFields[key] !== undefined) fields[key] = rawFields[key];
    const sameLatch = (h) =>
      h?.halted === true &&
      h.at === latch.at &&
      h.group === latch.group &&
      h.reason === latch.reason;
    if (sameLatch(haltState)) Object.assign(haltState, fields);
    let outcome;
    let handle;
    if (latch.persisted === false) {
      console.warn(
        `[celestrak-proxy] ${latch.group} halt evidence (${latch.reason}) status=${latch.status} ` +
          Object.entries(fields)
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(' ') +
          ' (halt file not updated: the latch write had failed, halted in memory only)',
      );
      return;
    }
    haltWrites += 1;
    try {
      let stage = 'open';
      try {
        handle = await fsp.open(HALT_FILE, 'r+');
        stage = 'read';
        const original = String(await handle.readFile('utf8'));
        let onDisk;
        try {
          onDisk = JSON.parse(original);
        } catch {
          onDisk = undefined;
        }
        if (onDisk === undefined) {
          outcome =
            'halt file not updated: it is not valid JSON; left unchanged';
        } else if (!sameLatch(onDisk)) {
          outcome =
            onDisk?.halted === true
              ? `halt file not updated: it now holds a different latch (group=${JSON.stringify(String(onDisk.group).slice(0, 40))} at=${Number(onDisk.at) || 'none'}); left unchanged`
              : 'halt file not updated: it no longer holds a halt; left unchanged';
        } else {
          const text = JSON.stringify({ ...onDisk, ...fields });
          const oldBytes = Buffer.byteLength(original, 'utf8');
          const newBytes = Buffer.byteLength(text, 'utf8');
          stage = 'write';
          try {
            const r = await handle.write(text, 0, 'utf8');
            if (
              typeof r?.bytesWritten === 'number' &&
              r.bytesWritten !== newBytes
            )
              throw Object.assign(new Error('short write'), {
                code: 'ESHORTWRITE',
              });
            if (newBytes < oldBytes) {
              stage = 'truncate';
              await handle.truncate(newBytes);
            }
            outcome = 'written';
            // Deleted by an operator after we opened it? Then the write went
            // to the unlinked inode: nothing was re-created; say so.
            const st = await handle.stat?.().catch(() => null);
            if (st && st.nlink === 0)
              outcome =
                'halt file not updated: removed by an operator during the update (not re-created)';
          } catch (err) {
            // Put the original latch back over whatever part was written.
            try {
              const r = await handle.write(original, 0, 'utf8');
              if (
                typeof r?.bytesWritten === 'number' &&
                r.bytesWritten !== oldBytes
              )
                throw Object.assign(new Error('short write'), {
                  code: 'ESHORTWRITE',
                });
              if (newBytes > oldBytes) await handle.truncate(oldBytes);
              outcome = `halt file not updated: ${stage} failed code=${ioCode(err)}; original latch restored`;
            } catch (restoreErr) {
              if (sameLatch(haltState)) haltState.diskDamaged = true;
              outcome =
                `halt file not updated: ${stage} failed code=${ioCode(err)}; restore failed code=${ioCode(restoreErr)}; ` +
                `file may be damaged, halt held in memory until an operator deletes ${HALT_FILE}`;
            }
          }
        }
      } catch (err) {
        outcome =
          stage === 'open' && err?.code === 'ENOENT'
            ? 'halt file not updated: removed by an operator before the evidence was added (not re-created)'
            : `halt file not updated: ${stage} failed code=${ioCode(err)}; existing latch left unchanged`;
      }
      if (handle) {
        try {
          await handle.close();
        } catch (err) {
          outcome += ` (close failed code=${ioCode(err)})`;
        }
      }
    } finally {
      haltWrites -= 1;
    }
    const detail = Object.entries(fields)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(' ');
    console.warn(
      `[celestrak-proxy] ${latch.group} halt evidence (${latch.reason}) status=${latch.status} ${detail}` +
        (outcome === 'written' ? '' : ` (${outcome})`),
    );
  }

  /**
   * Halt file on disk: { halt } when it holds a halt, { absent: true } when
   * there is no file (ENOENT), else { unreadable: code } (foreign content or
   * an I/O error). Foreign/unreadable content counts as not halted, as before.
   */
  async function readHalt() {
    let text;
    try {
      text = await fsp.readFile(HALT_FILE, 'utf8');
    } catch (err) {
      return err?.code === 'ENOENT'
        ? { absent: true }
        : { unreadable: ioCode(err) };
    }
    try {
      const parsed = JSON.parse(text);
      if (parsed && parsed.halted === true) return { halt: parsed };
    } catch {
      /* not JSON */
    }
    return { unreadable: 'content' };
  }

  /**
   * True if upstream calls are forbidden. The in-memory latch is cleared only
   * when the file is gone, i.e. a human removed it. While this process is
   * writing the halt file, the in-memory latch decides (the file may be
   * mid-write). If an evidence update damaged the file and could not restore
   * it, the latch also stays in memory until the file is deleted.
   */
  async function isHalted() {
    if (haltWrites > 0 && haltState) return true;
    const onDisk = await readHalt();
    if (onDisk.halt) {
      haltState = onDisk.halt;
      return true;
    }
    if (haltState?.diskDamaged && !onDisk.absent) {
      if (!haltState.damageLogged) {
        haltState.damageLogged = true;
        console.warn(
          `[celestrak-proxy] halt file unreadable (${onDisk.unreadable}) after a failed evidence update — ` +
            `still HALTED in memory; delete ${HALT_FILE} to re-enable upstream`,
        );
      }
      return true;
    }
    if (haltState) {
      // Same policy as before (an unreadable file does not hold the halt);
      // the log now says which case it was instead of always "removed".
      if (onDisk.absent)
        console.info(
          '[celestrak-proxy] halt file removed by operator — upstream re-enabled',
        );
      else
        console.warn(
          `[celestrak-proxy] halt file unreadable (${onDisk.unreadable}) — treated as cleared, upstream re-enabled`,
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
    const latched = {
      halted: true,
      at: Date.now(),
      group,
      reason,
      ...evidence,
      clear: `check https://celestrak.org, then delete ${HALT_FILE}`,
    };
    haltState = latched;
    if (already) return null;
    const detail = Object.entries(evidence)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v) : v}`)
      .join(' ');
    console.warn(
      `[celestrak-proxy] ${group} refresh failed (${reason})${detail ? ` ${detail}` : ''}` +
        (err?.latched ? ' body=(follows in a halt evidence line)' : '') +
        ` — ALL CelesTrak requests HALTED ` +
        `until an operator deletes ${HALT_FILE}; serving cache if any`,
    );
    haltWrites += 1;
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(HALT_FILE, JSON.stringify(latched), 'utf8');
    } catch (err) {
      latched.persisted = false;
      console.warn(
        `[celestrak-proxy] halt file write failed code=${ioCode(err)} — halted in memory only`,
      );
    } finally {
      haltWrites -= 1;
    }
    return latched;
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
      group,
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
      'satcat',
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
            // A refusal latched at its headers inside celestrakGet already.
            if (!err?.latched) await haltOnFailure('satcat', err);
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
                // A refusal latched at its headers inside celestrakGet already.
                if (!err?.latched) await haltOnFailure(group, err);
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
