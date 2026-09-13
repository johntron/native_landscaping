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
 * projects/<id>/location.json, which is gitignored (this repo is public).
 *
 * Raw API responses are cached (data/probe-cache.db, shared with
 * tools/usda-plants/probeCache.js) keyed by their full request URL, so
 * re-running after a pure logic change (a new filter, a taxon added) replays
 * from disk instead of re-hitting the network. --force bypasses the cache
 * for a real refresh of what iNaturalist currently has.
 *
 * Usage:
 *   node tools/fetch-ecosystem-index.mjs --project backyard
 *   node tools/fetch-ecosystem-index.mjs --project backyard --smoke   # one taxon, one radius
 *   node tools/fetch-ecosystem-index.mjs --project backyard --force   # bypass the response cache
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openEcosystemDb, replaceTaxonRows } from './ecosystemIndexDb.js';
// Same raw-response cache tools/usda-plants/probeCache.js already built for
// USDA, sharing its default file (data/probe-cache.db) — its schema is keyed
// by (source, endpoint, cache_key) specifically so unrelated sources like
// this one can share one cache file. Means re-deriving something from a
// response we already have (a filter tweak, a new taxon) replays from disk
// instead of a fresh ~25-request crawl; --force bypasses it for a real refresh.
import { openProbeCache, cached } from './usda-plants/probeCache.js';
import { isExcludedEstablishment } from '../src/analysis/establishmentMeans.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

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
async function fetchWithBackoff(url, options, attempt = 1) {
  const response = await fetch(url, options);
  if ((response.status === 429 || response.status >= 500) && attempt <= 3) {
    const retryAfterMs = Number(response.headers.get('retry-after')) * 1000 || attempt * 5000;
    console.warn(`  HTTP ${response.status} — backing off ${retryAfterMs}ms before retry ${attempt}/3`);
    await sleep(retryAfterMs);
    return fetchWithBackoff(url, options, attempt + 1);
  }
  return response;
}

async function main() {
  const args = process.argv.slice(2);
  const projectId = argAfter(args, '--project');
  const smoke = args.includes('--smoke');
  const force = args.includes('--force');
  if (!projectId) {
    console.error('Usage: node tools/fetch-ecosystem-index.mjs --project <id> [--smoke] [--force]');
    process.exit(1);
  }

  const locationPath = `${ROOT}projects/${projectId}/location.json`;
  if (!existsSync(locationPath)) {
    console.error(
      `${locationPath} does not exist. Create it (gitignored) with { "lat": ..., "lng": ... } or { "address": "..." }.`
    );
    process.exit(1);
  }
  const location = JSON.parse(readFileSync(locationPath, 'utf8'));
  const probeCache = openProbeCache();
  const { lat, lng } = await resolveCoordinates(location, probeCache, force);
  const placeId = await resolvePlaceId(lat, lng, probeCache, force);
  if (placeId) {
    console.log(`Native/introduced status will be checked against iNaturalist place_id=${placeId}`);
  } else {
    console.warn('Could not resolve a state/country place_id — establishment_means will be left blank for every row (nothing excluded).');
  }

  const projectConfigPath = `${ROOT}projects/${projectId}/project.json`;
  const projectConfig = JSON.parse(readFileSync(projectConfigPath, 'utf8'));
  const place = String(projectConfig.place || '').trim();
  if (!place) {
    console.error(`projects/${projectId}/project.json declares no "place"; add one before fetching.`);
    process.exit(1);
  }

  const taxa = smoke ? [ICONIC_TAXA[0]] : ICONIC_TAXA;

  console.log(`Indexing ecosystem for place "${place}" (lat=${lat}, lng=${lng})`);
  console.log(`Taxa: ${taxa.join(', ')}`);

  const db = openEcosystemDb();
  const fetchedOn = new Date().toISOString().slice(0, 10);

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
        const { results, fromCache } = await fetchSpeciesCounts({ lat, lng, radiusMi: radius, iconicTaxon, probeCache, force });
        wasCached = fromCache;
        results.forEach((entry) => {
          if (seen.has(entry.taxon_name)) return; // already have this species at a smaller radius
          seen.set(entry.taxon_name, { ...entry, radius_mi: radius, fetched_on: fetchedOn, source: 'api.inaturalist.org species_counts' });
          found += 1;
        });
      } catch (err) {
        console.warn(`  ${iconicTaxon} @ ${radius}mi: FAILED — ${err.message}`);
      }
      console.log(`  ${iconicTaxon} @ ${radius}mi: ${found} new species${wasCached ? ' (cached)' : ''}`);
      // Only the real network calls need throttling; a cache replay is just a disk read.
      if (!wasCached) await sleep(REQUEST_DELAY_MS);
    }

    let rows = [...seen.values()];
    if (placeId) {
      const meansById = await fetchEstablishmentMeans(
        rows.map((r) => r.taxon_id).filter((id) => Number.isFinite(id)),
        placeId,
        probeCache,
        force
      );
      rows = rows.map((r) => ({ ...r, establishment_means: meansById.get(r.taxon_id) || null }));
      // Stored, not filtered out here — data/ecosystem.db keeps every row
      // (see establishmentMeans.js for why: "unassessed" isn't "native", and
      // the page's own "N of M species" count wants the full picture). The
      // read side (server.js /api/ecosystem) excludes introduced/naturalized/
      // invasive rows by default.
      const excluded = rows.filter((r) => isExcludedEstablishment(r.establishment_means));
      if (excluded.length) {
        console.log(
          `  Flagged ${excluded.length} non-native/invasive ${iconicTaxon} (kept in the index, excluded from the page): ${excluded.map((r) => `${r.taxon_name} (${r.establishment_means})`).join(', ')}`
        );
      }
    }

    if (smoke) {
      console.log(`\n--smoke run: ${rows.length} ${iconicTaxon} rows, NOT writing data/ecosystem.db\n`);
      console.log(rows.map((r) => `${r.taxon_name} (${r.common_name})\t${r.radius_mi}mi\t${r.observation_count}`).join('\n'));
      continue;
    }
    replaceTaxonRows(db, place, iconicTaxon, rows);
    console.log(`  Wrote ${rows.length} ${iconicTaxon} rows for "${place}"`);
  }
}

