// nl-3s5.21: plants.csv holds identity and claim-backed botany only; how the
// design tool draws each species is an authored table, plant-drawing.csv.
// These tests pin that the split changed nothing a yard shows, and the parse
// policy for the drawing join and the multi-value site fields.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DRAWING_COLUMNS,
  LayoutDataError,
  createPlantFromSpecies,
  parseSpeciesCsv,
} from '../src/data/plantParser.js';
import { PLANTS_CSV_HEADER } from '../tools/claims/exportPlantsCsv.js';
import { parseCsv } from '../src/data/csvLoader.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const PLANTS_CSV = readFileSync(`${REPO_ROOT}plants.csv`, 'utf8');
const DRAWING_CSV = readFileSync(`${REPO_ROOT}plant-drawing.csv`, 'utf8');

// The equivalence test below is a frozen proof of the split, not a live
// invariant: later catalog edits (a new species, a corrected height) must not
// turn it red. So both sides come from git once the split is committed: the
// commit that added plant-drawing.csv, against its parent. Until that commit
// exists (the split still uncommitted) it compares the last pre-split commit
// with the working tree. The live invariants (one drawing row per id, the
// headers, no column in both files) are the other tests in this file.
const PRE_SPLIT_COMMIT = '2012c25';
const git = (...args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
const SPLIT_COMMIT = git('log', '--diff-filter=A', '--format=%H', '--', 'plant-drawing.csv').trim().split('\n').pop();
const COMBINED_CSV = git('show', `${SPLIT_COMMIT ? `${SPLIT_COMMIT}^` : PRE_SPLIT_COMMIT}:plants.csv`);
const SPLIT_PLANTS_CSV = SPLIT_COMMIT ? git('show', `${SPLIT_COMMIT}:plants.csv`) : PLANTS_CSV;
const SPLIT_DRAWING_CSV = SPLIT_COMMIT ? git('show', `${SPLIT_COMMIT}:plant-drawing.csv`) : DRAWING_CSV;

/** The one intended change: soil_pref's comma-joined string is now an array. */
function soilAsArray(value) {
  return String(value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

test('every species renders the same plant from the old combined CSV and from plants.csv + plant-drawing.csv', () => {
  // The combined file parses through the legacy path (no drawing table given),
  // exactly as every yard was drawn before the split.
  const before = parseSpeciesCsv(COMBINED_CSV);
  const after = parseSpeciesCsv(SPLIT_PLANTS_CSV, SPLIT_DRAWING_CSV);
  assert.deepEqual(
    after.map((entry) => entry.id),
    before.map((entry) => entry.id),
    'same species, same order'
  );
  assert.ok(before.length > 50, 'the fixture really is the catalog');

  const placement = { id: 'p1', speciesId: 'ignored', x: 3, y: 4, status: 'planned' };
  before.forEach((oldEntry, idx) => {
    const newEntry = after[idx];
    assert.deepEqual(newEntry, { ...oldEntry, soilPref: soilAsArray(oldEntry.soilPref) }, `${oldEntry.id}: species entry`);
    const oldPlant = createPlantFromSpecies(oldEntry, placement);
    const newPlant = createPlantFromSpecies(newEntry, placement);
    assert.deepEqual(newPlant, { ...oldPlant, soilPref: soilAsArray(oldPlant.soilPref) }, `${oldEntry.id}: plant`);
  });
});

test('the split kept every pre-split column, each in exactly one of the two files', () => {
  const [combinedHeader] = parseCsvHeader(COMBINED_CSV);
  const [splitPlantsHeader] = parseCsvHeader(SPLIT_PLANTS_CSV);
  const [splitDrawingHeader] = parseCsvHeader(SPLIT_DRAWING_CSV);
  assert.deepEqual(
    [...combinedHeader].sort(),
    [...splitPlantsHeader, ...splitDrawingHeader.filter((col) => col !== 'id' && col !== 'source')].sort(),
    'no pre-split column was lost'
  );
  const [plantsHeader] = parseCsvHeader(PLANTS_CSV);
  const [drawingHeader] = parseCsvHeader(DRAWING_CSV);
  assert.deepEqual(plantsHeader, PLANTS_CSV_HEADER, 'plants.csv is exactly what the claim-store export writes');
  assert.deepEqual(drawingHeader, ['id', ...DRAWING_COLUMNS, 'source']);
  assert.deepEqual(
    PLANTS_CSV_HEADER.filter((col) => DRAWING_COLUMNS.includes(col)),
    [],
    'no column has two homes'
  );
});

test('plant-drawing.csv has exactly one row per plants.csv species, in the same order', () => {
  const speciesIds = parseCsv(PLANTS_CSV).map((row) => row.id);
  const drawingIds = parseCsv(DRAWING_CSV).map((row) => row.id);
  assert.deepEqual(drawingIds, speciesIds);
});

function parseCsvHeader(text) {
  return [Object.keys(parseCsv(text)[0])];
}

// --- the drawing join -------------------------------------------------------

const SPECIES = [
  'id,common_name,botanical_name,sun_pref,water_pref,soil_pref',
  'a,Ay,Genus alpha,full-sun,low,"sandy,loamy"',
  'b,Bee,Genus beta,,,',
].join('\n');
const DRAW_HEADER = `id,${DRAWING_COLUMNS.join(',')},source`;
const drawRow = (id, source = 'someone') =>
  `${id},#112233,,,,,,umbel,5,upper,${source}`;

test('the drawing table supplies the drawing attributes', () => {
  const [a] = parseSpeciesCsv(SPECIES, [DRAW_HEADER, drawRow('a'), drawRow('b')].join('\n'));
  assert.equal(a.flowerColor, '#112233');
  assert.equal(a.inflorescence, 'umbel/head');
  assert.equal(a.flowerCountHint, 5);
  assert.equal(a.flowerZone, 'upper');
});

test('a species with no drawing row is refused, not drawn in fallback colours', () => {
  assert.throws(
    () => parseSpeciesCsv(SPECIES, [DRAW_HEADER, drawRow('a')].join('\n')),
    (err) => err instanceof LayoutDataError && /no row for "b"/.test(err.message)
  );
});

test('a drawing row for an unknown species, a repeated one, or one with no source is refused', () => {
  const cases = [
    [[drawRow('a'), drawRow('b'), drawRow('zz')], /"zz", which is not a plants.csv species id/],
    [[drawRow('a'), drawRow('a'), drawRow('b')], /Duplicate species id "a" in plant-drawing.csv/],
    [[drawRow('a'), drawRow('b', '')], /\(b\) has no source/],
  ];
  cases.forEach(([rows, message]) => {
    assert.throws(
      () => parseSpeciesCsv(SPECIES, [DRAW_HEADER, ...rows].join('\n')),
      (err) => err instanceof LayoutDataError && message.test(err.message),
      String(message)
    );
  });
});

test('plants.csv carrying a drawing column alongside the drawing table is refused', () => {
  const withColour = SPECIES.replace('soil_pref', 'soil_pref,flower_color').replace(/\n(.*)/g, '\n$1,');
  assert.throws(
    () => parseSpeciesCsv(withColour, [DRAW_HEADER, drawRow('a'), drawRow('b')].join('\n')),
    (err) => err instanceof LayoutDataError && /flower_color; those belong in plant-drawing.csv only/.test(err.message)
  );
});

// --- multi-value and vocabulary-checked site fields --------------------------

const one = (sun, water, soil) =>
  parseSpeciesCsv(`id,botanical_name,sun_pref,water_pref,soil_pref\nx,Genus x,${sun},${water},${soil}`)[0];

test('soil_pref is parsed once into an array; blank is an empty array', () => {
  assert.deepEqual(one('', '', '"sandy, Loamy,clay"').soilPref, ['sandy', 'loamy', 'clay']);
  assert.deepEqual(one('', '', 'clay-loam').soilPref, ['clay-loam']);
  assert.deepEqual(one('', '', '').soilPref, []);
});

test('sun and water stay single values on their scale, checked against SITE_VOCABULARY', () => {
  const entry = one('Full-Sun', 'medium', 'clay');
  assert.equal(entry.sunPref, 'full-sun');
  assert.equal(entry.waterPref, 'medium');
  assert.equal(one('', '', '').sunPref, '');
});

test('an unknown site value is a LayoutDataError naming the species, never silently kept or dropped', () => {
  const cases = [
    [() => one('', '', '"sandy,limestone"'), /x: soil_pref "sandy,limestone" has "limestone"/],
    [() => one('', '', 'sandy/loamy'), /has "sandy\/loamy"/],
    [() => one('', '', '"clay,clay"'), /lists "clay" twice/],
    [() => one('sunny', '', ''), /sun_pref "sunny" is not one of shade, part-sun, full-sun/],
    [() => one('"full-sun,part-sun"', '', ''), /a list is not supported/],
    [() => one('', 'wet', ''), /water_pref "wet"/],
  ];
  cases.forEach(([parse, message]) => {
    assert.throws(parse, (err) => err instanceof LayoutDataError && message.test(err.message), String(message));
  });
});
