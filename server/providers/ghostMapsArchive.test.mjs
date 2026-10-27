import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ghostMapsProxy } from './ghostMaps.js';
import {
  ArchiveUnavailableError,
  createGhostMapsArchive,
  ghostMapsArchiveDir,
  readOnlyGit,
} from './ghostMapsArchive.js';

const MASTER =
  'ArcGIS Data for ATAK (KMZs)/Common Intelligence Picture/Master Database/';
const KINETIC =
  'ArcGIS Data for ATAK (KMZs)/Common Intelligence Picture/30-Day Pulls/Kinetic_Activities_Last_30_Days.kmz';
const iso = (s) => Date.parse(s) / 1000;

/** A bare mirror shaped like the S4 archive, built with real git. */
function buildMirror(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostmaps-arch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bare = path.join(dir, 'mirror.git');
  const work = path.join(dir, 'work');
  const run = (cwd, args, env = {}) =>
    execFileSync('git', args, {
      cwd,
      env: { ...process.env, ...env, GIT_CONFIG_GLOBAL: '/dev/null' },
      encoding: 'utf8',
    }).trim();
  run(dir, ['init', '-q', '--bare', bare]);
  run(dir, ['init', '-q', '-b', 'main', work]);
  const commit = (when, files, message) => {
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(work, name)), { recursive: true });
      fs.writeFileSync(path.join(work, name), text);
    }
    run(work, ['add', '-A']);
    const stamp = `${when}`;
    run(
      work,
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message],
      { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp },
    );
    return run(work, ['rev-parse', 'HEAD']);
  };
  const c1 = commit('2026-10-10T12:00:00Z', {
    [`${MASTER}S2U_CIP_October_10_2026_Export_1.kmz`]: 'CIP-OCT-10',
  }, 'Oct 10 update');
  const c2 = commit('2026-10-15T12:00:00Z', {
    [`${MASTER}S2U_CIP_October_15_2026_Export_1.kmz`]: 'CIP-OCT-15',
    [KINETIC]: 'KINETIC-15',
  }, 'Oct 15 update\n\nbody');
  const c3 = commit('2026-10-20T12:00:00Z', {
    [KINETIC]: 'KINETIC-20',
  }, 'Oct 20 update');
  run(work, ['push', '-q', bare, 'HEAD:refs/remotes/origin/main']);
  return { dir, bare, work, run, commit, c1, c2, c3 };
}

const at = (s) => Date.parse(s);

test('catalogAt maps a time to the commit published then', async (t) => {
  const m = buildMirror(t);
  const archive = createGhostMapsArchive({ repoDir: m.bare });
  const before = await archive.catalogAt(at('2026-10-10T11:59:59Z'));
  assert.equal(before.position, 'before');
  assert.deepEqual(before.products, []);
  assert.equal(before.commit, null);
  assert.equal(before.firstCommittedAt, at('2026-10-10T12:00:00Z'));
  assert.equal(before.history, true);

  const exact = await archive.catalogAt(at('2026-10-10T12:00:00Z'));
  assert.equal(exact.position, 'exact');
  assert.equal(exact.commit, m.c1);
  assert.deepEqual(exact.products.map((p) => p.id), ['cip']);
  assert.match(exact.products[0].fileName, /October_10_2026/);
  assert.equal(exact.message, 'Oct 10 update');
  assert.equal(exact.committedAt, at('2026-10-10T12:00:00Z'));

  const between = await archive.catalogAt(at('2026-10-17T00:00:00Z'));
  assert.equal(between.position, 'between');
  assert.equal(between.commit, m.c2);
  assert.deepEqual(between.products.map((p) => p.id), ['cip', 'kinetic-30d']);
  assert.match(between.products[0].fileName, /October_15_2026/);
  assert.equal(between.message, 'Oct 15 update');

  const after = await archive.catalogAt(at('2026-12-31T00:00:00Z'));
  assert.equal(after.position, 'after');
  assert.equal(after.commit, m.c3);
  // the edition still published: CIP stays from c2's tree, kinetic is the new blob
  assert.match(after.products[0].fileName, /October_15_2026/);
  assert.notEqual(
    after.products[1].version,
    between.products[1].version,
    'kinetic changed at c3',
  );
});

test('fileAt returns the exact blob of that commit and refuses the rest', async (t) => {
  const m = buildMirror(t);
  const archive = createGhostMapsArchive({ repoDir: m.bare });
  const mid = await archive.catalogAt(at('2026-10-17T00:00:00Z'));
  const kin = mid.products.find((p) => p.id === 'kinetic-30d');
  const hit = await archive.fileAt(mid.commit, 'kinetic-30d', kin.version);
  assert.equal(hit.bytes.toString(), 'KINETIC-15');
  const late = await archive.catalogAt(at('2026-10-21T00:00:00Z'));
  const kinLate = late.products.find((p) => p.id === 'kinetic-30d');
  assert.equal(
    (await archive.fileAt(late.commit, 'kinetic-30d', kinLate.version)).bytes.toString(),
    'KINETIC-20',
  );
  // an old commit still serves its own edition after a newer one landed
  assert.equal((await archive.fileAt(mid.commit, 'kinetic-30d', kin.version)).bytes.toString(), 'KINETIC-15');
  // wrong id / wrong blob for the product / a commit that is not listed
  assert.equal(await archive.fileAt(mid.commit, 'cip', kin.version), null);
  assert.equal(await archive.fileAt(mid.commit, 'kinetic-30d', kinLate.version), null);
  assert.equal(await archive.fileAt('0'.repeat(40), 'cip', kin.version), null);
  assert.equal(await archive.fileAt('HEAD', 'cip', kin.version), null);
  assert.equal(await archive.fileAt(mid.commit, 'cip', 'nothex'), null);
});

