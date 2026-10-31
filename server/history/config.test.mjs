import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_RETENTION_DAYS,
  HISTORY_FEEDS,
  HistoryConfigError,
  loadHistoryConfig,
} from './config.js';

const load = (env, options) => loadHistoryConfig(env, options);
const problems = (env, options) => {
  try {
    load(env, options);
  } catch (error) {
    assert.ok(error instanceof HistoryConfigError);
    assert.equal(error.code, 'CONFIG');
    return error.problems;
  }
  return assert.fail('expected a HistoryConfigError');
};

describe('history configuration', () => {
  it('defaults every feed to sqlite, 30 days and ./data/history.sqlite', () => {
    const config = load({});
    assert.equal(config.defaultStore, 'sqlite');
    assert.equal(config.sqlitePath, './data/history.sqlite');
    assert.deepEqual(Object.keys(config.feeds), [...HISTORY_FEEDS]);
    for (const feed of Object.values(config.feeds)) {
      assert.deepEqual({ ...feed }, { store: 'sqlite', retentionDays: DEFAULT_RETENTION_DAYS });
    }
    assert.deepEqual([...config.warnings], []);
  });

  it('applies the global setting, then a per-feed override', () => {
    const config = load(
      { HISTORY_RETENTION_DAYS: '90', HISTORY_RETENTION_DAYS_AIRCRAFT: '7', HISTORY_SQLITE_PATH: '/var/lib/gev/h.sqlite' },
    );
    assert.equal(config.feeds.aircraft.retentionDays, 7);
    assert.equal(config.feeds.vessels.retentionDays, 90);
    assert.equal(config.sqlitePath, '/var/lib/gev/h.sqlite');
  });

  it('lets a feed pick elasticsearch when the build provides it', () => {
    const config = load(
      { HISTORY_STORE: 'sqlite', HISTORY_STORE_AIRCRAFT: ' Elasticsearch ' },
      { available: ['sqlite', 'elasticsearch'] },
    );
    assert.equal(config.feeds.aircraft.store, 'elasticsearch');
    assert.equal(config.feeds.vessels.store, 'sqlite');
  });

  it('treats 0 days as keep forever and blank values as unset', () => {
    const config = load({ HISTORY_RETENTION_DAYS_WATER: '0', HISTORY_RETENTION_DAYS: '', HISTORY_STORE: '  ' });
    assert.equal(config.feeds.water.retentionDays, 0);
    assert.equal(config.feeds.aircraft.retentionDays, DEFAULT_RETENTION_DAYS);
  });

  it('rejects a backend the build does not provide', () => {
    const found = problems({ HISTORY_STORE: 'elasticsearch' });
    assert.equal(found.length, 1);
    assert.match(found[0], /HISTORY_STORE selects a backend this build does not provide/);
  });

  it('rejects a per-feed backend the build does not provide', () => {
    assert.match(problems({ HISTORY_STORE_VESSELS: 'elasticsearch' })[0], /HISTORY_STORE_VESSELS/);
  });

  it('rejects an unknown backend name', () => {
    assert.match(problems({ HISTORY_STORE: 'oracle' })[0], /must be one of: sqlite, elasticsearch, mysql, postgres, live-api, live-only, mariadb/);
  });

  it('rejects an override for a feed that does not exist', () => {
    const found = problems({ HISTORY_STORE_AIRCRAF: 'sqlite', HISTORY_RETENTION_DAYS_NOPE: '5' });
    assert.equal(found.length, 2);
    assert.match(found[0], /HISTORY_STORE_AIRCRAF names no known feed/);
  });

  it('rejects bad retention values', () => {
    for (const value of ['-1', '1.5', 'abc', '3651', '1e3', '99999999']) {
      assert.match(problems({ HISTORY_RETENTION_DAYS: value })[0], /whole number of days/, value);
    }
  });

  it('lists every problem at once', () => {
    assert.equal(problems({ HISTORY_STORE: 'x', HISTORY_RETENTION_DAYS: 'y', HISTORY_STORE_NOPE: 'sqlite' }).length, 3);
  });

  it('never quotes a configured value in a problem', () => {
    const secret = 'https://user:hunter2-token@example.invalid/path';
    const text = problems({ HISTORY_STORE: secret, HISTORY_RETENTION_DAYS: secret, HISTORY_SQLITE_PATH: `${secret}\0` }).join('\n');
    assert.ok(!text.includes('hunter2'), text);
    assert.ok(!text.includes('example.invalid'), text);
  });

  it('warns when a sqlite path is set but no feed uses sqlite', () => {
    const config = load(
      { HISTORY_STORE: 'elasticsearch', HISTORY_SQLITE_PATH: './x.sqlite' },
      { available: ['sqlite', 'elasticsearch'] },
    );
    assert.equal(config.warnings.length, 1);
    assert.match(config.warnings[0], /HISTORY_SQLITE_PATH/);
  });

  it('returns a frozen object', () => {
    const config = load({});
    assert.throws(() => { 'use strict'; config.defaultStore = 'x'; }, TypeError);
    assert.throws(() => { 'use strict'; config.feeds.aircraft.store = 'x'; }, TypeError);
  });
});

describe('history configuration: odd variable names', () => {
  it('does not repeat a variable name that is not a plain upper-case name', () => {
    const odd = 'HISTORY_STORE_https://user:hunter2-token@example.invalid';
    let text = '';
    try {
      loadHistoryConfig({ [odd]: 'sqlite' });
    } catch (error) {
      text = error.problems.join('\n');
    }
    assert.match(text, /HISTORY_STORE_<unrecognised> names no known feed/);
    assert.ok(!text.includes('hunter2'), text);
  });
});

describe('history configuration: misspelled settings', () => {
  it('rejects a HISTORY_* name that is not a setting', () => {
    const found = problems({
      HISTORY_STORES: 'sqlite',
      HISTORY_RETENTION_DAY: '5',
      HISTORY_SQLITE: './x',
    });
    assert.equal(found.length, 3);
    assert.match(found[0], /HISTORY_STORES is not a history setting/);
  });

  it('ignores a misspelled name that is blank and unrelated names', () => {
    assert.doesNotThrow(() => load({ HISTORY_STORES: '', HISTORYSTORE: 'x', PATH: '/usr/bin' }));
  });
});
