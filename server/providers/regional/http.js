import {
  readResponseJsonCapped,
  readResponseTextCapped,
} from '../common/http.js';

// --- Byrd-IT p16: upstream failure log helpers (STANDARD R3, KB SeY7S6EBs9sMHq_KSKLr).
// The same block is copied into every p16 provider file (there is no shared
// runtime module, as in b12); src/byrdit/providerErrorLoggingP16.test.mjs
// checks that the copies stay identical and that redactSnippet equals the b12
// copy. Every helper is log-only and never throws.

/** Longest wait for a failing body's first bytes (ms). */
const P16_BODY_PEEK_MS = 1000;
/** Characters of a failing body read for the log; the rest is cancelled. */
const P16_BODY_PEEK_CHARS = 4096;

/**
 * Read at most P16_BODY_PEEK_CHARS of a failing response body within `ms`,
 * then cancel the body. A stalled body never holds the caller past `ms`.
 * Never throws; returns '' when there is no readable body.
 */
async function p16PeekBody(response, ms = P16_BODY_PEEK_MS) {
  let reader;
  try {
    reader = response?.body?.getReader?.();
  } catch {
    return '[body locked]';
  }
  if (!reader) return '';
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ done: true, timedOut: true }), ms);
    timer.unref?.();
  });
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (text.length < P16_BODY_PEEK_CHARS) {
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
  } catch {
    /* body errored: log what we have */
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      /* a pending read keeps the lock; the cancel above settles it */
    }
  }
  return text;
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

/**
 * Thrown-error classes, as fixed constants (b12 HUD tables). The error's
 * `cause.code`/`code`/`name` are only looked up here, never printed: anything
 * outside these tables is logged as `code=OTHER` / `error`.
 */
const P16_TIMEOUT_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ETIMEDOUT',
]);
const P16_DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN']);
const P16_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTDOWN',
  'EPROTO',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_DESTROYED',
  'UND_ERR_ABORTED',
  'UND_ERR_INFO',
  'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
  'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH',
  'UND_ERR_RES_EXCEEDED_MAX_SIZE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'ERR_SSL_WRONG_VERSION_NUMBER',
]);
const P16_LOCAL_CODES = new Set(['RESPONSE_TOO_LARGE', 'BODY_TOO_LARGE']);
const P16_ERROR_NAMES = new Set([
  'AbortError',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'Error',
]);

/** Cause class of a thrown error: constants only, never its message, code or name. */
function p16FailureClass(error) {
  try {
    // String codes only: DOMException carries a numeric legacy `code`.
    const rawCode =
      [error?.cause?.code, error?.code].find((c) => typeof c === 'string') ||
      '';
    const name = typeof error?.name === 'string' ? error.name : '';
    if (name === 'TimeoutError' || P16_TIMEOUT_CODES.has(rawCode))
      return `timeout${P16_TIMEOUT_CODES.has(rawCode) ? ` code=${rawCode}` : ''}`;
    if (P16_DNS_CODES.has(rawCode)) return `dns code=${rawCode}`;
    if (P16_NETWORK_CODES.has(rawCode)) return `network code=${rawCode}`;
    if (P16_LOCAL_CODES.has(rawCode)) return `local code=${rawCode}`;
    if (error instanceof SyntaxError) return 'malformed';
    if (rawCode) return 'error code=OTHER';
    return P16_ERROR_NAMES.has(name) ? name : 'error';
  } catch {
    return 'error';
  }
}

/**
 * `METHOD origin/path` of an upstream URL for a log line: no userinfo, no
 * query, no fragment, and the request's own secrets masked in the path.
 */
function p16Target(method, url, secrets = []) {
  try {
    const parsed = new URL(String(url));
    return `${method} ${redactSnippet(`${parsed.origin}${parsed.pathname}`, secrets, 300)}`;
  } catch {
    return `${method} [unparsable url]`;
  }
}

/**
 * Credential-like parts of a URL (userinfo, query values), so an upstream
 * that echoes them back is masked too. Never throws.
 */
function p16UrlSecrets(url) {
  try {
    const parsed = new URL(String(url));
    return [
      decodeURIComponent(parsed.username),
      decodeURIComponent(parsed.password),
      ...parsed.searchParams.values(),
    ].filter((value) => value.length >= 4);
  } catch {
    return [];
  }
}

/** Whole milliseconds since `startedAt` (a performance.now() value). */
function p16Elapsed(startedAt) {
  const ms = performance.now() - Number(startedAt);
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : -1;
}

/**
 * key=value fields for an upstream HTTP failure: target, status, elapsed and
 * a redacted body[:300]. `text` is the already-read body; without it the body
 * is peeked (bounded) and cancelled. Never throws.
 */
async function p16HttpFailure({
  method = 'GET',
  url,
  response,
  startedAt,
  secrets = [],
  text,
  withTarget = true,
}) {
  try {
    const status = Number(response?.status);
    const raw = text === undefined ? await p16PeekBody(response) : text;
    const all = [...secrets, ...p16UrlSecrets(url)];
    return (
      (withTarget
        ? `target=${JSON.stringify(p16Target(method, url, all))} `
        : '') +
      `status=${Number.isInteger(status) ? status : 'none'}` +
      ` elapsed_ms=${p16Elapsed(startedAt)}` +
      ` body=${JSON.stringify(redactSnippet(raw, all))}`
    );
  } catch {
    return 'detail=unavailable';
  }
}

