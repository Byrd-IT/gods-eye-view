import assert from 'node:assert/strict';
import test from 'node:test';
import { createGhostMapsLayer } from './index.js';

function element(localName, children = [], value = '', attributes = {}) {
  const node = {
    localName,
    children,
    get textContent() {
      return value + children.map((child) => child.textContent).join('');
    },
    getAttribute: (key) => attributes[key] ?? null,
    getElementsByTagName(name) {
      return children.flatMap((child) => [
        ...(name === '*' || name === child.localName ? [child] : []),
        ...child.getElementsByTagName(name),
      ]);
    },
  };
  for (const child of children) child.parentElement = node;
  return node;
}

function documentFixture() {
  return element('document', [
    element('kml', [
      element('Document', [
        element(
          'Style',
          [
            element('IconStyle', [
              element('Icon', [element('href', [], 'icon.png')]),
            ]),
          ],
          '',
          { id: 'pin' },
        ),
        element('Placemark', [
          element('name', [], 'Test report'),
          element('styleUrl', [], '#pin'),
          element('Point', [element('coordinates', [], '12,34')]),
        ]),
      ]),
    ]),
  ]);
}

// A stored KMZ with a local icon; the XML DOM double supplies its one point.
function fixtureKmz() {
  const files = [
    ['doc.kml', '<kml/>'],
    ['icon.png', 'packed icon'],
  ];
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, value] of files) {
    const key = Buffer.from(name);
    const bytes = Buffer.from(value);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(key.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt32LE(bytes.length, 20);
    directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(key.length, 28);
    directory.writeUInt32LE(offset, 42);
    local.push(header, key, bytes);
    central.push(directory, key);
    offset += header.length + key.length + bytes.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, directory, end]));
}

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C1 = '1'.repeat(40);
const C2 = '2'.repeat(40);
const T1 = Date.UTC(2026, 9, 10, 12);
const T2 = Date.UTC(2026, 9, 15, 12);

function setup(t, sourceOver = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'DOMParser');
  globalThis.DOMParser = class {
    parseFromString() {
      return documentFixture();
    }
  };
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'DOMParser', previous);
    else delete globalThis.DOMParser;
  });
  t.mock.method(URL, 'createObjectURL', () => 'blob:x');
  t.mock.method(URL, 'revokeObjectURL', () => {});
  t.mock.method(console, 'warn', () => {});
  const mounted = new Set();
  const viewer = {
    scene: { requestRender() {} },
    dataSources: {
      async add(ds) {
        mounted.add(ds);
        return ds;
      },
      remove(ds) {
        return mounted.delete(ds);
      },
    },
  };
  const calls = [];
  let push = null;
  const archive = new Map([
    [
      T1,
      {
        history: true,
        position: 'between',
        commit: C1,
        committedAt: T1,
        message: 'Oct 10',
        products: [{ id: 'cip', version: A, defaultOn: true }],
      },
    ],
    [
      T2,
      {
        history: true,
        position: 'after',
        commit: C2,
        committedAt: T2,
        message: 'Oct 15',
        products: [{ id: 'cip', version: B, defaultOn: true }],
      },
    ],
  ]);
  const source = {
    getCatalog: async () => {
      calls.push(['live-catalog']);
      return {
        commit: 'f'.repeat(40),
        products: [{ id: 'cip', version: 'c'.repeat(40), defaultOn: true }],
      };
    },
    getFile: async (id, version) => {
      calls.push(['live-file', id, version]);
      return fixtureKmz();
    },
    getCatalogAt: async (tMs) => {
      calls.push(['at', tMs]);
      const hit = archive.get(tMs);
      if (hit) return hit;
      return {
        history: true,
        position: 'before',
        firstCommittedAt: T1,
        commit: null,
        committedAt: null,
        products: [],
      };
    },
    getFileAt: async (id, version, commit) => {
      calls.push(['at-file', id, version, commit]);
      return fixtureKmz();
    },
    subscribe(onCatalog) {
      push = onCatalog;
      return () => {};
    },
    ...sourceOver,
  };
  const layer = createGhostMapsLayer({ storage: null, source });
  layer.init(viewer);
  layer.enable();
  t.after(() => layer.destroy());
  return { layer, calls, mounted, push: (c) => push(c), archive };
}

