// Byrd-IT b12 r3 repair (review t_49610c02 r2, repair t_aa221db1): the
// CelesTrak halt evidence update must never let a request through.
//
// After a refusal the halt is latched on its headers, then the body evidence
// is added to that same latch file. r2 did `truncate(0)` then `write()`: a
// request arriving in between read an empty file, took it for an operator
// clear, and called CelesTrak again. These tests pin the r3 rules:
//  - a GP or SATCAT request made while the halt file is being written (latch
//    write, evidence write, shrink) is refused with no upstream request, even
//    when the file is momentarily empty or torn;
//  - a failed or short evidence write restores the original latch; if even
//    that fails, the halt is held in memory until the file is deleted;
//  - an operator deletion is never undone (before or during the update), a
//    newer/different latch is never overwritten, and the latch's own fields
//    (halted/at/group/reason/clear/url/status/elapsed_ms) never change;
//  - non-ENOENT I/O failures are logged with their errno code and the real
//    outcome, never as "removed by an operator".
// fetch is always mocked. The mocked-disk tests touch no file; the real-disk
// tests use a private temp directory that is removed afterwards.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { celestrakProxy } from '../../server/providers/space.js';

const GP_CSV =
  'OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION\r\nISS,1998-067A,2026-09-19T00:00:00.000000,15.5';
const SATCAT_CSV =
  'OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER,LAUNCH_DATE,LAUNCH_SITE,DECAY_DATE,PERIOD,INCLINATION,APOGEE,PERIGEE,RCS,DATA_STATUS_CODE,ORBIT_CENTER,ORBIT_TYPE\r\n' +
  'ISS (ZARYA),1998-067A,25544,PAY,+,ISS,1998-11-20,TYMSC,,92.9,51.6,421,415,399.0516,,EA,ORB';
const LATCH_KEYS = [
  'halted',
  'at',
  'group',
  'reason',
  'clear',
  'url',
  'status',
  'elapsed_ms',
];
const settle = () => new Promise((resolve) => setImmediate(resolve));
const ioError = (code) =>
  Object.assign(new Error(`${code}: simulated`), { code });

function captureLogs(t) {
  const lines = [];
  for (const level of ['warn', 'error', 'info', 'log'])
    t.mock.method(console, level, (...args) => lines.push(args.join(' ')));
  return lines;
}

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    headersSent: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headersSent = true;
      for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
    },
    end(body) {
      this.body = body;
    },
  };
}

function celestrakApp() {
  const handlers = {};
  celestrakProxy().configureServer({
    middlewares: { use: (route, h) => (handlers[route] = h) },
  });
  // The refused request uses GP group `stations`; later GP requests use
  // `starlink` (another group, so no single-flight or cache sharing).
  const call = (kind, group) => {
    const res = fakeRes();
    const done =
      kind === 'SATCAT'
        ? handlers['/api/celestrak-rcs']({ url: '/' }, res)
        : handlers['/api/celestrak']({ url: `/${group}` }, res);
    return { res, done };
  };
  return {
    start: (kind) => call(kind, 'stations'),
    async request(kind) {
      const { res, done } = call(kind, 'starlink');
      await done;
      return res;
    },
  };
}

/** A refused response whose body is released only by `release(text)`. */
function stalledRefusal(status = 403) {
  let release;
  const body = new Promise((resolve) => (release = resolve));
  return {
    response: { status, ok: false, headers: new Headers(), text: () => body },
    release,
  };
}

/** Upstream mock: call 1 is the refusal, later calls answer GP/SATCAT CSV. */
function upstream(t, refusal) {
  const state = { calls: 0 };
  t.mock.method(globalThis, 'fetch', async (url) => {
    state.calls += 1;
    if (state.calls === 1) return refusal.response;
    return new Response(/satcat/i.test(String(url)) ? SATCAT_CSV : GP_CSV);
  });
  return state;
}

/**
 * In-memory disk with POSIX-like semantics: the 'r+' handle is an inode
 * (a write after unlink never re-creates the path), writes are positional
 * and return bytesWritten, truncate(len) shortens. Hooks run at the start of
 * each handle operation and may inject a failure or a concurrent request.
 */
