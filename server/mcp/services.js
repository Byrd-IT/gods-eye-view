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

/** First 300 bytes of an upstream body for a log line, markup and secrets removed. */
function redactSnippet(text, max = 300) {
  return String(text ?? '')
    .slice(0, 4096)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, '$1 REDACTED')
    .replace(
      /([?&](?:key|api_?key|token|access_token|secret|password|sig|signature)=)[^&\s"']*/gi,
      '$1REDACTED',
    )
    .replace(/\b(?:sk-[\w-]{8,}|AIza[\w-]{20,})/g, 'REDACTED')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
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

/** Read at most ~4 KiB of a cloned error body for the log without consuming the original. */
async function peekBody(response) {
  try {
    const reader = response.clone().body?.getReader();
    if (!reader) return '';
    const decoder = new TextDecoder();
    let text = '';
    while (text.length < 4096) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    reader.cancel().catch(() => {});
    return text;
  } catch {
    return '';
  }
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
      const body = redactSnippet(await peekBody(response));
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
