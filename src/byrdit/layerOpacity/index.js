/**
 * Byrd-IT fork: layer opacity feature entry. Builds the model, restores it
 * from `?lop=`, keeps the address in step with it, and installs the writer.
 */
import { installLayerOpacity } from './install.js';
import {
  createOpacityModel,
  readLopFromUrl,
  writeLopToUrl,
} from './opacityModel.js';

/** Layers that already carry their own opacity control. */
export const OWN_OPACITY_LAYERS = new Set(['recent-imagery']);

export function createLayerOpacity({
  viewer,
  dataManager,
  locationRef = globalThis.location,
  historyRef = globalThis.history,
}) {
  const ids = [...dataManager.layers.keys()].filter(
    (id) => !OWN_OPACITY_LAYERS.has(id),
  );
  const model = createOpacityModel({ ids });
  const restored = locationRef
    ? readLopFromUrl(locationRef.href, (id) => model.has(id))
    : new Map();
  const writer = installLayerOpacity({ viewer, dataManager, model });
  for (const [id, value] of restored) model.set(id, value);
  const unsubscribe = model.subscribe(() => {
    if (!locationRef || !historyRef?.replaceState) return;
    try {
      const next = writeLopToUrl(locationRef.href, model.entries());
      if (next !== locationRef.href)
        historyRef.replaceState(historyRef.state, '', next);
    } catch {
      /* the address is a convenience; never break the slider */
    }
  });
  return {
    model,
    ids,
    destroy() {
      unsubscribe();
      writer.destroy();
    },
  };
}
