import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const VITE = path.join(REPO, 'node_modules/vite/bin/vite.js');
const CONFIG = path.join(HERE, 'fixtures/sigterm-vite.config.mjs');

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function countFiles(dir) {
  let n = 0;
  for (const e of await fs
    .readdir(dir, { withFileTypes: true })
    .catch(() => [])) {
    n += e.isDirectory() ? await countFiles(path.join(dir, e.name)) : 1;
  }
  return n;
}

async function until(fn, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not ready */
    }
    if (Date.now() > end) throw new Error('timed out waiting for vite');
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('SIGTERM of a real vite dev server lands the final stats.json flush', async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-wb-sigterm-'));
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [
      VITE,
      '--config',
      CONFIG,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    {
      cwd: REPO,
      env: {
        ...process.env,
        GEV_BYRDIT_WAYBACK: '1',
        GEV_BYRDIT_WAYBACK_CACHE_DIR: cacheDir,
      },
      stdio: 'ignore',
    },
  );
  const exited = new Promise((resolve) =>
    child.once('exit', (code, sig) => resolve({ code, sig })),
  );
  try {
    const base = `http://127.0.0.1:${port}/api/byrdit/wayback`;
    const rel = await until(async () => {
      const r = await fetch(`${base}/releases`);
      if (!r.ok) return null;
      const body = await r.json();
      const list = Array.isArray(body) ? body : (body.releases ?? []);
      return list[0]?.release ?? null;
    });
    for (let c = 0; c < 8; c += 1) {
      const r = await fetch(`${base}/tile/${rel}/15/13527/${7630 + c}`);
      assert.equal(r.status, 200);
      await r.arrayBuffer();
    }
    // All 8 are on disk. The first save is immediate and later ones are
    // throttled, so stats.json is still behind when SIGTERM arrives.
    const files = await until(async () => {
      const n = await countFiles(path.join(cacheDir, 't'));
      return n >= 8 ? n : 0;
    });
    child.kill('SIGTERM');
    const { code } = await exited;
    assert.ok(code === 0 || code === 143 || code === null, `exit ${code}`);
    const stats = JSON.parse(
      await fs.readFile(path.join(cacheDir, 'stats.json'), 'utf8'),
    );
    assert.equal(
      stats.tiles,
      files,
      'stats.json tiles == files on disk after SIGTERM',
    );
    assert.ok(stats.bytes > 0);
  } finally {
    child.kill('SIGKILL');
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
});
