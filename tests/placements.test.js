import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PLACEMENT_CORE_KEYS,
  SPECIES_ATTRIBUTE_KEYS,
  sameLayout,
  toPlacement,
  toPlacementEntry,
  toPlacements,
} from '../src/data/placements.js';
import { buildPlantsFromCsv, createPlantFromSpecies, parseSpeciesCsv } from '../src/data/plantParser.js';
import { buildLayoutCsv } from '../src/data/layoutExporter.js';
import { reconcileHistoryWithLayout } from '../src/history/reconcileLayout.js';

const PLANTS_CSV = readFileSync(new URL('../plants.csv', import.meta.url), 'utf8');
const species = parseSpeciesCsv(PLANTS_CSV);
const holly = species.find((entry) => entry.speciesId === 'yaupon-holly');
const sumac = species.find((entry) => entry.speciesId === 'fragrant-sumac');

test('every key createPlantFromSpecies emits is either a placement key or a listed species attribute', () => {
  // If this fails, a new attribute was added to createPlantFromSpecies without
  // adding it to SPECIES_ATTRIBUTE_KEYS, and it would leak into history.
  const known = new Set([...PLACEMENT_CORE_KEYS, ...SPECIES_ATTRIBUTE_KEYS]);
  species.forEach((entry) => {
    Object.keys(createPlantFromSpecies(entry, { id: 'p', x: 1, y: 2 })).forEach((key) => {
      assert.ok(known.has(key), `createPlantFromSpecies emits "${key}", which placements.js does not classify`);
    });
  });
});

test('a full plant reduces to exactly { id, speciesId, x, y }', () => {
  const plant = createPlantFromSpecies(holly, { id: 'holly-1', x: 3.25, y: 4 });
  assert.deepStrictEqual(toPlacement(plant), { id: 'holly-1', speciesId: 'yaupon-holly', x: 3.25, y: 4 });
  // A legacy snapshot's speciesEpithet goes too.
  assert.deepStrictEqual(toPlacement({ ...plant, speciesEpithet: 'vomitoria' }), { id: 'holly-1', speciesId: 'yaupon-holly', x: 3.25, y: 4 });
});

test('unknown optional fields ride through untouched, and the input is never shared', () => {
  const source = { nursery: 'Example', receipt: [1, 2] };
  const plant = { ...createPlantFromSpecies(holly, { id: 'h', x: 0, y: 0 }), status: 'planted', source };
  const placement = toPlacement(plant);
  assert.deepStrictEqual(placement, { id: 'h', speciesId: 'yaupon-holly', x: 0, y: 0, status: 'planted', source });
  assert.notEqual(placement.source, source);
});

test('a snapshot with no speciesId is kept verbatim, not trimmed', () => {
  const stray = { id: 'a', botanicalName: 'X', x: 1, y: 2 };
  assert.deepStrictEqual(toPlacement(stray), stray);
  const legacy = { id: 'b', botanicalName: 'Foo americana', width: 3, growingMonths: [3, 4], x: 0, y: 0 };
  assert.deepStrictEqual(toPlacement(legacy), legacy);
  assert.notEqual(toPlacement(legacy), legacy);
});

test('toPlacements and toPlacementEntry keep an entry\'s own fields and order', () => {
  const entry = { id: 'e1', timestamp: 't', description: 'moved', plants: [createPlantFromSpecies(sumac, { id: 's', x: 1, y: 1 })], extra: 1 };
  const out = toPlacementEntry(entry);
  assert.deepStrictEqual(Object.keys(out), Object.keys(entry));
  assert.deepStrictEqual(out.plants, [{ id: 's', speciesId: 'fragrant-sumac', x: 1, y: 1 }]);
  assert.deepStrictEqual(toPlacements(null), []);
});

