#!/usr/bin/env node
/**
 * Index plants AND animals reported nearby a project's site on iNaturalist,
 * banded by a per-taxon dispersal radius, into a local SQLite file
 * (data/ecosystem.db). Foundation for a future "which plants would expand
 * the local ecosystem" page — this pass only indexes; it draws no
 * plant-animal conclusions.
 *
 * Deliberately separate from tools/fetch-nearby-fauna.mjs, which already
 * feeds the committed ecology/nearby-fauna.csv that src/analysis/ reads
 * offline — that pipeline is tested and in active use, so this script does
 * not touch it. This one covers a superset of taxa (adds Plantae), uses
 * real per-taxon radius ranges instead of one shared band list, and writes
 * to a gitignored SQLite index (like data/probe-cache.db) rather than a
 * committed CSV, since it's meant to be rebuilt by re-running this script,
 * not hand-curated.
 *
 * The exact coordinates never reach the index or git: they live in
 * a yard's location in app.db (tools/projectSite.mjs), never in git (this repo is public).
 *
 * Raw API responses are cached (data/probe-cache.db, shared with
 * tools/usda-plants/probeCache.js) keyed by their full request URL, so
 * re-running after a pure logic change (a new filter, a taxon added) replays
 * from disk instead of re-hitting the network. --force bypasses the cache
 * for a real refresh of what iNaturalist currently has.
 *
 * Keyed by yard (nl-3s5.6): rows are written under the yard's app.db
 * projects.id, never its free-text place label, and the build's progress is
 * recorded in the same database (project_index_builds) so the page can say
 * "building…". feed-poller runs this same build unattended for every yard
 * that has a location and no index yet (tools/ecosystemIndexQueue.js), so
 * running it by hand is only for a forced refresh or a --smoke look.
 *
 * Usage:
 *   node tools/fetch-ecosystem-index.mjs --project backyard [--owner <email>]
 *   node tools/fetch-ecosystem-index.mjs --project backyard --smoke   # one taxon, one radius, writes nothing
 *   node tools/fetch-ecosystem-index.mjs --project backyard --force   # bypass the response cache
 */
import { readProjectSite, ownerFromArgs } from './projectSite.mjs';
import {
  locationKey,
  markBuildFinished,
  markBuildStarted,
  openEcosystemDb,
  replaceTaxonRows,
} from './ecosystemIndexDb.js';
// Same raw-response cache tools/usda-plants/probeCache.js already built for
// USDA, sharing its default file (data/probe-cache.db) — its schema is keyed
// by (source, endpoint, cache_key) specifically so unrelated sources like
// this one can share one cache file. Means re-deriving something from a
// response we already have (a filter tweak, a new taxon) replays from disk
// instead of a fresh ~25-request crawl; --force bypasses it for a real refresh.
import { openProbeCache, cached, getCached } from './usda-plants/probeCache.js';
import { isExcludedEstablishment } from '../src/analysis/establishmentMeans.js';
import { geocodeAddress } from './geocode.mjs';
import { restrictToWildPreciseRecords } from './inatShared.mjs';


/**
 * Per-taxon radius bands, in miles, ascending. Reasoned defaults (not a
 * sourced biological fact) based on typical foraging/dispersal range:
 * flying pollinators and small ectotherms range least, birds most. Every
 * taxon gets a 0.25 mi "practically in the yard/block" band — nothing
 * biological rules out something being that close.
 * Mirrors the ordering (though not the exact numbers) of
 * src/analysis/faunaMatches.js's RANGE_THRESHOLD_MI, which uses a single
 * per-taxon threshold for matching rather than bands for indexing.
 *
 * iNaturalist's `radius` API parameter is in KILOMETERS, not miles, despite
 * every value here being a mile figure — confirmed empirically (an
 * observation at a known 19.18 km / 11.92 mi flips from excluded to
 * included between radius=19 and radius=19.2, not near 12). An earlier
 * version of this script passed these numbers straight through unconverted,
 * so every labeled band was actually only ~62% as wide as its label.
 * `fetchSpeciesCounts` converts mi -> km at the call site so the labels
 * stored in the index stay true miles.
 */
