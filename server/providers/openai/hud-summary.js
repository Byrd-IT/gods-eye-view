import {
  HUD_SUMMARY_INSTRUCTIONS,
  keylessHudSummaryResponse,
} from '../../../src/hudSummaryResponse.js';
import { enforceRateLimit, openAiRateLimiter } from './rate-limit.js';
import { readRequestBody } from '../common/request.js';
import { OPENAI_HUD_SUMMARY_MODEL_DEFAULT } from './constants.js';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
/**
 * Default upstream backstop for one HUD summary (ms); bounds headers and body.
 * The only caller, src/hud.js (_refreshSummary), aborts its request after
 * 5 s, whatever model is configured, so a reply slower than that is never
 * shown: 15 s (3x the client's abandon point) never cuts off a reply the
 * HUD could still use and only bounds a paid request nobody waits for.
 * Override with GEV_HUD_SUMMARY_TIMEOUT_MS (1000-600000).
 */
export const HUD_SUMMARY_TIMEOUT_MS = 15_000;

/** Effective HUD timeout: GEV_HUD_SUMMARY_TIMEOUT_MS when valid, else the default. */
export function hudSummaryTimeoutMs(env = process.env) {
  const ms = Number(env?.GEV_HUD_SUMMARY_TIMEOUT_MS);
  return Number.isInteger(ms) && ms >= 1000 && ms <= 600_000
    ? ms
    : HUD_SUMMARY_TIMEOUT_MS;
}

/**
 * Upstream error identifiers the HUD may log, as fixed constants of this file.
 * Only a value equal to one of these strings is logged; any other value is
 * reported as `unlisted`. The logged text is therefore always a string from
 * this source, never upstream bytes, so it cannot carry the API key or the
 * HUD context, however OpenAI (or anything answering in its place) reflects
 * them. Identifier shape alone is not a confidentiality boundary.
 * Sources: OpenAI "Error codes" guide (rate_limit_error/slow_down,
 * service_unavailable_error/server_is_overloaded, credit_balance_exhausted,
 * *_spend_limit_exceeded, organization_usage_limit_exceeded,
 * insufficient_quota) plus the long-standing Responses API error types and
 * codes. Missing an identifier only loses detail, never confidentiality.
 */
const OPENAI_ERROR_TYPES = new Set([
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'not_found_error',
  'conflict_error',
  'rate_limit_error',
  'insufficient_quota',
  'tokens',
  'requests',
  'server_error',
  'api_error',
  'service_unavailable_error',
]);
const OPENAI_ERROR_CODES = new Set([
  'invalid_api_key',
  'invalid_authentication',
  'invalid_organization',
  'no_organization',
  'account_deactivated',
  'unsupported_country_region_territory',
  'ip_not_authorized',
  'model_not_found',
  'insufficient_quota',
  'billing_hard_limit_reached',
  'billing_not_active',
  'credit_balance_exhausted',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
  'rate_limit_exceeded',
  'slow_down',
  'context_length_exceeded',
  'string_above_max_length',
  'invalid_value',
  'invalid_type',
  'unsupported_value',
  'unsupported_parameter',
  'unknown_parameter',
  'missing_required_parameter',
  'integer_below_min_value',
  'integer_above_max_value',
  'invalid_prompt',
  'server_error',
  'server_is_overloaded',
]);
/** error.param names a request field: only the fields this handler sends. */
const OPENAI_ERROR_PARAMS = new Set([
  'model',
  'instructions',
  'input',
  'reasoning',
  'reasoning.effort',
  'max_output_tokens',
]);
const OPENAI_ERROR_ALLOWLISTS = {
  type: OPENAI_ERROR_TYPES,
  code: OPENAI_ERROR_CODES,
  param: OPENAI_ERROR_PARAMS,
};

/**
 * Log facts about an OpenAI reply body WITHOUT any of its free text: an
 * error message can quote the request (the HUD context the browser sent),
 * so the HUD never logs body text at all, escaped or not. Only the byte
 * count, the body shape and error.type/code/param are logged, and those
 * three only as allow-listed constants (other values: `unlisted`).
 */
function openAiBodyFacts(raw) {
  const facts = [`body_bytes=${new TextEncoder().encode(raw).length}`];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    if (raw) facts.push('body_format=non-json');
    return facts.join(' ');
  }
  const error = parsed?.error;
  if (!error || typeof error !== 'object') {
    facts.push('body_format=json-without-error');
    return facts.join(' ');
  }
  for (const [field, allowed] of Object.entries(OPENAI_ERROR_ALLOWLISTS)) {
    const value = error[field];
    if (value === undefined || value === null) continue;
    facts.push(
      `error_${field}=${typeof value === 'string' && allowed.has(value) ? value : 'unlisted'}`,
    );
  }
  return facts.join(' ');
}

/** Lower-case hex of a string's UTF-8 bytes. */
function hexOf(text) {
  return Buffer.from(text, 'utf8').toString('hex');
}

/**
 * Forms in which a secret could be reflected inside a request id: the text
 * itself (lower case), its UTF-8 hex, base64 and base64url.
 */
function secretForms(text) {
  const value = String(text || '');
  if (!value) return [];
  const bytes = Buffer.from(value, 'utf8');
  return [
    value.toLowerCase(),
    bytes.toString('hex'),
    bytes.toString('base64'),
    bytes.toString('base64url'),
  ];
}

/**
 * OpenAI's request id, logged only when it is `req_` + lower-case hex (the
 * form OpenAI request ids are observed to take; any other value is logged as
 * `request_id=withheld`) AND its hex part shares nothing with the request's
 * secrets: the API key, the HUD context and the prompt, raw or hex/base64
 * encoded, in either direction (id inside a secret form, or a secret form
 * inside the id). A shape check alone would admit a reflected key or context.
 */
