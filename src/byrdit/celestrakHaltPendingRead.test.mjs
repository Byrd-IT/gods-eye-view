// Byrd-IT b12 r4 repair (review t_49610c02 r3, repair t_b8666753): an
// admission read of the CelesTrak halt file that is ALREADY PENDING when this
// process starts writing that file must never clear the halt.
//
// r3 checked `haltWrites` only before `await readHalt()`. A request could
// start its read while the valid latch was on disk (refusal body stalled);
// the evidence update then rewrote the file in place, and the old read
// returned a torn snapshot, either during the write or after it had
// finished (counter back to 0). isHalted() took that for "file unreadable",
// cleared the latch and let a second request out to CelesTrak.
//
// r4: every halt-file write bumps `haltEpoch` when it starts and when it
// ends. A read whose epoch changed while it was pending is discarded: while
// the write still runs the in-memory latch answers; after it, the file is
// read again (so a real operator deletion still re-enables upstream).
//
// Covered here, for GP and SATCAT (refused request x pending request), with
// the stale snapshot delivered DURING and AFTER the write: torn JSON, an
// empty file, an EIO read error and a stale ENOENT; a read that began before
// the initial latch write; operator deletion after the overlapped write
// (still honoured, one extra request only then); and an unrelated
// unreadable-file read with no overlap (old policy unchanged).
// fetch and the disk are always mocked: no file and no network is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { celestrakProxy } from '../../server/providers/space.js';

const GP_CSV =
  'OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION\r\nISS,1998-067A,2026-09-19T00:00:00.000000,15.5';
const SATCAT_CSV =
  'OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER,LAUNCH_DATE,LAUNCH_SITE,DECAY_DATE,PERIOD,INCLINATION,APOGEE,PERIGEE,RCS,DATA_STATUS_CODE,ORBIT_CENTER,ORBIT_TYPE\r\n' +
  'ISS (ZARYA),1998-067A,25544,PAY,+,ISS,1998-11-20,TYMSC,,92.9,51.6,421,415,399.0516,,EA,ORB';
const HALT_FILE = path.join(process.cwd(), '.gev-cache', 'celestrak-HALT.json');
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
  // The refused request uses GP group `stations`; the other GP requests use
  // `starlink` (another group: no single-flight or cache sharing).
  const call = (kind, group = 'starlink') => {
    const res = fakeRes();
    const done =
      kind === 'SATCAT'
        ? handlers['/api/celestrak-rcs']({ url: '/' }, res)
        : handlers['/api/celestrak']({ url: `/${group}`, method: 'GET' }, res);
    return { res, done };
  };
  return {
    start: (kind) => call(kind, 'stations'),
    begin: (kind) => call(kind),
    async request(kind) {
      const { res, done } = call(kind);
      await done;
      return res;
    },
  };
}

/** Upstream: call 1 is a refusal whose headers/body the test releases. */
function upstream(t) {
  let releaseHeaders;
  let releaseBody;
  const headers = new Promise((resolve) => (releaseHeaders = resolve));
  const body = new Promise((resolve) => (releaseBody = resolve));
  const state = {
    calls: 0,
    headers: () => releaseHeaders(),
    body: (text) => releaseBody(text),
  };
  t.mock.method(globalThis, 'fetch', async (url) => {
    state.calls += 1;
    if (state.calls === 1) {
      await headers;
      return {
        status: 403,
        ok: false,
        headers: new Headers(),
        text: () => body,
      };
    }
    return new Response(/satcat/i.test(String(url)) ? SATCAT_CSV : GP_CSV);
  });
  return state;
}

/**
 * In-memory disk. `hold()` makes the NEXT admission read of the halt file
 * (fsp.readFile on HALT_FILE) pend until the test calls `deliver(result)`
 * with `{ text }` or `{ error }`. Handle writes are positional; `onWrite`
 * runs inside the evidence write after the file was made torn.
 */
