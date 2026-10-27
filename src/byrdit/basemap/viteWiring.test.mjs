import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Touch point (BASEMAP.md 4.2): server/standalone/vite.config.js spreads
 * basemapPlugins() right after historyPlugins(). With GEV_BASEMAP unset the
 * plugin list is exactly the list without the fork module.
 */

async function pluginNames(t, flag) {
  const before = process.env.GEV_BASEMAP;
  if (flag === undefined) delete process.env.GEV_BASEMAP;
  else process.env.GEV_BASEMAP = flag;
  t.after(() => {
    if (before === undefined) delete process.env.GEV_BASEMAP;
    else process.env.GEV_BASEMAP = before;
  });
  const { default: config } =
    await import('../../../server/standalone/vite.config.js');
  const resolved = await config({ command: 'serve', mode: 'test' });
  return resolved.plugins
    .flat(Infinity)
    .filter(Boolean)
    .map((plugin) => plugin.name);
}

test('basemap OFF: the plugin list is exactly the list without the module', async (t) => {
  const off = await pluginNames(t, undefined);
  assert.ok(!off.includes('byrdit-basemap'));
  const on = await pluginNames(t, '1');
  assert.deepEqual(
    on.filter((name) => name !== 'byrdit-basemap'),
    off,
  );
});

test('basemap ON: registered before the provider plugins', async (t) => {
  const names = await pluginNames(t, '1');
  const basemap = names.indexOf('byrdit-basemap');
  assert.ok(basemap >= 0);
  assert.ok(basemap < names.indexOf('opensky-proxy'));
});

test('the upstream-owned touch point is the import plus one plugin line after historyPlugins', () => {
  const source = readFileSync(
    new URL('../../../server/standalone/vite.config.js', import.meta.url),
    'utf8',
  );
  const lines = source
    .split('\n')
    .filter((l) => l.includes('basemapPlugins'))
    .map((l) => l.trim());
  assert.deepEqual(lines, [
    "import { basemapPlugins } from '../byrdit/basemap.js';",
    '...basemapPlugins(),',
  ]);
  assert.match(
    source,
    /\.\.\.historyPlugins\(\),\n\s*\.\.\.basemapPlugins\(\),/,
  );
});
