#!/usr/bin/env node
// Reduce every layout-history.json snapshot to placements (nl-3s5.19).
//
//   node tools/migrate-history-placements.mjs <projects-dir> [--dry-run]
//        [--plants plants.csv] [--synonyms catalog/species-synonyms.csv]
//
// A history entry used to copy each plant whole: names, sizes, colours, months,
// preferences. The app has always rebuilt those from plants.csv on the way out,
// so they were dead weight (example-frontyard: about 300 entries, 5.5 MB). After
// this, every plant in every entry is a placement, `{ id, speciesId, x, y }`
// plus any per-plant field that is not a species attribute
// (src/data/placements.js decides which is which).
//
// What is kept, exactly: every entry, in order; each entry's own fields (id,
// timestamp, description, anything else), in order; the cursor; and each
// plant's id, speciesId and coordinates, as written.
//
// A snapshot without a speciesId (from before nl-3s5.18) is first resolved by
// its botanical name, exactly or through the synonym table, never by epithet,
// through src/data/speciesResolver.js. One that still resolves to nothing is
// kept VERBATIM, attributes and all, and reported: it is the only record of
// that plant, and the app draws it from those attributes, as it always has.
// A speciesId plants.csv no longer lists is reduced like any other, and
// reported: the app cannot draw that plant from the catalog either way.
//
// Idempotent: a file whose snapshots are all placements already is not
// touched, and no backup is written. Every file that does change is copied to
// <file>.bak-<timestamp> beside it (gitignored), then replaced through a temp
// file and a rename. The web server may save the same file while this runs: a
// file whose size or mtime changed between reading and replacing is skipped and
// reported, never overwritten; run the tool again for it.
//
// layout-history.json is hand-entered state that cannot be rebuilt: run with
// --dry-run first and read the report.
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSpeciesCsv } from '../src/data/plantParser.js';
import { buildSpeciesIndex, parseSynonymCsv, resolveSpeciesByName } from '../src/data/speciesResolver.js';
import { toPlacement } from '../src/data/placements.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Reduce one parsed layout-history.json to placements. Pure: returns a new
 * object and leaves `history` alone.
 * @param {object} history parsed layout-history.json
 * @param {ReturnType<typeof buildSpeciesIndex>} index
 * @returns {{ history: object, changed: boolean, entries: number, plants: number,
 *   resolvedByName: number, verbatim: string[], unknownIds: string[] }}
 */
export function migrateHistoryToPlacements(history, index) {
  const verbatim = [];
  const unknownIds = [];
  let plants = 0;
  let resolvedByName = 0;
  const entries = Array.isArray(history?.entries) ? history.entries : [];

  const migratedEntries = entries.map((entry, entryIdx) => {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.plants)) return entry;
    const where = (plant) => `entry ${entryIdx} ("${entry.description}"), plant ${plant?.id}`;
    return {
      ...entry,
      plants: entry.plants.map((plant) => {
        plants += 1;
        if (!plant || typeof plant !== 'object') return plant;
        let source = plant;
        if (!plant.speciesId) {
          const name = plant.botanicalName || plant.botanicalKey || '';
          const resolved = resolveSpeciesByName(index, name);
          if (!resolved) {
            verbatim.push(`${where(plant)}: "${name}" has no speciesId and matches no plants.csv name or synonym; kept verbatim`);
            return plant;
          }
          resolvedByName += 1;
          source = { ...plant, speciesId: resolved.entry.speciesId };
        } else if (!index.byId.has(String(plant.speciesId))) {
          unknownIds.push(`${where(plant)}: speciesId "${plant.speciesId}" is not in plants.csv`);
        }
        return toPlacement(source);
      }),
    };
  });

  const out = { ...history, entries: migratedEntries };
  return {
    history: out,
    changed: !isDeepStrictEqual(out, history),
    entries: entries.length,
    plants,
    resolvedByName,
    verbatim,
    unknownIds,
  };
}

/**
 * The guarantees, checked on the result before anything is written: the same
 * entries in the same order with the same fields, the same plant count and ids
 * in each, the same cursor. Returns what broke, or [] when nothing did.
 */
export function checkPreserved(before, after) {
  const problems = [];
  const a = Array.isArray(before?.entries) ? before.entries : [];
  const b = Array.isArray(after?.entries) ? after.entries : [];
  if (a.length !== b.length) problems.push(`entry count ${a.length} -> ${b.length}`);
  if (before?.cursor !== after?.cursor) problems.push(`cursor ${before?.cursor} -> ${after?.cursor}`);
  if (!isDeepStrictEqual(Object.keys(before || {}), Object.keys(after || {}))) problems.push('top-level fields changed');
  a.forEach((entry, i) => {
    const other = b[i];
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.plants)) {
      if (!isDeepStrictEqual(entry, other)) problems.push(`entry ${i} changed`);
      return;
    }
    const { plants: pa, ...restA } = entry;
    const { plants: pb, ...restB } = other || {};
    if (!isDeepStrictEqual(Object.keys(entry), Object.keys(other || {})) || !isDeepStrictEqual(restA, restB)) {
      problems.push(`entry ${i}: its own fields changed`);
    }
    if (!Array.isArray(pb) || pa.length !== pb.length) {
      problems.push(`entry ${i}: plant count changed`);
      return;
    }
    pa.forEach((plant, j) => {
      const q = pb[j];
      if (plant?.id !== q?.id || plant?.x !== q?.x || plant?.y !== q?.y) {
        problems.push(`entry ${i}, plant ${j}: id or position changed`);
      }
      if (plant?.speciesId && plant.speciesId !== q?.speciesId) {
        problems.push(`entry ${i}, plant ${j}: speciesId changed`);
      }
    });
  });
  return problems;
}

