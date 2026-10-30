// Byrd-IT plan library: identity rules, per-user scoping, admin read-only,
// versions, trash, path traversal, CSRF, size limits. Real HTTP over loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readdirSync, existsSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  cleanUserName,
  libraryIdentity,
} from '../../server/byrdit/planLibrary/identity.js';
import { createStore, MAX_USER_BYTES, MAX_VERSIONS } from '../../server/byrdit/planLibrary/store.js';
import { createPlanLibraryHandler } from '../../server/byrdit/planLibrary/api.js';

const PLAN = { schema: 'gevplan', areas: [{ kind: 'box' }], options: { aglM: 60 } };

async function boot({ trusted = '127.0.0.1', now } = {}) {
  const root = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), 'gevlib-'));
  const store = createStore({ root, now });
  const handler = createPlanLibraryHandler({
    store,
    env: { GEV_TRUSTED_PROXIES: trusted },
  });
  const server = http.createServer((req, res) =>
    handler(req, res, () => {
      res.statusCode = 404;
      res.end('next');
    }),
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const call = (method, p, { user, body, headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const h = { 'x-requested-with': 'gev', ...headers };
      if (user !== undefined) h['x-gev-user'] = user;
      if (data) h['content-type'] = 'application/json';
      const req = http.request(
        { host: '127.0.0.1', port, method, path: `/api/byrdit/plans${p}`, headers: h },
        (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () => {
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {}
            resolve({ status: res.statusCode, json });
          });
        },
      );
      req.on('error', reject);
      req.end(data);
    });
  return {
    root,
    store,
    call,
    port,
    close: async () => {
      await new Promise((r) => server.close(r));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('cleanUserName accepts logins and refuses traversal', () => {
  assert.equal(cleanUserName('Alice'), 'alice');
  assert.equal(cleanUserName('bob_2-x'), 'bob_2-x');
  for (const bad of ['', '..', '../x', 'a/b', 'a\\b', '.hidden', 'a b', 'x'.repeat(40), 5, null, ['a'], 'a\u0000b']) {
    assert.equal(cleanUserName(bad), null, String(bad));
  }
});

test('identity: header counts only from a trusted peer', () => {
  const req = (addr, user) => ({ socket: { remoteAddress: addr }, headers: user === undefined ? {} : { 'x-gev-user': user } });
  const env = { GEV_TRUSTED_PROXIES: '10.0.0.2,10.0.0.3' };
  assert.equal(libraryIdentity(req('10.0.0.2'), env), null, 'no header');
  assert.equal(libraryIdentity(req('192.168.1.5', 'byrdit'), env), null, 'untrusted peer');
  assert.deepEqual(libraryIdentity(req('10.0.0.3', 'Alice'), env), { user: 'alice', admin: false });
  assert.deepEqual(libraryIdentity(req('::ffff:10.0.0.2', 'byrdit'), env), { user: 'byrdit', admin: true });
  assert.equal(libraryIdentity(req('10.0.0.2', '../etc'), env), null);
  assert.equal(libraryIdentity(req('10.0.0.2', 'a,b'), env), null, 'duplicated header');
  assert.equal(libraryIdentity(req('10.0.0.2', 'byrdit'), {}), null, 'no trusted list');
  const custom = { ...env, GEV_ADMIN_USER: 'boss' };
  assert.equal(libraryIdentity(req('10.0.0.2', 'byrdit'), custom).admin, false);
  assert.equal(libraryIdentity(req('10.0.0.2', 'boss'), custom).admin, true);
});

test('no header: 401, and /me says there is no library', async () => {
  const s = await boot();
  try {
    assert.equal((await s.call('GET', '')).status, 401);
    assert.equal((await s.call('POST', '', { body: { name: 'x', plan: PLAN } })).status, 401);
    const me = await s.call('GET', '/me');
    assert.equal(me.status, 200);
    assert.deepEqual(me.json, { library: false });
    assert.deepEqual(s.store.users(), []);
  } finally {
    await s.close();
  }
});

test('header from an UNTRUSTED peer is ignored', async () => {
  const s = await boot({ trusted: '10.9.9.9' });
  try {
    const r = await s.call('GET', '', { user: 'byrdit' });
    assert.equal(r.status, 401);
    const w = await s.call('POST', '', { user: 'byrdit', body: { name: 'x', plan: PLAN } });
    assert.equal(w.status, 401);
    assert.deepEqual(s.store.users(), []);
    assert.deepEqual((await s.call('GET', '/me', { user: 'byrdit' })).json, { library: false });
  } finally {
    await s.close();
  }
});

test('save, open, rename, versions, restore version', async () => {
  const s = await boot();
  try {
    const made = await s.call('POST', '', { user: 'alice', body: { name: 'Barn', site: 'Farm', plan: PLAN } });
    assert.equal(made.status, 201);
    const id = made.json.plan.id;
    assert.match(id, /^p_[0-9a-f]{16}$/);
    assert.equal(made.json.plan.status, 'planned');
    const open = await s.call('GET', `/${id}`, { user: 'alice' });
    assert.deepEqual(open.json.plan, PLAN);
    const v2 = { ...PLAN, options: { aglM: 80 } };
    const saved = await s.call('PUT', `/${id}`, { user: 'alice', body: { plan: v2, status: 'flown' } });
    assert.equal(saved.json.plan.version, 2);
    assert.equal(saved.json.plan.status, 'flown');
    const ren = await s.call('PATCH', `/${id}`, { user: 'alice', body: { name: 'Big barn', notes: 'n' } });
    assert.equal(ren.json.plan.name, 'Big barn');
    assert.equal(ren.json.plan.version, 2, 'rename is not a new version');
    const versions = await s.call('GET', `/${id}/versions`, { user: 'alice' });
    assert.deepEqual(versions.json.versions.map((v) => v.version), [2, 1]);
    assert.deepEqual((await s.call('GET', `/${id}?version=1`, { user: 'alice' })).json.plan, PLAN);
    const back = await s.call('POST', `/${id}/versions/1/restore`, { user: 'alice' });
    assert.equal(back.json.plan.version, 3, 'restore is a new save');
    assert.deepEqual((await s.call('GET', `/${id}`, { user: 'alice' })).json.plan, PLAN);
    assert.equal((await s.call('PATCH', `/${id}`, { user: 'alice', body: { status: 'bogus' } })).status, 400);
    assert.equal((await s.call('PATCH', `/${id}`, { user: 'alice', body: { name: '  ' } })).status, 400);
    assert.equal((await s.call('POST', '', { user: 'alice', body: { plan: PLAN } })).status, 400);
    assert.equal((await s.call('POST', '', { user: 'alice', body: { name: 'x', plan: [] } })).status, 400);
  } finally {
    await s.close();
  }
});

test('duplicate, trash, trash list, restore, 30-day purge', async () => {
  let clock = 1_000_000;
  const s = await boot({ now: () => clock });
  try {
    const id = (await s.call('POST', '', { user: 'alice', body: { name: 'A', plan: PLAN } })).json.plan.id;
    const dup = await s.call('POST', `/${id}/duplicate`, { user: 'alice', body: {} });
    assert.equal(dup.status, 201);
    assert.equal(dup.json.plan.name, 'A (copy)');
    assert.notEqual(dup.json.plan.id, id);
    const del = await s.call('DELETE', `/${id}`, { user: 'alice' });
    assert.ok(del.json.plan.deletedAt);
    assert.equal((await s.call('GET', '', { user: 'alice' })).json.plans.length, 1);
    assert.equal((await s.call('GET', '?trash=1', { user: 'alice' })).json.plans.length, 1);
    assert.equal((await s.call('PUT', `/${id}`, { user: 'alice', body: { plan: PLAN } })).status, 409);
    await s.call('POST', `/${id}/restore`, { user: 'alice' });
    assert.equal((await s.call('GET', '', { user: 'alice' })).json.plans.length, 2);
    await s.call('DELETE', `/${id}`, { user: 'alice' });
    clock += 29 * 86_400_000;
    assert.equal((await s.call('GET', '?trash=1', { user: 'alice' })).json.plans.length, 1);
    clock += 2 * 86_400_000;
    assert.equal((await s.call('GET', '?trash=1', { user: 'alice' })).json.plans.length, 0);
    assert.equal((await s.call('GET', `/${id}`, { user: 'alice' })).status, 404);
  } finally {
    await s.close();
  }
});

test('user A cannot read or write user B; ?owner= is refused for non-admins', async () => {
  const s = await boot();
  try {
    const id = (await s.call('POST', '', { user: 'alice', body: { name: 'A', plan: PLAN } })).json.plan.id;
    assert.equal((await s.call('GET', `/${id}`, { user: 'bob' })).status, 404);
    assert.equal((await s.call('PUT', `/${id}`, { user: 'bob', body: { plan: PLAN } })).status, 404);
    assert.equal((await s.call('PATCH', `/${id}`, { user: 'bob', body: { name: 'x' } })).status, 404);
    assert.equal((await s.call('DELETE', `/${id}`, { user: 'bob' })).status, 404);
    assert.equal((await s.call('POST', `/${id}/duplicate`, { user: 'bob', body: {} })).status, 404);
    assert.equal((await s.call('GET', `/${id}/versions`, { user: 'bob' })).status, 404);
    assert.equal((await s.call('GET', `/${id}?owner=alice`, { user: 'bob' })).status, 403);
    assert.equal((await s.call('GET', '?owner=alice', { user: 'bob' })).status, 403);
    assert.equal((await s.call('GET', '?scope=all', { user: 'bob' })).status, 403);
    assert.deepEqual((await s.call('GET', '', { user: 'bob' })).json.plans, []);
    assert.equal((await s.call('GET', `/${id}`, { user: 'alice' })).status, 200);
  } finally {
    await s.close();
  }
});

test('admin (byrdit) reads everyone read-only and cannot change others', async () => {
  const s = await boot();
  try {
    const id = (await s.call('POST', '', { user: 'alice', body: { name: 'A', plan: PLAN } })).json.plan.id;
    await s.call('POST', '', { user: 'byrdit', body: { name: 'mine', plan: PLAN } });
    const all = await s.call('GET', '?scope=all', { user: 'byrdit' });
    assert.deepEqual(all.json.plans.map((p) => p.owner).sort(), ['alice', 'byrdit']);
    assert.equal((await s.call('GET', '/me', { user: 'byrdit' })).json.admin, true);
    assert.deepEqual((await s.call('GET', '/me', { user: 'byrdit' })).json.users, ['alice', 'byrdit']);
    assert.equal((await s.call('GET', '/me', { user: 'alice' })).json.users, undefined);
    const open = await s.call('GET', `/${id}?owner=alice`, { user: 'byrdit' });
    assert.equal(open.status, 200);
    assert.deepEqual(open.json.plan, PLAN);
    assert.equal((await s.call('GET', `/${id}/versions?owner=alice`, { user: 'byrdit' })).status, 200);
    // Writes: refused with ?owner=, and without it they hit byrdit's own (empty) folder.
    for (const [m, p, body] of [
      ['PUT', `/${id}?owner=alice`, { plan: PLAN }],
      ['PATCH', `/${id}?owner=alice`, { name: 'hacked' }],
      ['DELETE', `/${id}?owner=alice`],
      ['POST', `/${id}/restore?owner=alice`],
      ['POST', `/${id}/versions/1/restore?owner=alice`],
      ['POST', `/${id}/duplicate?owner=alice`, {}],
      ['PUT', `/${id}`, { plan: PLAN }],
      ['DELETE', `/${id}`],
    ]) {
      const r = await s.call(m, p, { user: 'byrdit', body });
      assert.ok(r.status === 403 || r.status === 404, `${m} ${p} -> ${r.status}`);
    }
    const after = await s.call('GET', `/${id}?owner=alice`, { user: 'alice' });
    assert.equal(after.json.meta.name, 'A');
    assert.equal(after.json.meta.version, 1);
    assert.equal(after.json.meta.deletedAt, null);
  } finally {
    await s.close();
  }
});

test('path traversal in owner, plan id and version never leaves the root', async () => {
  const s = await boot();
  try {
    await s.call('POST', '', { user: 'alice', body: { name: 'A', plan: PLAN } });
    for (const p of ['/..', '/..%2F..', '/p_0000000000000000/../..', '/%2e%2e', '/p_zz', '/x/versions/1/restore']) {
      const r = await s.call('GET', p, { user: 'byrdit' });
      assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
    }
    for (const o of ['..', '../alice', 'a/b', '%2e%2e%2falice']) {
      const r = await s.call('GET', `?owner=${encodeURIComponent(o)}`, { user: 'byrdit' });
      assert.ok([400, 403].includes(r.status), `${o} -> ${r.status}`);
    }
    for (const bad of ['..', '../alice', 'a/b']) {
      assert.throws(() => s.store.list(bad));
      assert.throws(() => s.store.get('alice', bad));
    }
    assert.deepEqual(readdirSync(s.root), ['alice']);
  } finally {
    await s.close();
  }
});

test('CSRF: writes need X-Requested-With and a same-origin Origin', async () => {
  const s = await boot();
  try {
    const body = { name: 'x', plan: PLAN };
    assert.equal((await s.call('POST', '', { user: 'alice', body, headers: { 'x-requested-with': '' } })).status, 403);
    assert.equal((await s.call('POST', '', { user: 'alice', body, headers: { origin: 'https://evil.example' } })).status, 403);
    const wrong = await s.call('POST', '', { user: 'alice', body, headers: { origin: `http://127.0.0.1:${s.port + 1}` } });
    assert.equal(wrong.status, 403, 'wrong port');
    const same = await s.call('POST', '', { user: 'alice', body, headers: { origin: `http://127.0.0.1:${s.port}` } });
    assert.equal(same.status, 201, 'the same origin is accepted');
    assert.equal((await s.call('POST', '', { user: 'alice', body })).status, 201);
  } finally {
    await s.close();
  }
});

test('size limit, plan count limit, atomic files', async () => {
  const s = await boot();
  try {
    const huge = { schema: 'gevplan', blob: 'x'.repeat(26 * 1024 * 1024) };
    const r = await s.call('POST', '', { user: 'alice', body: { name: 'big', plan: huge } }).catch((e) => ({ status: 'closed', e }));
    assert.ok(r.status === 413 || r.status === 'closed', String(r.status));
    assert.deepEqual(s.store.list('alice'), []);
    const store = createStore({ root: s.root });
    for (let i = 0; i < 500; i += 1) store.create('carol', { name: `p${i}` }, { a: 1 });
    assert.throws(() => store.create('carol', { name: 'one more' }, { a: 1 }), /Too many/);
    const dir = path.join(s.root, 'carol');
    const first = readdirSync(dir)[0];
    assert.ok(!readdirSync(path.join(dir, first)).some((n) => n.endsWith('.tmp')));
    assert.ok(existsSync(path.join(dir, first, 'meta.json')));
  } finally {
    await s.close();
  }
});

test('per-user byte quota, version cap and stale temp sweep', () => {
  const root = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), 'gevq-'));
  try {
    const store = createStore({ root });
    const blob = (n) => ({ blob: 'x'.repeat(n) });
    // Versions are capped.
    const p = store.create('dave', { name: 'v' }, { a: 1 });
    for (let i = 0; i < MAX_VERSIONS + 5; i += 1) store.save('dave', p.id, { a: i });
    assert.equal(store.versions('dave', p.id).length, MAX_VERSIONS);
    // The quota stops one user from filling the disk, and nobody else.
    const q = createStore({ root });
    const per = 7 * 1024 * 1024;
    const n = Math.floor(MAX_USER_BYTES / per);
    const first = q.create('erin', { name: 'big' }, blob(per));
    for (let i = 1; i < n; i += 1) q.save('erin', first.id, blob(per));
    assert.throws(() => q.save('erin', first.id, blob(per)), (e) => e.status === 507);
    assert.throws(() => q.create('erin', { name: 'more' }, blob(per)), (e) => e.status === 507);
    assert.ok(q.create('frank', { name: 'fine' }, blob(per)), 'another user is unaffected');
    // A leftover temp file from a crash is swept once it is old.
    const dir = path.join(root, 'dave', p.id, 'v');
    const tmp = path.join(dir, '9.json.1.abcd.tmp');
    writeFileSync(tmp, 'partial');
    const old = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(tmp, old, old);
    const fresh = path.join(dir, '10.json.1.efgh.tmp');
    writeFileSync(fresh, 'partial');
    store.list('dave');
    assert.ok(!existsSync(tmp), 'old temp file removed');
    assert.ok(existsSync(fresh), 'recent temp file kept (a write may be running)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
