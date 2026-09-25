import { projectIdFromUrl } from '../../src/data/projectPaths.js';
import { findCallerProject, findExampleFor, findExampleProject, parseLocation } from '../db/projectStore.js';
import { indexStatus, listSpeciesObservations, locationKey } from '../../tools/ecosystemIndexDb.js';
import { exampleIndexSource, listOwnerProjectSites } from '../db/projectSites.js';
import { excludeNonNative } from '../../src/analysis/establishmentMeans.js';
import { geocodeAddress } from '../../tools/geocode.mjs';
import { lookupEcoregion } from '../../tools/ecoregionLookup.mjs';
import { KNOWN_ECOREGIONS } from '../../src/data/ecoregionInput.js';
import { collectPayload, createRateLimiter, enforceRateLimit, loadReadableProject, rateLimitKeyFor, requireUser } from '../http.js';

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
 * to let server.js try the next route module.
 */
export async function handleEcosystemRoutes(req, res, ctx) {
  const { url, pathname, db } = ctx;
  maybePrune();
  if (pathname === '/api/ecosystem' && req.method === 'GET') {
    // Keyed by yard (nl-3s5.6), so ?project= is required and resolved like
    // every project read route: loadReadableProject, so 401 when anonymous and
    // the same 404 for a slug that is missing or someone else's. The rows
    // belong to that yard alone (data/ecosystem.db is keyed by app.db
    // projects.id), so no label a user can type reaches another owner's rows.
    // The old ?place= parameter is ignored.
    //
    // Three things answer here:
    //
    // - `rows`: the yard's nearby species, native or unassessed only
    //   (excludeNonNative). Empty until its index is built, and empty while a
    //   moved yard's index rebuilds, so an old site's species never show.
    // - `index`: { state, fetchedOn }, where state is no-location | queued |
    //   building | ready | failed (tools/ecosystemIndexDb.js indexStatus).
    //   feed-poller builds queued yards (tools/ecosystemIndexQueue.js). The
    //   build's error text is never sent: a geocoder's message can quote the
    //   address back.
    // - `location`: the yard's { lat, lng } alone, for its owner, so the page
    //   can link out to iNaturalist scoped to the actual site.
    //
    // The shared example yard (nl-3s5.24) is readable by any signed-in user
    // and has no location of its own. It shows the index of the owner's yard it
    // was refreshed from (exampleIndexSource), read-only, with location null:
    // the species list is what the owner chose to share, the coordinates are
    // not.
    if (!url.searchParams.has('project')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'The nearby index is per yard: pass ?project=<slug>' }));
      return true;
    }
    const project = loadReadableProject(ctx, res, projectIdFromUrl(url), {
      findProject: findCallerProject,
      findExample: findExampleFor,
    });
    if (!project) return true;
    try {
      const isExample = project.id === findExampleProject(ctx.db.app)?.id;
      const indexed = isExample ? exampleIndexSource(ctx.db.app) : project;
      const site = indexed ? parseLocation(indexed) : null;
      const status = indexed
        ? indexStatus(db.ecosystem, indexed.id, locationKey(site))
        : { state: 'no-location', rowsApply: false, fetchedOn: null };
      const iconicTaxon = url.searchParams.get('taxon') || undefined;
      const rows = status.rowsApply
        ? excludeNonNative(listSpeciesObservations(db.ecosystem, { projectId: indexed.id, iconicTaxon }))
        : [];
      let location = null;
      if (!isExample && site && Number.isFinite(site.lat) && Number.isFinite(site.lng)) {
        location = { lat: site.lat, lng: site.lng };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          project: project.slug,
          rows: rows.map(({ project_id, ...row }) => row),
          location,
          index: { state: status.state, fetchedOn: status.fetchedOn },
        })
      );
    } catch (err) {
      console.error(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // Address/city/ZIP -> coordinates (nl-5nm), for the saved-areas UI's
  // "enter a location" flow — same Nominatim geocode tools/fetch-ecosystem-
  // index.mjs already uses for a yard's stored address.
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

  // The place labels of the CALLER'S OWN yards whose nearby-species index is
  // built (nl-5nm, owner-scoped since nl-3s5.6): the saved-areas UI suggests a
  // place for an area's rarity lane and says whether it is indexed. The rarity
  // lane resolves an area's place among its owner's yards the same way
  // (tools/feedState/rarityTables.js), so a label here is always one the lane
  // can use, and another owner's labels never appear.
  if (pathname === '/api/ecosystem/places' && req.method === 'GET') {
    const user = requireUser(ctx, res);
    if (!user) return true;
    try {
      const places = new Set();
      for (const site of listOwnerProjectSites(db.app, user.id)) {
        if (!site.place) continue;
        const status = indexStatus(db.ecosystem, site.id, locationKey(site.location));
        if (status.rowsApply) places.add(site.place);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ places: [...places].sort() }));
    } catch (err) {
      console.error(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  return false;
}