function memoryDisk(t, { onWrite, onWriteFile } = {}) {
  const inodes = new Map();
  let held = null;
  const disk = {
    reads: 0,
    text: (p) => inodes.get(p)?.data.toString('utf8'),
    set: (p, s) => inodes.set(p, { data: Buffer.from(s) }),
    scribble: (p, s) => {
      const node = inodes.get(p);
      if (node) node.data = Buffer.from(s);
    },
    remove: (p) => inodes.delete(p),
    hold() {
      held = { armed: true };
    },
    get pending() {
      return Boolean(held?.deliver);
    },
    deliver(result) {
      const h = held;
      held = null;
      h.deliver(result);
    },
  };
  t.mock.method(fsp, 'readFile', async (p) => {
    const key = String(p);
    if (key === HALT_FILE) {
      disk.reads += 1;
      if (held?.armed) {
        held.armed = false;
        const result = await new Promise((resolve) => (held.deliver = resolve));
        if (result.error) throw result.error;
        return result.text;
      }
    }
    const node = inodes.get(key);
    if (!node) throw ioError('ENOENT');
    return node.data.toString('utf8');
  });
  t.mock.method(fsp, 'writeFile', async (p, data) => {
    if (onWriteFile && String(p) === HALT_FILE) await onWriteFile(disk);
    inodes.set(String(p), { data: Buffer.from(String(data)) });
  });
  t.mock.method(fsp, 'mkdir', async () => {});
  t.mock.method(fsp, 'open', async (p, flags) => {
    const key = String(p);
    assert.equal(flags, 'r+', 'the halt file is only ever opened r+');
    const node = inodes.get(key);
    if (!node) throw ioError('ENOENT');
    return {
      readFile: async () => node.data.toString('utf8'),
      async write(text, position) {
        const buf = Buffer.from(String(text), 'utf8');
        node.data = Buffer.from('{"halted":'); // torn mid-write
        if (onWrite) await onWrite(disk);
        const out = Buffer.alloc(
          Math.max(node.data.length, position + buf.length),
        );
        node.data.copy(out);
        buf.copy(out, position);
        node.data = out.subarray(0, position + buf.length);
        return { bytesWritten: buf.length, buffer: String(text) };
      },
      truncate: async (len = 0) => {
        node.data = node.data.subarray(0, len);
      },
      stat: async () => ({ nlink: inodes.get(key) === node ? 1 : 0 }),
      close: async () => {},
    };
  });
  return disk;
}

const KINDS = [
  ['GP', 'GP'],
  ['GP', 'SATCAT'],
  ['SATCAT', 'GP'],
  ['SATCAT', 'SATCAT'],
];
const SNAPSHOTS = {
  'torn JSON': { text: '{"halted":' },
  'an empty file': { text: '' },
  'an EIO read error': { error: ioError('EIO') },
  'a stale ENOENT': { error: ioError('ENOENT') },
};

// ------------------------------- 1. read pending across the evidence write

for (const [first, second] of KINDS)
  for (const delivery of ['during', 'after'])
    for (const [label, snapshot] of Object.entries(SNAPSHOTS))
      test(`r4: ${second} admission read pending across the ${first} evidence write, ${label} delivered ${delivery} the write: still halted, no upstream call`, async (t) => {
        const logs = captureLogs(t);
        const app = celestrakApp();
        let pending;
        let sawDuring = false;
        const disk = memoryDisk(t, {
          async onWrite(d) {
            if (delivery !== 'during') return;
            sawDuring = d.pending;
            d.deliver(snapshot);
            await pending.done; // answered without waiting for this write
          },
        });
        const up = upstream(t);
        const refused = app.start(first);
        up.headers();
        await settle();
        const latch = JSON.parse(disk.text(HALT_FILE));
        assert.equal(latch.halted, true, 'latch on disk before the read');
        disk.hold();
        pending = app.begin(second);
        await settle();
        assert.equal(disk.pending, true, 'admission read is pending');
        up.body('403 Forbidden: your IP is blocked');
        await refused.done;
        if (delivery === 'during') assert.ok(sawDuring, 'delivered mid-write');
        else disk.deliver(snapshot);
        await pending.done;
        assert.equal(up.calls, 1, 'no second CelesTrak request');
        assert.equal(pending.res.statusCode, 503, 'refused while halted');
        assert.ok(
          !logs.some((l) => /re-enabled|treated as cleared/.test(l)),
          'latch never cleared',
        );
        // The enriched latch is intact and keeps refusing both kinds.
        const enriched = JSON.parse(disk.text(HALT_FILE));
        for (const k of ['halted', 'at', 'group', 'reason', 'clear'])
          assert.deepEqual(enriched[k], latch[k], k);
        assert.equal(enriched.body, '403 Forbidden: your IP is blocked');
        assert.equal((await app.request('GP')).statusCode, 503);
        assert.equal((await app.request('SATCAT')).statusCode, 503);
        assert.equal(up.calls, 1);
      });

