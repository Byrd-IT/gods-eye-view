import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GHOSTMAPS_MAX_FILE_BYTES,
  GHOSTMAPS_REPO,
  buildGhostMapsCatalog,
} from '../../src/layers/ghostMaps/catalog.js';
import { pickCommitAt } from '../../src/layers/ghostMaps/historyAt.js';

// GhostMaps "as published" archive reader (History playback, card G1).
//
// The archive is a bare git mirror of the S2 repository kept by the
// ghostmaps-archive timer (~/ghostmaps-archive/GhostMaps.git: every upstream
// head also gets refs/archive/<branch>/<UTC>-<sha12>). This module only READS
// it with local git (no network, no GitHub API) and maps a time to the
// product files S2 had published then. It never writes to the mirror: the
// allow-list below holds read-only git subcommands only (no fetch, gc, prune,
// update-ref, repack ...), and the child environment disables optional locks.

/** The only git subcommands this module may run (all read-only). */
export const READ_ONLY_GIT = Object.freeze([
  'log',
  'ls-tree',
  'cat-file',
  'for-each-ref',
]);

const LIST_TIMEOUT_MS = 20_000;
const BLOB_TIMEOUT_MS = 60_000;
const MAX_LOG_BYTES = 16 * 1024 * 1024;
const MAX_TREE_BYTES = 16 * 1024 * 1024;
const MAX_CONCURRENT_GIT = 4;
const CATALOG_CACHE_MAX = 16;
const COMMIT_RE = /^[0-9a-f]{40}$/;

/** The mirror location: GHOSTMAPS_ARCHIVE, else the timer's default path. */
export function ghostMapsArchiveDir(
  raw = process.env.GHOSTMAPS_ARCHIVE,
  home = os.homedir(),
) {
  const value = String(raw || '').trim();
  return value || path.join(home, 'ghostmaps-archive', 'GhostMaps.git');
}

export class ArchiveUnavailableError extends Error {
  constructor(message = 'GhostMaps archive unavailable') {
    super(message);
    this.name = 'ArchiveUnavailableError';
  }
}

/** Run git with an argument vector (no shell), read-only subcommands only. */
export function readOnlyGit(repoDir) {
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    LC_ALL: 'C',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
  return (
    args,
    { timeoutMs = LIST_TIMEOUT_MS, maxBuffer = MAX_TREE_BYTES } = {},
  ) =>
    new Promise((resolve, reject) => {
      if (!READ_ONLY_GIT.includes(args[0]))
        return reject(new Error(`git ${args[0]} is not allowed here`));
      execFile(
        'git',
        ['--git-dir', repoDir, ...args],
        { env, timeout: timeoutMs, maxBuffer, encoding: 'buffer' },
        (error, stdout) => {
          if (error) return reject(new ArchiveUnavailableError());
          resolve(stdout);
        },
      );
    });
}

/**
 * @param {object} [options]
 * @param {string} [options.repoDir]  bare mirror path
 * @param {Function} [options.runGit] (args, {timeoutMs, maxBuffer}) => Buffer;
 *   a test seam. The default enforces the read-only allow-list.
 * @param {() => number} [options.now]
 * @param {number} [options.listTtlMs]  how long a commit list is trusted
 */
