// Fixture for sigterm.test.mjs: a real vite dev server carrying only the
// wayback plugin, with an offline scripted upstream (no network).
import { waybackPlugins } from '../index.js';

const RAW = {
  63116: {
    itemTitle: 'World Imagery (Wayback 2026-09-24)',
    itemURL:
      'https://wayback.maptiles.arcgis.com/x/tile/63116/{level}/{row}/{col}',
  },
};
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff]),
  Buffer.alloc(400, 7),
]);

const fetchImpl = async (url) =>
  String(url).includes('waybackconfig')
    ? new Response(JSON.stringify(RAW))
    : new Response(JPEG, {
        status: 200,
        headers: { 'content-type': 'image/jpeg', etag: '"e1"' },
      });

export default {
  root: new URL('./root/', import.meta.url).pathname,
  logLevel: 'silent',
  plugins: waybackPlugins({ fetchImpl, log: () => {} }),
};
