// Byrd-IT: the per-user Drone Flight Plan library, on disk.
//
//   <root>/<user>/<planId>/meta.json     name, details, status, times, version
//   <root>/<user>/<planId>/v/<n>.json    the full plan document, one per save
//
// <root> is OUTSIDE the git checkout (GEV_PLAN_DIR, default ~/gev-data/plans)
// so a deploy never touches it and a backup job can copy it. Every function
// takes the owner's already-cleaned user name; the store re-checks it and the
// plan id against strict patterns, so no argument can leave <root>.
// Writes are atomic (temp file in the same directory, fsync, rename).

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

export const PLAN_DIR_ENV = 'GEV_PLAN_DIR';
export const MAX_PLAN_BYTES = 25 * 1024 * 1024;
export const MAX_PLANS_PER_USER = 500;
export const MAX_VERSIONS = 100;
export const TRASH_DAYS = 30;
export const STATUSES = Object.freeze(['planned', 'flown', 'processed']);

const USER = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const PLAN_ID = /^p_[0-9a-f]{16}$/;
const TEXT_LIMITS = { name: 120, site: 200, customer: 200, notes: 5000 };

export class LibraryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function defaultRoot(env = process.env) {
  const set = env?.[PLAN_DIR_ENV];
  return set && path.isAbsolute(set)
    ? set
    : path.join(homedir(), 'gev-data', 'plans');
}

function atomicWrite(file, text) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

const text = (value, key) =>
  typeof value === 'string' ? value.trim().slice(0, TEXT_LIMITS[key]) : '';

/** The details a person can edit, cleaned. Only keys present are returned. */
export function cleanDetails(raw, { requireName = false } = {}) {
  const out = {};
  for (const key of Object.keys(TEXT_LIMITS)) {
    if (raw?.[key] !== undefined) out[key] = text(raw[key], key);
  }
  if (raw?.status !== undefined) {
    if (!STATUSES.includes(raw.status)) {
      throw new LibraryError(
        'bad-status',
        'Status must be planned, flown or processed',
      );
    }
    out.status = raw.status;
  }
  if (requireName && !out.name) {
    throw new LibraryError('name-required', 'A plan needs a name');
  }
  if (out.name === '') {
    throw new LibraryError('name-required', 'A plan needs a name');
  }
  return out;
}

/** Validate the plan document: an object that serialises under the size cap. */
function planText(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new LibraryError('bad-plan', 'The plan must be an object');
  }
  const body = JSON.stringify(plan);
  if (Buffer.byteLength(body) > MAX_PLAN_BYTES) {
    throw new LibraryError('too-large', 'The plan is too large', 413);
  }
  return body;
}

