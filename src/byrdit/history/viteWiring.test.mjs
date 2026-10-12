import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Touch point (DESIGN 4.1): server/standalone/vite.config.js spreads
 * historyPlugins() before every provider plugin, so a bridged route is
 * answered before upstream's plugin sees it. With every flag off the plugin
 * list is unchanged (upstream's order pin in src/tooling/viteBuild.test.mjs).
 */

async function pluginNames(t, flag) {
  const before = process.env.GEV_BRIDGE_MILITARY;
  if (flag === undefined) delete process.env.GEV_BRIDGE_MILITARY;
  else process.env.GEV_BRIDGE_MILITARY = flag;
  t.after(() => {
    if (before === undefined) delete process.env.GEV_BRIDGE_MILITARY;
    else process.env.GEV_BRIDGE_MILITARY = before;
  });
  const { default: config } =
    await import('../../../server/standalone/vite.config.js');
  const resolved = await config({ command: 'serve', mode: 'test' });
  return resolved.plugins
    .flat(Infinity)
    .filter(Boolean)
    .map((plugin) => plugin.name);
}

test('bridge ON: vite.config.js registers it before every provider plugin', async (t) => {
  const names = await pluginNames(t, '1');
  const bridge = names.indexOf('byrdit-history-bridge');
  assert.ok(bridge >= 0, 'history bridge plugin is registered');
  assert.ok(
    bridge < names.indexOf('opensky-proxy'),
    'before the first provider',
  );
  assert.ok(bridge < names.indexOf('adsblol-proxy'));
});

test('bridge OFF: the plugin list is exactly the list without the fork module', async (t) => {
  const off = await pluginNames(t, undefined);
  assert.ok(!off.includes('byrdit-history-bridge'));
  const on = await pluginNames(t, '1');
  assert.deepEqual(
    on.filter((name) => name !== 'byrdit-history-bridge'),
    off,
  );
});

test('the upstream-owned touch point is the import plus one plugin line', () => {
  const source = readFileSync(
    new URL('../../../server/standalone/vite.config.js', import.meta.url),
    'utf8',
  );
  const lines = source.split('\n').filter((l) => l.includes('historyPlugins'));
  assert.deepEqual(
    lines.map((l) => l.trim()),
    [
      "import { historyPlugins } from '../byrdit/history.js';",
      '...historyPlugins(),',
    ],
  );
  const plugins = source.slice(source.indexOf('plugins: ['));
  assert.ok(
    plugins.indexOf('...historyPlugins()') <
      plugins.indexOf('...localProviderPlugins('),
  );
});
