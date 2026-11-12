import path from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basemapEnabled } from '../../src/byrdit/basemap/proxy.js';
import { waybackEnabled } from './wayback/index.js';

/**
 * Shared runtime config for the two HTML flag features: the Byrd-IT Open base
 * map (GEV_BASEMAP) and Esri Wayback (GEV_BYRDIT_WAYBACK). Both gate a browser
 * feature through a same-origin flag: `<meta name="gev-basemap|gev-wayback"
 * content="1">`, read synchronously by `basemapFlagOn` / `waybackFlagOn`.
 *
 * Under `vite dev` the per-feature plugins inject those tags per runtime env
 * (src/byrdit/basemap/proxy.js, server/byrdit/wayback/index.js), already
 * runtime-correct. Under `vite preview`, though, Vite serves the built
 * dist/index.html and does NOT run transformIndexHtml (vite 6.4.4), so the
 * tags are whatever the BUILD env said: a preview started with different flags
 * serves tags that contradict the routes this very server mounts. This module
 * makes the tags runtime config under preview: a preview-only middleware
 * strips every baked flag meta from the served page and injects one tag per
 * flag the PREVIEW process has on, from the live env. Building is untouched
 * (dist keeps its baked tags for non-preview deployments), dev is untouched,
 * and there are no new upstream calls.
 */

/** The two flags this module owns, evaluated from the live env. */
export function runtimeFeatureFlags(env = process.env) {
  return { basemap: basemapEnabled(env), wayback: waybackEnabled(env) };
}

/** Baked tag, any attribute order or quote style; non-greedy so it stays one tag. */
const BAKED_META =
  /<meta\b[^>]*\bname\s*=\s*(["'])gev-(?:basemap|wayback)\1[^>]*>/gi;
const HEAD_TAG = /<head\b[^>]*>/i;
const HTML_TAG = /<html\b[^>]*>/i;
const META_HTML = Object.freeze({
  basemap: '<meta name="gev-basemap" content="1">',
  wayback: '<meta name="gev-wayback" content="1">',
});

/**
 * One runtime tag per enabled flag after every baked flag meta is removed,
 * right inside `<head>` (so the browser's first querySelector match is the
 * runtime answer). No `<head>`: after `<html>`; then at the very start.
 * @param {string} html
 * @param {{basemap?: boolean, wayback?: boolean}} flags
 */
export function applyRuntimeFlagMetas(
  html,
  { basemap = false, wayback = false } = {},
) {
  const tags =
    (basemap ? META_HTML.basemap : '') + (wayback ? META_HTML.wayback : '');
  const stripped = html.replace(BAKED_META, '');
  if (!tags) return stripped;
  const anchor = stripped.match(HEAD_TAG) ?? stripped.match(HTML_TAG);
  if (!anchor) return tags + stripped;
  return stripped.replace(anchor[0], () => anchor[0] + tags);
}

/**
 * The preview middleware: serves flag-correct HTML for the entry page (and
 * Vite's SPA fallback for extension-less routes) from the built outDir.
 * `readTarget(rel)` reads one file from the outDir — `null` is index.html —
 * or null when it does not exist, which keeps real files with sirv and lets
 * us hand non-files through to Vite's own fallback.
 *
 * API routes never engage: the feature plugins (basemap, Wayback, ...) own
 * those. The feature middleware runs before this plugin; the explicit guard
 * also prevents an HTML response from shadowing any later JSON route.
 * @param {{env?: Record<string, string|undefined>, readTarget?: (rel: string|null) => Promise<string|null>}} [options]
 */
export function previewFlagHtmlMiddleware({
  env = process.env,
  readTarget,
} = {}) {
  if (typeof readTarget !== 'function')
    throw new TypeError('previewFlagHtmlMiddleware requires readTarget');
  return async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    // No Accept gate: vite preview's SPA fallback answers html regardless of
    // Accept, and this middleware must not narrow that. API paths are the
    // exception — feature plugins own those (they run ahead of this one).
    // MCP is also a server endpoint, installed by a later plugin.
    const raw = String(req.url ?? '');
    const pathname = raw.split(/[?#]/)[0];
    if (
      pathname.startsWith('/api') ||
      pathname === '/mcp' ||
      pathname.startsWith('/mcp/')
    )
      return next();
    const last = pathname.slice(pathname.lastIndexOf('/') + 1);
    // '/' and '/index.html' are always the entry page; an extension-less path
    // is Vite's SPA fallback territory — sirv only answers real files.
    const isEntry = pathname === '/' || pathname === '/index.html';
    if (!isEntry && last.includes('.')) return next();
    let file;
    if (isEntry) {
      file = await readTarget(null);
      if (file == null) return next();
    } else {
      let rel;
      try {
        rel = decodeURIComponent(pathname.slice(1));
      } catch {
        return next();
      }
      file = await readTarget(rel);
      if (file != null) return next(); // a real file: sirv serves it
      file = await readTarget(null);
      if (file == null) return next(); // no build to serve
    }
    if (res.writableEnded) return undefined;
    const body = applyRuntimeFlagMetas(file, runtimeFeatureFlags(env));
    const headers = {
      'content-type': 'text/html; charset=utf-8',
      // The flags are runtime config now: a preview restart with different
      // flags must never be answered from a cache of the old page.
      'cache-control': 'no-store',
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    return res.end(body);
  };
}

/**
 * FS-backed reader for one file inside the built outDir, or null.
 * @param {string} directory absolute path of the build outDir
 */
export function readTargetResolver(directory) {
  const entry = path.join(directory, 'index.html');
  return async (rel) => {
    const target = rel == null ? entry : path.join(directory, rel);
    try {
      const root = await realpath(directory);
      const resolved = await realpath(target);
      const relative = path.relative(root, resolved);
      if (
        relative.startsWith(`..${path.sep}`) ||
        relative === '..' ||
        path.isAbsolute(relative)
      )
        return null;
      const info = await stat(resolved);
      if (!info.isFile()) return null;
      return await readFile(resolved, 'utf8');
    } catch {
      return null;
    }
  };
}

/**
 * The shared plugin: under preview it installs one middleware ahead of the
 * static server. No transformIndexHtml (building stays exactly as it is) and
 * no configureServer (dev keeps the per-feature runtime tags).
 * @param {{env?: Record<string, string|undefined>}} [options]
 */
export function featureFlagsHtmlPlugins({ env = process.env } = {}) {
  let readTarget = null;
  return [
    {
      name: 'byrdit-feature-flags',
      configResolved(config) {
        const outDir = config?.build?.outDir;
        if (!outDir) return;
        // build.outDir is preview's serving root (preview.outDir defaults
        // to it and the standalone config never overrides that).
        readTarget = readTargetResolver(
          path.isAbsolute(outDir)
            ? outDir
            : path.resolve(config.root ?? process.cwd(), outDir),
        );
      },
      configurePreviewServer(server) {
        server.middlewares.use((req, res, next) => {
          if (!readTarget) return next(); // never resolved: nothing to serve
          return previewFlagHtmlMiddleware({ env, readTarget })(req, res, next);
        });
      },
    },
  ];
}
