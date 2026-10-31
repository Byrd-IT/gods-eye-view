// Byrd-IT: read-only HTTP API of the photogrammetry surface models used by
// the Drone Flight Plan clearance check, /api/byrdit/surfaces/*.
//
//   GET /          { surfaces: [ header, ... ] }   newest first
//   GET /:id       the .gevsurf file (binary)
//
// Files live in GEV_SURFACE_DIR (default ~/gev-surfaces), written by
// tools/droneSurface/build-surface.mjs. They show a private property from
// the air, so the same identity rule as the plan library applies: no
// identity, no data. Nothing here writes, deletes or runs a process.

import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { libraryIdentity } from '../planLibrary/identity.js';
import {
  decodeSurfaceHeader,
  isSurfaceId,
} from '../../../src/byrdit/dronePlan/surfaceGrid.js';

export const SURFACE_API_PREFIX = '/api/byrdit/surfaces';
export const SURFACE_EXT = '.gevsurf';
export const SURFACE_DIR_ENV = 'GEV_SURFACE_DIR';
/** Largest file the API will hand out. */
export const MAX_SURFACE_BYTES = 400 * 1024 * 1024;

export const surfaceDir = (env = process.env) =>
  env[SURFACE_DIR_ENV] || join(homedir(), 'gev-surfaces');

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

/** Read just the header of one file, or null when it is not a good file. */
function headerOf(file) {
  try {
    const fd = openSync(file, 'r');
    try {
      const head = Buffer.alloc(70000);
      const n = readSync(fd, head, 0, head.length, 0);
      const { meta } = decodeSurfaceHeader(
        head.buffer.slice(head.byteOffset, head.byteOffset + n),
      );
      return meta;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

export function listSurfaces(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(SURFACE_EXT)) continue;
    const id = name.slice(0, -SURFACE_EXT.length);
    if (!isSurfaceId(id)) continue;
    const file = join(dir, name);
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      continue;
    }
    if (size > MAX_SURFACE_BYTES) continue;
    const meta = headerOf(file);
    if (meta && meta.id === id) out.push({ ...meta, bytes: size });
  }
  out.sort((a, b) => {
    const ta = a.capturedAt ? Date.parse(a.capturedAt) : 0;
    const tb = b.capturedAt ? Date.parse(b.capturedAt) : 0;
    return tb - ta || (a.id < b.id ? -1 : 1);
  });
  return out;
}

export function createSurfaceHandler({ env = process.env } = {}) {
  return function surfaceHandler(req, res, next) {
    const url = new URL(req.url ?? '/', 'http://local');
    const p = url.pathname;
    if (p !== SURFACE_API_PREFIX && !p.startsWith(`${SURFACE_API_PREFIX}/`))
      return next();
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return send(res, 405, { error: 'method-not-allowed' });
    if (!libraryIdentity(req, env))
      return send(res, 401, { error: 'no-identity' });
    const dir = surfaceDir(env);
    try {
      const rest = p.slice(SURFACE_API_PREFIX.length).replace(/^\/+|\/+$/g, '');
      if (!rest) return send(res, 200, { surfaces: listSurfaces(dir) });
      if (!isSurfaceId(rest)) return send(res, 404, { error: 'not-found' });
      const file = join(dir, `${rest}${SURFACE_EXT}`);
      if (!existsSync(file)) return send(res, 404, { error: 'not-found' });
      const size = statSync(file).size;
      if (size > MAX_SURFACE_BYTES)
        return send(res, 404, { error: 'not-found' });
      res.statusCode = 200;
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-length', String(size));
      res.setHeader('cache-control', 'private, no-cache');
      if (req.method === 'HEAD') return res.end();
      // Streamed, so a few requests at once never hold whole files in memory.
      const stream = createReadStream(file);
      stream.on('error', () => res.destroy());
      return stream.pipe(res);
    } catch (error) {
      // Never echo internals (paths) to the caller.
      console.error('surface api error:', error?.code ?? error?.name);
      return send(res, 500, { error: 'internal' });
    }
  };
}

export function ensureSurfaceDir(env = process.env) {
  mkdirSync(surfaceDir(env), { recursive: true });
}

export function surfacePlugins({ env = process.env } = {}) {
  const handler = createSurfaceHandler({ env });
  return [
    {
      name: 'byrdit-surfaces',
      configureServer(server) {
        server.middlewares.use(handler);
      },
      configurePreviewServer(server) {
        server.middlewares.use(handler);
      },
    },
  ];
}