function memoryDisk(t, hooks = {}) {
  const files = new Map(); // path -> Buffer
  const ops = [];
  const inodes = new Map(); // path -> { data: Buffer }
  t.mock.method(fsp, 'readFile', async (p) => {
    const node = inodes.get(String(p));
    if (!node) throw ioError('ENOENT');
    if (hooks.readFile) await hooks.readFile(String(p));
    return node.data.toString('utf8');
  });
  t.mock.method(fsp, 'writeFile', async (p, data) => {
    ops.push(['writeFile', String(p)]);
    if (hooks.writeFile) await hooks.writeFile(String(p), String(data), disk);
    inodes.set(String(p), { data: Buffer.from(String(data)) });
  });
  t.mock.method(fsp, 'mkdir', async () => {});
  t.mock.method(fsp, 'stat', async () => {
    throw new Error('no stat');
  });
  t.mock.method(fsp, 'open', async (p, flags) => {
    const key = String(p);
    assert.equal(
      flags,
      'r+',
      'the halt file is only ever opened r+ (never created)',
    );
    ops.push(['open', key]);
    if (hooks.open) await hooks.open(key, disk);
    const node = inodes.get(key);
    if (!node) throw ioError('ENOENT');
    let writeNo = 0;
    return {
      async readFile() {
        ops.push(['read', key]);
        if (hooks.read) await hooks.read(key, disk);
        return node.data.toString('utf8');
      },
      async write(text, position) {
        writeNo += 1;
        ops.push(['write', key, writeNo]);
        const buf = Buffer.from(String(text), 'utf8');
        const put = (bytes) => {
          const end = position + bytes.length;
          const out = Buffer.alloc(Math.max(node.data.length, end));
          node.data.copy(out);
          bytes.copy(out, position);
          node.data = out;
        };
        const act = hooks.write ? await hooks.write(writeNo, buf, disk) : null;
        if (act?.partial) put(buf.subarray(0, act.partial));
        if (act?.throw) throw act.throw;
        if (act?.short) {
          put(buf.subarray(0, act.short));
          return { bytesWritten: act.short, buffer: String(text) };
        }
        if (!act?.partial) put(buf);
        return { bytesWritten: buf.length, buffer: String(text) };
      },
      async truncate(len = 0) {
        ops.push(['truncate', key, len]);
        if (hooks.truncate) await hooks.truncate(len, disk);
        node.data = node.data.subarray(0, len);
      },
      async close() {},
    };
  });
  const disk = {
    ops,
    has: (p) => inodes.has(p),
    text: (p) => inodes.get(p)?.data.toString('utf8'),
    set: (p, text) => inodes.set(p, { data: Buffer.from(text) }),
    /** Make the visible file content `text` without changing the inode. */
    scribble: (p, text) => {
      const node = inodes.get(p);
      if (node) node.data = Buffer.from(text);
    },
    remove: (p) => inodes.delete(p),
  };
  return disk;
}

const HALT_FILE = path.join(process.cwd(), '.gev-cache', 'celestrak-HALT.json');
const kinds = [
  ['GP', 'GP'],
  ['GP', 'SATCAT'],
  ['SATCAT', 'GP'],
  ['SATCAT', 'SATCAT'],
];

// ---------------------------------------------------- 1. request mid-write

