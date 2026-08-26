import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STATUSES, analyzeEcology, buildEcologyContext } from '../src/analysis/ecology.js';
import { describeMonths, monthName } from '../src/analysis/months.js';
import { parseSpeciesCsv, createPlantFromSpecies } from '../src/data/plantParser.js';

const CATALOG = parseSpeciesCsv(
  readFileSync(fileURLToPath(new URL('../plants.csv', import.meta.url)), 'utf8')
);

/** Place one of each named species, so a fixture reads as a list of common names. */
function place(...botanicalNames) {
  return botanicalNames.map((name, idx) => {
    const entry = CATALOG.find((row) => row.botanicalName === name);
    assert.ok(entry, `plants.csv has no ${name}`);
    return createPlantFromSpecies(entry, { id: `p${idx}`, x: idx, y: 0 });
  });
}

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

/** A minimal species row, for the cases no catalog species happens to cover. */
function synthetic(botanicalName) {
  return {
    id: botanicalName,
    botanicalName,
    botanicalKey: botanicalName.toLowerCase(),
    speciesEpithet: botanicalName.split(' ')[1],
    commonName: botanicalName,
    growthShape: 'mound',
    growingMonths: [],
    floweringMonths: [],
    fruitMonths: [],
    fruitLoad: '',
    width: 2,
    height: 2,
  };
}

function run(plants, extra = {}) {
  const results = analyzeEcology(
    buildEcologyContext({ plants, species: CATALOG, ...extra })
  );
  return Object.fromEntries(results.map((result) => [result.id, result]));
}

test('describeMonths names runs the way a season is written, wrapping the year end', () => {
  assert.equal(describeMonths([10, 11, 12, 1, 2]), 'Oct-Feb');
  assert.equal(describeMonths([3]), 'Mar');
  assert.equal(describeMonths([1, 2, 6]), 'Jan-Feb, Jun');
  // A run that wraps the year end is one run, and reported from its true start.
  assert.equal(describeMonths([11, 12, 1, 5]), 'May, Nov-Jan');
  assert.equal(describeMonths([]), 'no months');
  assert.equal(describeMonths([1,2,3,4,5,6,7,8,9,10,11,12]), 'all year');
  assert.equal(monthName(12), 'Dec');
});

test('every result carries one of exactly four statuses', () => {
  const allowed = new Set(Object.values(STATUSES));
  const results = analyzeEcology(buildEcologyContext({ plants: place('Salvia farinacea'), species: CATALOG }));
  assert.equal(results.length, 3);
  results.forEach((result) => {
    assert.ok(allowed.has(result.status), `${result.id} returned "${result.status}"`);
    assert.ok(result.title && result.summary, `${result.id} needs a title and summary`);
    assert.ok(Array.isArray(result.findings) && Array.isArray(result.suggestions));
  });
});

test('an empty yard reports not-declared everywhere rather than throwing', () => {
  const results = analyzeEcology(buildEcologyContext({ plants: [], species: CATALOG }));
  results.forEach((result) => assert.equal(result.status, STATUSES.NOT_DECLARED, result.id));
});

test('a rule that throws becomes a not-declared row, never an exception', () => {
  const ctx = buildEcologyContext({ plants: place('Salvia farinacea'), species: CATALOG });
  Object.defineProperty(ctx, 'placedSpecies', {
    get() {
      throw new Error('boom');
    },
  });
  const results = analyzeEcology(ctx);
  results.forEach((result) => {
    assert.equal(result.status, STATUSES.NOT_DECLARED);
  });
  assert.match(results[0].summary, /boom/);
});

test('bloom succession counts species per month and only inside the growing window', () => {
  // Autumn sage blooms Mar-Nov and grows Mar-Dec, so December is bare and inside
  // the window; January and February are outside it and must not read as gaps.
  const result = run(place('Salvia farinacea'))['bloom-succession'];
  assert.equal(result.status, STATUSES.GAP);
  assert.ok(
    result.findings.some((f) => /outside every planted species/.test(f)),
    'dormant months are named as out of window, not counted as gaps'
  );
  assert.ok(result.suggestions.length, 'suggests catalog species covering the bare months');
});

