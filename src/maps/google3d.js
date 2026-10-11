const clean = (value) => String(value || '').trim();

/**
 * Decide which map provider can deliver the best startup experience.
 * Google 3D is only ever reached with OUR Google key (or server tokens); a
 * Cesium ion token never selects Google 3D (the ion-hosted Google asset runs
 * on Cesium's account and quota, which the owner does not want to depend on).
 * @param {{googleApiKey?: string}} credentials
 * @returns {'google-direct'|'osm'}
 */
export function selectMapStartupRoute({ googleApiKey = '' } = {}) {
  return clean(googleApiKey) ? 'google-direct' : 'osm';
}

/**
 * Load Google Photorealistic 3D Tiles directly from Google, with the app's
 * Google key (delivered at runtime, see byrdit/serverKeys.js) or, for
 * embedders, short-lived server tokens (googleTokens.js). There is NO
 * fallback to Cesium ion's hosted Google asset: when Google direct fails the
 * caller gets `{tileset: null, route: 'osm', errors}` and shows the non-Google
 * globe with a visible status.
 *
 * @param {object} Cesium
 * @param {{googleApiKey?: string, googleTokens?: {token: Function}|null}} credentials
 * @returns {Promise<{tileset: object|null, route: 'google-direct'|'google-token'|'osm', errors: Error[]}>}
 */
export async function loadPhotorealisticTileset(
  Cesium,
  { googleApiKey = '', googleTokens = null } = {},
) {
  const googleKey = clean(googleApiKey);
  const errors = [];

  const attempts = [];
  if (googleKey)
    attempts.push({
      route: 'google-direct',
      create: () => createGoogleDirectTileset(Cesium, googleKey),
    });
  else if (googleTokens)
    attempts.push({
      route: 'google-token',
      create: () => createGoogleTokenTileset(Cesium, googleTokens),
    });

  for (const attempt of attempts) {
    try {
      const tileset = await attempt.create();
      return { tileset, route: attempt.route, errors };
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }

  return { tileset: null, route: 'osm', errors };
}

/** Pass credentials to the source instead of changing SDK-wide defaults. */
export function createGoogleDirectTileset(Cesium, key) {
  key = clean(key);
  if (!key) throw new Error('Google 3D requires an explicit browser key');
  // Tiles keep drawing their own texture while draped weather loads.
  return Cesium.createGooglePhotorealistic3DTileset(
    { key, onlyUsingWithGoogleGeocoder: true },
    { asynchronouslyLoadImagery: true },
  );
}

/**
 * Google 3D with short-lived tokens instead of a key. Every tile request
 * carries the token as a header; a tile refused for an expired token gets
 * the renewed one and is tried once more.
 */
export async function createGoogleTokenTileset(Cesium, tokens) {
  const token = await tokens.token();
  if (!token) throw new Error('Google 3D tokens are not offered');
  const credit = Cesium.GoogleMaps.getDefaultCredit?.();
  const resource = new Cesium.Resource({
    url: `${Cesium.GoogleMaps.mapTilesApiEndpoint}v1/3dtiles/root.json`,
    headers: { Authorization: `Bearer ${token}` },
    credits: credit ? [credit] : undefined,
    retryAttempts: 1,
    async retryCallback(failed, error) {
      if (![401, 403].includes(error?.statusCode)) return false;
      const used = failed.headers.Authorization?.replace(/^Bearer /, '');
      const renewed = await tokens.token({ replacing: used });
      if (!renewed || renewed === used) return false;
      failed.headers.Authorization = `Bearer ${renewed}`;
      return true;
    },
  });
  // The settings Cesium's Google helper applies to the key route.
  return Cesium.Cesium3DTileset.fromUrl(resource, {
    cacheBytes: 1536 * 1024 * 1024,
    maximumCacheOverflowBytes: 1024 * 1024 * 1024,
    enableCollision: true,
    // Tiles keep drawing their own texture while draped weather loads.
    asynchronouslyLoadImagery: true,
  });
}
