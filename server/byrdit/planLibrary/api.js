// Byrd-IT: HTTP API of the per-user plan library, /api/byrdit/plans/*.
//
//   GET    /me                          { library, user, admin }
//   GET    /                            ?scope=mine|all  ?trash=1  list
//   POST   /                            { details..., plan }       create
//   GET    /:id                         ?owner=&version=           open
//   PUT    /:id                         { details..., plan }       new version
//   PATCH  /:id                         { details... }             rename etc.
//   POST   /:id/duplicate               { name? }
//   DELETE /:id                         move to trash (30 days)
//   POST   /:id/restore                 out of the trash
//   GET    /:id/versions                ?owner=
//   POST   /:id/versions/:n/restore     restore = a new save
//
// Identity: libraryIdentity() only (X-GEV-User from a trusted proxy peer).
// Every call is scoped to that user. The admin may add ?owner=<user> to the
// GET routes to READ another user's plans; every write ignores that and is
// refused when it names someone else. No identity: 401 and nothing is read.
// State changes need the header X-Requested-With: gev and, when the browser
// sends an Origin, the Origin host must be the Host header (CSRF).

import { libraryIdentity, cleanUserName } from './identity.js';
import { LibraryError, MAX_PLAN_BYTES, createStore } from './store.js';

export const API_PREFIX = '/api/byrdit/plans';

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(text);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new LibraryError('too-large', 'The request is too large', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('not an object');
        }
        resolve(value);
      } catch {
        reject(new LibraryError('bad-json', 'The request body is not JSON'));
      }
    });
    req.on('error', () => reject(new LibraryError('aborted', 'Request aborted')));
  });
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/**
 * @param {{ store?: ReturnType<typeof createStore>, env?: object }} [deps]
 * @returns {(req, res, next) => void}
 */
export function createPlanLibraryHandler({ store = createStore(), env = process.env } = {}) {
  async function route(req, res, url, who) {
    const parts = url.pathname.slice(API_PREFIX.length).split('/').filter(Boolean);
    const method = req.method;
    const write = method !== 'GET' && method !== 'HEAD';
    if (write) {
      if (req.headers['x-requested-with'] !== 'gev' || !sameOrigin(req)) {
        throw new LibraryError('csrf', 'Missing or foreign request origin', 403);
      }
    }
    // Whose plans: always the caller's own, unless the admin READS another's.
    const asked = url.searchParams.get('owner');
    let owner = who.user;
    if (asked && asked !== who.user) {
      const other = cleanUserName(asked);
      if (!other) throw new LibraryError('bad-user', 'Bad user name');
      if (!who.admin) throw new LibraryError('forbidden', 'Not your plans', 403);
      if (write) throw new LibraryError('read-only', 'Other users\' plans are read-only', 403);
      owner = other;
    }
    const own = owner === who.user;

    if (parts[0] === 'me' && method === 'GET' && parts.length === 1) {
      return send(res, 200, {
        library: true,
        user: who.user,
        admin: who.admin,
        users: who.admin ? store.users() : undefined,
      });
    }
    if (!parts.length) {
      if (method === 'GET') {
        const trash = url.searchParams.get('trash') === '1';
        if (url.searchParams.get('scope') === 'all') {
          if (!who.admin) throw new LibraryError('forbidden', 'Admin only', 403);
          const plans = store
            .users()
            .flatMap((u) =>
              store.list(u, { trash, purgeOld: false }),
            )
            .sort((a, b) => b.updatedAt - a.updatedAt);
          return send(res, 200, { plans });
        }
        return send(res, 200, {
          plans: store.list(owner, { trash, purgeOld: own }),
        });
      }
      if (method === 'POST') {
        const body = await readBody(req, MAX_PLAN_BYTES + 65_536);
        return send(res, 201, { plan: store.create(who.user, body, body.plan) });
      }
      throw new LibraryError('method', 'Method not allowed', 405);
    }
    const id = parts[0];
    if (parts.length === 1) {
      if (method === 'GET') {
        const v = url.searchParams.get('version');
        return send(res, 200, store.get(owner, id, v ? Number(v) : null));
      }
      if (method === 'PUT') {
        const body = await readBody(req, MAX_PLAN_BYTES + 65_536);
        return send(res, 200, { plan: store.save(who.user, id, body.plan, body) });
      }
      if (method === 'PATCH') {
        const body = await readBody(req, 65_536);
        return send(res, 200, { plan: store.update(who.user, id, body) });
      }
      if (method === 'DELETE') {
        return send(res, 200, { plan: store.trash(who.user, id) });
      }
      throw new LibraryError('method', 'Method not allowed', 405);
    }
    if (parts[1] === 'duplicate' && method === 'POST' && parts.length === 2) {
      const body = await readBody(req, 65_536);
      return send(res, 201, { plan: store.duplicate(who.user, id, body.name) });
    }
    if (parts[1] === 'restore' && method === 'POST' && parts.length === 2) {
      return send(res, 200, { plan: store.restore(who.user, id) });
    }
    if (parts[1] === 'versions') {
      if (parts.length === 2 && method === 'GET') {
        return send(res, 200, { versions: store.versions(owner, id) });
      }
      if (parts.length === 4 && parts[3] === 'restore' && method === 'POST') {
        const n = Number(parts[2]);
        if (!Number.isInteger(n) || n < 1) {
          throw new LibraryError('not-found', 'No such version', 404);
        }
        return send(res, 200, { plan: store.restoreVersion(who.user, id, n) });
      }
    }
    throw new LibraryError('not-found', 'No such route', 404);
  }

  return function planLibraryHandler(req, res, next) {
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.pathname !== API_PREFIX && !url.pathname.startsWith(`${API_PREFIX}/`)) {
      return next();
    }
    const who = libraryIdentity(req, env);
    if (!who) {
      // The map still works; the panel shows "Sign in through byrd-it.com".
      if (url.pathname === `${API_PREFIX}/me`) {
        return send(res, 200, { library: false });
      }
      return send(res, 401, { error: 'no-identity' });
    }
    route(req, res, url, who).catch((error) => {
      if (error instanceof LibraryError) {
        return send(res, error.status, { error: error.code, message: error.message });
      }
      // Never echo internals (paths) to the caller.
      console.error('plan library error:', error?.code ?? error?.name);
      return send(res, 500, { error: 'internal' });
    });
  };
}

export function planLibraryPlugins({ env = process.env, ...deps } = {}) {
  const handler = createPlanLibraryHandler({ env, ...deps });
  return [
    {
      name: 'byrdit-plan-library',
      configureServer(server) {
        server.middlewares.use(handler);
      },
      configurePreviewServer(server) {
        server.middlewares.use(handler);
      },
    },
  ];
}