test('bloom succession is thin, not a gap, when a month rests on one species', () => {
  // Hand-built rather than drawn from the catalog: the point is the boundary
  // between "covered" and "covered by one thing", which no real pair happens to sit on.
  const evergreen = { ...synthetic('Aaa aaa'), growingMonths: ALL_MONTHS, floweringMonths: ALL_MONTHS };
  const nearly = {
    ...synthetic('Bbb bbb'),
    growingMonths: ALL_MONTHS,
    floweringMonths: ALL_MONTHS.filter((m) => m !== 12),
  };
  const both = [evergreen, nearly].map((entry, idx) =>
    createPlantFromSpecies(entry, { id: `s${idx}`, x: idx, y: 0 })
  );
  const result = run(both)['bloom-succession'];
  assert.equal(result.status, STATUSES.PARTIAL);
  assert.ok(result.findings.some((f) => /Only one species blooms in Dec/.test(f)));

  const result2 = run([both[0]])['bloom-succession'];
  assert.equal(result2.status, STATUSES.PARTIAL, 'one all-year bloomer is thin every month');
  const result3 = run(both.concat(
    createPlantFromSpecies({ ...synthetic('Ccc ccc'), growingMonths: ALL_MONTHS, floweringMonths: ALL_MONTHS }, { id: 's3', x: 3, y: 0 })
  ))['bloom-succession'];
  assert.equal(result3.status, STATUSES.OK);
  assert.match(result3.summary, /blooms every month/);
});

test('a wrap-around fruit range counts as winter food', () => {
  const winterFruiter = CATALOG.find((entry) => entry.botanicalName === 'Ilex vomitoria');
  assert.ok(winterFruiter.fruitMonths.includes(1), 'parseMonthField wraps 10-2 into January');
  assert.ok(winterFruiter.fruitMonths.includes(12));
});

test('bird food judges the Sep-Feb window, not the whole year', () => {
  // Passionflower fruits Jul-Oct: summer food only, so the winter months are bare.
  const summerOnly = run(place('Passiflora incarnata'))['bird-food'];
  assert.equal(summerOnly.status, STATUSES.GAP);
  assert.ok(summerOnly.findings.some((f) => /No fruit at all/.test(f)));

  const winter = run(place('Ilex vomitoria', 'Callicarpa americana', 'Rhus aromatica'))['bird-food'];
  assert.notEqual(winter.status, STATUSES.GAP);
});

test('bird food ignores a species whose fruit load is none', () => {
  const none = CATALOG.filter((entry) => entry.fruitLoad === 'none' && entry.fruitMonths.length);
  if (!none.length) return; // the catalog may carry no such row; the guard still matters
  const result = run(place(none[0].botanicalName))['bird-food'];
  assert.equal(result.status, STATUSES.GAP);
});

test('vertical layers reports empty strata and suggests fillers for them', () => {
  const groundOnly = run(place('Calyptocarpus vialis'))['vertical-layers'];
  assert.equal(groundOnly.status, STATUSES.GAP);
  assert.ok(groundOnly.findings.some((f) => /canopy: 0 species/.test(f)));
  assert.ok(groundOnly.suggestions.length);

  const layered = run(
    place("Cercis canadensis var. texensis 'Oklahoma'", 'Sorghastrum nutans', 'Salvia farinacea', 'Calyptocarpus vialis')
  )['vertical-layers'];
  assert.equal(layered.status, STATUSES.OK);
  assert.deepEqual(layered.suggestions, [], 'nothing to suggest when every layer is filled');
});

test('layers are counted by species, so a big drift of one plant fills one layer only', () => {
  const drift = place('Calyptocarpus vialis');
  const many = Array.from({ length: 19 }, (_, i) => ({ ...drift[0], id: `d${i}` }));
  const result = run(many)['vertical-layers'];
  assert.ok(result.findings.some((f) => /ground layer: 1 species/.test(f)));
});