test('an old head kept only under refs/archive is still found', async (t) => {
  const m = buildMirror(t);
  // S2 force-pushed: the old head d1 survives only as an archive ref
  m.run(m.work, ['checkout', '-q', '-b', 'rewritten', m.c1]);
  const d1 = m.commit('2026-10-12T00:00:00Z', {
    [KINETIC]: 'KINETIC-REWRITTEN',
  }, 'rewritten head');
  m.run(m.work, ['push', '-q', m.bare, `${d1}:refs/archive/main/20261012T000100Z-${d1.slice(0, 12)}`]);
  const archive = createGhostMapsArchive({ repoDir: m.bare });
  const cat = await archive.catalogAt(at('2026-10-13T00:00:00Z'));
  assert.equal(cat.commit, d1);
  assert.equal(cat.position, 'between');
});

test('reading never changes the mirror and refuses writing git commands', async (t) => {
  const m = buildMirror(t);
  const snapshot = () =>
    execFileSync('find', [m.bare, '-type', 'f', '-printf', '%p %s %T@\\n'], {
      encoding: 'utf8',
    })
      .split('\n')
      .sort()
      .join('\n');
  const before = snapshot();
  const archive = createGhostMapsArchive({ repoDir: m.bare });
  for (const when of ['2026-10-10T00:00:00Z', '2026-10-17T00:00:00Z', '2026-12-31T00:00:00Z']) {
    const cat = await archive.catalogAt(at(when));
    for (const p of cat.products) await archive.fileAt(cat.commit, p.id, p.version);
  }
  assert.equal(snapshot(), before);
  const git = readOnlyGit(m.bare);
  for (const verb of ['fetch', 'gc', 'prune', 'repack', 'update-ref', 'config', 'push', 'reflog', 'branch'])
    await assert.rejects(git([verb]), /not allowed/, verb);
  assert.equal(snapshot(), before);
});

test('a missing mirror is an unavailable archive', async () => {
  const archive = createGhostMapsArchive({ repoDir: '/nonexistent/ghostmaps.git' });
  await assert.rejects(archive.catalogAt(Date.now()), ArchiveUnavailableError);
});

test('a new commit is picked up when the refs move', async (t) => {
  const m = buildMirror(t);
  let clock = 1_000_000;
  const archive = createGhostMapsArchive({ repoDir: m.bare, now: () => clock });
  assert.equal((await archive.catalogAt(at('2027-01-01T00:00:00Z'))).commit, m.c3);
  const c4 = m.commit('2026-10-25T12:00:00Z', { [KINETIC]: 'KINETIC-25' }, 'Oct 25');
  m.run(m.work, ['push', '-q', m.bare, 'HEAD:refs/remotes/origin/main']);
  clock += 60_000;
  assert.equal((await archive.catalogAt(at('2027-01-01T00:00:00Z'))).commit, c4);
});

test('the archive path comes from GHOSTMAPS_ARCHIVE or the timer default', () => {
  assert.equal(ghostMapsArchiveDir('/x/y.git', '/home/u'), '/x/y.git');
  assert.equal(
    ghostMapsArchiveDir('', '/home/u'),
    '/home/u/ghostmaps-archive/GhostMaps.git',
  );
  assert.equal(
    ghostMapsArchiveDir('  ', '/home/u'),
    '/home/u/ghostmaps-archive/GhostMaps.git',
  );
});

function proxyOver(archive) {
  let started = 0;
  const watcher = {
    start: () => {
      started += 1;
      return Promise.resolve(false);
    },
    catalog: () => ({ commit: null }),
    subscribers: () => 0,
  };
  let handler;
  ghostMapsProxy({ watcher, archive }).configureServer({
    middlewares: { use: (_route, fn) => (handler = fn) },
  });
  const call = async (url, method = 'GET') => {
    const res = {
      destroyed: false,
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.raw = body;
        this.body = String(body ?? '');
      },
    };
    await handler({ method, url }, res);
    return res;
  };
  return { call, started: () => started };
}