for (const [first, second] of kinds) {
  test(`r3: a ${second} request while the ${first} evidence is being written (file torn/empty) is refused with no upstream call`, async (t) => {
    const logs = captureLogs(t);
    const app = celestrakApp();
    let during;
    let seenDuring;
    const disk = memoryDisk(t, {
      async write(n, buf, d) {
        if (n !== 1) return null;
        // Worst case for a reader: the visible file is empty mid-write.
        d.scribble(HALT_FILE, '');
        during = await app.request(second);
        seenDuring = d.text(HALT_FILE);
        return null;
      },
    });
    const refusal = stalledRefusal(403);
    const up = upstream(t, refusal);
    const pending = app.start(first);
    await settle();
    const latched = JSON.parse(disk.text(HALT_FILE));
    refusal.release('403 Forbidden: your IP is blocked');
    await pending.done;
    assert.ok(during, 'the concurrent request ran inside the evidence write');
    assert.equal(
      seenDuring,
      '',
      'the file really was empty during that request',
    );
    assert.equal(during.statusCode, 503, 'refused while halted');
    assert.equal(up.calls, 1, 'no second CelesTrak request');
    assert.equal(pending.res.statusCode, 502);
    const enriched = JSON.parse(disk.text(HALT_FILE));
    for (const k of LATCH_KEYS) assert.deepEqual(enriched[k], latched[k], k);
    assert.equal(enriched.body, '403 Forbidden: your IP is blocked');
    assert.ok(
      !logs.some((l) => /removed by operator/.test(l)),
      'memory latch was never cleared',
    );
    // Afterwards the latch on disk still refuses both kinds.
    assert.equal((await app.request('GP')).statusCode, 503);
    assert.equal((await app.request('SATCAT')).statusCode, 503);
    assert.equal(up.calls, 1);
  });
}

test('r3: the reviewer interleaving (request between truncate and write) is refused when the file must shrink', async (t) => {
  captureLogs(t);
  const app = celestrakApp();
  let during;
  const disk = memoryDisk(t, {
    async read(key, d) {
      // Same latch, but stored pretty-printed (longer): the compact
      // enriched text is shorter, so the update ends with truncate(len).
      d.scribble(key, JSON.stringify(JSON.parse(d.text(key)), null, 8));
    },
    async truncate(len, d) {
      assert.ok(len > 0, 'never truncated to zero');
      d.scribble(HALT_FILE, '');
      during = await app.request('SATCAT');
    },
  });
  const refusal = stalledRefusal(403);
  const up = upstream(t, refusal);
  const pending = app.start('GP');
  await settle();
  refusal.release('blocked');
  await pending.done;
  assert.ok(during, 'the request ran during the truncate');
  assert.equal(during.statusCode, 503);
  assert.equal(up.calls, 1);
  assert.ok(!disk.ops.some(([op, , len]) => op === 'truncate' && len === 0));
});

test('r3: a request while the initial latch file is being written is refused', async (t) => {
  captureLogs(t);
  const app = celestrakApp();
  let during;
  memoryDisk(t, {
    async writeFile(p, data, d) {
      if (p !== HALT_FILE) return;
      d.set(HALT_FILE, ''); // O_TRUNC|O_CREAT happened, data not yet written
      during = await app.request('GP');
    },
  });
  const refusal = stalledRefusal(500);
  const up = upstream(t, refusal);
  const pending = app.start('SATCAT');
  await settle();
  refusal.release('Internal Server Error');
  await pending.done;
  assert.equal(during.statusCode, 503);
  assert.equal(up.calls, 1);
});

// ---------------------------------------------------- 2. write failures

