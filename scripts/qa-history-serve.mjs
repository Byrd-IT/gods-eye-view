#!/usr/bin/env node
/**
 * QA server for the B12 umbrella QA (card t_5aa880c7): GEV's real
 * standalone Vite server (server/standalone/vite.config.js) from THIS
 * checkout, with the history API on, so /api/history/* runs this branch's
 * server code (B9/B10 + B12c slices) against the real Elasticsearch.
 *
 *   node scripts/qa-history-serve.mjs --port 4410 < reader.env
 *
 * stdin: ES_URL=... and ES_API_KEY=... lines (the gev-history reader key
 * file). They are read once from stdin and only placed in this process's
 * environment; never printed or written. Collector bridges are off
 * (GEV_BRIDGE_* removed), so live layers use their own upstreams, as in a
 * plain dev server. Loopback only.
 */
import { readFileSync } from 'node:fs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const env = {};
for (const line of readFileSync(0, 'utf8').split('\n')) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}
if (!env.ES_URL || !env.ES_API_KEY) {
  console.error('stdin must carry ES_URL and ES_API_KEY');
  process.exit(2);
}
process.env.GEV_HISTORY_API = '1';
process.env.GEV_HISTORY_ES_URL = env.ES_URL;
process.env.GEV_HISTORY_ES_API_KEY = env.ES_API_KEY;
for (const k of Object.keys(process.env))
  if (k.startsWith('GEV_BRIDGE_')) delete process.env[k];

const { createServer } = await import('vite');
const server = await createServer({
  configFile: 'server/standalone/vite.config.js',
  server: {
    host: '127.0.0.1',
    port: Number(arg('--port', '4410')),
    strictPort: true,
    // a QA run, not development: no HMR websocket through the QA hop
    hmr: false,
  },
  logLevel: 'warn',
});
await server.listen();
console.log('qa server on', server.resolvedUrls?.local?.[0] ?? 'loopback');
