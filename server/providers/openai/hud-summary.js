import {
  HUD_SUMMARY_INSTRUCTIONS,
  keylessHudSummaryResponse,
} from '../../../src/hudSummaryResponse.js';
import { enforceRateLimit, openAiRateLimiter } from './rate-limit.js';
import { readRequestBody } from '../common/request.js';
import { OPENAI_HUD_SUMMARY_MODEL_DEFAULT } from './constants.js';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
/** Upstream timeout for one HUD summary (ms); bounds headers and body read. */
export const HUD_SUMMARY_TIMEOUT_MS = 15_000;

/**
 * First 300 bytes of an upstream body for a log line. OpenAI error bodies
 * never echo the prompt, but they can quote a masked key: mask sk-... and
 * bearer tokens anyway, strip markup, collapse whitespace.
 */
function redactSnippet(text, max = 300) {
  return String(text ?? '')
    .slice(0, 4096)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\b(Bearer|Basic)\s+[\w.~+/=*-]+/gi, '$1 REDACTED')
    .replace(/\bsk-[\w*.-]{4,}/g, 'REDACTED')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
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
      signal: AbortSignal.timeout(HUD_SUMMARY_TIMEOUT_MS),
    });
    upstreamStatus = response.status;
    const raw = await response.text().catch(() => '');
    let data = {};
    try {
      data = JSON.parse(raw);
    } catch {
      data = {};
    }
    const summary = toFiveWordHudSummary(extractOpenAiResponseText(data));
    res.statusCode = response.ok && summary ? 200 : response.status || 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (!response.ok)
      console.warn(
        `[hud-summary] upstream HTTP ${response.status} target="POST ${OPENAI_RESPONSES_URL}" ` +
          `status=${response.status} elapsed_ms=${Math.round(performance.now() - startedAt)} ` +
          `body=${JSON.stringify(redactSnippet(raw))}`,
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
          ? ` target="POST ${OPENAI_RESPONSES_URL}" status=${upstreamStatus || 'none'} ` +
            `elapsed_ms=${Math.round(performance.now() - startedAt)} timeout_ms=${HUD_SUMMARY_TIMEOUT_MS}`
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
