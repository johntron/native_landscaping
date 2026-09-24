import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPlantFromSpecies, parseSpeciesCsv, plantsFromPlacements } from '../src/data/plantParser.js';
import { buildSpeciesIndex, parseSynonymCsv } from '../src/data/speciesResolver.js';
import { checkPreserved, migrateHistoryFile, migrateHistoryToPlacements } from '../tools/migrate-history-placements.mjs';

const species = parseSpeciesCsv(readFileSync(new URL('../plants.csv', import.meta.url), 'utf8'));
const synonyms = parseSynonymCsv(readFileSync(new URL('../catalog/species-synonyms.csv', import.meta.url), 'utf8'));
const index = buildSpeciesIndex(species, synonyms);
const holly = species.find((entry) => entry.speciesId === 'yaupon-holly');
const sumac = species.find((entry) => entry.speciesId === 'fragrant-sumac');

/** A legacy history: full plant objects, a name-only snapshot, and a stray unresolvable row. */
function legacyHistory() {
  const full = (entry, id, x, y) => ({ ...createPlantFromSpecies(entry, { id, x, y }), speciesEpithet: 'x' });
  return {
    entries: [
      { id: 'e0', timestamp: '2026-01-01T00:00:00Z', description: 'Initial layout', plants: [full(holly, 'h1', 1, 2)] },
      {
        id: 'e1',
        timestamp: '2026-01-02T00:00:00Z',
        description: 'Added sumac',
        plants: [full(holly, 'h1', 1, 2), { id: 's1', botanicalName: 'Rhus trilobata', width: 9, x: 3.333, y: 4 }],
      },
      { id: 'e2', timestamp: '2026-01-03T00:00:00Z', description: 't', plants: [{ id: 'a', botanicalName: 'X', x: 1, y: 2 }] },
      { id: 'e3', timestamp: '2026-01-04T00:00:00Z', description: 'Removed everything', plants: [] },
    ],
    cursor: 1,
  };
}

test('every snapshot becomes a placement; entries, their fields, their order and the cursor are kept', () => {
  const before = legacyHistory();
  const result = migrateHistoryToPlacements(before, index);
  assert.equal(result.changed, true);
  assert.deepStrictEqual(checkPreserved(before, result.history), []);
  assert.deepStrictEqual(before, legacyHistory(), 'the input is not mutated');
  assert.equal(result.history.cursor, 1);
  assert.deepStrictEqual(result.history.entries.map((e) => e.description), ['Initial layout', 'Added sumac', 't', 'Removed everything']);
  assert.deepStrictEqual(result.history.entries[1].plants, [
    { id: 'h1', speciesId: 'yaupon-holly', x: 1, y: 2 },
    { id: 's1', speciesId: 'fragrant-sumac', x: 3.333, y: 4 },
  ]);
  assert.equal(result.resolvedByName, 1);
  // The unresolvable stray row is kept verbatim and reported, never dropped.
  assert.deepStrictEqual(result.history.entries[2].plants, [{ id: 'a', botanicalName: 'X', x: 1, y: 2 }]);
  assert.equal(result.verbatim.length, 1);
  assert.match(result.verbatim[0], /entry 2 \("t"\), plant a: "X"/);
});

test('migrated entries render exactly the plants the legacy entries did', () => {
  const before = legacyHistory();
  const after = migrateHistoryToPlacements(before, index).history;
  before.entries.forEach((entry, i) => {
    assert.deepStrictEqual(
      plantsFromPlacements(after.entries[i].plants, species, { synonyms }),
      plantsFromPlacements(entry.plants, species, { synonyms }),
      `entry ${i}`
    );
  });
});

test('a second run is a no-op', () => {
  const once = migrateHistoryToPlacements(legacyHistory(), index).history;
  const twice = migrateHistoryToPlacements(once, index);
  assert.equal(twice.changed, false);
  assert.deepStrictEqual(twice.history, once);
});

test('checkPreserved catches a lost entry, a changed description and a moved cursor', () => {
  const before = legacyHistory();
  const after = migrateHistoryToPlacements(before, index).history;
  assert.match(checkPreserved(before, { ...after, entries: after.entries.slice(1) }).join(), /entry count/);
  assert.match(checkPreserved(before, { ...after, cursor: 0 }).join(), /cursor/);
  const renamed = structuredClone(after);
  renamed.entries[0].description = 'other';
  assert.match(checkPreserved(before, renamed).join(), /entry 0: its own fields changed/);
});

test('on disk: dry run writes nothing; a real run backs up and replaces; a rerun touches nothing', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'migrate-history-'));
  try {
    const file = path.join(dir, 'layout-history.json');
    const original = JSON.stringify(legacyHistory(), null, 2);
    writeFileSync(file, original);

    const dry = migrateHistoryFile(file, index, { dryRun: true, stamp: 's1' });
    assert.equal(dry.status, 'would-migrate');
    assert.equal(readFileSync(file, 'utf8'), original);
    assert.deepStrictEqual(readdirSync(dir), ['layout-history.json']);

    const real = migrateHistoryFile(file, index, { stamp: 's1' });
    assert.equal(real.status, 'migrated');
    assert.ok(real.sizeAfter < real.sizeBefore);
    assert.equal(readFileSync(`${file}.bak-s1`, 'utf8'), original);
    const migrated = JSON.parse(readFileSync(file, 'utf8'));
    migrated.entries.forEach((entry) => entry.plants.forEach((plant) => {
      if (plant.speciesId) assert.deepStrictEqual(Object.keys(plant), ['id', 'speciesId', 'x', 'y']);
    }));

    const rerun = migrateHistoryFile(file, index, { stamp: 's2' });
    assert.equal(rerun.status, 'already');
    assert.deepStrictEqual(readdirSync(dir).sort(), ['layout-history.json', 'layout-history.json.bak-s1']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
