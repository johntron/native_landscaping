#!/usr/bin/env node
/**
 * Fetch which animal species are reported near a yard, banded by distance,
 * from iNaturalist (api.inaturalist.org), into the yard's 'fauna' layer in
 * data/ecosystem.db. The design tool's local-fauna-support rule and the
 * plant detail sheet read it through /api/ecosystem/site.
 *
 * Per yard since nl-3s5.31. Before that the rows were merged into the
 * committed ecology/nearby-fauna.csv keyed by the yard's `place` label, which
 * put one owner's site in a public repo. The location is read from app.db
 * (tools/projectSite.mjs) and never written anywhere.
 *
 * Deliberately still separate from the species index
 * (tools/fetch-ecosystem-index.mjs): this layer's five shared distance bands
 * are what faunaMatches.js's RANGE_THRESHOLD_MI was written against.
 *
 * feed-poller builds this layer for every yard with a location
 * (tools/ecosystemIndexQueue.js), so running it by hand is for a forced
 * refresh or a --smoke look.
 *
 * Usage:
 *   node tools/fetch-nearby-fauna.mjs --project backyard [--owner <email>]
 *   node tools/fetch-nearby-fauna.mjs --project backyard --smoke   # one taxon, one radius, writes nothing
 *   node tools/fetch-nearby-fauna.mjs --project backyard --force   # bypass the response cache
 */
import { readProjectSite, ownerFromArgs } from './projectSite.mjs';
import { openProbeCache } from './usda-plants/probeCache.js';
import { openEcosystemDb } from './ecosystemIndexDb.js';
import { MI_TO_KM, fetchEstablishmentMeans, resolvePlaceId, restrictToWildPreciseRecords } from './inatShared.mjs';
import {
  USER_AGENT,
  argAfter,
  buildAndRecordLayer,
  cachedRequest,
  createIo,
  isEntryPoint,
  resolveCoordinates,
  today,
} from './siteLayerShared.mjs';

/**
 * Distance bands, in miles. Deliberately several bands rather than one radius:
 * the rule/UI can then ask "is this animal within the range it would actually
 * find a new plant" per taxon (a ground beetle's range is not a hawk's), using
 * whichever band it was first seen in as a proxy for "how close is confirmed
 * presence".
 */
const RADII_MI = [1, 3, 8, 15, 25];

/** One species_counts call per (iconic taxon, radius) so results are tagged unambiguously. */
const ICONIC_TAXA = ['Aves', 'Insecta', 'Mammalia', 'Reptilia', 'Amphibia'];

/** Sorted by observation count already; the long tail past this is mostly noise/vagrants for our purpose. */
const PER_TAXON_PAGE_SIZE = 200;

/** iNaturalist asks for roughly one request a second; requests here go strictly one at a time. */
const REQUEST_DELAY_MS = 1000;

export const FAUNA_SOURCE = 'api.inaturalist.org species_counts';

/**
 * The animals reported near the yard, one row per (iconic taxon, species) at
 * the nearest band it was found in. ~25 species_counts requests plus the
 * establishment-means lookups, all through the probe cache. A request that
 * fails is logged and counted, and the build carries on; a build with any
 * failure is recorded as failed and its rows are not written
 * (buildAndRecordLayer).
 *
 * @param {{ location: object, probeCache: import('node:sqlite').DatabaseSync, fetchImpl?: typeof fetch,
 *   force?: boolean, smoke?: boolean, requestDelayMs?: number, logger?: { log: Function, warn: Function } }} args
 */