test('history time shows the archived edition by commit and blob', async (t) => {
  const { layer, calls, mounted } = setup(t);
  await layer.setHistoryTime(T1);
  assert.deepEqual(calls, [
    ['at', T1],
    ['at-file', 'cip', A, C1],
  ]);
  assert.equal(mounted.size, 1);
  assert.equal(layer.getHistoryState().status, 'published');
  assert.equal(layer.getHistoryState().commit, C1);
  assert.equal(layer.getStats().history.committedAt, T1);
  assert.match(
    layer.getRowControls().info,
    /^HISTORY · as published 2026-10-10 12:00Z/,
  );
});

test('a later slider time swaps to the newer edition', async (t) => {
  const { layer, calls } = setup(t);
  await layer.setHistoryTime(T1);
  calls.length = 0;
  await layer.setHistoryTime(T2);
  assert.deepEqual(calls, [
    ['at', T2],
    ['at-file', 'cip', B, C2],
  ]);
  assert.equal(layer.getHistoryState().commit, C2);
});

test('the same edition at another time reloads nothing', async (t) => {
  const { layer, calls, archive } = setup(t);
  await layer.setHistoryTime(T1);
  archive.set(T1 + 1000, { ...archive.get(T1) });
  calls.length = 0;
  await layer.setHistoryTime(T1 + 1000);
  assert.deepEqual(calls, [['at', T1 + 1000]]);
});

test('an empty archive is nothing published yet, not a blank edition', async (t) => {
  const { layer, mounted } = setup(t, {
    getCatalogAt: async () => ({
      history: true,
      position: 'empty',
      commit: null,
      committedAt: null,
      products: [],
    }),
  });
  await layer.setHistoryTime(T1);
  assert.equal(mounted.size, 0);
  assert.equal(layer.getHistoryState().status, 'before');
  assert.equal(layer.getHistoryState().commit, null);
  assert.equal(
    layer.getRowControls().info,
    'HISTORY · nothing published yet at this time',
  );
});

test('before the first commit nothing is drawn and the state says so', async (t) => {
  const { layer, calls, mounted } = setup(t);
  await layer.setHistoryTime(T1);
  assert.equal(mounted.size, 1);
  await layer.setHistoryTime(T1 - 86_400_000);
  assert.equal(mounted.size, 0, 'the older edition left');
  assert.equal(layer.getHistoryState().status, 'before');
  assert.equal(layer.getHistoryState().firstCommittedAt, T1);
  assert.equal(calls.filter((c) => c[0].startsWith('live')).length, 0);
  assert.equal(
    layer.getRowControls().info,
    'HISTORY · nothing published yet at this time',
  );
});

test('LIVE with no history time leaves the live edition mounted', async (t) => {
  const { layer, calls, mounted } = setup(t);
  await layer.update({});
  assert.equal(mounted.size, 1);
  calls.length = 0;
  await layer.setHistoryTime(null);
  assert.equal(mounted.size, 1);
  assert.deepEqual(calls, []);
  assert.equal(layer.getHistoryState(), null);
});

test('LIVE after an archive failure does not reload the live edition', async (t) => {
  const { layer, calls, mounted } = setup(t, {
    getCatalogAt: async () => {
      throw new Error('archive down');
    },
  });
  await layer.update({});
  assert.equal(mounted.size, 1);
  calls.length = 0;
  await layer.setHistoryTime(T1);
  assert.equal(layer.getHistoryState().status, 'unavailable');
  assert.equal(
    mounted.size,
    1,
    'the live edition stayed when the archive failed',
  );
  const afterFail = calls.length;
  await layer.setHistoryTime(null);
  assert.equal(mounted.size, 1);
  assert.equal(
    calls.length,
    afterFail,
    'LIVE does not fetch the live edition again',
  );
  assert.equal(layer.getHistoryState(), null);
  assert.equal(layer.getRowControls().info.includes('HISTORY'), false);
});

