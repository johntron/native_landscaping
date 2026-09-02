#!/usr/bin/env node
/**
 * Fetch documented plant-animal interactions from GloBI (Global Biotic
 * Interactions, api.globalbioticinteractions.org) for every genus in
 * plants.csv, and write ecology/plant-animal-interactions.csv.
 *
 * This is the same pattern as ecology/host-genera.csv: externally researched
 * biological facts belong in a checked-in, sourced CSV, not fetched at
 * runtime. src/analysis/ stays pure and offline; this script is the only
 * thing that talks to the network, and it is never invoked by npm test.
 *
 * Usage:
 *   node tools/fetch-plant-animal-interactions.mjs            # all genera in plants.csv
 *   node tools/fetch-plant-animal-interactions.mjs --smoke    # one genus, for a quick check
 *   node tools/fetch-plant-animal-interactions.mjs --genus Asclepias --genus Passiflora
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../src/data/csvLoader.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLANTS_CSV = `${ROOT}plants.csv`;
const OUT_CSV = `${ROOT}ecology/plant-animal-interactions.csv`;

/**
 * GloBI's interaction_type vocabulary is large and includes relationships that
 * say nothing about whether a plant supports an animal (adjacentTo,
 * coOccursWith, hasPathogen, eats [plant eats animal], preyedUponBy...). Only
 * these say "this animal uses this plant" — kept as TWO categories, not more,
 * because the underlying data does not reliably support a finer split.
 *
 * A smoke test against Achillea showed why: its 868 `eatenBy` records include
 * both true herbivores (beetles, moths) AND foraging bees (Agapostemon,
 * Bombus) with no pollinatedBy/flowersVisitedBy records at all — the source
 * study just filed "forages on" under "eatenBy". Splitting eatenBy into
 * "pollinator" vs "herbivore" would be inventing a distinction the data does
 * not carry. So:
 *   pollinator — filed under a verb that is UNAMBIGUOUSLY about flower visits
 *   feeds-on   — everything else that says an animal consumes/develops on the
 *                plant (herbivory, larval hosting, egg-laying, or foraging
 *                filed generically as eatenBy) — read the raw
 *                `interaction_type` column when the distinction matters.
 */
const CATEGORY_BY_TYPE = {
  pollinatedBy: 'pollinator',
  flowersVisitedBy: 'pollinator',
  visitsFlowersOf: 'pollinator',
  visitedBy: 'pollinator',
  hostOf: 'feeds-on',
  eatenBy: 'feeds-on',
  hasEggsLayedOnBy: 'feeds-on',
};

const REQUEST_DELAY_MS = 500;

async function main() {
  const args = process.argv.slice(2);
  const smoke = args.includes('--smoke');
  const explicitGenera = args
    .map((arg, i) => (arg === '--genus' ? args[i + 1] : null))
    .filter(Boolean);

  const genera = explicitGenera.length
    ? explicitGenera
    : smoke
      ? [catalogGenera()[0]]
      : catalogGenera();

  console.log(`Fetching GloBI interactions for ${genera.length} genus/genera: ${genera.join(', ')}`);

  const rows = [];
  for (const genus of genera) {
    try {
      const found = await fetchGenusInteractions(genus);
      console.log(`  ${genus}: ${found.length} usable interaction(s)`);
      rows.push(...found);
    } catch (err) {
      console.warn(`  ${genus}: FAILED — ${err.message}`);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  writeCsv(rows, smoke || explicitGenera.length);
}

function catalogGenera() {
  const csvText = readFileSync(PLANTS_CSV, 'utf8');
  const genera = new Set();
  parseCsv(csvText).forEach((row) => {
    const genus = String(row.botanical_name || '').trim().split(/\s+/)[0];
    if (genus) genera.add(genus);
  });
  return [...genera].sort();
}

async function fetchGenusInteractions(genus) {
  const url = `https://api.globalbioticinteractions.org/interaction?sourceTaxon=${encodeURIComponent(genus)}&type=csv`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'native-landscaping-app (ecology data fetch)' },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const csvText = await response.text();
  const records = parseCsv(csvText);

  const seen = new Set();
  const out = [];
  records.forEach((record) => {
    const type = record.interaction_type;
    const category = CATEGORY_BY_TYPE[type];
    if (!category) return;
    // Keep only animal targets — GloBI covers fungi, other plants, bacteria.
    const path = record.target_taxon_path || '';
    if (!/\bAnimalia\b/.test(path)) return;
    const animalSpecies = String(record.target_taxon_name || '').trim();
    if (!animalSpecies) return;
    const key = `${genus}|${animalSpecies}|${category}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      genus,
      animal_species: animalSpecies,
      animal_common: '',
      category,
      interaction_type: type,
      synonym_of: '',
      source: buildSource(record),
    });
  });
  return out;
}

const FETCH_DATE = new Date().toISOString().slice(0, 10);

/** Cite the underlying study when GloBI names one; it is a more checkable claim than the aggregator alone. */
function buildSource(record) {
  const study = String(record.study_title || '').trim();
  const base = `globalbioticinteractions.org, fetched ${FETCH_DATE}`;
  return study ? `${base} (source study: ${study})` : base;
}

function writeCsv(rows, isPartialRun) {
  const header = [
    'genus',
    'animal_species',
    'animal_common',
    'category',
    'interaction_type',
    'synonym_of',
    'source',
  ];
  const lines = [header.join(',')];
  rows
    .sort((a, b) => a.genus.localeCompare(b.genus) || a.animal_species.localeCompare(b.animal_species))
    .forEach((row) => {
      lines.push(header.map((key) => escapeCell(row[key])).join(','));
    });
  const csv = lines.join('\n') + '\n';

  if (isPartialRun) {
    console.log('\n--smoke/--genus run: printing to stdout, NOT writing ecology/plant-animal-interactions.csv\n');
    console.log(csv);
    return;
  }

  writeFileSync(OUT_CSV, csv);
  console.log(`\nWrote ${rows.length} rows to ${OUT_CSV}`);
}

function escapeCell(value) {
  const str = String(value ?? '');
  if (!/[",\n]/.test(str)) return str;
  return `"${str.replace(/"/g, '""')}"`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