// ------------------------------- 2. read pending across the latch write

for (const [first, second] of KINDS)
  for (const delivery of ['during', 'after'])
    test(`r4: ${second} admission read began before the ${first} latch existed (stale ENOENT delivered ${delivery} the latch write): halted, no upstream call`, async (t) => {
      const logs = captureLogs(t);
      const app = celestrakApp();
      let pending;
      const disk = memoryDisk(t, {
        async onWriteFile(d) {
          if (delivery !== 'during') return;
          d.deliver({ error: ioError('ENOENT') });
          await pending.done;
        },
      });
      const up = upstream(t);
      const refused = app.start(first);
      await settle();
      assert.equal(up.calls, 1, 'refused request is waiting for headers');
      disk.hold();
      pending = app.begin(second);
      await settle();
      assert.equal(disk.pending, true, 'admission read is pending');
      up.headers();
      await settle();
      if (delivery === 'after') {
        assert.equal(JSON.parse(disk.text(HALT_FILE)).halted, true);
        disk.deliver({ error: ioError('ENOENT') });
      }
      await pending.done;
      up.body('blocked');
      await refused.done;
      assert.equal(up.calls, 1, 'no second CelesTrak request');
      assert.equal(pending.res.statusCode, 503);
      assert.ok(!logs.some((l) => /re-enabled/.test(l)), 'latch never cleared');
      assert.equal((await app.request(second)).statusCode, 503);
      assert.equal(up.calls, 1);
    });

// ------------------------------- 3. operator deletion still works

for (const second of ['GP', 'SATCAT'])
  test(`r4: overlapped ${second} read is re-read, so an operator deletion made after the write still re-enables upstream`, async (t) => {
    const logs = captureLogs(t);
    const app = celestrakApp();
    const disk = memoryDisk(t);
    const up = upstream(t);
    const refused = app.start('GP');
    up.headers();
    await settle();
    disk.hold();
    const pending = app.begin(second);
    await settle();
    up.body('blocked');
    await refused.done;
    const readsBefore = disk.reads;
    disk.remove(HALT_FILE); // the operator clears the halt
    disk.deliver({ text: '{"halted":' });
    await pending.done;
    assert.equal(disk.reads, readsBefore + 1, 'the stale snapshot was re-read');
    assert.equal(pending.res.statusCode, 200, 'operator clear honoured');
    assert.equal(up.calls, 2, 'exactly one request after the clear');
    assert.ok(
      logs.some((l) => /removed by operator — upstream re-enabled/.test(l)),
    );
  });

// ------------------------------- 4. no overlap: unchanged policy

for (const second of ['GP', 'SATCAT'])
  test(`r4: a ${second} read with NO overlapping write keeps the old policy (unreadable file = cleared, logged) and is read once`, async (t) => {
    const logs = captureLogs(t);
    const app = celestrakApp();
    const disk = memoryDisk(t);
    const up = upstream(t);
    const refused = app.start('GP');
    up.headers();
    up.body('blocked');
    await refused.done;
    disk.scribble(HALT_FILE, 'not json');
    const readsBefore = disk.reads;
    disk.hold();
    const pending = app.begin(second);
    await settle();
    disk.deliver({ text: 'not json' });
    await pending.done;
    assert.equal(disk.reads, readsBefore + 1, 'no retry without an overlap');
    assert.equal(pending.res.statusCode, 200);
    assert.equal(up.calls, 2);
    assert.ok(
      logs.some((l) =>
        /halt file unreadable \(content\) — treated as cleared/.test(l),
      ),
    );
  });