test('a live push is ignored while history is on, LIVE restores live', async (t) => {
  const { layer, calls, mounted, push } = setup(t);
  await layer.setHistoryTime(T1);
  calls.length = 0;
  push({
    commit: 'f'.repeat(40),
    products: [{ id: 'cip', version: 'd'.repeat(40), defaultOn: true }],
  });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, [], 'no live file while history is on');
  await layer.setHistoryTime(null);
  assert.equal(layer.getHistoryState(), null);
  assert.deepEqual(calls, [
    ['live-catalog'],
    ['live-file', 'cip', 'c'.repeat(40)],
  ]);
  assert.equal(mounted.size, 1);
});

test('an archive failure shows live and does not echo the error', async (t) => {
  const secret = 'Bearer synth-token-9f3a7c21';
  const { layer } = setup(t, {
    getCatalogAt: async () => {
      const error = new Error(`fetch failed ${secret}`);
      error.cause = secret;
      throw error;
    },
    getCatalog: async () => {
      throw new Error(`live ${secret}`);
    },
  });
  const logs = [];
  t.mock.method(console, 'warn', (...args) =>
    logs.push(args.map(String).join(' ')),
  );
  await layer.setHistoryTime(T1);
  assert.equal(layer.getHistoryState().status, 'unavailable');
  assert.equal(layer.getStats().error, 'GhostMaps catalog unavailable');
  const haystack = [
    ...logs,
    JSON.stringify(layer.getHistoryState()),
    JSON.stringify(layer.getStats()),
    JSON.stringify(layer.getRowControls()),
  ].join('\n');
  assert.equal(haystack.includes(secret), false);
  assert.equal(haystack.includes('9f3a7c21'), false);
  assert.match(logs.join('\n'), /history unavailable/);
});

test('LIVE does not keep the history row if the live catalog fails', async (t) => {
  const { layer, mounted } = setup(t, {
    getCatalog: async () => {
      throw new Error('HTTP 503');
    },
  });
  await layer.setHistoryTime(T1);
  assert.match(layer.getRowControls().info, /^HISTORY /);
  assert.equal(mounted.size, 1);
  await layer.setHistoryTime(null);
  assert.equal(layer.getHistoryState(), null);
  assert.equal(layer.getRowControls().info.includes('HISTORY'), false);
  assert.equal(mounted.size, 0, 'the archived edition left the globe');
});

test('a failed archive and a failed live fetch unload the previous edition', async (t) => {
  let failArchive = false;
  const { layer, mounted } = setup(t, {
    getCatalogAt: async (tMs) => {
      if (failArchive) throw new Error('archive down');
      return {
        history: true,
        position: 'exact',
        commit: C1,
        committedAt: tMs,
        message: 'Oct 10',
        products: [{ id: 'cip', version: A, defaultOn: true }],
      };
    },
    getCatalog: async () => {
      throw new Error('live down');
    },
  });
  await layer.setHistoryTime(T1);
  assert.equal(mounted.size, 1);
  failArchive = true;
  await layer.setHistoryTime(T2);
  assert.equal(layer.getHistoryState().status, 'unavailable');
  assert.equal(mounted.size, 0);
  assert.equal(layer.getRowControls().info.includes('HISTORY'), false);
});

test('a slow answer for an older time never replaces a newer one', async (t) => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { layer, archive } = setup(t);
  const base = archive;
  const slowSource = {
    getCatalogAt: async (tMs) => {
      if (tMs === T1) await gate;
      return base.get(tMs);
    },
  };
  const second = setup(t, slowSource);
  const first = second.layer.setHistoryTime(T1);
  await second.layer.setHistoryTime(T2);
  release();
  await first;
  assert.equal(second.layer.getHistoryState().commit, C2);
  assert.equal(layer.getHistoryState(), null);
});

test('the layer enabled while history is on asks the archive', async (t) => {
  const { layer, calls } = setup(t);
  layer.disable();
  await layer.setHistoryTime(T2);
  assert.equal(layer.getHistoryState(), null, 'disabled: no answer yet');
  layer.enable();
  await layer.update({});
  assert.deepEqual(calls.slice(0, 2), [
    ['at', T2],
    ['at-file', 'cip', B, C2],
  ]);
});