export function createStore({
  root = defaultRoot(),
  now = () => Date.now(),
} = {}) {
  const base = path.resolve(root);

  function userDir(user) {
    if (typeof user !== 'string' || !USER.test(user)) {
      throw new LibraryError('bad-user', 'Bad user name', 400);
    }
    return path.join(base, user);
  }
  function planDir(user, id) {
    if (typeof id !== 'string' || !PLAN_ID.test(id)) {
      throw new LibraryError('not-found', 'No such plan', 404);
    }
    return path.join(userDir(user), id);
  }
  function loadMeta(user, id) {
    const meta = readJson(path.join(planDir(user, id), 'meta.json'));
    if (!meta) throw new LibraryError('not-found', 'No such plan', 404);
    return meta;
  }
  function saveMeta(user, id, meta) {
    atomicWrite(
      path.join(planDir(user, id), 'meta.json'),
      JSON.stringify(meta, null, 1),
    );
  }
  function ids(user) {
    try {
      return readdirSync(userDir(user)).filter((n) => PLAN_ID.test(n));
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }
  function versionNumbers(user, id) {
    try {
      return readdirSync(path.join(planDir(user, id), 'v'))
        .map((n) => /^(\d{1,6})\.json$/.exec(n)?.[1])
        .filter(Boolean)
        .map(Number)
        .sort((a, b) => a - b);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }
  function writeVersion(user, id, n, body) {
    atomicWrite(path.join(planDir(user, id), 'v', `${n}.json`), body);
    const all = versionNumbers(user, id);
    for (const old of all.slice(0, Math.max(0, all.length - MAX_VERSIONS))) {
      rmSync(path.join(planDir(user, id), 'v', `${old}.json`), { force: true });
    }
  }

  /** Public fields of a plan; the id is the only handle. */
  function view(user, meta) {
    return { ...meta, owner: user };
  }

  /** Trash older than TRASH_DAYS goes for good. */
  function purge(user) {
    const limit = now() - TRASH_DAYS * 86_400_000;
    for (const id of ids(user)) {
      let meta;
      try {
        meta = loadMeta(user, id);
      } catch {
        continue;
      }
      if (meta.deletedAt && meta.deletedAt < limit) {
        rmSync(planDir(user, id), { recursive: true, force: true });
      }
    }
  }

  return {
    root: base,

    list(user, { trash = false, purgeOld = true } = {}) {
      if (purgeOld) purge(user);
      const out = [];
      for (const id of ids(user)) {
        let meta;
        try {
          meta = loadMeta(user, id);
        } catch {
          continue;
        }
        if (Boolean(meta.deletedAt) === trash) out.push(view(user, meta));
      }
      return out.sort((a, b) => b.updatedAt - a.updatedAt);
    },

    create(user, details, plan) {
      const clean = cleanDetails(details, { requireName: true });
      const body = planText(plan);
      if (ids(user).length >= MAX_PLANS_PER_USER) {
        throw new LibraryError(
          'too-many',
          'Too many plans: delete some first',
          409,
        );
      }
      const id = `p_${randomBytes(8).toString('hex')}`;
      const t = now();
      const meta = {
        id,
        name: clean.name,
        site: clean.site ?? '',
        customer: clean.customer ?? '',
        notes: clean.notes ?? '',
        status: clean.status ?? 'planned',
        createdAt: t,
        updatedAt: t,
        version: 1,
        deletedAt: null,
      };
      mkdirSync(planDir(user, id), { recursive: true, mode: 0o700 });
      writeVersion(user, id, 1, body);
      saveMeta(user, id, meta);
      return view(user, meta);
    },

    get(user, id, version = null) {
      const meta = loadMeta(user, id);
      const n = version ?? meta.version;
      if (!Number.isInteger(n) || n < 1) {
        throw new LibraryError('not-found', 'No such version', 404);
      }
      const plan = readJson(path.join(planDir(user, id), 'v', `${n}.json`));
      if (!plan) throw new LibraryError('not-found', 'No such version', 404);
      return { meta: view(user, meta), plan, version: n };
    },

    /** A new version (the old ones stay), and optional detail edits. */
    save(user, id, plan, details = {}) {
      const meta = loadMeta(user, id);
      if (meta.deletedAt) {
        throw new LibraryError(
          'in-trash',
          'Restore the plan before saving',
          409,
        );
      }
      const clean = cleanDetails(details);
      const body = planText(plan);
      const next = Math.max(meta.version, ...versionNumbers(user, id)) + 1;
      writeVersion(user, id, next, body);
      const updated = { ...meta, ...clean, version: next, updatedAt: now() };
      saveMeta(user, id, updated);
      return view(user, updated);
    },

    /** Rename / details only: no new version. */
    update(user, id, details) {
      const meta = loadMeta(user, id);
      const updated = { ...meta, ...cleanDetails(details), updatedAt: now() };
      saveMeta(user, id, updated);
      return view(user, updated);
    },

    duplicate(user, id, name) {
      const { meta, plan } = this.get(user, id);
      return this.create(
        user,
        {
          name: text(name, 'name') || `${meta.name} (copy)`.slice(0, 120),
          site: meta.site,
          customer: meta.customer,
          notes: meta.notes,
          status: 'planned',
        },
        plan,
      );
    },

    trash(user, id) {
      const meta = loadMeta(user, id);
      const updated = { ...meta, deletedAt: now() };
      saveMeta(user, id, updated);
      return view(user, updated);
    },

    restore(user, id) {
      const meta = loadMeta(user, id);
      const updated = { ...meta, deletedAt: null, updatedAt: now() };
      saveMeta(user, id, updated);
      return view(user, updated);
    },

    versions(user, id) {
      loadMeta(user, id);
      return versionNumbers(user, id)
        .reverse()
        .map((n) => {
          const st = statSync(path.join(planDir(user, id), 'v', `${n}.json`));
          return {
            version: n,
            savedAt: Math.round(st.mtimeMs),
            bytes: st.size,
          };
        });
    },

    /** Restoring an old version is a NEW save carrying that version's plan. */
    restoreVersion(user, id, n) {
      const { plan } = this.get(user, id, n);
      return this.save(user, id, plan);
    },

    /** User folders that exist, for the admin's "All users" filter. */
    users() {
      try {
        return readdirSync(base)
          .filter((n) => USER.test(n))
          .sort();
      } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
      }
    },
  };
}
