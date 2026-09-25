#!/usr/bin/env node
/**
 * Fetch every butterfly and moth species with a research-grade, wild record in
 * a REGION (not anyone's yard) from iNaturalist into the committed
 * ecology/region-fauna.csv (nl-3s5.31). The public "Start here" page's
 * keystone screen (index.html, src/patchnetwork/) reads it to say which of the
 * flora's named larval hosts' Lepidoptera have been recorded in the region.
 *
 * Why a region: that screen used to read ecology/nearby-fauna.csv for the
 * owner's own site ("home"), which put the owner's surroundings on a public
 * page and in a public repo. A county is public, is the grain the flora's
 * "Dallas Co." column already uses, and says nothing about any one yard.
 * A signed-in yard's own nearby fauna lives in data/ecosystem.db instead
 * (tools/fetch-nearby-fauna.mjs).
 *
 * The region list is a judgement call, not a sourced fact: Dallas County, the
 * county the screen's flora column checks and the one the Blackland Prairie
 * demo is about. Add a region by adding a row to REGIONS; the page shows the
 * first one.
 *
 * Politeness: species_counts pages of 500, one request at a time with a 1.5 s
 * pause, through the shared probe cache (data/probe-cache.db, or DATA_DIR),
 * so a re-run replays from disk. Dallas County's Lepidoptera are a handful of
 * pages.
 *
 * Usage:
 *   node tools/fetch-region-fauna.mjs            # fetch and write ecology/region-fauna.csv
 *   node tools/fetch-region-fauna.mjs --smoke    # first page only, print, write nothing
 *   node tools/fetch-region-fauna.mjs --force    # bypass the response cache
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openProbeCache } from './usda-plants/probeCache.js';
import { restrictToWildPreciseRecords } from './inatShared.mjs';
import { USER_AGENT, cachedRequest, createIo, isEntryPoint, today } from './siteLayerShared.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const REGION_FAUNA_CSV = `${ROOT}ecology/region-fauna.csv`;

/**
 * Judgement: the regions fetched. `inatPlaceId` verified live 2026-09-24
 * (api.inaturalist.org/v1/places/1281: "Dallas County, US, TX", place_type 9).
 */
export const REGIONS = Object.freeze([{ region: 'Dallas County, TX', inatPlaceId: 1281 }]);

/** iNaturalist taxon 47157 is the order Lepidoptera (verified live 2026-09-24). */
export const LEPIDOPTERA_TAXON_ID = 47157;
const TAXON_GROUP = 'Lepidoptera';

/** species_counts' largest page. */
const PER_PAGE = 500;
/** Safety stop, far above Dallas County's Lepidoptera; a region that hits it is reported, never silently cut. */
const MAX_PAGES = 20;
const REQUEST_DELAY_MS = 1500;

export const REGION_FAUNA_SOURCE = 'api.inaturalist.org species_counts (place_id, research grade, wild)';

export const REGION_FAUNA_HEADER = [
  'region',
  'inat_place_id',
  'taxon_group',
  'animal_species',
  'animal_common',
  'taxon_id',
  'observation_count',
  'fetched_on',
  'source',
];

/**
 * Every species of the group recorded in one region, paging species_counts to
 * the end.
 *
 * @param {{ region: string, inatPlaceId: number }} region
 * @param {{ probeCache: import('node:sqlite').DatabaseSync, fetchImpl?: typeof fetch, force?: boolean,
 *   smoke?: boolean, requestDelayMs?: number, logger?: { log: Function, warn: Function } }} options
 * @returns {Promise<{ rows: object[], networkRequests: number, complete: boolean }>}
 */
export async function fetchRegionFauna(
  { region, inatPlaceId },
  { probeCache, fetchImpl, force = false, smoke = false, requestDelayMs = REQUEST_DELAY_MS, logger = console }
) {
  const io = createIo({ probeCache, fetchImpl, force, requestDelayMs, logger });
  const fetchedOn = today();
  const bySpecies = new Map();
  let complete = false;
  for (let page = 1; page <= (smoke ? 1 : MAX_PAGES); page += 1) {
    const url = new URL('https://api.inaturalist.org/v1/observations/species_counts');
    url.searchParams.set('place_id', String(inatPlaceId));
    url.searchParams.set('taxon_id', String(LEPIDOPTERA_TAXON_ID));
    url.searchParams.set('per_page', String(PER_PAGE));
    url.searchParams.set('page', String(page));
    restrictToWildPreciseRecords(url);
    const { raw: body } = await cachedRequest(io, 'inaturalist', 'observations/species_counts', url.toString(), () => [
      url,
      { headers: { 'User-Agent': USER_AGENT } },
    ]);
    const results = body.results || [];
    for (const entry of results) {
      const name = entry.taxon?.name;
      // species_counts returns leaf taxa, which can be a subspecies; the
      // screen joins on the first two words, so keep the rank it gave.
      if (!name || bySpecies.has(name)) continue;
      bySpecies.set(name, {
        region,
        inat_place_id: inatPlaceId,
        taxon_group: TAXON_GROUP,
        animal_species: name,
        animal_common: entry.taxon?.preferred_common_name || '',
        taxon_id: entry.taxon?.id ?? '',
        observation_count: entry.count ?? 0,
        fetched_on: fetchedOn,
        source: REGION_FAUNA_SOURCE,
      });
    }
    const total = Number(body.total_results) || 0;
    logger.log(`  ${region} page ${page}: ${results.length} taxa (${bySpecies.size} of ${total})`);
    if (!results.length || page * PER_PAGE >= total) {
      complete = true;
      break;
    }
  }
  if (!complete && !smoke) logger.warn(`  ${region}: stopped at ${MAX_PAGES} pages; the table is INCOMPLETE`);
  return { rows: [...bySpecies.values()], networkRequests: io.networkRequests, complete };
}

export function toRegionFaunaCsv(rows) {
  const escapeCell = (value) => {
    const str = String(value ?? '');
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const lines = [REGION_FAUNA_HEADER.join(',')];
  rows
    .slice()
    .sort((a, b) => String(a.region).localeCompare(String(b.region)) || String(a.animal_species).localeCompare(String(b.animal_species)))
    .forEach((row) => lines.push(REGION_FAUNA_HEADER.map((key) => escapeCell(row[key])).join(',')));
  return lines.join('\n') + '\n';
}

async function main() {
  const args = process.argv.slice(2);
  const smoke = args.includes('--smoke');
  const force = args.includes('--force');
  const probeCache = openProbeCache();
  const all = [];
  for (const region of REGIONS) {
    const { rows, complete } = await fetchRegionFauna(region, { probeCache, force, smoke });
    if (!complete && !smoke) {
      console.error(`${region.region} did not finish; nothing written`);
      process.exit(1);
    }
    all.push(...rows);
  }
  if (smoke) {
    console.log(`\n--smoke run: ${all.length} rows, NOT writing ${REGION_FAUNA_CSV}\n`);
    console.table(all.slice(0, 20));
    return;
  }
  writeFileSync(REGION_FAUNA_CSV, toRegionFaunaCsv(all));
  console.log(`Wrote ${all.length} rows to ${REGION_FAUNA_CSV}`);
}

if (isEntryPoint(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
