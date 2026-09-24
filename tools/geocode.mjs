/**
 * Address/city/ZIP -> coordinates, via OpenStreetMap's Nominatim (free, no
 * key). Extracted from tools/fetch-ecosystem-index.mjs's resolveCoordinates
 * so the saved-areas UI (nl-5nm) can geocode a typed location the same way
 * that script already turns a yard's stored address into lat/lng,
 * instead of forking a second copy of the same request.
 *
 * Cached via tools/usda-plants/probeCache.js (source 'nominatim'), same as
 * the original call site — a repeated lookup of the same string is a disk
 * read, not a fresh hit against Nominatim's shared, rate-limited service.
 */
import { cached } from './usda-plants/probeCache.js';

const USER_AGENT = 'native-landscaping-app (ecology data fetch; github.com/johntron/native_landscaping)';

/**
 * @param {string} query free-text address, city, or ZIP
 * @param {object} options
 * @param {import('node:sqlite').DatabaseSync} options.probeCache open handle from openProbeCache()
 * @param {boolean} [options.force] bypass the cache for a fresh lookup
 * @returns {Promise<{lat: number, lng: number, displayName: string, city: string, state: string, country: string}>}
 */
export async function geocodeAddress(query, { probeCache, force = false } = {}) {
  const trimmed = String(query || '').trim();
  if (!trimmed) throw new Error('geocodeAddress requires a non-empty query');

  const { raw: results } = await cached(
    probeCache,
    'nominatim',
    'search',
    trimmed,
    async () => {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=1&q=${encodeURIComponent(trimmed)}`;
      const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (!response.ok) throw new Error(`Geocoding failed: HTTP ${response.status}`);
      return response.json();
    },
    { force }
  );
  if (!results.length) throw new Error(`Geocoding found nothing for "${trimmed}"`);

  const result = results[0];
  const address = result.address || {};
  return {
    lat: Number(result.lat),
    lng: Number(result.lon),
    displayName: result.display_name || trimmed,
    city: address.city || address.town || address.village || address.hamlet || '',
    state: address.state || '',
    country: address.country || '',
  };
}
