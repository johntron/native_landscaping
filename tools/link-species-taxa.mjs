#!/usr/bin/env node
// Link plants.csv to the claim store's taxa, and publish the synonyms the
// browser needs (nl-3s5.18).
//
//   node tools/link-species-taxa.mjs [--claims-db data/claims.db] [--dry-run]
//
// Two outputs, both committed:
//
// 1. plants.csv `taxon_id`: the taxa.id whose scientific_name equals the row's
//    botanical_name EXACTLY. No fuzzy matching, no epithet, no stripping a
//    variety or cultivar to reach its parent: a row with no exact taxa match is
//    left blank ("don't invent plant data"). Every other cell of plants.csv is
//    rewritten byte for byte.
//
//    Caveat: taxa.id is an AUTOINCREMENT assigned in seeding order
//    (tools/claims/taxaSeed.js walks plants.csv top to bottom), so reordering
//    plants.csv and rebuilding claims.db renumbers taxa. Re-run this tool after
//    any rebuild; tools/claims/exportPlantsCsv.js writes the same column from
//    the store it exports. taxon_id is a link into the store, never a key a
//    saved yard uses: yards key on plants.csv's `id`.
//
// 2. catalog/species-synonyms.csv: every taxa row with resolves_to set whose
//    resolves_to chain ends at a taxon a plants.csv row links to. The browser
//    cannot query SQLite, so this is how a legacy layout row or an import that
//    names a species by an older name finds its species id
//    (src/data/speciesResolver.js). A synonym that equals a current plants.csv
//    name is skipped, since the exact-name match already handles it.
//
// Reads claims.db read-only; never writes it.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseCsv } from '../src/data/csvLoader.js';
import { normalizeBotanicalName } from '../src/data/speciesResolver.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PLANTS_CSV = path.join(REPO_ROOT, 'plants.csv');
export const SYNONYMS_CSV = path.join(REPO_ROOT, 'catalog', 'species-synonyms.csv');
export const SYNONYMS_HEADER = ['synonym', 'species_id', 'accepted_name', 'source'];
const SYNONYM_SOURCE =
  "claims.db taxa.resolves_to, set by name reconciliation against Diggs, Lipscomb & O'Kennon 1999 (tools/claims/nameReconciliation.js)";