export async function buildFaunaLayer({
  location,
  probeCache,
  fetchImpl,
  force = false,
  smoke = false,
  requestDelayMs = REQUEST_DELAY_MS,
  logger = console,
}) {
  const io = createIo({ probeCache, fetchImpl, force, requestDelayMs, logger });
  const fetchJson = async (endpoint, url) =>
    (await cachedRequest(io, 'inaturalist', endpoint, url.toString(), () => [url, { headers: { 'User-Agent': USER_AGENT } }])).raw;

  const { lat, lng } = await resolveCoordinates(location, io);
  const radii = smoke ? [RADII_MI[Math.floor(RADII_MI.length / 2)]] : RADII_MI;
  const taxa = smoke ? [ICONIC_TAXA[0]] : ICONIC_TAXA;

  const placeId = await resolvePlaceId(lat, lng, { fetchJson });
  if (!placeId) logger.warn('Could not resolve a state/country place_id — establishment_means will be blank for every row.');

  // Nearest (smallest) radius a species was found at, per iconic taxon: radii
  // are visited ascending, so the first hit IS the nearest band.
  const seen = new Map(); // `${iconicTaxon}|${animalSpecies}` -> row
  for (const iconicTaxon of taxa) {
    for (const radius of radii) {
      let found = 0;
      try {
        const results = await fetchSpeciesCounts({ lat, lng, radiusMi: radius, iconicTaxon, fetchJson });
        results.forEach((entry) => {
          const key = `${iconicTaxon}|${entry.animal_species}`;
          if (seen.has(key)) return;
          seen.set(key, { ...entry, iconic_taxon: iconicTaxon, nearest_radius_mi: radius });
          found += 1;
        });
      } catch (err) {
        io.failures += 1;
        logger.warn(`  ${iconicTaxon} @ ${radius}mi: FAILED — ${err.message}`);
      }
      logger.log(`  ${iconicTaxon} @ ${radius}mi: ${found} new species`);
    }
  }

  const found = [...seen.values()];
  // Stored rather than filtered: the read side decides, and "unassessed" is
  // not "introduced" — see src/analysis/establishmentMeans.js.
  const meansById =
    placeId && found.length
      ? await fetchEstablishmentMeans(found.map((row) => Number(row.taxon_id)), placeId, { fetchJson })
      : new Map();

  const fetchedOn = today();
  const rows = found.map((row) => ({
    iconic_taxon: row.iconic_taxon,
    animal_species: row.animal_species,
    animal_common: row.animal_common,
    nearest_radius_mi: row.nearest_radius_mi,
    observation_count: row.observation_count,
    establishment_means: meansById.get(Number(row.taxon_id)) || '',
    fetched_on: fetchedOn,
    source: FAUNA_SOURCE,
  }));
  return { rows, networkRequests: io.networkRequests, failures: io.failures, fetchedOn };
}

/** Build and record one yard's 'fauna' layer (feed-poller's queue and the CLI). */
export function buildAndRecordFauna(args) {
  return buildAndRecordLayer('fauna', buildFaunaLayer, args);
}

async function fetchSpeciesCounts({ lat, lng, radiusMi, iconicTaxon, fetchJson }) {
  const url = new URL('https://api.inaturalist.org/v1/observations/species_counts');
  url.searchParams.set('lat', lat);
  url.searchParams.set('lng', lng);
  // The API's radius is in KM, not miles (nl-a8v).
  url.searchParams.set('radius', (radiusMi * MI_TO_KM).toFixed(3));
  url.searchParams.set('iconic_taxa[]', iconicTaxon);
  url.searchParams.set('per_page', String(PER_TAXON_PAGE_SIZE));
  url.searchParams.set('order_by', 'observation_count'); // most-established local presence first
  // Wild, research-grade, precisely located records only (nl-hr5): captive
  // records and obscured locations would put species in the wrong distance band.
  restrictToWildPreciseRecords(url);

  const body = await fetchJson('observations/species_counts', url);
  return (body.results || [])
    .map((entry) => ({
      animal_species: entry.taxon?.name || '',
      animal_common: entry.taxon?.preferred_common_name || '',
      taxon_id: entry.taxon?.id ?? '',
      observation_count: entry.count ?? 0,
    }))
    .filter((row) => row.animal_species);
}

async function main() {
  const args = process.argv.slice(2);
  const slug = argAfter(args, '--project');
  const smoke = args.includes('--smoke');
  const force = args.includes('--force');
  if (!slug) {
    console.error('Usage: node tools/fetch-nearby-fauna.mjs --project <slug> [--owner <email>] [--smoke] [--force]');
    process.exit(1);
  }
  let site;
  try {
    site = readProjectSite(slug, { ownerEmail: ownerFromArgs(args), requirePlace: false });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const probeCache = openProbeCache();
  if (smoke) {
    const { rows } = await buildFaunaLayer({ location: site.location, probeCache, force, smoke: true });
    console.log(`\n--smoke run: ${rows.length} row(s), NOT writing data/ecosystem.db\n`);
    console.table(rows.slice(0, 50));
    return;
  }
  const db = openEcosystemDb();
  const result = await buildAndRecordFauna({ projectId: site.projectId, location: site.location, db, probeCache, force });
  console.log(
    `Yard "${slug}" (#${site.projectId}) nearby fauna: ${result.state}, ${result.rows} row(s), ${result.networkRequests} network request(s)` +
      (result.error ? ` — ${result.error}` : '')
  );
  if (result.state !== 'ready') process.exitCode = 1;
}

if (isEntryPoint(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
