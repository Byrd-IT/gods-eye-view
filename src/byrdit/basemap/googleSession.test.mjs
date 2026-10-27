import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGoogleSession,
  getGoogleRootCount,
  resetGoogleRootCount,
  GoogleUnavailableError,
} from './googleSession.js';

const HOUR = 3_600_000;

function harness({ fail = () => false, hasCredentials = true } = {}) {
  let t = 1_000_000;
  const attached = [];
  const detached = [];
  let made = 0;
  const session = createGoogleSession({
    hasCredentials,
    now: () => t,
    load: async () => {
      made += 1;
      if (fail(made)) return { tileset: null, errors: [new Error('403')] };
      return { tileset: { id: made, show: true }, route: 'google-direct' };
    },
    attach: (tileset) => {
      tileset.show = false;
      attached.push(tileset.id);
    },
    detach: (tileset) => detached.push(tileset.id),
  });
  return {
    session,
    attached,
    detached,
    advance: (ms) => {
      t += ms;
    },
  };
}

test('no root request until Google is wanted', () => {
  resetGoogleRootCount();
  const { session } = harness();
  assert.equal(session.tileset, null);
  assert.equal(getGoogleRootCount(), 0);
});

test('one tileset per page load: repeated entries reuse it (0 extra roots)', async () => {
  resetGoogleRootCount();
  const { session, attached, advance } = harness();
  const first = await session.ensure();
  assert.equal(getGoogleRootCount(), 1);
  assert.equal(first.show, false, 'attached hidden; the switch shows it');
  for (let i = 0; i < 20; i++) {
    advance(60_000);
    assert.equal(await session.ensure(), first);
  }
  assert.equal(getGoogleRootCount(), 1);
  assert.deepEqual(attached, [1]);
});

test('concurrent entries share one in-flight root request', async () => {
  resetGoogleRootCount();
  const { session } = harness();
  const [a, b] = await Promise.all([session.ensure(), session.ensure()]);
  assert.equal(a, b);
  assert.equal(getGoogleRootCount(), 1);
});

test('re-root only after 2.5 h, replacing (and releasing) the old tileset', async () => {
  resetGoogleRootCount();
  const { session, advance, detached } = harness();
  const first = await session.ensure();
  advance(2.4 * HOUR);
  assert.equal(await session.ensure(), first);
  assert.equal(getGoogleRootCount(), 1);
  advance(0.2 * HOUR); // 2.6 h
  const second = await session.ensure();
  assert.notEqual(second, first);
  assert.equal(getGoogleRootCount(), 2);
  assert.deepEqual(detached, [1]);
});

test('failures back off exponentially and are capped at 3 roots per hour', async () => {
  resetGoogleRootCount();
  const { session, advance } = harness({ fail: () => true });
  await assert.rejects(session.ensure(), GoogleUnavailableError);
  assert.equal(getGoogleRootCount(), 1);
  // Inside the backoff window: fail fast, no request.
  await assert.rejects(session.ensure(), /backing off/);
  assert.equal(getGoogleRootCount(), 1);
  assert.equal(session.isBackingOff(), true);
  advance(31_000);
  await assert.rejects(session.ensure(), /403/);
  assert.equal(getGoogleRootCount(), 2);
  advance(61_000);
  await assert.rejects(session.ensure(), /403/);
  assert.equal(getGoogleRootCount(), 3);
  // Backoff (120 s) has passed but the hourly cap holds.
  advance(10 * 60_000);
  await assert.rejects(session.ensure(), /backing off/);
  assert.equal(getGoogleRootCount(), 3);
  advance(HOUR);
  await assert.rejects(session.ensure(), /403/);
  assert.equal(getGoogleRootCount(), 4);
});

test('recovery after a failure resets the backoff', async () => {
  resetGoogleRootCount();
  const { session, advance } = harness({ fail: (n) => n === 1 });
  await assert.rejects(session.ensure());
  advance(31_000);
  const tileset = await session.ensure();
  assert.equal(tileset.id, 2);
  assert.equal(session.isBackingOff(), false);
});

test('a stale tileset is kept while a re-root backs off', async () => {
  resetGoogleRootCount();
  const { session, advance } = harness({ fail: (n) => n > 1 });
  const first = await session.ensure();
  advance(2.6 * HOUR);
  await assert.rejects(session.ensure(), /403/);
  assert.equal(await session.ensure(), first);
  assert.equal(getGoogleRootCount(), 2);
});

test('no Google credentials: never a root request', async () => {
  resetGoogleRootCount();
  const { session } = harness({ hasCredentials: false });
  await assert.rejects(session.ensure(), /Google key/);
  assert.equal(getGoogleRootCount(), 0);
  assert.equal(session.hasCredentials, false);
});

test('destroy releases the tileset and refuses new roots', async () => {
  resetGoogleRootCount();
  const { session, detached } = harness();
  await session.ensure();
  session.destroy();
  assert.deepEqual(detached, [1]);
  assert.equal(session.tileset, null);
  await assert.rejects(session.ensure(), /closed/);
  assert.equal(getGoogleRootCount(), 1);
});
