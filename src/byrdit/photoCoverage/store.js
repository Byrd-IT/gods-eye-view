import { coverageCounts } from './coverageCore.js';
import { defaultArea, rankGaps } from './gaps.js';

const PREFIX = '/api/byrdit/coverage';
const MODEL = /^(s4_today|s6_shop800|nov16plus)$/;
const SET_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
export function createCoverageStore({ fetchImpl = globalThis.fetch } = {}) {
  let state = null,
    generation = 0;
  async function json(path, options) {
    try {
      const r = await fetchImpl(`${PREFIX}/${path}`, options);
      if (!r.ok) throw new Error('request failed');
      return await r.json();
    } catch {
      throw new Error('Coverage service unavailable');
    }
  }
  const snapshot = () => {
    if (!state) return null;
    const counts = coverageCounts(state.cells, state.photos, state.discarded);
    return {
      ...state,
      discarded: new Set(state.discarded),
      counts,
      gaps: rankGaps(state.cells, state.mask, counts),
    };
  };
  return {
    snapshot,
    async load(model) {
      if (!MODEL.test(model)) throw new Error('Unknown coverage model');
      const g = ++generation;
      state = null;
      const [meta, pd, cells] = await Promise.all(
        ['model.json', 'photos.json', 'cells.json'].map((file) =>
          json(`${model}/${file}`),
        ),
      );
      if (g !== generation) return null;
      if (meta.id !== model || pd.model !== model || cells.model !== model)
        throw new Error('Mismatched coverage model');
      coverageCounts(cells, pd.photos);
      state = {
        model,
        meta,
        photos: pd.photos,
        cells,
        mask: defaultArea(cells, pd.photos),
        discarded: new Set(),
        history: [],
      };
      return snapshot();
    },
    clear() {
      generation++;
      state = null;
    },
    setKept(names, kept) {
      if (!state || !Array.isArray(names)) throw new Error('No coverage model');
      const known = new Set(
        state.photos.filter((p) => p.placed).map((p) => p.name),
      );
      if (names.some((n) => !known.has(n))) throw new Error('Unknown photo');
      state.history.push(new Set(state.discarded));
      for (const name of names)
        if (kept) state.discarded.delete(name);
        else state.discarded.add(name);
      return snapshot();
    },
    undo() {
      if (state?.history.length) state.discarded = state.history.pop();
      return snapshot();
    },
    async listSets() {
      if (!state) throw new Error('No coverage model');
      return json(`${state.model}/keepsets.json`);
    },
    async loadSet(file) {
      if (!state || !SET_FILE.test(file)) throw new Error('Invalid keep set');
      const s = state,
        doc = await json(`${s.model}/keepsets/${file}.json`);
      if (state !== s) return null;
      const known = new Set(
        s.photos.filter((p) => p.placed).map((p) => p.name),
      );
      if (
        doc.model !== s.model ||
        !Array.isArray(doc.discard) ||
        doc.discard.some((n) => !known.has(n))
      )
        throw new Error('Invalid keep set');
      s.history.push(new Set(s.discarded));
      s.discarded = new Set(doc.discard);
      return snapshot();
    },
    async save(name, note = '') {
      if (!state) throw new Error('No coverage model');
      const s = state;
      return json(`${s.model}/keepsets`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-requested-with': 'gev',
        },
        body: JSON.stringify({ name, note, discard: [...s.discarded] }),
      });
    },
  };
}