export function createGhostMapsArchive({
  repoDir = ghostMapsArchiveDir(),
  runGit = readOnlyGit(repoDir),
  now = () => Date.now(),
  listTtlMs = 5_000,
} = {}) {
  let list = null; // {at, commits, set, signature}
  let listing = null;
  const catalogs = new Map(); // commit sha -> products
  let active = 0;
  const waiting = [];

  async function limited(fn) {
    // A freed slot goes straight to the next waiter (active stays put), so a
    // new caller cannot slip in between and push the count past the cap.
    if (active >= MAX_CONCURRENT_GIT)
      await new Promise((resolve) => waiting.push(resolve));
    else active += 1;
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  }

  const git = (args, options) => limited(() => runGit(args, options));

  /** Published heads, newest first by walk order: [{sha, ts, message}]. */
  async function readCommits() {
    if (!fs.existsSync(repoDir)) throw new ArchiveUnavailableError();
    const refs = String(
      await git([
        'for-each-ref',
        '--format=%(objectname) %(refname)',
        'refs/remotes/origin',
        'refs/archive',
      ]),
    );
    // The signature of every ref the mirror holds: unchanged means the
    // commit list is unchanged.
    const signature = refs;
    if (list && list.signature === signature) {
      list.at = now();
      return list;
    }
    // Published heads: the branch head and every head the timer archived
    // (so a force-push upstream does not lose an old head).
    const branch = GHOSTMAPS_REPO.branch;
    const tips = [];
    for (const line of refs.split('\n')) {
      const [sha, name] = line.split(' ');
      if (
        COMMIT_RE.test(sha || '') &&
        (name === `refs/remotes/origin/${branch}` ||
          name?.startsWith(`refs/archive/${branch}/`))
      )
        tips.push(sha);
    }
    if (!tips.length) {
      list = { at: now(), commits: [], set: new Set(), signature };
      return list;
    }
    const raw = await git(
      [
        'log',
        '--first-parent',
        '-z',
        '--format=%H%x1f%ct%x1f%s',
        ...new Set(tips),
      ],
      { maxBuffer: MAX_LOG_BYTES },
    );
    const seen = new Set();
    const commits = [];
    for (const record of String(raw).split('\0')) {
      const [sha, ts, ...subject] = record.split('\x1f');
      const time = Number(ts);
      if (!COMMIT_RE.test(sha || '') || !Number.isFinite(time) || seen.has(sha))
        continue;
      seen.add(sha);
      commits.push({
        sha,
        ts: time,
        message: subject.join('\x1f').split('\n')[0].slice(0, 200),
      });
    }
    list = { at: now(), commits, set: seen, signature };
    return list;
  }

  async function commitList() {
    if (list && now() - list.at < listTtlMs) return list;
    listing ??= readCommits().finally(() => {
      listing = null;
    });
    return listing;
  }

  /** Products (the live catalog rules) of one commit's tree. */
  async function productsOf(sha) {
    const hit = catalogs.get(sha);
    if (hit) {
      catalogs.delete(sha);
      catalogs.set(sha, hit);
      return hit;
    }
    const raw = await git(['ls-tree', '-r', '-l', '-z', sha], {
      maxBuffer: MAX_TREE_BYTES,
    });
    const tree = [];
    for (const record of String(raw).split('\0')) {
      const m = /^\d+ (\w+) ([0-9a-f]{40}) +(\d+|-)\t([\s\S]+)$/.exec(record);
      if (m)
        tree.push({
          type: m[1],
          sha: m[2],
          size: m[3] === '-' ? 0 : Number(m[3]),
          path: m[4],
        });
    }
    const products = buildGhostMapsCatalog(tree);
    catalogs.set(sha, products);
    while (catalogs.size > CATALOG_CACHE_MAX)
      catalogs.delete(catalogs.keys().next().value);
    return products;
  }

  const publicProduct = ({
    id,
    title,
    defaultOn,
    fileName,
    fileTitle,
    version,
    size,
    dateMs,
  }) => ({ id, title, defaultOn, fileName, fileTitle, version, size, dateMs });

  return {
    repoDir,

    /**
     * The catalog S2 had published at `tMs`, in the live catalog's shape plus
     * `history: true`, `position` and `asOf`. Before the first commit there
     * are no products (nothing was published yet).
     */
    async catalogAt(tMs) {
      const { commits } = await commitList();
      const { position, commit } = pickCommitAt(commits, tMs);
      let firstTs = null;
      for (const c of commits)
        if (firstTs === null || c.ts < firstTs) firstTs = c.ts;
      const base = {
        history: true,
        asOf: new Date(tMs).toISOString(),
        position,
        repo: GHOSTMAPS_REPO.url,
        branch: GHOSTMAPS_REPO.branch,
        checkedAt: null,
        changedAt: null,
        pollMs: null,
        error: null,
        // the first recorded commit, so "before" can say what the archive
        // starts at
        firstCommittedAt: firstTs === null ? null : firstTs * 1000,
      };
      if (!commit)
        return {
          ...base,
          commit: null,
          committedAt: null,
          message: null,
          products: [],
        };
      const products = await productsOf(commit.sha);
      return {
        ...base,
        commit: commit.sha,
        committedAt: commit.ts * 1000,
        message: commit.message || null,
        products: products.map(publicProduct),
      };
    },

    /**
     * One product file of a published commit, by commit and blob sha (so the
     * answer is immutable). Only a commit the archive lists, and only a blob
     * that commit's catalog names for `id`, is ever read.
     * @returns {Promise<?{product: object, bytes: Buffer}>} null = unknown
     */
    async fileAt(commitSha, id, version) {
      if (!COMMIT_RE.test(commitSha || '') || !COMMIT_RE.test(version || ''))
        return null;
      const { set } = await commitList();
      if (!set.has(commitSha)) return null;
      const product = (await productsOf(commitSha)).find(
        (p) => p.id === id && p.version === version,
      );
      if (!product) return null;
      // Size first: an oversized file is "not found", not a maxBuffer 503.
      const size = Number.parseInt(
        String(await git(['cat-file', '-s', product.version])).trim(),
        10,
      );
      if (!Number.isFinite(size) || size > GHOSTMAPS_MAX_FILE_BYTES)
        return null;
      const bytes = await git(['cat-file', 'blob', product.version], {
        timeoutMs: BLOB_TIMEOUT_MS,
        maxBuffer: GHOSTMAPS_MAX_FILE_BYTES + 1,
      });
      if (bytes.length > GHOSTMAPS_MAX_FILE_BYTES) return null;
      return { product, bytes };
    },
  };
}
