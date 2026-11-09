import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// The placeholder already contains the selected unit. A fixed unit in the
// translation would falsely label an mph limit as metres per second.
test('all translated speed-limit warnings leave the unit to the placeholder', () => {
  const directory = new URL('../../i18n/locales/', import.meta.url);
  const key = 'A waypoint speed is missing, zero or above {max}';
  const files = readdirSync(directory).filter((name) => name.endsWith('.json'));
  assert.ok(files.length > 0);
  for (const name of files) {
    const catalog = JSON.parse(readFileSync(new URL(name, directory), 'utf8'));
    assert.ok(catalog[key]?.includes('{max}'), name);
    assert.doesNotMatch(catalog[key], /m\/s|м\/с|米\/秒/, name);
  }
});