for (const [label, failure, expectCode] of [
  ['EIO after a partial write', { partial: 20, throw: ioError('EIO') }, 'EIO'],
  ['ENOSPC before any byte', { throw: ioError('ENOSPC') }, 'ENOSPC'],
  ['a short write', { short: 7 }, 'ESHORTWRITE'],
]) {
  test(`r3: evidence write fails (${label}): original latch restored byte for byte, still refusing GP and SATCAT`, async (t) => {
    const logs = captureLogs(t);
    const disk = memoryDisk(t, {
      async write(n, buf, d) {
        if (n !== 1) return null;
        // A torn file (the new text cut short, then garbage) before failing.
        if (failure.partial)
          d.scribble(HALT_FILE, `${buf.subarray(0, 40)}\u0000garbage`);
        return failure;
      },
    });
    const refusal = stalledRefusal(403);
    const up = upstream(t, refusal);
    const app = celestrakApp();
    const pending = app.start('GP');
    await settle();
    const original = disk.text(HALT_FILE);
    refusal.release('blocked body');
    await pending.done;
    assert.equal(
      disk.text(HALT_FILE),
      original,
      'original latch restored exactly',
    );
    const line = logs.find((l) => / halt evidence \(/.test(l));
    assert.match(
      line,
      new RegExp(
        `halt file not updated: write failed code=${expectCode}; original latch restored\\)$`,
      ),
    );
    assert.doesNotMatch(line, /operator/);
    assert.doesNotMatch(line, /simulated/, 'error messages are not logged');
    assert.equal((await app.request('GP')).statusCode, 503);
    assert.equal((await app.request('SATCAT')).statusCode, 503);
    assert.equal(up.calls, 1);
  });
}

test('r3: evidence write AND restore fail: file left damaged, halt held in memory for GP and SATCAT until the operator deletes it', async (t) => {
  const logs = captureLogs(t);
  const disk = memoryDisk(t, {
    async write(n, buf, d) {
      d.scribble(HALT_FILE, '{"halted":tr'); // torn, then every write fails
      return { throw: ioError('EIO') };
    },
  });
  const refusal = stalledRefusal(403);
  const up = upstream(t, refusal);
  const app = celestrakApp();
  const pending = app.start('SATCAT');
  await settle();
  refusal.release('blocked body');
  await pending.done;
  assert.throws(
    () => JSON.parse(disk.text(HALT_FILE)),
    'the file really is damaged',
  );
  assert.ok(
    logs.some((l) =>
      /satcat halt evidence .*write failed code=EIO; restore failed code=EIO; file may be damaged, halt held in memory until an operator deletes .*celestrak-HALT\.json\)$/.test(
        l,
      ),
    ),
  );
  assert.equal((await app.request('GP')).statusCode, 503);
  assert.equal((await app.request('SATCAT')).statusCode, 503);
  assert.equal(up.calls, 1, 'a damaged file never admits a request');
  assert.equal(
    logs.filter((l) => /still HALTED in memory/.test(l)).length,
    1,
    'logged once',
  );
  assert.ok(!logs.some((l) => /removed by operator/.test(l)));
  disk.remove(HALT_FILE); // the operator clears it
  const next = await app.request('GP');
  assert.equal(next.statusCode, 200);
  assert.equal(up.calls, 2);
  assert.ok(
    logs.some((l) =>
      /halt file removed by operator — upstream re-enabled/.test(l),
    ),
  );
});