function requestIdFact(response, secrets) {
  const id = response?.headers?.get?.('x-request-id');
  if (typeof id !== 'string' || !id) return '';
  const match = /^req_([0-9a-f]{1,64})$/.exec(id);
  if (!match) return ' request_id=withheld';
  const hex = match[1];
  for (const secret of secrets)
    for (const form of secretForms(secret))
      if (form.includes(hex) || hex.includes(form))
        return ' request_id=withheld';
  return ` request_id=${id}`;
}

/** Cause class of a thrown error: never its message. */
function failureClass(error) {
  // String codes only: DOMException carries a numeric legacy `code`.
  // Only errno-style codes (ECONNRESET, UND_ERR_*, BODY_TOO_LARGE) and plain
  // class names are logged; anything else is reduced to a constant.
  const rawCode =
    [error?.cause?.code, error?.code].find((c) => typeof c === 'string') || '';
  const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(rawCode)
    ? rawCode
    : rawCode
      ? 'OTHER'
      : '';
  if (
    error?.name === 'TimeoutError' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'ETIMEDOUT'
  )
    return `timeout${code ? ` code=${code}` : ''}`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `dns code=${code}`;
  if (error instanceof SyntaxError) return 'malformed';
  if (code) return `network code=${code}`;
  const name = error?.name;
  return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name)
    ? name
    : 'error';
}

function extractOpenAiResponseText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }
  if (!Array.isArray(data?.output)) return '';
  return data.output
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .map((part) => part?.text || part?.output_text || '')
    .join(' ')
    .trim();
}

function toFiveWordHudSummary(value) {
  return String(value || '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join(' ');
}

async function handleHudSummary(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const keyless = keylessHudSummaryResponse(apiKey);
  if (keyless) {
    res.statusCode = keyless.statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(keyless.payload));
    return;
  }

  // Per-IP throttle (GEV_RATELIMIT_OPENAI_PER_MIN). On by default; 0 disables.
  // Keyless HUD fallback has no provider cost and resolves above without
  // consuming a paid-endpoint quota slot.
  if (!enforceRateLimit(openAiRateLimiter(), req, res)) return;

  // `stage` tells a client-side failure (oversized/invalid request body) from
  // an upstream one in the log. The prompt, the context and the key are never
  // logged.
  let stage = 'client-body';
  let startedAt = 0;
  let upstreamStatus = 0;
  const timeoutMs = hudSummaryTimeoutMs();
  const target = `target="POST ${OPENAI_RESPONSES_URL}"`;
  const elapsed = () => Math.round(performance.now() - startedAt);
  try {
    const body = await readRequestBody(req, 64 * 1024);
    const context = JSON.parse(body || '{}');
    const input = JSON.stringify(context);
    // Never logged, in any form: diagnostics are checked against these.
    const secrets = [apiKey, body, input, HUD_SUMMARY_INSTRUCTIONS];
    stage = 'upstream';
    startedAt = performance.now();
    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model:
          process.env.OPENAI_HUD_SUMMARY_MODEL ||
          OPENAI_HUD_SUMMARY_MODEL_DEFAULT,
        instructions: HUD_SUMMARY_INSTRUCTIONS,
        input,
        reasoning: { effort: 'minimal' },
        max_output_tokens: 100,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    upstreamStatus = response.status;
    // Body phase: a read or parse failure keeps the old reply (an empty
    // reply object, so no summary) but is logged with its cause.
    let raw = '';
    let bodyRead = true;
    try {
      raw = await response.text();
    } catch (error) {
      bodyRead = false;
      console.warn(
        `[hud-summary] upstream body read failed class=${failureClass(error)} ${target} ` +
          `status=${response.status} elapsed_ms=${elapsed()} timeout_ms=${timeoutMs}` +
          requestIdFact(response, secrets),
      );
    }
    let data = {};
    let parsed = false;
    if (bodyRead) {
      try {
        data = JSON.parse(raw);
        parsed = true;
      } catch {
        data = {};
        if (response.ok)
          console.warn(
            `[hud-summary] upstream body malformed class=malformed ${target} ` +
              `status=${response.status} elapsed_ms=${elapsed()} ` +
              openAiBodyFacts(raw) +
              requestIdFact(response, secrets),
          );
      }
    }
    const summary = toFiveWordHudSummary(extractOpenAiResponseText(data));
    res.statusCode = response.ok && summary ? 200 : response.status || 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (!response.ok)
      console.warn(
        `[hud-summary] upstream HTTP ${response.status} ${target} ` +
          `status=${response.status} elapsed_ms=${elapsed()} ` +
          openAiBodyFacts(raw) +
          requestIdFact(response, secrets),
      );
    else if (parsed && !summary)
      console.warn(
        `[hud-summary] upstream reply has no summary text ${target} ` +
          `status=${response.status} elapsed_ms=${elapsed()} ` +
          openAiBodyFacts(raw) +
          requestIdFact(response, secrets),
      );
    res.end(
      JSON.stringify({
        summary: summary || null,
        // Never relay `data.error.message`: that is OpenAI's own wording, and
        // it carries request ids, organization hints and quota phrasing.
        error: response.ok ? null : 'OpenAI HUD summary request failed',
      }),
    );
  } catch (error) {
    console.warn(
      `[hud-summary] request failed stage=${stage} class=${failureClass(error)}` +
        (stage === 'upstream'
          ? ` ${target} status=${upstreamStatus || 'none'} ` +
            `elapsed_ms=${elapsed()} timeout_ms=${timeoutMs}`
          : ''),
    );
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        error: 'OpenAI HUD summary request failed',
      }),
    );
  }
}

export { handleHudSummary };