test('the live path does not echo a fetch error (catalog and file)', async (t) => {
  const secret =
    'https://user:pw-synth-4471@host.example/x?api_key=synth-key-8812';
  const { layer } = setup(t, {
    getCatalog: async () => {
      throw new Error(`catalog ${secret}`);
    },
  });
  const logs = [];
  t.mock.method(console, 'warn', (...args) =>
    logs.push(
      args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' '),
    ),
  );
  await layer.update({});
  assert.equal(layer.getStats().error, 'GhostMaps catalog unavailable');
  const file = setup(t, {
    getFile: async () => {
      const error = new Error(`file ${secret}`);
      error.template = `template ${secret}`;
      throw error;
    },
  });
  t.mock.method(console, 'warn', (...args) =>
    logs.push(
      args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' '),
    ),
  );
  await file.layer.update({});
  assert.equal(file.layer.getStats().error, 'GhostMaps file could not be read');
  const haystack = [
    ...logs,
    JSON.stringify(layer.getStats()),
    JSON.stringify(file.layer.getStats()),
    JSON.stringify(file.layer.getRowControls()),
  ].join('\n');
  for (const needle of [
    'pw-synth-4471',
    'synth-key-8812',
    'user:pw',
    'api_key',
  ])
    assert.equal(haystack.includes(needle), false, needle);
  assert.ok(logs.length >= 2, 'both paths logged a fixed line');
});

test('LIVE during the first archive request refreshes a live push that was ignored', async (t) => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { layer, calls, push } = setup(t, {
    getCatalogAt: async () => {
      await gate;
      return { history: true, position: 'before', commit: null, products: [] };
    },
  });
  await layer.update({}); // the live edition is drawn
  calls.length = 0;
  const pending = layer.setHistoryTime(T1); // first archive request runs
  push({
    commit: 'f'.repeat(40),
    products: [{ id: 'cip', version: 'd'.repeat(40), defaultOn: true }],
  });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, [], 'the push is ignored while history is on');
  await layer.setHistoryTime(null);
  assert.equal(calls[0]?.[0], 'live-catalog', 'the ignored push is refreshed');
  release();
  await pending;
  assert.equal(layer.getHistoryState(), null);
});

test('LIVE with no ignored push does not fetch the live edition again', async (t) => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { layer, calls } = setup(t, {
    getCatalogAt: async () => {
      await gate;
      return { history: true, position: 'before', commit: null, products: [] };
    },
  });
  await layer.update({});
  calls.length = 0;
  const pending = layer.setHistoryTime(T1);
  await layer.setHistoryTime(null);
  assert.deepEqual(calls, []);
  release();
  await pending;
});

test('an archive failure reuses the last live catalog and does not call the live endpoint', async (t) => {
  const { layer, calls, mounted } = setup(t, {
    getCatalogAt: async () => {
      throw new Error('archive down');
    },
  });
  await layer.update({});
  const liveCalls = calls.filter(([k]) => k === 'live-catalog').length;
  assert.equal(liveCalls, 1);
  assert.equal(mounted.size, 1);
  calls.length = 0;
  await layer.setHistoryTime(T1);
  assert.equal(layer.getHistoryState().status, 'unavailable');
  assert.equal(
    calls.some(([k]) => k === 'live-catalog'),
    false,
    'the live endpoint (which starts the GitHub watcher) is not called',
  );
  assert.equal(mounted.size, 1, 'live stays drawn');
  // a second failure at another time, and LIVE, still make no live call
  await layer.setHistoryTime(T2);
  await layer.setHistoryTime(null);
  assert.equal(
    calls.some(([k]) => k === 'live-catalog'),
    false,
  );
  assert.equal(mounted.size, 1);
});

test('with no live catalog yet, an archive failure still asks for live', async (t) => {
  const { layer, calls, mounted } = setup(t, {
    getCatalogAt: async () => {
      throw new Error('archive down');
    },
  });
  await layer.setHistoryTime(T1);
  assert.equal(layer.getHistoryState().status, 'unavailable');
  assert.equal(calls.filter(([k]) => k === 'live-catalog').length, 1);
  assert.equal(mounted.size, 1);
});