/** Split one CSV line into RAW cells, quotes kept, so untouched cells rejoin byte for byte. */
function splitRawCells(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (const char of line) {
    if (char === '"') inQuotes = !inQuotes;
    if (char === ',' && !inQuotes) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function csvCell(value) {
  const str = String(value ?? '');
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/**
 * Compute plants.csv's taxon_id per row from `taxa` rows. Pure.
 * @param {Array<{id: string, botanical_name: string}>} plantRows
 * @param {Array<{id: number, scientific_name: string}>} taxa
 * @returns {Map<string, string>} species id -> taxon id ('' when no exact match)
 */
export function linkTaxonIds(plantRows, taxa) {
  const byName = new Map(taxa.map((t) => [t.scientific_name.trim(), t]));
  const out = new Map();
  plantRows.forEach((row) => {
    const taxon = byName.get(String(row.botanical_name || '').trim());
    out.set(row.id, taxon ? String(taxon.id) : '');
  });
  return out;
}

/**
 * Synonym rows for catalog/species-synonyms.csv. Pure.
 * @param {Array<{id: string, botanical_name: string}>} plantRows
 * @param {Map<string, string>} taxonIdBySpecies from linkTaxonIds
 * @param {Array<{id: number, scientific_name: string, resolves_to: number|null}>} taxa
 * @returns {{rows: Array<Record<string,string>>, skipped: string[]}}
 */
export function buildSynonymRows(plantRows, taxonIdBySpecies, taxa) {
  const taxonById = new Map(taxa.map((t) => [Number(t.id), t]));
  const speciesByTaxon = new Map();
  plantRows.forEach((row) => {
    const taxonId = taxonIdBySpecies.get(row.id);
    if (taxonId) speciesByTaxon.set(Number(taxonId), row);
  });
  const currentNames = new Set(plantRows.map((row) => normalizeBotanicalName(row.botanical_name)));

  const rows = [];
  const skipped = [];
  taxa
    .filter((t) => t.resolves_to !== null && t.resolves_to !== undefined)
    .forEach((synonym) => {
      // Follow resolves_to to the end of the chain, refusing a cycle.
      const seen = new Set([Number(synonym.id)]);
      let target = taxonById.get(Number(synonym.resolves_to));
      while (target && target.resolves_to !== null && target.resolves_to !== undefined) {
        if (seen.has(Number(target.id))) {
          skipped.push(`${synonym.scientific_name}: resolves_to cycle`);
          return;
        }
        seen.add(Number(target.id));
        target = taxonById.get(Number(target.resolves_to));
      }
      if (!target) {
        skipped.push(`${synonym.scientific_name}: resolves_to points at a missing taxon`);
        return;
      }
      const species = speciesByTaxon.get(Number(target.id));
      if (!species) return; // resolves to a taxon plants.csv does not carry: nothing to point at
      if (currentNames.has(normalizeBotanicalName(synonym.scientific_name))) {
        skipped.push(`${synonym.scientific_name}: is a current plants.csv name`);
        return;
      }
      rows.push({
        synonym: synonym.scientific_name.trim(),
        species_id: species.id,
        accepted_name: species.botanical_name.trim(),
        source: SYNONYM_SOURCE,
      });
    });

  // One synonym naming two species would be a guess either way: drop both.
  const bySynonym = new Map();
  rows.forEach((row) => {
    const key = normalizeBotanicalName(row.synonym);
    bySynonym.set(key, [...(bySynonym.get(key) || []), row]);
  });
  const unique = [];
  bySynonym.forEach((group, key) => {
    const targets = new Set(group.map((row) => row.species_id));
    if (targets.size > 1) {
      skipped.push(`${key}: maps to ${[...targets].join(' and ')}`);
      return;
    }
    unique.push(group[0]);
  });
  unique.sort((a, b) => a.synonym.localeCompare(b.synonym));
  return { rows: unique, skipped };
}

/**
 * Rewrite plants.csv text with a taxon_id column right after botanical_name,
 * leaving every other cell exactly as it was.
 * @param {string} csvText
 * @param {Map<string, string>} taxonIdBySpecies
 */
export function writeTaxonIdColumn(csvText, taxonIdBySpecies) {
  // Keep each line's own terminator: plants.csv mixes CRLF rows with an LF
  // last row, and a rewrite that normalized them would touch every line.
  const parts = csvText.split(/(\r?\n)/);
  const lines = parts.filter((_, i) => i % 2 === 0);
  const terminators = parts.filter((_, i) => i % 2 === 1);
  const header = splitRawCells(lines[0]);
  let taxonCol = header.indexOf('taxon_id');
  const insert = taxonCol === -1;
  if (insert) taxonCol = header.indexOf('botanical_name') + 1;
  const idCol = header.indexOf('id');
  const out = lines.map((line, i) => {
    const cells = splitRawCells(line);
    if (i === 0) {
      if (insert) cells.splice(taxonCol, 0, 'taxon_id');
      return cells.join(',');
    }
    if (!line.trim()) return line;
    const speciesId = cells[idCol].replace(/^"|"$/g, '').trim();
    const value = csvCell(taxonIdBySpecies.get(speciesId) ?? '');
    if (insert) cells.splice(taxonCol, 0, value);
    else cells[taxonCol] = value;
    return cells.join(',');
  });
  return out.map((line, i) => line + (terminators[i] ?? '')).join('');
}

function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const dbFlag = argv.indexOf('--claims-db');
  const dbPath = path.resolve(dbFlag >= 0 ? argv[dbFlag + 1] : path.join(REPO_ROOT, 'data', 'claims.db'));
  if (!existsSync(dbPath)) {
    console.error(`No claim store at ${dbPath}; pass --claims-db <path> (rebuild with tools/claims/rebuild.js).`);
    process.exit(1);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const taxa = db.prepare('SELECT id, scientific_name, resolves_to FROM taxa').all();
  db.close();

  const plantsText = readFileSync(PLANTS_CSV, 'utf8');
  const plantRows = parseCsv(plantsText);
  const taxonIds = linkTaxonIds(plantRows, taxa);

  plantRows.forEach((row) => {
    const next = taxonIds.get(row.id);
    if (row.taxon_id && row.taxon_id !== next) {
      console.log(`  taxon_id changed for ${row.id}: ${row.taxon_id} -> ${next || '(blank)'}`);
    }
  });
  const blank = plantRows.filter((row) => !taxonIds.get(row.id));
  console.log(`plants.csv: ${plantRows.length - blank.length} of ${plantRows.length} rows linked to a taxon; ${blank.length} left blank`);
  blank.forEach((row) => console.log(`  blank: ${row.id} (${row.botanical_name}) has no exact taxa match`));

  const { rows: synonymRows, skipped } = buildSynonymRows(plantRows, taxonIds, taxa);
  console.log(`catalog/species-synonyms.csv: ${synonymRows.length} synonyms`);
  synonymRows.forEach((row) => console.log(`  ${row.synonym} -> ${row.species_id} (${row.accepted_name})`));
  skipped.forEach((line) => console.log(`  skipped: ${line}`));

  if (dryRun) {
    console.log('Dry run: nothing written.');
    return;
  }
  writeFileSync(PLANTS_CSV, writeTaxonIdColumn(plantsText, taxonIds));
  const synonymsText = [SYNONYMS_HEADER.join(','), ...synonymRows.map((row) => SYNONYMS_HEADER.map((col) => csvCell(row[col])).join(','))].join('\n');
  writeFileSync(SYNONYMS_CSV, `${synonymsText}\n`);
  console.log(`Wrote ${path.relative(REPO_ROOT, PLANTS_CSV)} and ${path.relative(REPO_ROOT, SYNONYMS_CSV)}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
