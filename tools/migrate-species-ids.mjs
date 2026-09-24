#!/usr/bin/env node
// Migrate saved yards to reference species by plants.csv `id` (nl-3s5.18).
//
//   node tools/migrate-species-ids.mjs <projects-dir> [--dry-run]
//        [--plants plants.csv] [--synonyms catalog/species-synonyms.csv]
//
// For every project directory under <projects-dir>:
//
// - planting_layout.csv in the old `id,botanical_name,x_ft,y_ft` shape is
//   rewritten as `id,species_id,x_ft,y_ft`. Coordinates are copied as written,
//   not reformatted. A file with even one row that cannot be resolved is left
//   untouched, since a CSV cannot be half in one shape and half in the other.
// - layout-history.json gets a `speciesId` added to every plant snapshot that
//   lacks one. Nothing else in the file changes: not the other plant fields,
//   not the entries, not the cursor. A plant that cannot be resolved is left
//   exactly as it is.
//
// Resolution goes through src/data/speciesResolver.js: the full botanical name
// exactly, then the synonym table. NEVER by species epithet, and never by
// stripping a variety or cultivar. Anything unresolved is reported, not guessed.
//
// Idempotent: a file already in the new shape is not touched, and no backup is
// written. Every file that does change is first copied to
// <file>.bak-<timestamp> beside it, then replaced through a temp file and a
// rename so a crash cannot leave half a file.
//
// layout-history.json is gitignored, hand-entered state that cannot be rebuilt:
// run with --dry-run first and read the report.
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../src/data/csvLoader.js';
import { parseSpeciesCsv } from '../src/data/plantParser.js';
import { buildSpeciesIndex, parseSynonymCsv, resolveSpeciesByName } from '../src/data/speciesResolver.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEW_HEADER = ['id', 'species_id', 'x_ft', 'y_ft'];

function csvCell(value) {
  const str = String(value ?? '');
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/**
 * Migrate one planting_layout.csv's text. Pure.
 * @returns {{status: 'migrated'|'already'|'unresolved', text?: string, problems: string[], count: number}}
 */
export function migrateLayoutCsv(csvText, index) {
  const header = (csvText.split(/\r?\n/)[0] || '').split(',').map((h) => h.trim());
  const rows = parseCsv(csvText);
  const problems = [];

  if (header.includes('species_id')) {
    rows.forEach((row) => {
      if (!index.byId.has(row.species_id)) {
        problems.push(`row ${row.id}: species_id "${row.species_id}" is not in plants.csv`);
      }
    });
    return { status: 'already', problems, count: 0 };
  }

  const out = [];
  rows.forEach((row) => {
    const name = row.botanical_name || row.botanicalName || '';
    const resolved = resolveSpeciesByName(index, name);
    if (!resolved) {
      problems.push(`row ${row.id}: "${name}" matches no plants.csv name or synonym`);
      return;
    }
    out.push([csvCell(row.id), csvCell(resolved.entry.speciesId), csvCell(row.x_ft ?? row.x), csvCell(row.y_ft ?? row.y)].join(','));
  });
  if (problems.length) return { status: 'unresolved', problems, count: 0 };

  // buildLayoutCsv's own layout: LF, no trailing newline.
  return { status: 'migrated', text: [NEW_HEADER.join(','), ...out].join('\n'), problems, count: out.length };
}

/**
 * Add speciesId to every plant snapshot in a parsed layout-history.json. Mutates
 * `history` in place (the caller holds the only copy) and reports what it did.
 * @returns {{added: number, problems: string[]}}
 */
export function migrateHistory(history, index) {
  let added = 0;
  const problems = [];
  const entries = Array.isArray(history?.entries) ? history.entries : [];
  entries.forEach((entry, entryIdx) => {
    if (!Array.isArray(entry?.plants)) return;
    entry.plants = entry.plants.map((plant) => {
      if (!plant || typeof plant !== 'object') return plant;
      if (plant.speciesId) {
        if (!index.byId.has(String(plant.speciesId))) {
          problems.push(`entry ${entryIdx} ("${entry.description}"), plant ${plant.id}: speciesId "${plant.speciesId}" is not in plants.csv`);
        }
        return plant;
      }
      const name = plant.botanicalName || plant.botanicalKey || '';
      const resolved = resolveSpeciesByName(index, name);
      if (!resolved) {
        problems.push(`entry ${entryIdx} ("${entry.description}"), plant ${plant.id}: "${name}" matches no plants.csv name or synonym; left as is`);
        return plant;
      }
      added += 1;
      // speciesId right after id, so a diff of the file reads as one added line per plant.
      const { id, ...rest } = plant;
      return { id, speciesId: resolved.entry.speciesId, ...rest };
    });
  });
  return { added, problems };
}

function writeWithBackup(file, text, stamp) {
  const backup = `${file}.bak-${stamp}`;
  copyFileSync(file, backup);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, file);
  return backup;
}

