/**
 * Browser side of the per-user plan library (server/byrdit/planLibrary/api.js).
 * `fetchImpl` is injectable for tests. Every call returns the parsed JSON or
 * throws a LibraryClientError with the server's error code.
 */
export const LIBRARY_BASE = '/api/byrdit/plans';

export class LibraryClientError extends Error {
  constructor(code, status, message) {
    super(message || code);
    this.name = 'LibraryClientError';
    this.code = code;
    this.status = status;
  }
}

export function createLibraryClient({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  base = LIBRARY_BASE,
} = {}) {
  async function call(method, path, body) {
    if (!fetchImpl) throw new LibraryClientError('offline', 0);
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        credentials: 'same-origin',
        headers: {
          'x-requested-with': 'gev',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new LibraryClientError('offline', 0);
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (!res.ok) {
      throw new LibraryClientError(
        json?.error ?? 'error',
        res.status,
        json?.message,
      );
    }
    return json ?? {};
  }
  const owner = (o) => (o ? `owner=${encodeURIComponent(o)}` : '');
  const q = (...parts) => {
    const s = parts.filter(Boolean).join('&');
    return s ? `?${s}` : '';
  };
  const id = (v) => encodeURIComponent(v);
  return {
    me: () => call('GET', '/me'),
    list: ({ scope = 'mine', trash = false } = {}) =>
      call(
        'GET',
        `/${q(scope === 'all' ? 'scope=all' : '', trash ? 'trash=1' : '')}`,
      ),
    create: (details, plan) => call('POST', '', { ...details, plan }),
    open: (planId, { owner: o, version } = {}) =>
      call(
        'GET',
        `/${id(planId)}${q(owner(o), version ? `version=${Number(version)}` : '')}`,
      ),
    save: (planId, plan, details = {}) =>
      call('PUT', `/${id(planId)}`, { ...details, plan }),
    update: (planId, details) => call('PATCH', `/${id(planId)}`, details),
    duplicate: (planId, name) =>
      call('POST', `/${id(planId)}/duplicate`, { name }),
    trash: (planId) => call('DELETE', `/${id(planId)}`),
    restore: (planId) => call('POST', `/${id(planId)}/restore`),
    versions: (planId, { owner: o } = {}) =>
      call('GET', `/${id(planId)}/versions${q(owner(o))}`),
    restoreVersion: (planId, n) =>
      call('POST', `/${id(planId)}/versions/${Number(n)}/restore`),
  };
}
