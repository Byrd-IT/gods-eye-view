/**
 * Output masking for scripts/qa-naip-compare.mjs. The --url may carry
 * credentials (user:pass@host) or tokens in its query; browser errors can echo
 * it, and page errors can carry tokens of their own. None of that may reach
 * stdout or stderr, whole or in part.
 */
import { makeRedactor, urlSecrets } from './qa-map-clear-view-redact.mjs';

/** Origin and path only: a request URL can carry a key or token in its query. */
export const safeUrl = (raw) => {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`.slice(0, 140);
  } catch {
    return '(unparsable url)';
  }
};

/**
 * makeNaipRedactors(baseUrl) -> { scrub, redact }
 *   scrub(text)  masks the --url secrets, URL userinfo and query strings
 *   redact(text) scrub plus auth headers, bearer tokens and any bare run of 20
 *                or more token characters (for page and browser error text,
 *                not for our own PASS/FAIL lines, whose selectors are long)
 */
export function makeNaipRedactors(baseUrl) {
  const scrub = makeRedactor(urlSecrets(baseUrl));
  const redact = (text) =>
    scrub(
      String(text)
        .replace(
          /\b(x-api-key|api-key|authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]+/gi,
          '$1: ***',
        )
        .replace(/(bearer|basic)\s+\S+/gi, '$1 ***')
        .replace(/[A-Za-z0-9_-]{20,}/g, '***'),
    );
  return { scrub, redact };
}
