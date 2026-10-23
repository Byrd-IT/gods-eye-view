import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const script = path.join(root, 'deploy/gev-wayback-cache-sync.sh');
const stale = path.join(root, 'deploy/gev-wayback-cache-sync-staleness.sh');
const rsync = spawnSync('rsync', ['--version']);
const skip = rsync.status === 0 ? false : 'rsync not installed';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-wb-sync-'));
  const src = path.join(dir, 'src');
  const dest = path.join(dir, 'dest');
  const state = path.join(dir, 'state');
  fs.mkdirSync(path.join(src, 't/100/17/5'), { recursive: true });
  fs.mkdirSync(dest);
  fs.writeFileSync(path.join(src, 't/100/17/5/6'), 'tile-one');
  fs.writeFileSync(path.join(src, 't/100/17/5/7.123.tmp'), 'half-written');
  fs.writeFileSync(path.join(src, 'stats.json'), '{}');
  const env = {
    ...process.env,
    GEV_WAYBACK_CACHE_DIR: src,
    GEV_WAYBACK_SYNC_DEST: dest,
    GEV_WAYBACK_SYNC_STATE: state,
  };
  return { dir, src, dest, state, env };
}

test('cache sync: copies tiles, skips tmp files and stats, writes the last-ok stamp', { skip }, () => {
  const { src, dest, state, env } = setup();
  execFileSync(script, { env });
  assert.equal(fs.readFileSync(path.join(dest, 't/100/17/5/6'), 'utf8'), 'tile-one');
  assert.equal(fs.existsSync(path.join(dest, 't/100/17/5/7.123.tmp')), false);
  assert.equal(fs.existsSync(path.join(dest, 'stats.json')), false);
  assert.match(fs.readFileSync(path.join(state, 'last-ok'), 'utf8'), /^\d{4}-\d\d-\d\dT/);
  assert.ok(src);
});

test('cache sync is append-only: a deleted or changed source tile never changes the copy', { skip }, () => {
  const { src, dest, env } = setup();
  execFileSync(script, { env });
  fs.writeFileSync(path.join(src, 't/100/17/5/6'), 'DAMAGED');
  fs.mkdirSync(path.join(src, 't/100/17/5'), { recursive: true });
  fs.writeFileSync(path.join(src, 't/100/17/5/8'), 'tile-two');
  execFileSync(script, { env });
  assert.equal(fs.readFileSync(path.join(dest, 't/100/17/5/6'), 'utf8'), 'tile-one', 'existing copy untouched');
  assert.equal(fs.readFileSync(path.join(dest, 't/100/17/5/8'), 'utf8'), 'tile-two', 'new tile appended');
  fs.rmSync(path.join(src, 't'), { recursive: true });
  execFileSync(script, { env });
  assert.equal(fs.readFileSync(path.join(dest, 't/100/17/5/8'), 'utf8'), 'tile-two', 'nothing deleted on S1');
});

test('cache sync: a failing rsync fails the run (the unit pages)', { skip }, () => {
  const { env } = setup();
  const r = spawnSync(script, { env: { ...env, GEV_WAYBACK_SYNC_DEST: '/nonexistent-dir-xyz/a/b' } });
  assert.notEqual(r.status, 0);
});

test('cache sync: restore command copies a lost cache back without overwriting', { skip }, () => {
  const { src, dest, env } = setup();
  execFileSync(script, { env });
  fs.rmSync(path.join(src, 't'), { recursive: true });
  execFileSync('rsync', ['-a', '--ignore-existing', '--exclude', '*.tmp', `${dest}/`, `${src}/`]);
  assert.equal(fs.readFileSync(path.join(src, 't/100/17/5/6'), 'utf8'), 'tile-one');
});

test('staleness check: no stamp / old stamp fail, fresh stamp passes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-wb-stale-'));
  const env = { ...process.env, GEV_WAYBACK_SYNC_STATE: dir };
  assert.equal(spawnSync(stale, [], { env }).status, 1);
  fs.writeFileSync(path.join(dir, 'last-ok'), new Date(Date.now() - 3600_000).toISOString());
  assert.equal(spawnSync(stale, [], { env }).status, 0);
  fs.writeFileSync(path.join(dir, 'last-ok'), new Date(Date.now() - 40 * 3600_000).toISOString());
  assert.equal(spawnSync(stale, [], { env }).status, 1);
});
