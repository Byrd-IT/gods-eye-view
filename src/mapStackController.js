import { MapSourceController } from './maps/controller.js';
import { createDefaultMapSources } from './maps/defaultSources.js';
import { governorRequestRender } from './renderGovernor.js';
export { MAP_STACKS } from './maps/catalog.js';
export { photorealUnavailableReason } from './maps/availability.js';

/** Preserve the standalone entry point; applications can compose the source controller directly. */
export class MapStackController extends MapSourceController {
  constructor(viewer, options = {}) {
    const registry = createDefaultMapSources(options);
    super(viewer, {
      registry,
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