/** key=value fields for a thrown upstream failure (no message). Never throws. */
function p16ThrownFailure({
  method = 'GET',
  url,
  error,
  startedAt,
  timeoutMs,
  secrets = [],
  stage,
  withTarget = true,
}) {
  try {
    const all = [...secrets, ...p16UrlSecrets(url)];
    return (
      (withTarget
        ? `target=${JSON.stringify(p16Target(method, url, all))} `
        : '') +
      (stage === 'body' || stage === 'headers' ? `stage=${stage} ` : '') +
      `class=${p16FailureClass(error)}` +
      ` elapsed_ms=${p16Elapsed(startedAt)}` +
      (Number.isFinite(timeoutMs) ? ` timeout_ms=${timeoutMs}` : '')
    );
  } catch {
    return 'detail=unavailable';
  }
}

/** Attach log fields to an error without changing it otherwise. Never throws. */
function p16Annotate(error, fields) {
  try {
    if (error && typeof error === 'object' && !error.p16Log)
      Object.defineProperty(error, 'p16Log', {
        value: fields,
        enumerable: false,
        configurable: true,
      });
  } catch {
    /* frozen error: the log falls back to its old text */
  }
  return error;
}
// --- end of p16 helpers

const REGIONAL_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * Byrd-IT p16 (R3): every regional caller swallows a failed read (the
 * briefing degrades to 'partial'), so nothing was logged. One line per failure
 * is now written here, at most once per target + outcome per
 * P16_REGIONAL_LOG_WINDOW_MS, with the count not logged since. The target is
 * origin + path only: the query (place name, coordinates) is never logged.
 */
const P16_REGIONAL_LOG_WINDOW_MS = 60_000;
/** @type {Map<string, {at: number, suppressed: number}>} */
const p16RegionalLogGate = new Map();
function p16AdmitRegionalLog(key, now = Date.now()) {
  const gate = p16RegionalLogGate.get(key);
  if (gate && now - gate.at < P16_REGIONAL_LOG_WINDOW_MS) {
    gate.suppressed += 1;
    return null;
  }
  if (p16RegionalLogGate.size >= 64) p16RegionalLogGate.clear();
  p16RegionalLogGate.set(key, { at: now, suppressed: 0 });
  return { suppressed: gate?.suppressed || 0 };
}
/** Write one gated line; `describe` runs (and peeks a body) only when admitted. */
async function p16RegionalLog(key, describe) {
  try {
    const admitted = p16AdmitRegionalLog(key);
    if (!admitted) return;
    console.warn(
      `[regional-proxy] ${await describe()}` +
        (admitted.suppressed ? ` suppressed=${admitted.suppressed}` : ''),
    );
  } catch {
    /* logging only */
  }
}

/**
 * One bounded upstream read for the regional providers.
 *
 * The deadline covers the BODY, not just the headers. `return`ing the reader's
 * promise from inside a try/finally leaves the try block the moment the promise
 * exists, so the abort timer used to be cleared before a single byte of body had
 * arrived — an upstream that answered its headers and then stalled had no
 * deadline at all. Awaiting inside the try keeps the timer alive until the body
 * is in hand, and the same signal is handed to the reader so an abort stops the
 * read rather than just the connect.
 *
 * `redirect` is stated rather than inherited: feeds that legitimately redirect
 * (news RSS) follow, and a fixed API endpoint can be given 'error' so a
 * redirect cannot steer the proxy at a destination this code never named.
 *
 * @param {string} url
 * @param {{headers?: object, timeoutMs?: number, maxBytes?: number, redirect?: 'follow'|'error'|'manual'}} [options]
 */
async function fetchRegional(url, read, options = {}) {
  const {
    headers = {},
    timeoutMs = 9000,
    maxBytes = REGIONAL_MAX_RESPONSE_BYTES,
    redirect = 'follow',
  } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  const target = p16Target('GET', url);
  const logThrown = (error, stage) =>
    p16RegionalLog(
      `${target} ${stage} ${p16FailureClass(error)}`,
      () =>
        `upstream request failed ${p16ThrownFailure({ url, error, startedAt, timeoutMs, stage })}`,
    );
  try {
    let response;
    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers,
        redirect,
      });
    } catch (error) {
      await logThrown(error, 'headers');
      throw error;
    }
    if (!response.ok) {
      await p16RegionalLog(
        `${target} ${response.status}`,
        async () =>
          `upstream HTTP ${response.status} ${await p16HttpFailure({ url, response, startedAt })}`,
      );
      throw new Error(`Upstream returned ${response.status}`);
    }
    try {
      return await read(response, maxBytes, controller.signal);
    } catch (error) {
      await logThrown(error, 'body');
      throw error;
    }
  } finally {
    clearTimeout(timeout);
  }
}

function fetchRegionalJson(url, options = {}) {
  return fetchRegional(url, readResponseJsonCapped, options);
}

function fetchRegionalText(url, options = {}) {
  return fetchRegional(url, readResponseTextCapped, options);
}

export { fetchRegionalJson, fetchRegionalText };
