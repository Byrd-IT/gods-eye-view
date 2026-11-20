import { readResponseTextCapped } from '../common/http.js';

/**
 * Read catalogs that are only useful together, because the pack joins them.
 *
 * The requests share one deadline and refuse redirects. Whichever fails first
 * (before its headers, on its status, or while its capped body is read or
 * parsed) aborts the others at once, so a stalled feed is not waited on until
 * the deadline. Every response body is released, including one that arrives
 * after another feed has already failed.
 *
 * @param {Array<{url: string, label: string}>} feeds `label` names the feed
 *   in the error ("locations download failed: 503").
 * @param {{accept: string, maxBytes: number, timeoutMs: number,
 *   parse?: (text: string) => unknown,
 *   describeFailure?: (failure: {url: string, label: string,
 *     response?: Response, error?: unknown, startedAt: number,
 *     stage: 'headers'|'status'|'body'}) => Promise<string>|string}} options
 *   Byrd-IT: `describeFailure` returns the key=value fields the fork's provider
 *   error logging (p16) attaches to the error as `p16Log`.
 * @returns {Promise<unknown[]>} The parsed bodies (texts without `parse`), in
 *   feed order.
 */
export async function readCatalogsTogether(
  feeds,
  { accept, maxBytes, timeoutMs, parse = (text) => text, describeFailure },
) {
  const sibling = new AbortController();
  const signal = AbortSignal.any([
    sibling.signal,
    AbortSignal.timeout(timeoutMs),
  ]);
  return Promise.all(
    feeds.map(async ({ url, label }) => {
      let response;
      let stage = 'headers';
      const startedAt = performance.now();
      try {
        response = await fetch(url, {
          headers: { Accept: accept },
          redirect: 'manual',
          signal,
        });
        signal.throwIfAborted();
        stage = 'body';
        if (!response.ok) {
          const failure = new Error(
            response.status >= 300 && response.status < 400
              ? `${label} catalog redirected; redirects are not followed`
              : `${label} download failed: ${response.status}`,
          );
          if (describeFailure)
            await annotate(failure, {
              url,
              label,
              response,
              startedAt,
              stage: 'status',
            });
          throw failure;
        }
        return parse(await readResponseTextCapped(response, maxBytes, signal));
      } catch (error) {
        sibling.abort();
        if (describeFailure && !error?.p16Log)
          await annotate(error, { url, label, error, startedAt, stage });
        await response?.body?.cancel().catch(() => {});
        throw error;
      }
    }),
  );

  /** Attach the fork's log fields to an error. Never throws. */
  async function annotate(error, failure) {
    try {
      const fields = await describeFailure(failure);
      if (fields && error && typeof error === 'object')
        Object.defineProperty(error, 'p16Log', {
          value: fields,
          enumerable: false,
          configurable: true,
        });
    } catch {
      /* the log falls back to the error text */
    }
  }
}
