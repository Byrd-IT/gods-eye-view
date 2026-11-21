import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoverageStore } from './store.js';
const model = 's4_today';
const photos = [
  { name: 'a.jpg', placed: true, looks_at_ground: true, x: 0, y: 0 },
];
const cells = {
  model,
  nx: 2,
  ny: 2,
  x0: 0,
  y0: 0,
  cell_m: 10,
  k: [0],
  photos: [[0]],
};
const meta = { id: model };
const ok = (body) => ({ ok: true, json: async () => body });
test('keep/discard, undo, save and load share upstream contract', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push([url, options]);
    if (url.endsWith('/model.json')) return ok(meta);
    if (url.endsWith('/photos.json')) return ok({ model, photos });
    if (url.endsWith('/cells.json')) return ok(cells);
    if (url.endsWith('/keepsets.json')) return ok([{ file: 'old' }]);
    if (url.endsWith('/keepsets/old.json'))
      return ok({ model, discard: ['a.jpg'] });
    return ok({ ok: true });
  };
  const s = createCoverageStore({ fetchImpl });
  assert.deepEqual((await s.load(model)).counts, [1]);
  assert.deepEqual(s.setKept(['a.jpg'], false).counts, [0]);
  assert.deepEqual(s.undo().counts, [1]);
  assert.equal((await s.listSets())[0].file, 'old');
  assert.deepEqual((await s.loadSet('old')).counts, [0]);
  await s.save('new');
  const [url, opts] = requests.at(-1);
  assert(url.endsWith('/s4_today/keepsets'));
  assert.deepEqual(JSON.parse(opts.body), {
    name: 'new',
    note: '',
    discard: ['a.jpg'],
  });
  assert.equal(opts.headers['x-requested-with'], 'gev');
  assert.throws(() => s.setKept(['bad'], false));
  await assert.rejects(s.load('../bad'));
});
test('an old load cannot replace the state after clear', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const s = createCoverageStore({
    fetchImpl: async (url) => {
      await gate;
      return ok(
        url.endsWith('/model.json')
          ? meta
          : url.endsWith('/photos.json')
            ? { model, photos }
            : cells,
      );
    },
  });
  const loading = s.load(model);
  s.clear();
  release();
  assert.equal(await loading, null);
  assert.equal(s.snapshot(), null);
});

test('transport and JSON parser errors are not exposed to callers', async () => {
  for (const fetchImpl of [
    async () => {
      throw new Error('sensitive upstream detail');
    },
    async () => ({
      ok: true,
      json: async () => {
        throw new Error('sensitive upstream detail');
      },
    }),
  ]) {
    const store = createCoverageStore({ fetchImpl });
    await assert.rejects(store.load(model), (error) => {
      assert.equal(error.message, 'Coverage service unavailable');
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});
