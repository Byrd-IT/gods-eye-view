import { buildLiveApiAdapters } from './adapters/index.js';
import { createLiveApiStore } from './liveApi.js';
import { createLiveOnlyStore } from './liveOnly.js';

export { createLiveApiStore, createLiveOnlyStore, buildLiveApiAdapters };
export * from './support.js';

/** The two backends the store router knows by name. */
export const LIVE_BACKENDS = Object.freeze({
  'live-only': () => createLiveOnlyStore(),
  'live-api': (_config, env) =>
    createLiveApiStore({ adapters: buildLiveApiAdapters(env) }),
});