for (const [stage, hook, code] of [
  ['open', 'open', 'EACCES'],
  ['read', 'read', 'EIO'],
]) {
  test(`r3: ${stage} failure (${code}) is logged with its code, not as an operator removal; latch unchanged`, async (t) => {
    const logs = captureLogs(t);
    const disk = memoryDisk(t, {
      [hook]: async () => {
        throw ioError(code);
      },
    });
    const refusal = stalledRefusal(403);
    const up = upstream(t, refusal);
    const app = celestrakApp();
    const pending = app.start('GP');
    await settle();
    const original = disk.text(HALT_FILE);
    refusal.release('blocked body');
    await pending.done;
    assert.equal(disk.text(HALT_FILE), original);
    const line = logs.find((l) => / halt evidence \(/.test(l));
    assert.match(
      line,
      new RegExp(
        `halt file not updated: ${stage} failed code=${code}; existing latch left unchanged\\)$`,
      ),
    );
    assert.doesNotMatch(line, /operator|simulated/);
    assert.equal((await app.request('SATCAT')).statusCode, 503);
    assert.equal(up.calls, 1);
  });
}

test('r3: the latch write itself failed: no evidence write is attempted and the log says so with its code', async (t) => {
  const logs = captureLogs(t);
  const disk = memoryDisk(t, {
    async writeFile(p) {
      if (p === HALT_FILE) throw ioError('EROFS');
    },
  });
  const refusal = stalledRefusal(403);
  upstream(t, refusal);
  const app = celestrakApp();
  const pending = app.start('GP');
  await settle();
  refusal.release('blocked body');
  await pending.done;
  assert.ok(
    logs.some((l) =>
      /halt file write failed code=EROFS — halted in memory only/.test(l),
    ),
  );
  assert.ok(
    logs.some((l) =>
      /halt evidence .*\(halt file not updated: the latch write had failed, halted in memory only\)$/.test(
        l,
      ),
    ),
  );
  assert.ok(
    !disk.ops.some(([op]) => op === 'open'),
    'enrichment does not touch the disk',
  );
  assert.equal(disk.has(HALT_FILE), false);
});

// ------------------------------------- 3. operator deletion / newer latch

test('r3: operator deletion before the update: not re-created, logged as such, next request fetches', async (t) => {
  const logs = captureLogs(t);
  const disk = memoryDisk(t);
  const refusal = stalledRefusal(503);
  const up = upstream(t, refusal);
  const app = celestrakApp();
  const pending = app.start('SATCAT');
  await settle();
  disk.remove(HALT_FILE);
  refusal.release('Service Unavailable');
  await pending.done;
  assert.equal(disk.has(HALT_FILE), false);
  assert.ok(
    logs.some((l) =>
      /halt evidence .*\(halt file not updated: removed by an operator before the evidence was added \(not re-created\)\)$/.test(
        l,
      ),
    ),
  );
  assert.equal((await app.request('GP')).statusCode, 200);
  assert.equal(up.calls, 2);
});

test('r3: a newer latch on disk (different at/group) is left byte-identical and keeps refusing', async (t) => {
  const logs = captureLogs(t);
  const disk = memoryDisk(t);
  const refusal = stalledRefusal(403);
  const up = upstream(t, refusal);
  const app = celestrakApp();
  const pending = app.start('GP');
  await settle();
  const old = JSON.parse(disk.text(HALT_FILE));
  // Operator cleared it and a newer latch was made (here: another writer).
  const newer = JSON.stringify({
    halted: true,
    at: old.at + 60_000,
    group: 'geo',
    reason: 'HTTP 500',
    clear: old.clear,
  });
  disk.set(HALT_FILE, newer);
  refusal.release('old body');
  await pending.done;
  assert.equal(disk.text(HALT_FILE), newer, 'newer latch untouched');
  assert.ok(
    logs.some((l) =>
      /halt evidence .*halt file not updated: it now holds a different latch \(group="geo" at=\d+\); left unchanged\)$/.test(
        l,
      ),
    ),
  );
  assert.equal((await app.request('SATCAT')).statusCode, 503);
  assert.equal(up.calls, 1);
});

test('r3: same at/group but a different reason is a different latch: not overwritten', async (t) => {
  captureLogs(t);
  const disk = memoryDisk(t);
  const refusal = stalledRefusal(403);
  upstream(t, refusal);
  const app = celestrakApp();
  const pending = app.start('GP');
  await settle();
  const other = JSON.stringify({
    ...JSON.parse(disk.text(HALT_FILE)),
    reason: 'HTTP 500',
  });
  disk.set(HALT_FILE, other);
  refusal.release('body');
  await pending.done;
  assert.equal(disk.text(HALT_FILE), other);
});

test('r3: foreign (non-JSON) content is left unchanged and logged as such', async (t) => {
  const logs = captureLogs(t);
  const disk = memoryDisk(t);
  const refusal = stalledRefusal(403);
  upstream(t, refusal);
  const app = celestrakApp();
  const pending = app.start('GP');
  await settle();
  disk.set(HALT_FILE, 'operator note: do not touch');
  refusal.release('body');
  await pending.done;
  assert.equal(disk.text(HALT_FILE), 'operator note: do not touch');
  assert.ok(
    logs.some((l) =>
      /halt file not updated: it is not valid JSON; left unchanged\)$/.test(l),
    ),
  );
  assert.ok(!disk.ops.some(([op]) => op === 'write'));
});

test('r3: enrichment only adds body/body_note; every latch field and the policy text are preserved', async (t) => {
  captureLogs(t);
  const disk = memoryDisk(t);
  const refusal = stalledRefusal(429);
  upstream(t, refusal);
  const app = celestrakApp();
  const pending = app.start('GP');
  await settle();
  const latched = JSON.parse(disk.text(HALT_FILE));
  refusal.release('rate limited');
  await pending.done;
  const enriched = JSON.parse(disk.text(HALT_FILE));
  assert.deepEqual(
    Object.keys(enriched).sort(),
    [...Object.keys(latched), 'body'].sort(),
  );
  for (const k of Object.keys(latched))
    assert.deepEqual(enriched[k], latched[k], k);
  assert.match(
    enriched.clear,
    /^check https:\/\/celestrak\.org, then delete .*celestrak-HALT\.json$/,
  );
});