const RADII_MI_BY_TAXON = {
  Plantae: [0.25, 1, 3, 8, 15],
  Amphibia: [0.25, 1, 3, 8],
  Reptilia: [0.25, 1, 3, 8],
  Insecta: [0.25, 1, 3, 8, 15, 25],
  Mammalia: [0.25, 3, 8, 15, 25],
  Aves: [0.25, 5, 15, 25, 50],
};

const MI_TO_KM = 1.60934;

const ICONIC_TAXA = Object.keys(RADII_MI_BY_TAXON);

/** Sorted by observation count already; the long tail past this is mostly noise/vagrants for our purpose. */
const PER_TAXON_PAGE_SIZE = 200;

// iNaturalist's documented API guidance asks for roughly <=1 request/second
// and a descriptive User-Agent; this script issues requests strictly
// sequentially (never in parallel) and pads the delay a bit below that
// ceiling rather than riding it exactly. A run indexes ~20-25 requests total
// (taxa x radii), so this costs well under a minute, and results are cached
// in SQLite so re-running only happens when the index is deliberately
// refreshed, not on every page load.
const REQUEST_DELAY_MS = 1500;

/** Retry once with backoff on 429/5xx instead of immediately giving up or hammering the API. */
async function fetchWithBackoff(url, options, io, attempt = 1) {
  io.networkRequests += 1;
  const response = await io.fetchImpl(url, options);
  if ((response.status === 429 || response.status >= 500) && attempt <= 3) {
    const retryAfterMs = Number(response.headers.get('retry-after')) * 1000 || attempt * 5000;
    io.logger.warn(`  HTTP ${response.status} — backing off ${retryAfterMs}ms before retry ${attempt}/3`);
    await sleep(io.requestDelayMs ? retryAfterMs : 0);
    return fetchWithBackoff(url, options, io, attempt + 1);
  }
  return response;
}

const USER_AGENT = 'native-landscaping-app (ecology data fetch; github.com/johntron/native_landscaping)';

/**
 * One iNaturalist GET through the shared probe cache. A real request is
 * followed by the politeness delay; a cache replay is not.
 * @returns {Promise<{ raw: any, fromCache: boolean }>}
 */
async function cachedInat(io, endpoint, url) {
  const { raw, cached: fromCache } = await cached(
    io.probeCache,
    'inaturalist',
    endpoint,
    url.toString(),
    async () => {
      try {
        const response = await fetchWithBackoff(url, { headers: { 'User-Agent': USER_AGENT } }, io);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
      } finally {
        if (io.requestDelayMs) await sleep(io.requestDelayMs);
      }
    },
    { force: io.force }
  );
  return { raw, fromCache: Boolean(fromCache) };
}

/**
 * Build one yard's index: every iconic taxon at every radius band, written
 * under `projectId`. Requests go strictly one at a time, and only real
 * network requests are followed by the politeness delay; a replay from the
 * probe cache is a disk read. A request that fails is logged and counted, and
 * the build carries on with the rest (a retry replays the ones that worked).
 *
 * @param {object} args
 * @param {number} args.projectId app.db projects.id
 * @param {{ lat?: number, lng?: number, address?: string }} args.location
 * @param {import('node:sqlite').DatabaseSync} args.db ecosystem.db (openEcosystemDb)
 * @param {import('node:sqlite').DatabaseSync} args.probeCache
 * @param {typeof fetch} [args.fetchImpl] injected so tests never reach iNaturalist
 * @param {boolean} [args.force] bypass the response cache
 * @param {boolean} [args.smoke] one taxon, one radius, nothing written
 * @param {number} [args.requestDelayMs]
 * @param {{ log: Function, warn: Function }} [args.logger]
 * @returns {Promise<{ rows: number, networkRequests: number, failures: number, fetchedOn: string }>}
 */
