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
 * Log facts about an OpenAI reply body WITHOUT any of its free text: an
 * error message can quote the request (the HUD context the browser sent),
 * so the HUD never logs body text at all, escaped or not. Only the byte
 * count, the body shape and error.type/code/param (identifier-shaped values
 * that do not occur in the request context) are logged.
 */
function openAiBodyFacts(raw, contextText) {
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
  const context = String(contextText || '').toLowerCase();
  for (const field of ['type', 'code', 'param']) {
    const value = error[field];
    if (
      typeof value === 'string' &&
      /^[\w.[\]-]{1,64}$/.test(value) &&
      !context.includes(value.toLowerCase())
    )
      facts.push(`error_${field}=${value}`);
  }
  return facts.join(' ');
}

/** OpenAI's request id header, when it has the expected shape. */
function requestIdFact(response) {
  const id = response?.headers?.get?.('x-request-id');
  return typeof id === 'string' && /^[\w-]{1,80}$/.test(id)
    ? ` request_id=${id}`
    : '';
}

/** Cause class of a thrown error: never its message. */
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
    return `timeout${code ? ` code=${code}` : ''}`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `dns code=${code}`;
  if (error instanceof SyntaxError) return 'malformed';
  if (code) return `network code=${code}`;
  return error?.name || 'error';
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
        input: JSON.stringify(context),
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
          requestIdFact(response),
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
              openAiBodyFacts(raw, body) +
              requestIdFact(response),
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
          openAiBodyFacts(raw, body) +
          requestIdFact(response),
      );
    else if (parsed && !summary)
      console.warn(
        `[hud-summary] upstream reply has no summary text ${target} ` +
          `status=${response.status} elapsed_ms=${elapsed()} ` +
          openAiBodyFacts(raw, body) +
          requestIdFact(response),
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
