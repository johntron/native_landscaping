#!/usr/bin/env node
/**
 * Fetch which animal species are already reported nearby a project's site,
 * banded by distance, from iNaturalist (api.inaturalist.org), and merge the
 * result into ecology/nearby-fauna.csv keyed by `place`.
 *
 * Same pattern as fetch-plant-animal-interactions.mjs: the network call
 * happens here, once, offline, and the app only ever reads the checked-in
 * CSV. src/analysis/ stays pure.
 *
 * The exact coordinates never reach the CSV or git: they live in
 * projects/<id>/location.json, which is gitignored (this repo is public).
 * Only the resulting species list — which does not by itself disclose an
 * address — is committed, keyed by the project's `place` label.
 *
 * Usage:
 *   node tools/fetch-nearby-fauna.mjs --project backyard
 *   node tools/fetch-nearby-fauna.mjs --project backyard --smoke   # one taxon, one radius
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../src/data/csvLoader.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_CSV = `${ROOT}ecology/nearby-fauna.csv`;

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

const REQUEST_DELAY_MS = 1000;

async function main() {
  const args = process.argv.slice(2);
  const projectId = argAfter(args, '--project');
  const smoke = args.includes('--smoke');
  if (!projectId) {
    console.error('Usage: node tools/fetch-nearby-fauna.mjs --project <id> [--smoke]');
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
  const { lat, lng } = await resolveCoordinates(location);

  const projectConfigPath = `${ROOT}projects/${projectId}/project.json`;
  const projectConfig = JSON.parse(readFileSync(projectConfigPath, 'utf8'));
  const place = String(projectConfig.place || '').trim();
  if (!place) {
    console.error(`projects/${projectId}/project.json declares no "place"; add one before fetching.`);
    process.exit(1);
  }

  const radii = smoke ? [RADII_MI[Math.floor(RADII_MI.length / 2)]] : RADII_MI;
  const taxa = smoke ? [ICONIC_TAXA[0]] : ICONIC_TAXA;

  console.log(`Fetching nearby fauna for place "${place}" (lat=${lat}, lng=${lng})`);
  console.log(`Radii: ${radii.join(', ')} mi; taxa: ${taxa.join(', ')}`);

  // seen: nearest (smallest) radius a species was found at, across all iconic
  // taxa queried so far — radii are visited ascending so the first hit IS the
  // nearest band.
  const seen = new Map(); // key: `${iconicTaxon}|${animalSpecies}` -> row

  for (const iconicTaxon of taxa) {
    for (const radius of radii) {
      let found = 0;
      try {
        const results = await fetchSpeciesCounts({ lat, lng, radius, iconicTaxon });
        results.forEach((entry) => {
          const key = `${iconicTaxon}|${entry.animal_species}`;
          if (seen.has(key)) return; // already have this species at a smaller radius
          seen.set(key, { ...entry, iconic_taxon: iconicTaxon, nearest_radius_mi: radius, place });
          found += 1;
        });
      } catch (err) {
        console.warn(`  ${iconicTaxon} @ ${radius}mi: FAILED — ${err.message}`);
      }
      console.log(`  ${iconicTaxon} @ ${radius}mi: ${found} new species`);
      await sleep(REQUEST_DELAY_MS);
    }
  }

  const newRows = [...seen.values()];
  if (smoke) {
    console.log(`\n--smoke run: printing ${newRows.length} rows to stdout, NOT writing ecology/nearby-fauna.csv\n`);
    console.log(toCsv(newRows));
    return;
  }

  mergeAndWrite(place, newRows);
}

async function resolveCoordinates(location) {
  if (Number.isFinite(location.lat) && Number.isFinite(location.lng)) {
    return { lat: location.lat, lng: location.lng };
  }
  if (!location.address) {
    throw new Error('location.json has neither lat/lng nor an address');
  }
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(location.address)}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'native-landscaping-app (ecology data fetch)' },
  });
  if (!response.ok) throw new Error(`Geocoding failed: HTTP ${response.status}`);
  const results = await response.json();
  if (!results.length) throw new Error(`Geocoding found nothing for "${location.address}"`);
  return { lat: Number(results[0].lat), lng: Number(results[0].lon) };
}

async function fetchSpeciesCounts({ lat, lng, radius, iconicTaxon }) {
  const url = new URL('https://api.inaturalist.org/v1/observations/species_counts');
  url.searchParams.set('lat', lat);
  url.searchParams.set('lng', lng);
  url.searchParams.set('radius', radius);
  url.searchParams.set('iconic_taxa[]', iconicTaxon);
  url.searchParams.set('per_page', String(PER_TAXON_PAGE_SIZE));
  url.searchParams.set('order_by', 'observation_count'); // most-established local presence first

  const response = await fetch(url, {
    headers: { 'User-Agent': 'native-landscaping-app (ecology data fetch)' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  return (body.results || [])
    .map((entry) => ({
      animal_species: entry.taxon?.name || '',
      animal_common: entry.taxon?.preferred_common_name || '',
      observation_count: entry.count ?? '',
    }))
    .filter((row) => row.animal_species);
}

/** Merge new rows for one place into the existing CSV, replacing that place's rows only. */
function mergeAndWrite(place, newRows) {
  const existing = existsSync(OUT_CSV) ? parseCsv(readFileSync(OUT_CSV, 'utf8')) : [];
  const untouched = existing.filter((row) => row.place !== place);
  const fetchedOn = new Date().toISOString().slice(0, 10);
  const rows = [
    ...untouched,
    ...newRows.map((row) => ({
      place: row.place,
      animal_species: row.animal_species,
      animal_common: row.animal_common,
      iconic_taxon: row.iconic_taxon,
      nearest_radius_mi: row.nearest_radius_mi,
      observation_count: row.observation_count,
      fetched_on: fetchedOn,
      source: 'api.inaturalist.org species_counts',
    })),
  ];
  writeFileSync(OUT_CSV, toCsv(rows, true));
  console.log(`\nWrote ${rows.length} total rows (${newRows.length} for "${place}") to ${OUT_CSV}`);
}

const CSV_HEADER = [
  'place',
  'animal_species',
  'animal_common',
  'iconic_taxon',
  'nearest_radius_mi',
  'observation_count',
  'fetched_on',
  'source',
];

function toCsv(rows, includeHeader) {
  const lines = includeHeader ? [CSV_HEADER.join(',')] : [];
  rows
    .slice()
    .sort(
      (a, b) =>
        String(a.place).localeCompare(String(b.place)) ||
        String(a.iconic_taxon).localeCompare(String(b.iconic_taxon)) ||
        String(a.animal_species).localeCompare(String(b.animal_species))
    )
    .forEach((row) => {
      lines.push(CSV_HEADER.map((key) => escapeCell(row[key])).join(','));
    });
  return lines.join('\n') + '\n';
}

function escapeCell(value) {
  const str = String(value ?? '');
  if (!/[",\n]/.test(str)) return str;
  return `"${str.replace(/"/g, '""')}"`;
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