test('r3: unreadable halt content outside an update keeps the old policy (not halted) and says so honestly', async (t) => {
  const logs = captureLogs(t);
  const disk = memoryDisk(t);
  const refusal = stalledRefusal(403);
  const up = upstream(t, refusal);
  const app = celestrakApp();
  const pending = app.start('GP');
  await settle();
  refusal.release('body');
  await pending.done;
  disk.set(HALT_FILE, 'garbage'); // not deleted: replaced by foreign text
  assert.equal((await app.request('GP')).statusCode, 200);
  assert.equal(up.calls, 2);
  assert.ok(
    logs.some((l) =>
      /halt file unreadable \(content\) — treated as cleared, upstream re-enabled/.test(
        l,
      ),
    ),
  );
  assert.ok(!logs.some((l) => /halt file removed by operator/.test(l)));
});

// ---------------------------------------------------- 4. real filesystem

/** Plugin whose .gev-cache lives in a private temp dir (removed after). */
async function realDiskApp(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gev-halt-r3-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const cwd = process.cwd();
  process.chdir(dir);
  let app;
  try {
    app = celestrakApp(); // CACHE_DIR is captured here
  } finally {
    process.chdir(cwd);
  }
  return { app, haltFile: path.join(dir, '.gev-cache', 'celestrak-HALT.json') };
}

/** Wrap the real fsp.open so the first handle.write runs `before` first. */
function wrapRealOpen(t, before) {
  const realOpen = fsp.open.bind(fsp);
  let n = 0;
  t.mock.method(fsp, 'open', async (...args) => {
    assert.equal(args[1], 'r+');
    const handle = await realOpen(...args);
    return new Proxy(handle, {
      get(target, prop) {
        if (prop === 'write')
          return async (...a) => {
            if (++n === 1) await before();
            return target.write(...a);
          };
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  });
}

test('r3 real disk: torn file during the evidence write still refuses; final file is the exact enriched latch', async (t) => {
  captureLogs(t);
  const { app, haltFile } = await realDiskApp(t);
  let during;
  wrapRealOpen(t, async () => {
    await fsp.truncate(haltFile, 0); // simulate a reader seeing an empty file
    during = await app.request('SATCAT');
    await fsp.truncate(haltFile, 0);
  });
  const refusal = stalledRefusal(403);
  const up = upstream(t, refusal);
  const pending = app.start('GP');
  await settle();
  for (let i = 0; i < 400 && !(await fsp.stat(haltFile).catch(() => null)); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  const latched = JSON.parse(await fsp.readFile(haltFile, 'utf8'));
  refusal.release('403 Forbidden');
  await pending.done;
  assert.equal(during.statusCode, 503);
  assert.equal(up.calls, 1);
  const text = await fsp.readFile(haltFile, 'utf8');
  const enriched = JSON.parse(text); // valid JSON, no trailing bytes
  assert.equal(text, JSON.stringify({ ...latched, body: '403 Forbidden' }));
  for (const k of LATCH_KEYS) assert.deepEqual(enriched[k], latched[k], k);
});

test('r3 real disk: operator deletes the file during the update: not re-created, outcome logged, next request fetches', async (t) => {
  const logs = captureLogs(t);
  const { app, haltFile } = await realDiskApp(t);
  wrapRealOpen(t, () => fsp.unlink(haltFile));
  const refusal = stalledRefusal(500);
  const up = upstream(t, refusal);
  const pending = app.start('SATCAT');
  for (let i = 0; i < 400 && !(await fsp.stat(haltFile).catch(() => null)); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  refusal.release('Internal Server Error');
  await pending.done;
  await assert.rejects(fsp.stat(haltFile), { code: 'ENOENT' });
  assert.ok(
    logs.some((l) =>
      /halt evidence .*\(halt file not updated: removed by an operator during the update \(not re-created\)\)$/.test(
        l,
      ),
    ),
  );
  assert.equal((await app.request('GP')).statusCode, 200);
  assert.equal(up.calls, 2);
});
