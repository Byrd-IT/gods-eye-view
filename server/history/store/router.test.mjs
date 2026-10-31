import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AVAILABLE_BACKENDS, applyRetention, createHistoryStore } from './index.js';
import { createSqliteStore } from './sqlite.js';

const T0 = Date.UTC(2026, 0, 1);
const DAY = 24 * 3600 * 1000;
const memory = (name) => () => ({ ...createSqliteStore({ path: ':memory:' }), backend: name });

describe('history store router', () => {
  it('builds sqlite stores from the environment', async () => {
    assert.deepEqual([...AVAILABLE_BACKENDS], ['sqlite', 'live-only', 'live-api']);
    const store = createHistoryStore({ HISTORY_SQLITE_PATH: ':memory:' });
    await store.append('aircraft', [{ t: T0, key: 'a', lat: 0, lon: 0 }]);
    assert.equal((await store.coverage('aircraft')).count, 1);
    assert.equal((await store.health()).ok, true);
    await store.close();
  });

  it('refuses an unsupported combination before opening anything', () => {
    assert.throws(() => createHistoryStore({ HISTORY_STORE_AIRCRAFT: 'elasticsearch', HISTORY_SQLITE_PATH: '/nonexistent/never-created/h.sqlite' }), (error) => error.code === 'CONFIG');
  });

  it('routes each feed to the backend its setting names', async () => {
    const store = createHistoryStore(
      { HISTORY_STORE: 'sqlite', HISTORY_STORE_AIRCRAFT: 'elasticsearch' },
      { backends: { sqlite: memory('sqlite'), elasticsearch: memory('elasticsearch') } },
    );
    await store.append('aircraft', [{ t: T0, key: 'a', lat: 0, lon: 0 }]);
    await store.append('vessels', [{ t: T0, key: 'v', lat: 0, lon: 0 }]);
    const health = await store.health();
    assert.deepEqual(Object.keys(health.backends).sort(), ['elasticsearch', 'sqlite']);
    assert.deepEqual(Object.keys(health.backends.elasticsearch.feeds), ['aircraft']);
    assert.deepEqual(Object.keys(health.backends.sqlite.feeds), ['vessels']);
    await store.close();
  });

  it('rejects a feed the settings do not cover', async () => {
    const store = createHistoryStore({ HISTORY_SQLITE_PATH: ':memory:' });
    for (const feed of ['satellites', 'constructor', 'toString', 'hasownproperty']) {
      await assert.rejects(store.slice(feed, { t: T0 }), (error) => error.code === 'INVALID_ARGUMENT', feed);
    }
    await store.close();
  });

  it('closes backends already opened when a later one fails to open', () => {
    let closed = 0;
    const good = () => ({ close() { closed += 1; } });
    const bad = () => { throw new Error('boom'); };
    assert.throws(() => createHistoryStore(
      { HISTORY_STORE: 'sqlite', HISTORY_STORE_WATER: 'elasticsearch' },
      { backends: { sqlite: good, elasticsearch: bad } },
    ), /boom/);
    assert.equal(closed, 1);
  });

  it('applies each feed retention and skips keep-forever feeds', async () => {
    const env = { HISTORY_SQLITE_PATH: ':memory:', HISTORY_RETENTION_DAYS: '10', HISTORY_RETENTION_DAYS_WATER: '0', HISTORY_RETENTION_DAYS_VESSELS: '2' };
    const store = createHistoryStore(env);
    const now = T0 + 30 * DAY;
    for (const feed of ['aircraft', 'vessels', 'water']) {
      await store.append(feed, [{ t: now - 20 * DAY, key: 'old' }, { t: now - 5 * DAY, key: 'mid' }, { t: now - DAY, key: 'new' }]);
    }
    const deleted = await applyRetention(store, store.config, now);
    assert.equal(deleted.aircraft, 1);
    assert.equal(deleted.vessels, 2);
    assert.equal('water' in deleted, false);
    assert.equal((await store.coverage('water')).count, 3);
    assert.equal((await store.coverage('aircraft')).count, 2);
    await store.close();
  });
});