export async function buildEcosystemIndex({
  projectId,
  location,
  db,
  probeCache,
  fetchImpl = fetch,
  force = false,
  smoke = false,
  requestDelayMs = REQUEST_DELAY_MS,
  logger = console,
}) {
  const io = { probeCache, force, fetchImpl, requestDelayMs, logger, networkRequests: 0, failures: 0 };
  const { lat, lng } = await resolveCoordinates(location, io);
  const placeId = await resolvePlaceId(lat, lng, io);
  if (placeId) {
    logger.log(`Native/introduced status will be checked against iNaturalist place_id=${placeId}`);
  } else {
    logger.warn('Could not resolve a state/country place_id — establishment_means will be left blank for every row (nothing excluded).');
  }

  const taxa = smoke ? [ICONIC_TAXA[0]] : ICONIC_TAXA;
  // Never the coordinates: this lands in feed-poller's logs.
  logger.log(`Indexing ecosystem for yard #${projectId}`);
  logger.log(`Taxa: ${taxa.join(', ')}`);

  const fetchedOn = new Date().toISOString().slice(0, 10);
  let written = 0;

  for (const iconicTaxon of taxa) {
    const radii = smoke
      ? [RADII_MI_BY_TAXON[iconicTaxon][Math.floor(RADII_MI_BY_TAXON[iconicTaxon].length / 2)]]
      : RADII_MI_BY_TAXON[iconicTaxon];

    // seen: nearest (smallest) radius a species was found at — radii are
    // visited ascending so the first hit IS the nearest band.
    const seen = new Map(); // key: taxon_name -> row

    for (const radius of radii) {
      let found = 0;
      let wasCached = true;
      try {
        const { results, fromCache } = await fetchSpeciesCounts({ lat, lng, radiusMi: radius, iconicTaxon }, io);
        wasCached = fromCache;
        results.forEach((entry) => {
          if (seen.has(entry.taxon_name)) return; // already have this species at a smaller radius
          seen.set(entry.taxon_name, { ...entry, radius_mi: radius, fetched_on: fetchedOn, source: 'api.inaturalist.org species_counts' });
          found += 1;
        });
      } catch (err) {
        io.failures += 1;
        wasCached = false;
        logger.warn(`  ${iconicTaxon} @ ${radius}mi: FAILED — ${err.message}`);
      }
      logger.log(`  ${iconicTaxon} @ ${radius}mi: ${found} new species${wasCached ? ' (cached)' : ''}`);
    }

    let rows = [...seen.values()];
    if (placeId) {
      const meansById = await fetchEstablishmentMeans(
        rows.map((r) => r.taxon_id).filter((id) => Number.isFinite(id)),
        placeId,
        io
      );
      rows = rows.map((r) => ({ ...r, establishment_means: meansById.get(r.taxon_id) || null }));
      // Stored, not filtered out here — data/ecosystem.db keeps every row
      // (see establishmentMeans.js for why: "unassessed" isn't "native", and
      // the page's own "N of M species" count wants the full picture). The
      // read side (/api/ecosystem) excludes introduced/naturalized/invasive
      // rows by default.
      const excluded = rows.filter((r) => isExcludedEstablishment(r.establishment_means));
      if (excluded.length) {
        logger.log(
          `  Flagged ${excluded.length} non-native/invasive ${iconicTaxon} (kept in the index, excluded from the page): ${excluded.map((r) => `${r.taxon_name} (${r.establishment_means})`).join(', ')}`
        );
      }
    }

    if (smoke) {
      logger.log(`\n--smoke run: ${rows.length} ${iconicTaxon} rows, NOT writing data/ecosystem.db\n`);
      logger.log(rows.map((r) => `${r.taxon_name} (${r.common_name})\t${r.radius_mi}mi\t${r.observation_count}`).join('\n'));
      continue;
    }
    replaceTaxonRows(db, projectId, iconicTaxon, rows);
    written += rows.length;
    logger.log(`  Wrote ${rows.length} ${iconicTaxon} rows for yard #${projectId}`);
  }
  return { rows: written, networkRequests: io.networkRequests, failures: io.failures, fetchedOn };
}

/**
 * Build one yard's index and record the build's state around it
 * (project_index_builds): 'building' while it runs, then 'ready', or 'failed'
 * when it threw or any request failed (the rows that did arrive are kept, and
 * the queue retries). Shared by the CLI and feed-poller's queue.
 *
 * @param {Parameters<typeof buildEcosystemIndex>[0]} args
 * @returns {Promise<{ state: 'ready'|'failed', rows: number, networkRequests: number, failures: number, error?: string }>}
 */
