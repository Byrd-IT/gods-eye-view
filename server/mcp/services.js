/**
 * Local composition of tool services: Core's default services, pointed at a
 * running God's Eye View server's `/api` routes.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createToolServices } from '../../src/tools/services.js';

// Bundled data some sources read by module-relative URL.
const BUNDLED_DATA = new URL('../../src/data/local_data/', import.meta.url);

export const DEFAULT_API_BASE = 'http://localhost:4173';

/**
 * Backstop for one local `/api` request a tool makes (ms). It only has to
 * catch a hung local server: it sits above the slowest server-side upstream
 * chain a route can legitimately take (Overpass tries each configured
 * endpoint for up to 22 s; other providers cap at 10-60 s), so a slow but
 * valid answer is never cut off here.
 */
export const API_FETCH_TIMEOUT_MS = 120_000;

// Failure logs go to stderr: under `npm run mcp` stdout carries the MCP
// protocol, so a console.log here would corrupt the stdio stream.
const LOG = '[mcp-services]';

/** URL for a log line: no credentials, secret-looking query values masked. */
function redactUrl(value) {
  try {
    const url = new URL(String(value));
    url.username = '';
    url.password = '';
    for (const name of [...url.searchParams.keys()])
      if (/key|token|secret|pass|auth|sig/i.test(name))
        url.searchParams.set(name, 'REDACTED');
    return url.href;
  } catch {
    return '(unparseable url)';
  }
}

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
    .replace(/\b([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/?#@"'<>]*@/gi, '$1REDACTED@')
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

/** Cause class of a thrown fetch/read error: never its message (it can carry URLs). */
function failureClass(error) {
  // String codes only: DOMException carries a numeric legacy `code`.
  const code =
    [error?.cause?.code, error?.code].find((c) => typeof c === 'string') || '';
  if (
    error?.name === 'TimeoutError' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'ETIMEDOUT'
  )
    return { cls: 'timeout', code };
  if (error?.name === 'AbortError') return { cls: 'aborted', code };
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { cls: 'dns', code };
  if (error instanceof SyntaxError) return { cls: 'malformed', code };
  if (code) return { cls: 'network', code };
  return { cls: error?.name || 'error', code };
}

/** Longest wait for a failing body's bytes before the log line is written (ms). */
const BODY_PEEK_MS = 1000;

/**
 * Read at most ~4 KiB of a cloned error body for the log without consuming
 * the original, waiting at most `ms`: a stalled body never holds the
 * caller's response back longer than that.
 */
async function peekBody(response, ms = BODY_PEEK_MS) {
  let reader;
  let timer;
  try {
    reader = response.clone().body?.getReader();
    if (!reader) return '';
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), ms);
      timer.unref?.();
    });
    const decoder = new TextDecoder();
    let text = '';
    while (text.length < 4096) {
      const { done, value, timedOut } = await Promise.race([
        reader.read(),
        deadline,
      ]);
      if (timedOut) {
        text += text
          ? ' [body read cut at peek deadline]'
          : '[no body bytes before peek deadline]';
        break;
      }
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text;
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
    reader?.cancel().catch(() => {});
  }
}

/**
 * The credentials this request itself carries (URL userinfo, secret-named
 * query values, credential headers), so an upstream that echoes one back
 * cannot get it into a log line.
 */
function requestSecrets(target, init) {
  const secrets = [];
  try {
    const url = new URL(
      String(target instanceof Request ? target.url : target),
    );
    if (url.username) secrets.push(decodeURIComponent(url.username));
    if (url.password) secrets.push(decodeURIComponent(url.password));
    for (const [name, value] of url.searchParams)
      if (/key|token|secret|pass|auth|sig/i.test(name)) secrets.push(value);
  } catch {
    /* unparseable target: nothing to collect */
  }
  try {
    const headers = new Headers(
      init?.headers || (target instanceof Request ? target.headers : undefined),
    );
    for (const [name, value] of headers)
      if (/auth|cookie|key|token|secret|pass/i.test(name)) {
        secrets.push(value);
        const credential = value.replace(/^\s*\S+\s+/, '');
        if (credential !== value) secrets.push(credential);
      }
  } catch {
    /* unusable headers: nothing to collect */
  }
  return secrets;
}

/**
 * Resolve the sources' relative `/api/...` requests against `apiBase`, and
 * serve `file:` URLs inside the bundled data directory from disk, as a
 * browser would load those module-relative assets.
 *
 * Every API request carries a timeout (combined with any caller signal). A
 * non-OK status or a thrown request is logged to stderr with method, redacted
 * URL, status or cause class, elapsed time and a redacted 300-byte body
 * snippet; the response or error the caller sees is unchanged.
 */
export function createApiFetch({
  apiBase = DEFAULT_API_BASE,
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = API_FETCH_TIMEOUT_MS,
  log = (...args) => console.error(...args),
} = {}) {
  const base = new URL(apiBase);
  if (!['http:', 'https:'].includes(base.protocol))
    throw new TypeError(`apiBase must be an http(s) URL: ${apiBase}`);
  return async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('file:')) return readBundled(url, log);
    const target =
      typeof input === 'string' && input.startsWith('/')
        ? new URL(input, base)
        : input;
    const method = String(
      init?.method || (input instanceof Request ? input.method : 'GET'),
    ).toUpperCase();
    const signals = [
      init?.signal,
      input instanceof Request ? input.signal : null,
      AbortSignal.timeout(timeoutMs),
    ].filter(Boolean);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    const shownUrl = redactUrl(target instanceof Request ? target.url : target);
    const started = performance.now();
    let response;
    try {
      response = await fetchImpl(target, { ...init, signal });
    } catch (error) {
      const { cls, code } = failureClass(error);
      log(
        `${LOG} ERROR api request failed method=${method} url=${shownUrl} ` +
          `class=${cls}${code ? ` code=${code}` : ''} ` +
          `elapsed_ms=${Math.round(performance.now() - started)} timeout_ms=${timeoutMs}`,
      );
      throw error;
    }
    if (response?.ok === false) {
      const body = redactSnippet(
        await peekBody(response),
        requestSecrets(target, init),
      );
      log(
        `${LOG} WARN api request non-OK method=${method} url=${shownUrl} ` +
          `status=${response.status} elapsed_ms=${Math.round(performance.now() - started)} ` +
          `body=${JSON.stringify(body)}`,
      );
    }
    return response;
  };
}

async function readBundled(url, log = (...args) => console.error(...args)) {
  const href = new URL(url).href;
  if (!href.startsWith(BUNDLED_DATA.href) || href.includes('/../')) {
    log(`${LOG} WARN bundled read refused (outside bundled data) status=404`);
    return new Response(null, { status: 404 });
  }
  try {
    const body = await readFile(fileURLToPath(href));
    return new Response(body, {
      headers: {
        'Content-Type': href.endsWith('.json')
          ? 'application/json'
          : 'application/octet-stream',
      },
    });
  } catch (error) {
    // The 404 is the contract the sources expect for a missing asset; the
    // log keeps the real cause (ENOENT vs EACCES vs EISDIR ...).
    log(
      `${LOG} WARN bundled read failed path=${href.slice(BUNDLED_DATA.href.length)} ` +
        `code=${error?.code || error?.name || 'unknown'} status=404`,
    );
    return new Response(null, { status: 404 });
  }
}

/** Construct every service Core's tools read, backed by the local server. */
export function createLocalToolServices(options = {}) {
  return createToolServices({
    fetchImpl: createApiFetch(options),
    appUrl: options.apiBase ?? DEFAULT_API_BASE,
    panelKey: options.panelKey,
  });
}