test('the /at routes answer from the archive and never start the live watcher', async (t) => {
  const m = buildMirror(t);
  const { call, started } = proxyOver(createGhostMapsArchive({ repoDir: m.bare }));
  const res = await call('/at?t=2026-10-17T00:00:00Z');
  assert.equal(res.status, 200);
  const cat = JSON.parse(res.body);
  assert.equal(cat.commit, m.c2);
  assert.equal(cat.history, true);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  const kin = cat.products.find((p) => p.id === 'kinetic-30d');
  const file = await call(`/at/file/kinetic-30d?c=${cat.commit}&v=${kin.version}`);
  assert.equal(file.status, 200);
  assert.equal(file.raw.toString(), 'KINETIC-15');
  assert.match(file.headers['Cache-Control'], /immutable/);
  assert.equal(file.headers['X-GhostMaps-Version'], kin.version);
  assert.equal(started(), 0);
});

test('the /at routes refuse bad input and report an unavailable mirror', async (t) => {
  const m = buildMirror(t);
  const { call } = proxyOver(createGhostMapsArchive({ repoDir: m.bare }));
  for (const url of ['/at', '/at?t=', '/at?t=2026-10-17', '/at?t=yesterday', '/at?t=1e3'])
    assert.equal((await call(url)).status, 400, url);
  assert.equal((await call('/at?t=2026-10-17T00:00:00Z', 'POST')).status, 405);
  assert.equal((await call('/at/file/cip?c=HEAD&v=zz')).status, 404);
  assert.equal((await call('/at/file/cip')).status, 404);
  assert.equal((await call('/at/file/../x?c=1&v=2')).status, 404);
  const gone = proxyOver(createGhostMapsArchive({ repoDir: '/nonexistent/g.git' }));
  const res = await gone.call('/at?t=2026-10-17T00:00:00Z');
  assert.equal(res.status, 503);
  assert.deepEqual(JSON.parse(res.body), { error: 'ghostmaps_archive_unavailable' });
  assert.equal(gone.started(), 0);
});

test('hostile query values and a failing mirror echo nothing back or to the log', async (t) => {
  const logs = [];
  for (const level of ['log', 'warn', 'error', 'info', 'debug'])
    t.mock.method(console, level, (...args) => logs.push(args.map(String).join(' ')));
  const secrets = [
    'Bearer synth-token-9f3a7c21',
    'https://user:synth-pass-77@evil.example/x',
    'synthkey_ABC123SUFFIX',
    'api_key=synth-key-5512',
  ];
  const mirrorPath = '/srv/private/mirror-synth.git';
  const m = buildMirror(t);
  const targets = [
    proxyOver(createGhostMapsArchive({ repoDir: m.bare })),
    proxyOver(createGhostMapsArchive({ repoDir: mirrorPath })),
  ];
  const seen = [];
  for (const { call } of targets)
    for (const s of secrets) {
      const q = encodeURIComponent(s);
      for (const url of [
        `/at?t=${q}`,
        `/at?t=2026-10-17T00:00:00Z&x=${q}`,
        `/at/file/cip?c=${q}&v=${q}`,
        `/at/file/${q}?c=${q}`,
      ]) {
        const res = await call(url);
        seen.push(res.body, JSON.stringify(res.headers ?? {}));
      }
    }
  const haystack = [...seen, ...logs].join('\n');
  for (const s of secrets)
    for (const form of [s, encodeURIComponent(s), Buffer.from(s).toString('base64'), s.slice(-6), s.match(/synth[\w-]+/)[0]])
      assert.ok(!haystack.includes(form), `leaked ${form.length} chars`);
  assert.ok(!haystack.includes(mirrorPath), 'mirror path leaked');
  assert.ok(seen.length >= 32);
});

test('an oversized blob is not found without reading it, and the git cap holds at 4', async (t) => {
  const m = buildMirror(t);
  const real = readOnlyGit(m.bare);
  const calls = [];
  let running = 0;
  let peak = 0;
  let oversize = false;
  const runGit = async (args, options) => {
    running += 1;
    peak = Math.max(peak, running);
    calls.push(args.join(' '));
    try {
      await new Promise((r) => setTimeout(r, 3));
      if (oversize && args[0] === 'cat-file' && args[1] === '-s')
        return Buffer.from('999999999\n');
      return await real(args, options);
    } finally {
      running -= 1;
    }
  };
  const archive = createGhostMapsArchive({ repoDir: m.bare, runGit });
  const mid = await archive.catalogAt(at('2026-10-17T00:00:00Z'));
  const kin = mid.products.find((p) => p.id === 'kinetic-30d');
  // normal size passes
  assert.ok(await archive.fileAt(mid.commit, 'kinetic-30d', kin.version));
  // the cap: many concurrent reads never run more than four git calls
  await Promise.all(
    Array.from({ length: 20 }, () =>
      archive.fileAt(mid.commit, 'kinetic-30d', kin.version),
    ),
  );
  assert.ok(peak <= 4, `peak ${peak}`);
  oversize = true;
  calls.length = 0;
  assert.equal(
    await archive.fileAt(mid.commit, 'kinetic-30d', kin.version),
    null,
  );
  assert.equal(
    calls.some((c) => c.startsWith('cat-file blob')),
    false,
  );
});