function sameFile(a, b) {
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/**
 * Migrate one layout-history.json on disk. Returns a report line list and
 * counts; writes only when not a dry run and the file really changes.
 */
export function migrateHistoryFile(file, index, { dryRun = false, stamp } = {}) {
  const lines = [];
  const before = statSync(file);
  const raw = readFileSync(file, 'utf8');
  let history;
  try {
    history = JSON.parse(raw);
  } catch (err) {
    return { status: 'unreadable', lines: [`unreadable JSON (${err.message}); untouched`], problems: 1 };
  }
  const result = migrateHistoryToPlacements(history, index);
  const problems = checkPreserved(history, result.history);
  const cursorNote = `cursor ${history?.cursor}`;
  const bytesBefore = Buffer.byteLength(raw);
  if (problems.length) {
    return { status: 'refused', lines: [`NOT migrated: ${problems.join('; ')}`], problems: problems.length };
  }

  const notes = [
    ...result.verbatim.map((line) => `  kept verbatim: ${line}`),
    ...result.unknownIds.map((line) => `  not in catalog: ${line}`),
  ];
  if (!result.changed) {
    return {
      status: 'already',
      lines: [`already placements only (${result.entries} entries, ${cursorNote}, ${bytesBefore} bytes); untouched`, ...notes],
      problems: notes.length,
      sizeBefore: bytesBefore,
      sizeAfter: bytesBefore,
    };
  }

  // The server writes JSON.stringify(history, null, 2) with no trailing
  // newline; keep whatever the file had.
  const text = JSON.stringify(result.history, null, 2) + (raw.endsWith('\n') ? '\n' : '');
  const bytesAfter = Buffer.byteLength(text);
  const summary = `${result.entries} entries, ${result.plants} plant snapshots, ${cursorNote}; ${bytesBefore} -> ${bytesAfter} bytes`
    + (result.resolvedByName ? `; ${result.resolvedByName} resolved by name` : '');

  if (dryRun) {
    return { status: 'would-migrate', lines: [`would migrate: ${summary}`, ...notes], problems: notes.length, sizeBefore: bytesBefore, sizeAfter: bytesAfter };
  }

  const backup = `${file}.bak-${stamp}`;
  const temp = `${file}.${process.pid}.migrate.tmp`;
  if (!sameFile(before, statSync(file))) {
    return { status: 'raced', lines: ['changed on disk while being read; skipped, run again'], problems: 1 };
  }
  copyFileSync(file, backup);
  writeFileSync(temp, text);
  if (!sameFile(before, statSync(file))) {
    rmSync(temp, { force: true });
    rmSync(backup, { force: true });
    return { status: 'raced', lines: ['changed on disk while being migrated; skipped, run again'], problems: 1 };
  }
  renameSync(temp, file);
  lines.push(`migrated: ${summary} (backup ${path.basename(backup)})`, ...notes);
  return { status: 'migrated', lines, problems: notes.length, sizeBefore: bytesBefore, sizeAfter: bytesAfter };
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
    console.error('usage: node tools/migrate-history-placements.mjs <projects-dir> [--dry-run] [--plants <csv>] [--synonyms <csv>]');
    process.exit(1);
  }
  const plantsPath = path.resolve(flag('--plants') || path.join(REPO_ROOT, 'plants.csv'));
  const synonymsPath = path.resolve(flag('--synonyms') || path.join(REPO_ROOT, 'catalog', 'species-synonyms.csv'));
  const species = parseSpeciesCsv(readFileSync(plantsPath, 'utf8'));
  const synonyms = existsSync(synonymsPath) ? parseSynonymCsv(readFileSync(synonymsPath, 'utf8')) : new Map();
  const index = buildSpeciesIndex(species, synonyms);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  console.log(`${dryRun ? 'DRY RUN: ' : ''}reducing history to placements in ${path.resolve(projectsDir)} (${species.length} species, ${synonyms.size} synonyms)`);
  let problems = 0;
  let totalBefore = 0;
  let totalAfter = 0;

  readdirSync(projectsDir)
    .filter((name) => statSync(path.join(projectsDir, name)).isDirectory())
    .sort()
    .forEach((name) => {
      const file = path.join(projectsDir, name, 'layout-history.json');
      if (!existsSync(file)) return;
      const result = migrateHistoryFile(file, index, { dryRun, stamp });
      problems += result.problems;
      totalBefore += result.sizeBefore || 0;
      totalAfter += result.sizeAfter || 0;
      result.lines.forEach((line, i) => console.log(i === 0 ? `${name}/layout-history.json: ${line}` : line));
    });

  console.log(`total ${totalBefore} -> ${totalAfter} bytes; ${problems} item${problems === 1 ? '' : 's'} reported above.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