export async function buildAndRecordEcosystemIndex(args) {
  const key = locationKey(args.location);
  if (!key) throw new Error(`Yard #${args.projectId} has no usable location`);
  markBuildStarted(args.db, args.projectId, key);
  try {
    const result = await buildEcosystemIndex(args);
    const state = result.failures ? 'failed' : 'ready';
    const error = result.failures ? `${result.failures} request(s) failed` : null;
    markBuildFinished(args.db, args.projectId, { state, error, fetchedOn: result.fetchedOn });
    return { state, ...result, ...(error ? { error } : {}) };
  } catch (err) {
    const error = withoutQuotedText(err.message);
    markBuildFinished(args.db, args.projectId, { state: 'failed', error });
    // An exception may have come after any number of real requests; count it
    // as one, so the queue never treats a failed build as free.
    return { state: 'failed', rows: 0, networkRequests: 1, failures: 1, error };
  }
}

/**
 * An error message with any quoted text blanked. The geocoder quotes the
 * address back ('Geocoding found nothing for "<address>"'), and this message
 * is stored in ecosystem.db and printed in feed-poller's logs, neither of which
 * may hold a location.
 */
export function withoutQuotedText(message) {
  return String(message ?? '').replace(/"[^"]*"/g, '"…"');
}

async function main() {
  const args = process.argv.slice(2);
  const projectSlug = argAfter(args, '--project');
  const smoke = args.includes('--smoke');
  const force = args.includes('--force');
  if (!projectSlug) {
    console.error('Usage: node tools/fetch-ecosystem-index.mjs --project <slug> [--owner <email>] [--smoke] [--force]');
    process.exit(1);
  }

  // The location lives in app.db (nl-3s5.3) and never reaches git.
  // tools/projectSite.mjs says how to set one. The index is keyed by the
  // yard's id, so a place label is not required.
  let site;
  try {
    site = readProjectSite(projectSlug, { ownerEmail: ownerFromArgs(args), requirePlace: false });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const probeCache = openProbeCache();
  const db = openEcosystemDb();
  const common = { projectId: site.projectId, location: site.location, db, probeCache, force };
  if (smoke) {
    await buildEcosystemIndex({ ...common, smoke: true });
    return;
  }
  const result = await buildAndRecordEcosystemIndex(common);
  console.log(
    `Yard "${projectSlug}" (#${site.projectId}): ${result.state}, ${result.rows} rows, ${result.networkRequests} network request(s)` +
      (result.error ? ` — ${result.error}` : '')
  );
  if (result.state !== 'ready') process.exitCode = 1;
}

async function resolveCoordinates(location, io) {
  if (Number.isFinite(location.lat) && Number.isFinite(location.lng)) {
    return { lat: location.lat, lng: location.lng };
  }
  if (!location.address) {
    throw new Error('the stored location has neither lat/lng nor an address');
  }
  // Nominatim, through the same probe cache (tools/geocode.mjs). Counted as a
  // network request unless it will replay, so the queue's budget sees it.
  if (io.force || !getCached(io.probeCache, 'nominatim', 'search', String(location.address).trim())) {
    io.networkRequests += 1;
  }
  const { lat, lng } = await geocodeAddress(location.address, { probeCache: io.probeCache, force: io.force });
  return { lat, lng };
}

// iNaturalist per-taxon "listed_taxa" (native/introduced/invasive/etc,
// preferred_establishment_means) is checklist data scoped to a PLACE, and
// coverage varies wildly by which place: empirically, for a Dallas, TX site,
// the county checklist (place_type 9) flagged only ~15-30% of nearby species,
// while the STATE checklist (place_type 8) flagged 70-100% of the same
// species (verified against a 60-species sample spanning Plantae/Aves/
// Insecta — Columba livia, Apis mellifera, Ligustrum quihoui, Melia
// azedarach all correctly came back "introduced" at state level; several
// were unlisted at county level). So this deliberately prefers state
// (place_type 8) over the finer county, falling back to country (12) if a
// site has no enclosing state (non-US), and to nothing if neither resolves
// — leaving establishment_means blank for every row, which excludes nothing
// (see establishmentMeans.js: unassessed is not the same as non-native).
const PREFERRED_PLACE_TYPES = [8, 12];
const PLACE_BBOX_DEG = 0.05;

async function resolvePlaceId(lat, lng, io) {
  const url = new URL('https://api.inaturalist.org/v1/places/nearby');
  url.searchParams.set('swlat', lat - PLACE_BBOX_DEG);
  url.searchParams.set('swlng', lng - PLACE_BBOX_DEG);
  url.searchParams.set('nelat', lat + PLACE_BBOX_DEG);
  url.searchParams.set('nelng', lng + PLACE_BBOX_DEG);
  const { raw: body } = await cachedInat(io, 'places/nearby', url);
  const standard = body.results?.standard || [];
  for (const placeType of PREFERRED_PLACE_TYPES) {
    const match = standard.find((p) => p.place_type === placeType);
    if (match) return match.id;
  }
  return null;
}

/** Batches taxon ids (iNaturalist's /v1/taxa/{ids} rejects more than 30 at once — verified empirically). */
const TAXA_IDS_PER_REQUEST = 30;

async function fetchEstablishmentMeans(taxonIds, placeId, io) {
  const uniqueIds = [...new Set(taxonIds)];
  const meansById = new Map();
  for (let i = 0; i < uniqueIds.length; i += TAXA_IDS_PER_REQUEST) {
    const chunk = uniqueIds.slice(i, i + TAXA_IDS_PER_REQUEST);
    const url = new URL(`https://api.inaturalist.org/v1/taxa/${chunk.join(',')}`);
    url.searchParams.set('preferred_place_id', String(placeId));
    try {
      const { raw: body } = await cachedInat(io, 'taxa/preferred_establishment_means', url);
      (body.results || []).forEach((taxon) => {
        if (taxon.preferred_establishment_means) meansById.set(taxon.id, taxon.preferred_establishment_means);
      });
    } catch (err) {
      io.failures += 1;
      io.logger.warn(`  establishment_means lookup FAILED for a batch of ${chunk.length} taxa — ${err.message}`);
    }
  }
  return meansById;
}

async function fetchSpeciesCounts({ lat, lng, radiusMi, iconicTaxon }, io) {
  const url = new URL('https://api.inaturalist.org/v1/observations/species_counts');
  url.searchParams.set('lat', lat);
  url.searchParams.set('lng', lng);
  url.searchParams.set('radius', (radiusMi * MI_TO_KM).toFixed(3)); // API takes km, not mi — see RADII_MI_BY_TAXON's comment
  url.searchParams.set('iconic_taxa[]', iconicTaxon);
  url.searchParams.set('per_page', String(PER_TAXON_PAGE_SIZE));
  url.searchParams.set('order_by', 'observation_count'); // most-established local presence first
  // Wild, research-grade, precisely located records only — see
  // restrictToWildPreciseRecords in inatShared.mjs for why each filter is needed.
  restrictToWildPreciseRecords(url);

  const { raw: body, fromCache } = await cachedInat(io, 'observations/species_counts', url);

  const results = (body.results || [])
    .map((entry) => ({
      taxon_id: entry.taxon?.id ?? null,
      taxon_name: entry.taxon?.name || '',
      common_name: entry.taxon?.preferred_common_name || '',
      genus: String(entry.taxon?.name || '').trim().split(/\s+/)[0] || '',
      observation_count: entry.count ?? 0,
      // Only hotlink photos under an actual open license (cc0/cc-by/cc-by-nc/etc,
      // square_url is published by iNaturalist specifically for this).
      // license_code is null for "all rights reserved" — verified empirically
      // (e.g. Ulmus crassifolia, Cercis canadensis nearby both came back
      // license_code=null) — those default to full copyright with no reuse
      // grant, so they're left out entirely rather than displayed anyway.
      photo_url: entry.taxon?.default_photo?.license_code ? entry.taxon.default_photo.square_url || '' : '',
      photo_attribution: entry.taxon?.default_photo?.license_code ? entry.taxon.default_photo.attribution || '' : '',
    }))
    .filter((row) => row.taxon_name);
  return { results, fromCache };
}

function argAfter(args, flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Imported by feed-poller's queue (tools/ecosystemIndexQueue.js), so the CLI
// runs only when this file is the entry point.
const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