test('a live push missed in history is answered by the live redraw after an archive failure', async (t) => {
  const { layer, calls, push } = setup(t, {
    getCatalogAt: async () => {
      throw new Error('archive down');
    },
  });
  await layer.update({});
  await layer.setHistoryTime(T1); // unavailable: live from the cache
  push({
    commit: 'e'.repeat(40),
    products: [{ id: 'cip', version: 'd'.repeat(40), defaultOn: true }],
  });
  calls.length = 0;
  // The next failure sees the cache is stale and fetches live once ...
  await layer.setHistoryTime(T2);
  assert.equal(calls.filter(([k]) => k === 'live-catalog').length, 1);
  calls.length = 0;
  // ... and that fetch answered the push: LIVE does not fetch again.
  await layer.setHistoryTime(null);
  assert.equal(calls.filter(([k]) => k === 'live-catalog').length, 0);
});

test('an archive failure that is superseded during the drop neither applies live nor asks for it', async (t) => {
  let n = 0;
  const { layer, calls, mounted, archive } = setup(t, {
    getCatalogAt: async (tMs) => {
      n += 1;
      calls.push(['at', tMs]);
      // the second request (a failure) is the stale one
      if (n === 2) throw new Error('archive down');
      return archive.get(tMs);
    },
  });
  await layer.setHistoryTime(T1); // a history edition is drawn
  assert.equal(layer.getHistoryState().commit, C1);
  calls.length = 0;
  // The failed request drops the history draw; a newer request starts then.
  let newer = null;
  const realDelete = mounted.delete.bind(mounted);
  t.mock.method(mounted, 'delete', (ds) => {
    if (!newer) newer = layer.setHistoryTime(T2);
    return realDelete(ds);
  });
  await layer.setHistoryTime(T1 + 1);
  assert.ok(newer, 'the drop started the newer request');
  await newer;
  assert.equal(
    calls.some(([k]) => k === 'live-catalog'),
    false,
    'the stale failure did not ask for live',
  );
  assert.equal(layer.getHistoryState().status, 'published');
  assert.equal(layer.getHistoryState().commit, C2);
});

test('LIVE whose live fetch fails keeps the missed push for the next fetch', async (t) => {
  let liveFails = false;
  const { layer, calls, push } = setup(t, {
    getCatalogAt: async () => {
      throw new Error('archive down');
    },
    getCatalog: async () => {
      calls.push(['live-catalog']);
      if (liveFails) throw new Error('live down');
      return {
        commit: 'f'.repeat(40),
        products: [{ id: 'cip', version: 'c'.repeat(40), defaultOn: true }],
      };
    },
  });
  await layer.update({});
  await layer.setHistoryTime(T1); // unavailable, live from the cache
  push({
    commit: 'e'.repeat(40),
    products: [{ id: 'cip', version: 'd'.repeat(40), defaultOn: true }],
  });
  liveFails = true;
  await layer.setHistoryTime(null); // the live fetch fails
  liveFails = false;
  calls.length = 0;
  // the push is still owed: the cache is stale, so live is fetched
  await layer.setHistoryTime(T2);
  assert.equal(calls.filter(([k]) => k === 'live-catalog').length, 1);
});

test('disabling the layer forgets a missed live push and the cached live catalog', async (t) => {
  const { layer, calls, push } = setup(t, {
    getCatalogAt: async () => {
      throw new Error('archive down');
    },
  });
  await layer.update({});
  await layer.setHistoryTime(T1);
  push({ commit: 'e'.repeat(40), products: [] });
  layer.disable();
  layer.enable();
  calls.length = 0;
  // Nothing cached after disable: this failure must ask for live, once,
  // and the old missed flag must not cause a second fetch on LIVE.
  await layer.setHistoryTime(T2);
  assert.equal(calls.filter(([k]) => k === 'live-catalog').length, 1);
  calls.length = 0;
  await layer.setHistoryTime(null);
  assert.equal(calls.filter(([k]) => k === 'live-catalog').length, 0);
});
