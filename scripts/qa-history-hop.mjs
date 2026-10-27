#!/usr/bin/env node
/**
 * QA hop for the B12 umbrella QA (card t_5aa880c7): TLS (HTTP/2, like the
 * public NPM host, with HTTP/1.1 fallback) + Basic Auth in front of a GEV
 * server. /api/history/* goes to --history, everything else to --app. The
 * QA runner points both at this checkout's own server
 * (scripts/qa-history-serve.mjs, HMR off). This script never handles an
 * Elasticsearch credential.
 *
 *   QA_HOP_PASSWORD=<throwaway> node scripts/qa-history-hop.mjs \
 *     --listen 15444 --app 127.0.0.1:4410 --history 127.0.0.1:4410 \
 *     --key key.pem --cert cert.pem
 *
 * User 'qa'. The password is a throwaway made by the QA runner; it guards
 * a loopback port for the length of one run. HTTP/2 matters: over
 * HTTP/1.1 the browser opens at most 6 connections per origin, so with
 * many layers on, history requests queue behind live ones and the timed
 * frame fetch would include that queueing.
 */
import fs from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const LISTEN = Number(arg('--listen', '15444'));
const [appHost, appPort] = arg('--app', '127.0.0.1:4410').split(':');
const [histHost, histPort] = arg('--history', '127.0.0.1:4410').split(':');
const pw = process.env.QA_HOP_PASSWORD;
if (!pw) {
  console.error('QA_HOP_PASSWORD is not set');
  process.exit(2);
}
const expected = 'Basic ' + Buffer.from(`qa:${pw}`).toString('base64');
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
// connection-specific headers: not forwarded, and illegal in HTTP/2
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'host',
  'authorization',
  'http2-settings',
  'te',
]);
const clean = (headers) =>
  Object.fromEntries(
    Object.entries(headers).filter(
      ([k]) => !k.startsWith(':') && !HOP_BY_HOP.has(k.toLowerCase()),
    ),
  );

const server = http2.createSecureServer(
  {
    key: fs.readFileSync(arg('--key', 'key.pem')),
    cert: fs.readFileSync(arg('--cert', 'cert.pem')),
    allowHTTP1: true,
  },
  (req, res) => {
    if (
      process.env.QA_HOP_NOAUTH !== '1' &&
      req.headers.authorization !== expected
    ) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="gev-qa"' });
      res.end();
      return;
    }
    const history = /^\/api\/history\//.test(req.url ?? '');
    const port = history ? histPort : appPort;
    const up = http.request(
      {
        host: history ? histHost : appHost,
        port: Number(port),
        path: req.url,
        method: req.method,
        // the history API accepts loopback hosts only (isAllowedHost)
        headers: { ...clean(req.headers), host: `localhost:${port}` },
        agent,
      },
      (r) => {
        res.writeHead(r.statusCode ?? 502, clean(r.headers));
        r.pipe(res);
      },
    );
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  },
);
server.on('sessionError', () => {});
server.listen(LISTEN, '127.0.0.1', () =>
  console.log(`qa hop on https://127.0.0.1:${LISTEN} (h2 + http/1.1)`),
);
