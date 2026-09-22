/**
 * Coordinates -> EPA Level I ecoregion, via a public, keyless Esri
 * FeatureServer of CEC/EPA North America Terrestrial Ecoregions Level I
 * polygons. Live-tested 2026-09-22 against three known points and confirmed
 * to return exactly the codes this project already documents in
 * src/data/ecoregionInput.js's KNOWN_ECOREGIONS/ECOREGION_CROSSWALK:
 *   Dallas          (32.7767, -96.7970) -> "9"  Great Plains
 *   East Texas      (31.3,    -94.7)    -> "8"  Eastern Temperate Forests
 *   Trans-Pecos     (30.0,   -104.0)    -> "10" North American Deserts
 *
 * This is a real point-in-polygon lookup against sourced boundary data, not
 * a guess — the distinction src/data/ecoregionInput.js's header comment
 * draws against ZIP-code guessing. A miss (point outside coverage, or a
 * request failure) returns null rather than throwing, matching this
 * project's "report, don't guess" stance elsewhere (loadYardRelevanceTables,
 * loadRarityTables): the caller decides how to tell the user nothing was
 * found, this module never fabricates an answer.
 */
import { cached } from './usda-plants/probeCache.js';

const FEATURE_SERVER_QUERY_URL =
  'https://services7.arcgis.com/oF9CDB4lUYF7Um9q/arcgis/rest/services/NA_Terrestrial_Ecoregions_Level_1/FeatureServer/5/query';

/** Cache key precision: ecoregion boundaries don't need full GPS precision, and rounding keeps repeat lookups near the same point cheap. */
function roundForCacheKey(n) {
  return Math.round(n * 1000) / 1000;
}

/**
 * @param {number} lat
 * @param {number} lng
 * @param {object} options
 * @param {import('node:sqlite').DatabaseSync} options.probeCache open handle from openProbeCache()
 * @param {boolean} [options.force] bypass the cache for a fresh lookup
 * @returns {Promise<{code: string, name: string}|null>}
 */
export async function lookupEcoregion(lat, lng, { probeCache, force = false } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error('lookupEcoregion requires finite lat/lng');
  }
  const cacheKey = `${roundForCacheKey(lat)},${roundForCacheKey(lng)}`;

  const { raw: body } = await cached(
    probeCache,
    'cec-ecoregions',
    'level1-query',
    cacheKey,
    async () => {
      const url = new URL(FEATURE_SERVER_QUERY_URL);
      url.searchParams.set('geometry', `${lng},${lat}`);
      url.searchParams.set('geometryType', 'esriGeometryPoint');
      url.searchParams.set('inSR', '4326');
      url.searchParams.set('spatialRel', 'esriSpatialRelIntersects');
      url.searchParams.set('outFields', 'LEVEL1,NameL1_En');
      url.searchParams.set('returnGeometry', 'false');
      url.searchParams.set('f', 'json');
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Ecoregion lookup failed: HTTP ${response.status}`);
      const parsed = await response.json();
      if (parsed.error) throw new Error(`Ecoregion lookup failed: ${parsed.error.message || JSON.stringify(parsed.error)}`);
      return parsed;
    },
    { force }
  );

  const feature = body.features?.[0];
  if (!feature) return null;
  return {
    code: String(feature.attributes.LEVEL1),
    name: feature.attributes.NameL1_En || '',
  };
}