function main(argv) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : null;
  };
  const dryRun = argv.includes('--dry-run');
  const valueFlags = new Set(['--plants', '--synonyms']);
  const positional = argv.filter((arg, i) => !arg.startsWith('--') && !valueFlags.has(argv[i - 1]));
  const projectsDir = positional[0];
  if (!projectsDir) {
    console.error('usage: node tools/migrate-species-ids.mjs <projects-dir> [--dry-run] [--plants <csv>] [--synonyms <csv>]');
    process.exit(1);
  }
  const plantsPath = path.resolve(flag('--plants') || path.join(REPO_ROOT, 'plants.csv'));
  const synonymsPath = path.resolve(flag('--synonyms') || path.join(REPO_ROOT, 'catalog', 'species-synonyms.csv'));
  const species = parseSpeciesCsv(readFileSync(plantsPath, 'utf8'));
  const synonyms = existsSync(synonymsPath) ? parseSynonymCsv(readFileSync(synonymsPath, 'utf8')) : new Map();
  const index = buildSpeciesIndex(species, synonyms);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  console.log(`${dryRun ? 'DRY RUN: ' : ''}migrating ${path.resolve(projectsDir)} against ${plantsPath} (${species.length} species, ${synonyms.size} synonyms)`);
  let unresolvedTotal = 0;

  const projects = readdirSync(projectsDir)
    .filter((name) => statSync(path.join(projectsDir, name)).isDirectory())
    .sort();
  projects.forEach((name) => {
    const dir = path.join(projectsDir, name);

    const layoutFile = path.join(dir, 'planting_layout.csv');
    if (existsSync(layoutFile)) {
      const result = migrateLayoutCsv(readFileSync(layoutFile, 'utf8'), index);
      unresolvedTotal += result.problems.length;
      if (result.status === 'migrated') {
        const backup = dryRun ? null : writeWithBackup(layoutFile, result.text, stamp);
        console.log(`${name}/planting_layout.csv: ${dryRun ? 'would migrate' : 'migrated'} ${result.count} rows${backup ? ` (backup ${path.basename(backup)})` : ''}`);
      } else if (result.status === 'already') {
        console.log(`${name}/planting_layout.csv: already uses species_id; untouched`);
      } else {
        console.log(`${name}/planting_layout.csv: NOT migrated, left untouched (unresolved rows below)`);
      }
      result.problems.forEach((line) => console.log(`  unresolved: ${line}`));
    }

    const historyFile = path.join(dir, 'layout-history.json');
    if (existsSync(historyFile)) {
      const raw = readFileSync(historyFile, 'utf8');
      let history;
      try {
        history = JSON.parse(raw);
      } catch (err) {
        console.log(`${name}/layout-history.json: unreadable JSON (${err.message}); untouched`);
        unresolvedTotal += 1;
        return;
      }
      const { added, problems } = migrateHistory(history, index);
      unresolvedTotal += problems.length;
      if (added) {
        // The server writes JSON.stringify(history, null, 2) with no trailing
        // newline; keep whatever the file had so the diff is only the new lines.
        const text = JSON.stringify(history, null, 2) + (raw.endsWith('\n') ? '\n' : '');
        const backup = dryRun ? null : writeWithBackup(historyFile, text, stamp);
        console.log(`${name}/layout-history.json: ${dryRun ? 'would add' : 'added'} speciesId to ${added} plant snapshots${backup ? ` (backup ${path.basename(backup)})` : ''}`);
      } else {
        console.log(`${name}/layout-history.json: nothing to add; untouched`);
      }
      problems.forEach((line) => console.log(`  unresolved: ${line}`));
    }
  });

  console.log(`${unresolvedTotal} unresolved item${unresolvedTotal === 1 ? '' : 's'} reported above${unresolvedTotal ? '; they were left exactly as they were' : ''}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
