import {
  IMAGE_FIELDS,
  NEAREST_LIMIT,
  NEAREST_RADIUS_M,
  SEQUENCE_IMAGE_FIELDS,
  SEQUENCE_IMAGES_LIMIT,
} from './policy.js';

/** HTTP error flagged `keyRequired`, `keyRejected` or `retryAfterSec` (429). */
export class MapillarySourceError extends Error {
  constructor(message, { status = 0, payload = null, retryAfterSec } = {}) {
    super(message);
    this.name = 'MapillarySourceError';
    this.status = status;
    this.payload = payload;
    this.keyRequired = payload?.keyRequired ?? payload?.error === 'no_key';
    this.keyRejected = payload?.keyRejected === true;
    const wait = Number(retryAfterSec ?? payload?.retryAfter);
    this.retryAfterSec =
      status === 429 ? (Number.isFinite(wait) && wait > 0 ? wait : 60) : null;
  }
}

async function readJsonOrThrow(response, label) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    /* status is authoritative */
  }
  if (!response.ok)
    throw new MapillarySourceError(
      payload?.error?.message ||
        payload?.error ||
        `${label} HTTP ${response.status}`,
      { status: response.status, payload },
    );
  return payload;
}

/**
 * Mapillary network access: tiles and Graph API lookups both go through this
 * app's server, which adds the client token (the browser never holds it).
 * `configured` is learned from the status route.
 * @param {{fetchImpl?: Function, endpoints?: object}} options
 */
export function createMapillarySource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  endpoints = {},
} = {}) {
  const urls = {
    status: '/api/mapillary/status',
    tiles: '/api/mapillary/tiles',
    graph: '/api/mapillary/graph',
    ...endpoints,
  };
  let configured = false;

  async function graph(path, params = {}, { signal } = {}) {
    const search = new URLSearchParams(params);
    const response = await fetchImpl(`${urls.graph}/${path}?${search}`, {
      signal,
    });
    return readJsonOrThrow(response, 'Mapillary graph');
  }

  return {
    /** Absolute Graph endpoint (with trailing slash) for MapillaryJS. */
    get graphEndpoint() {
      // MapillaryJS resolves paths against this with `new URL`, so it must be
      // absolute and end in a slash.
      return new URL(
        `${urls.graph.replace(/\/$/, '')}/`,
        globalThis.location?.href ?? 'http://localhost/',
      ).href;
    },
    /** True once the server has said it holds a token. */
    hasToken: () => configured,

    async getStatus({ signal } = {}) {
      const response = await fetchImpl(urls.status, {
        signal,
        cache: 'no-store',
      });
      const status = await readJsonOrThrow(response, 'Mapillary status');
      configured = status?.configured === true;
      return status;
    },

    /** Raw protobuf bytes for one tile; an empty array means no data. */
    async getTile(layer, z, x, y, { signal } = {}) {
      const response = await fetchImpl(
        `${urls.tiles}/${layer}/${z}/${x}/${y}`,
        {
          signal,
        },
      );
      if (response.status === 204) return new Uint8Array(0);
      if (!response.ok) {
        let payload = null;
        try {
          payload = await response.json();
        } catch {
          /* ignore */
        }
        throw new MapillarySourceError(
          payload?.error || `Tile HTTP ${response.status}`,
          {
            status: response.status,
            payload,
            retryAfterSec: response.headers?.get?.('retry-after') ?? undefined,
          },
        );
      }
      return new Uint8Array(await response.arrayBuffer());
    },

    async getSequenceImages(
      sequenceId,
      { signal, limit = SEQUENCE_IMAGES_LIMIT } = {},
    ) {
      const payload = await graph(
        'images',
        {
          sequence_ids: String(sequenceId),
          fields: SEQUENCE_IMAGE_FIELDS,
          limit: String(limit),
        },
        { signal },
      );
      return Array.isArray(payload?.data) ? payload.data : [];
    },

    async nearestImages(
      { lat, lon, radius = NEAREST_RADIUS_M, limit = NEAREST_LIMIT },
      { signal } = {},
    ) {
      const payload = await graph(
        'images',
        {
          lat: String(lat),
          lng: String(lon),
          radius: String(Math.min(50, Math.max(1, radius))),
          limit: String(Math.min(100, Math.max(1, limit))),
          fields: IMAGE_FIELDS,
        },
        { signal },
      );
      return Array.isArray(payload?.data) ? payload.data : [];
    },
  };
}