test('sameLayout agrees with comparing the layout CSV text, which it replaces', () => {
  const plants = [
    createPlantFromSpecies(holly, { id: 'h', x: 12.3456789, y: 0.1 + 0.2 }),
    createPlantFromSpecies(sumac, { id: 's', x: 1, y: 2 }),
  ];
  // What the CSV reloads as: coordinates rounded to the file's three decimals.
  const reloaded = buildPlantsFromCsv(PLANTS_CSV, buildLayoutCsv(plants));
  assert.equal(reloaded[0].x, 12.346);
  assert.ok(sameLayout(toPlacements(plants), reloaded), 'full precision in history matches the rounded file');

  const cases = [
    [[{ id: 'h', speciesId: 'yaupon-holly', x: 12.3456, y: 1 }], [{ id: 'h', speciesId: 'yaupon-holly', x: 12.3464, y: 1 }]],
    [[{ id: 'h', speciesId: 'yaupon-holly', x: 12.3456, y: 1 }], [{ id: 'h', speciesId: 'yaupon-holly', x: 12.3446, y: 1 }]],
    [[{ id: 'h', speciesId: 'yaupon-holly', x: 1, y: 1 }], [{ id: 'h', speciesId: 'fragrant-sumac', x: 1, y: 1 }]],
    [[{ id: 'h', speciesId: 'yaupon-holly', x: 1, y: 1 }], [{ id: 'h2', speciesId: 'yaupon-holly', x: 1, y: 1 }]],
    [toPlacements(plants), toPlacements([...plants].reverse())],
    [[], []],
  ];
  cases.forEach(([a, b]) => {
    assert.equal(sameLayout(a, b), buildLayoutCsv(a) === buildLayoutCsv(b), JSON.stringify([a, b]));
  });
});

test('sameLayout: an empty layout matches an empty entry; a plant without speciesId never matches', () => {
  assert.equal(sameLayout([], buildPlantsFromCsv(PLANTS_CSV, buildLayoutCsv([]))), true);
  const stray = [{ id: 'a', botanicalName: 'X', x: 1, y: 2 }];
  assert.equal(sameLayout(stray, stray), false);
  assert.equal(sameLayout(undefined, []), false);
});

test('reconcile: the entry at the cursor is the layout file', () => {
  const a = [{ id: 'h', speciesId: 'yaupon-holly', x: 1, y: 1 }];
  const b = [{ id: 'h', speciesId: 'yaupon-holly', x: 2, y: 2 }];
  const entries = [{ id: 'e0', plants: a }, { id: 'e1', plants: b }];
  assert.deepStrictEqual(reconcileHistoryWithLayout(entries, 1, b), { entries, cursor: 1, verdict: 'current' });
  assert.deepStrictEqual(reconcileHistoryWithLayout([], -1, b), { entries: [], cursor: -1, verdict: 'empty' });
});

test('reconcile: another entry is the layout file, so the cursor moves and redo is kept', () => {
  const a = [{ id: 'h', speciesId: 'yaupon-holly', x: 1, y: 1 }];
  const b = [{ id: 'h', speciesId: 'yaupon-holly', x: 2, y: 2 }];
  const entries = [{ id: 'e0', plants: a }, { id: 'e1', plants: b }, { id: 'e2', plants: [] }];
  const result = reconcileHistoryWithLayout(entries, 2, a);
  assert.equal(result.verdict, 'moved');
  assert.equal(result.cursor, 0);
  assert.equal(result.entries.length, 3);
});

test('reconcile: no entry is the layout file, so history up to the cursor is kept for the caller to append to', () => {
  const a = [{ id: 'h', speciesId: 'yaupon-holly', x: 1, y: 1 }];
  const edited = [{ id: 'h', speciesId: 'yaupon-holly', x: 9, y: 9 }];
  const entries = [{ id: 'e0', plants: a }, { id: 'e1', plants: [{ id: 'a', botanicalName: 'X', x: 1, y: 2 }] }, { id: 'e2', plants: a }];
  const result = reconcileHistoryWithLayout(entries, 1, edited);
  assert.equal(result.verdict, 'diverged');
  assert.equal(result.cursor, 1);
  assert.deepStrictEqual(result.entries.map((e) => e.id), ['e0', 'e1']);
});
