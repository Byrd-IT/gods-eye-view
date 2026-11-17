import { MapSourceController } from './maps/controller.js';
import { createDefaultMapSources } from './maps/defaultSources.js';
import { mapEngineFor } from './maps/engine.js';
import { governorRequestRender } from './renderGovernor.js';
export { MAP_STACKS } from './maps/catalog.js';
export { photorealUnavailableReason } from './maps/availability.js';

/** Preserve the standalone entry point; applications can compose the source controller directly. */
export class MapStackController extends MapSourceController {
  constructor(viewer, options = {}) {
    // Byrd-IT: no Google key in the page (server-side keys); the proxy adds it.
    // The scene's map engine, unless the caller names one.
    const engine = options.engine ?? mapEngineFor(viewer);
    const registry = createDefaultMapSources({ ...options, engine });
    super(viewer, {
      registry,
      engine,
      initialStack: options.googleTileset
        ? options.initialStack || 'photoreal'
        : registry.defaultId,
      ...options,
      requestRender: governorRequestRender,
    });
    this.googleTileset = options.googleTileset || null;
    this.cesiumToken = String(options.cesiumToken || '').trim();
    this._googleKeyPresent = Boolean(String(options.googleApiKey || '').trim());
  }
  _hasPhotorealCredentials() {
    return Boolean(this._googleKeyPresent);
  }
}