async function resolveCoordinates(location, probeCache, force) {
  if (Number.isFinite(location.lat) && Number.isFinite(location.lng)) {
    return { lat: location.lat, lng: location.lng };
  }
  if (!location.address) {
    throw new Error('location.json has neither lat/lng nor an address');
  }
  const { raw: results } = await cached(
    probeCache,
    'nominatim',
    'search',
    location.address,
    async () => {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(location.address)}`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'native-landscaping-app (ecology data fetch)' },
      });
      if (!response.ok) throw new Error(`Geocoding failed: HTTP ${response.status}`);
      return response.json();
    },
    { force }
  );
  if (!results.length) throw new Error(`Geocoding found nothing for "${location.address}"`);
  return { lat: Number(results[0].lat), lng: Number(results[0].lon) };
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

async function resolvePlaceId(lat, lng, probeCache, force) {
  const url = new URL('https://api.inaturalist.org/v1/places/nearby');
  url.searchParams.set('swlat', lat - PLACE_BBOX_DEG);
  url.searchParams.set('swlng', lng - PLACE_BBOX_DEG);
  url.searchParams.set('nelat', lat + PLACE_BBOX_DEG);
  url.searchParams.set('nelng', lng + PLACE_BBOX_DEG);
  const { raw: body } = await cached(
    probeCache,
    'inaturalist',
    'places/nearby',
    url.toString(),
    async () => {
      const response = await fetchWithBackoff(url, {
        headers: { 'User-Agent': 'native-landscaping-app (ecology data fetch; github.com/johntron/native_landscaping)' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    },
    { force }
  );
  const standard = body.results?.standard || [];
  for (const placeType of PREFERRED_PLACE_TYPES) {
    const match = standard.find((p) => p.place_type === placeType);
    if (match) return match.id;
  }
  return null;
}

/** Batches taxon ids (iNaturalist's /v1/taxa/{ids} rejects more than 30 at once — verified empirically). */
const TAXA_IDS_PER_REQUEST = 30;

async function fetchEstablishmentMeans(taxonIds, placeId, probeCache, force) {
  const uniqueIds = [...new Set(taxonIds)];
  const meansById = new Map();
  for (let i = 0; i < uniqueIds.length; i += TAXA_IDS_PER_REQUEST) {
    const chunk = uniqueIds.slice(i, i + TAXA_IDS_PER_REQUEST);
    const url = new URL(`https://api.inaturalist.org/v1/taxa/${chunk.join(',')}`);
    url.searchParams.set('preferred_place_id', String(placeId));
    let wasCached = true;
    try {
      const { raw: body, cached: fromCache } = await cached(
        probeCache,
        'inaturalist',
        'taxa/preferred_establishment_means',
        url.toString(),
        async () => {
          const response = await fetchWithBackoff(url, {
            headers: { 'User-Agent': 'native-landscaping-app (ecology data fetch; github.com/johntron/native_landscaping)' },
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json();
        },
        { force }
      );
      wasCached = fromCache;
      (body.results || []).forEach((taxon) => {
        if (taxon.preferred_establishment_means) meansById.set(taxon.id, taxon.preferred_establishment_means);
      });
    } catch (err) {
      console.warn(`  establishment_means lookup FAILED for a batch of ${chunk.length} taxa — ${err.message}`);
    }
    if (!wasCached) await sleep(REQUEST_DELAY_MS);
  }
  return meansById;
}

async function fetchSpeciesCounts({ lat, lng, radiusMi, iconicTaxon, probeCache, force }) {
  const url = new URL('https://api.inaturalist.org/v1/observations/species_counts');
  url.searchParams.set('lat', lat);
  url.searchParams.set('lng', lng);
  url.searchParams.set('radius', (radiusMi * MI_TO_KM).toFixed(3)); // API takes km, not mi — see RADII_MI_BY_TAXON's comment
  url.searchParams.set('iconic_taxa[]', iconicTaxon);
  url.searchParams.set('per_page', String(PER_TAXON_PAGE_SIZE));
  url.searchParams.set('order_by', 'observation_count'); // most-established local presence first
  // Exclude pet-store/cultivated records and anything not vetted to species —
  // without these, e.g. a Dallas search for Amphibia returns a captive
  // axolotl and red-eyed tree frog alongside actually-wild species.
  url.searchParams.set('captive', 'false');
  url.searchParams.set('quality_grade', 'research');
  // Two INDEPENDENT obscuring mechanisms, both of which randomize the public
  // location within a large cell (not the true sighting), and both need
  // excluding — one does not imply the other:
  //  - taxon_geoprivacy=open: excludes species iNaturalist itself
  //    force-obscures regardless of observer choice (raptors,
  //    poaching-targeted plants). Confirmed on Haliaeetus leucocephalus
  //    (Bald Eagle): every nearby record had taxon_geoprivacy=obscured,
  //    public_positional_accuracy=29039m (~18 mi). geoprivacy=open alone did
  //    NOT catch this — verified empirically the eagle still appeared.
  //  - geoprivacy=open: excludes an individual OBSERVER's own choice to
  //    obscure a record, independent of the species. Confirmed on a nearby
  //    Phyllanthus polygonoides record: obscured=true, geoprivacy=obscured,
  //    but taxon_geoprivacy=None — taxon_geoprivacy=open alone did NOT
  //    catch this one; only adding geoprivacy=open did. Verified this
  //    doesn't over-filter: it drops nearby Plantae results by only ~1.5%
  //    (1062 -> 1046), not the near-total loss it'd be if "open" excluded
  //    ordinary public records with no geoprivacy value set.
  url.searchParams.set('taxon_geoprivacy', 'open');
  url.searchParams.set('geoprivacy', 'open');

  const { raw: body, cached: fromCache } = await cached(
    probeCache,
    'inaturalist',
    'observations/species_counts',
    url.toString(),
    async () => {
      const response = await fetchWithBackoff(url, {
        headers: { 'User-Agent': 'native-landscaping-app (ecology data fetch; github.com/johntron/native_landscaping)' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    },
    { force }
  );

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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
