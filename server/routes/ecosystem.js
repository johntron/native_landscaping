import { promises as fs } from 'node:fs';
import { isValidProjectId } from '../../src/data/projectConfig.js';
import { projectIdFromUrl, resolveProjectPaths } from '../../src/data/projectPaths.js';
import { listSpeciesObservations, listPlaces } from '../../tools/ecosystemIndexDb.js';
import { excludeNonNative } from '../../src/analysis/establishmentMeans.js';
import { geocodeAddress } from '../../tools/geocode.mjs';
import { lookupEcoregion } from '../../tools/ecoregionLookup.mjs';
import { KNOWN_ECOREGIONS } from '../../src/data/ecoregionInput.js';
import { collectPayload, createRateLimiter, enforceRateLimit, rateLimitKeyFor } from '../http.js';

// /api/geocode calls Nominatim (tools/geocode.mjs). Nominatim's usage policy
// (https://operations.osmfoundation.org/policies/nominatim/) caps usage at
// 1 request/second per client — sourced, not a judgement — so capacity 1 with
// a 1/s refill lets exactly that through and no burst beyond it. The policy's
// "client" is this server, not each visitor, so besides the per-caller bucket
// every geocode also draws from one shared bucket (GEOCODE_SHARED_KEY): two
// users together still stay under 1/s. Cache hits draw too (conservative).
const GEOCODE_SHARED_KEY = 'upstream:nominatim';
const geocodeLimiter = createRateLimiter({ capacity: 1, refillPerSecond: 1 });

// /api/ecoregion calls the CEC ArcGIS FeatureServer (tools/ecoregionLookup.mjs),
// which publishes no rate limit. Judgement call: sized to give the design
// tool's location flow (one lookup per address entered, occasionally retried)
// comfortable headroom while still bounding a runaway client.
const ecoregionLimiter = createRateLimiter({ capacity: 10, refillPerSecond: 1 });

// Sampled pruning (nl-3s5.7): every request that hits either limiter has a
// small chance of also sweeping idle buckets, so memory doesn't grow one
// entry per visitor forever without needing a live timer in every test.
const PRUNE_SAMPLE_RATE = 0.01; // judgement: rare enough to be free, frequent enough to matter
function maybePrune() {
  if (Math.random() < PRUNE_SAMPLE_RATE) {
    geocodeLimiter.prune();
    ecoregionLimiter.prune();
  }
}

/**
 * The nearby-ecosystem index and the location lookups the saved-areas UI uses:
 * species observed near a place, which places are indexed, geocoding, and
 * point-to-ecoregion.
 *
 * Returns true when it handled the request (a response has been sent), false
 * to let server.js try the next route module. `publicDir` is the served root,
 * which the e2e scratch server points somewhere else.
 */
export async function handleEcosystemRoutes(req, res, ctx) {
  const { url, pathname, publicDir, db } = ctx;
  maybePrune();
  if (pathname === '/api/ecosystem' && req.method === 'GET') {
    try {
      const place = url.searchParams.get('place') || 'home';
      const iconicTaxon = url.searchParams.get('taxon') || undefined;
      const rows = excludeNonNative(listSpeciesObservations(db.ecosystem, { place, iconicTaxon }));
      // location.json is gitignored and otherwise server-only; only surfaced
      // here, per request, so the ecosystem page can link out to iNaturalist
      // scoped to the actual site rather than a generic global search.
      let location = null;
      const projectId = projectIdFromUrl(url);
      if (projectId && isValidProjectId(projectId)) {
        try {
          const { locationFile } = resolveProjectPaths(projectId, publicDir);
          const raw = JSON.parse(await fs.readFile(locationFile, 'utf8'));
          if (Number.isFinite(raw.lat) && Number.isFinite(raw.lng)) {
            location = { lat: raw.lat, lng: raw.lng };
          }
        } catch {
          // No location.json for this project — links just won't be location-scoped.
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ place, rows, location }));
    } catch (err) {
      console.error(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // Address/city/ZIP -> coordinates (nl-5nm), for the saved-areas UI's
  // "enter a location" flow — same Nominatim geocode tools/fetch-ecosystem-
  // index.mjs already uses for a project's location.json address.
  if (pathname === '/api/geocode' && req.method === 'POST') {
    if (!enforceRateLimit(geocodeLimiter, rateLimitKeyFor(ctx, req), res)) return true;
    if (!enforceRateLimit(geocodeLimiter, GEOCODE_SHARED_KEY, res)) return true;
    try {
      const body = await collectPayload(req, { requirePlants: false });
      const query = typeof body.query === 'string' ? body.query : '';
      const result = await geocodeAddress(query, { probeCache: db.probeCache });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      console.error(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // Coordinates -> EPA Level I ecoregion (nl-5nm), via the live-tested CEC
  // FeatureServer point lookup (see tools/ecoregionLookup.mjs). `known`
  // tells the caller whether this project actually has keystone-genus data
  // for the detected code (src/data/ecoregionInput.js's KNOWN_ECOREGIONS) —
  // a real detection the yard-relevance lane still can't use is reported as
  // such, never silently filled in as if it were usable.
  if (pathname === '/api/ecoregion' && req.method === 'GET') {
    if (!enforceRateLimit(ecoregionLimiter, rateLimitKeyFor(ctx, req), res)) return true;
    try {
      // A missing or blank param must stay missing: Number(null) and Number('')
      // are both 0, which passed the finiteness check and looked up 0,0 (nl-yju).
      const coordinate = (name) => {
        const raw = url.searchParams.get(name);
        return raw === null || raw.trim() === '' ? NaN : Number(raw);
      };
      const lat = coordinate('lat');
      const lng = coordinate('lng');
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        throw new Error('"lat" and "lng" query params are required and must be numbers');
      }
      const result = await lookupEcoregion(lat, lng, { probeCache: db.probeCache });
      if (!result) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: null, name: null, known: false }));
        return true;
      }
      const known = Object.prototype.hasOwnProperty.call(KNOWN_ECOREGIONS, result.code);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: result.code, name: result.name, known }));
    } catch (err) {
      console.error(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // Which places already have a local iNaturalist species index (data/
  // ecosystem.db, built by tools/fetch-ecosystem-index.mjs) — lets the
  // saved-areas UI tell "indexed" from "not indexed yet" for a place name
  // it's suggesting (nl-5nm), instead of the rarity lane silently returning
  // zero items for a place nobody's built an index for.
  if (pathname === '/api/ecosystem/places' && req.method === 'GET') {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ places: listPlaces(db.ecosystem) }));
    } catch (err) {
      console.error(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  return false;
}
