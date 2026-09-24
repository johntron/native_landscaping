import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openClaimsStore, createSchema } from '../tools/claims/claimsStore.js';
import { buildPlantsCsv, PLANTS_CSV_HEADER } from '../tools/claims/exportPlantsCsv.js';
import { DRAWING_COLUMNS } from '../src/data/plantParser.js';

function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'claims-export-test-'));
  return join(dir, 'claims.db');
}

function makeStore() {
  const db = openClaimsStore(tempDbPath());
  createSchema(db);
  return db;
}

function insertTaxon(db, { name, rank = 'species', parentId = null }) {
  const result = db
    .prepare('INSERT INTO taxa (scientific_name, rank, parent_id) VALUES (?, ?, ?)')
    .run(name, rank, parentId);
  return Number(result.lastInsertRowid);
}

function insertLicense(db, { source, grant, condition = null }) {
  const result = db
    .prepare('INSERT INTO licenses (source, "grant", condition) VALUES (?, ?, ?)')
    .run(source, grant, condition);
  return Number(result.lastInsertRowid);
}

function insertClaim(db, { speciesId, field, value, status = 'asserted', source, licenseId = null }) {
  db.prepare(
    `INSERT INTO claims (species_id, field, value, status, source, retrieved_at, license_id)
     VALUES (?, ?, ?, ?, ?, '2026-09-21T00:00:00Z', ?)`,
  ).run(speciesId, field, value, status, source, licenseId);
}

test('regenerating with no store changes produces a byte-identical file (determinism)', () => {
  const db = makeStore();
  const speciesId = insertTaxon(db, { name: 'Passiflora incarnata' });
  insertClaim(db, { speciesId, field: 'sun_pref', value: 'part-sun', source: 'usda-plants-characteristics' });
  const identityRows = [{ id: 'native-passionflower', common_name: 'Native passionflower', botanical_name: 'Passiflora incarnata' }];

  const first = buildPlantsCsv(db, identityRows);
  const second = buildPlantsCsv(db, identityRows);
  assert.equal(first.csvText, second.csvText);
});

test('an asserted claim resolved via precedence lands in the right column', () => {
  const db = makeStore();
  const speciesId = insertTaxon(db, { name: 'Passiflora incarnata' });
  const usdaLicense = insertLicense(db, { source: 'usda-plants', grant: 'unrestricted' });
  insertClaim(db, {
    speciesId,
    field: 'sun_pref',
    value: 'part-sun',
    source: 'usda-plants-characteristics',
    licenseId: usdaLicense,
  });
  const identityRows = [{ id: 'x', common_name: 'X', botanical_name: 'Passiflora incarnata' }];

  const { csvText } = buildPlantsCsv(db, identityRows);
  const [, dataLine] = csvText.trim().split('\n');
  const cells = dataLine.split(',');
  assert.equal(cells[PLANTS_CSV_HEADER.indexOf('sun_pref')], 'part-sun');
});

test('a review-status field lands as an empty cell, not a fabricated default', () => {
  const db = makeStore();
  const speciesId = insertTaxon(db, { name: 'Callicarpa americana' });
  // Two tied, disagreeing claims -> precedence.js resolves to {status: 'review'}.
  insertClaim(db, { speciesId, field: 'sun_pref', value: 'full-sun', source: 'npin' });
  insertClaim(db, { speciesId, field: 'sun_pref', value: 'part-sun', source: 'npin' });
  const identityRows = [{ id: 'x', common_name: 'X', botanical_name: 'Callicarpa americana' }];

  const { csvText } = buildPlantsCsv(db, identityRows);
  const [, dataLine] = csvText.trim().split('\n');
  const cells = dataLine.split(',');
  assert.equal(cells[PLANTS_CSV_HEADER.indexOf('sun_pref')], '');
});

test('an unknown-status claim is excluded, landing as an empty cell', () => {
  const db = makeStore();
  const speciesId = insertTaxon(db, { name: 'Symphoricarpos orbiculatus' });
  insertClaim(db, { speciesId, field: 'height_ft', value: null, status: 'unknown', source: 'usda-plants-characteristics' });
  const identityRows = [{ id: 'x', common_name: 'X', botanical_name: 'Symphoricarpos orbiculatus' }];

  const { csvText } = buildPlantsCsv(db, identityRows);
  const [, dataLine] = csvText.trim().split('\n');
  const cells = dataLine.split(',');
  assert.equal(cells[PLANTS_CSV_HEADER.indexOf('height_ft')], '');
});

test('commercial status read from config: flipping to commercial drops NPIN-sourced values from the export, leaves the claim in the store', () => {
  const db = makeStore();
  const speciesId = insertTaxon(db, { name: 'Passiflora incarnata' });
  const npinLicense = insertLicense(db, {
    source: 'npin',
    grant: 'personal-noncommercial',
    condition: 'void if project becomes commercial',
  });
  insertClaim(db, { speciesId, field: 'sun_pref', value: 'part-sun', source: 'npin', licenseId: npinLicense });
  const identityRows = [{ id: 'x', common_name: 'X', botanical_name: 'Passiflora incarnata' }];

  const nonCommercial = buildPlantsCsv(db, identityRows, { commercialStatus: 'non-commercial' });
  const nonCommercialCells = nonCommercial.csvText.trim().split('\n')[1].split(',');
  assert.equal(nonCommercialCells[PLANTS_CSV_HEADER.indexOf('sun_pref')], 'part-sun');

  const commercial = buildPlantsCsv(db, identityRows, { commercialStatus: 'commercial' });
  const commercialCells = commercial.csvText.trim().split('\n')[1].split(',');
  assert.equal(commercialCells[PLANTS_CSV_HEADER.indexOf('sun_pref')], '');

  // The underlying claim is untouched.
  const stillThere = db.prepare("SELECT value FROM claims WHERE species_id = ? AND field = 'sun_pref'").get(speciesId);
  assert.equal(stillThere.value, 'part-sun');
});

test('a claim with no license row publishes regardless of commercial status (fail-open)', () => {
  const db = makeStore();
  const speciesId = insertTaxon(db, { name: 'Passiflora incarnata' });
  insertClaim(db, { speciesId, field: 'sun_pref', value: 'part-sun', source: 'manual-correction', licenseId: null });
  const identityRows = [{ id: 'x', common_name: 'X', botanical_name: 'Passiflora incarnata' }];

  const { csvText } = buildPlantsCsv(db, identityRows, { commercialStatus: 'commercial' });
  const cells = csvText.trim().split('\n')[1].split(',');
  assert.equal(cells[PLANTS_CSV_HEADER.indexOf('sun_pref')], 'part-sun');
});

test('cultivar: own claim wins outright, even when it resolves blank, with no fallback to the parent', () => {
  const db = makeStore();
  const speciesId = insertTaxon(db, { name: 'Ilex vomitoria' });
  const cultivarId = insertTaxon(db, { name: "Ilex vomitoria 'Nana'", rank: 'cultivar', parentId: speciesId });
  insertClaim(db, { speciesId, field: 'height_ft', value: '45', source: 'usda-plants-characteristics' });
  // Cultivar has its own claims, but they tie -> review -> blank. Must NOT fall through to the species' 45.
  insertClaim(db, { speciesId: cultivarId, field: 'height_ft', value: '3', source: 'manual-correction' });
  insertClaim(db, { speciesId: cultivarId, field: 'height_ft', value: '4', source: 'manual-correction' });
  const identityRows = [{ id: 'x', common_name: 'X', botanical_name: "Ilex vomitoria 'Nana'" }];

  const { csvText } = buildPlantsCsv(db, identityRows);
  const cells = csvText.trim().split('\n')[1].split(',');
  assert.equal(cells[PLANTS_CSV_HEADER.indexOf('height_ft')], '');
});

test('cultivar: no own claim falls back to the parent species claim', () => {
  const db = makeStore();
  const speciesId = insertTaxon(db, { name: 'Ilex vomitoria' });
  const cultivarId = insertTaxon(db, { name: "Ilex vomitoria 'Nana'", rank: 'cultivar', parentId: speciesId });
  insertClaim(db, { speciesId, field: 'sun_pref', value: 'sun,part-shade,shade', source: 'npin' });
  const identityRows = [{ id: 'x', common_name: 'X', botanical_name: "Ilex vomitoria 'Nana'" }];

  const { csvText } = buildPlantsCsv(db, identityRows);
  assert.match(csvText, /"sun,part-shade,shade"/);
});

test('cultivar: own claim license-voided still blanks, no fallback to the parent', () => {
  const db = makeStore();
  const speciesId = insertTaxon(db, { name: 'Ilex vomitoria' });
  const cultivarId = insertTaxon(db, { name: "Ilex vomitoria 'Nana'", rank: 'cultivar', parentId: speciesId });
  const npinLicense = insertLicense(db, { source: 'npin', grant: 'personal-noncommercial', condition: 'void if commercial' });
  insertClaim(db, { speciesId, field: 'water_pref', value: 'low', source: 'usda-plants-characteristics' });
  insertClaim(db, { speciesId: cultivarId, field: 'water_pref', value: 'medium', source: 'npin', licenseId: npinLicense });
  const identityRows = [{ id: 'x', common_name: 'X', botanical_name: "Ilex vomitoria 'Nana'" }];

  const { csvText } = buildPlantsCsv(db, identityRows, { commercialStatus: 'commercial' });
  const cells = csvText.trim().split('\n')[1].split(',');
  assert.equal(cells[PLANTS_CSV_HEADER.indexOf('water_pref')], '');
});

test('a comma-bearing value is quoted, matching the current file convention', () => {
  const db = makeStore();
  const speciesId = insertTaxon(db, { name: 'Passiflora incarnata' });
  insertClaim(db, { speciesId, field: 'soil_pref', value: 'sandy,loamy', source: 'usda-plants-characteristics' });
  const identityRows = [{ id: 'x', common_name: 'X', botanical_name: 'Passiflora incarnata' }];

  const { csvText } = buildPlantsCsv(db, identityRows);
  assert.match(csvText, /"sandy,loamy"/);
});

test('an embedded newline is replaced with a space and logged', () => {
  const db = makeStore();
  const speciesId = insertTaxon(db, { name: 'Passiflora incarnata' });
  insertClaim(db, { speciesId, field: 'water_pref', value: 'medium\nish', source: 'manual-correction' });
  const identityRows = [{ id: 'native-passionflower', common_name: 'X', botanical_name: 'Passiflora incarnata' }];

  const { csvText, replacements } = buildPlantsCsv(db, identityRows);
  assert.ok(csvText.includes('medium ish'));
  assert.deepEqual(replacements, [{ id: 'native-passionflower', field: 'water_pref', kind: 'newline' }]);
  // Exactly two lines: header + one data row, so the scrub actually prevented a stray line.
  assert.equal(csvText.trim().split('\n').length, 2);
});

test('an embedded quote is replaced and logged', () => {
  const db = makeStore();
  const speciesId = insertTaxon(db, { name: 'Passiflora incarnata' });
  insertClaim(db, { speciesId, field: 'water_pref', value: 'the "best" plant', source: 'manual-correction' });
  const identityRows = [{ id: 'x', common_name: 'X', botanical_name: 'Passiflora incarnata' }];

  const { csvText, replacements } = buildPlantsCsv(db, identityRows);
  assert.ok(csvText.includes("the 'best' plant"));
  assert.deepEqual(replacements, [{ id: 'x', field: 'water_pref', kind: 'quote' }]);
});

test('a species absent from the claim store (no taxa row) exports identity columns with blank claim fields', () => {
  const db = makeStore();
  const identityRows = [{ id: 'ghost', common_name: 'Ghost plant', botanical_name: 'Nonexistus fabricatus' }];

  const { csvText } = buildPlantsCsv(db, identityRows);
  const cells = csvText.trim().split('\n')[1].split(',');
  assert.equal(cells[PLANTS_CSV_HEADER.indexOf('id')], 'ghost');
  assert.equal(cells[PLANTS_CSV_HEADER.indexOf('sun_pref')], '');
});

test('the header matches the committed plants.csv column order', () => {
  // Read from the file itself, so a column added to plants.csv (taxon_id,
  // nl-3s5.18) without teaching the exporter fails here instead of being
  // silently dropped by the next export.
  const committed = readFileSync(new URL('../plants.csv', import.meta.url), 'utf8')
    .split(/\r?\n/)[0]
    .split(',');
  assert.deepEqual(PLANTS_CSV_HEADER, committed);
});

test('taxon_id is the exported store\'s own taxa id, and blank without an exact taxa match', () => {
  const db = makeStore();
  const taxonId = insertTaxon(db, { name: 'Passiflora incarnata' });
  const identityRows = [
    { id: 'native-passionflower', common_name: 'Native passionflower', botanical_name: 'Passiflora incarnata' },
    { id: 'ghost', common_name: 'Ghost plant', botanical_name: 'Passiflora ghostii' },
  ];

  const { csvText } = buildPlantsCsv(db, identityRows);
  const [, linked, ghost] = csvText.trim().split('\n').map((line) => line.split(','));
  assert.equal(linked[PLANTS_CSV_HEADER.indexOf('taxon_id')], String(taxonId));
  assert.equal(ghost[PLANTS_CSV_HEADER.indexOf('taxon_id')], '');
});

test('the export writes no drawing column, even when the store holds a colour claim (nl-3s5.21)', () => {
  // plant-drawing.csv owns how a species is drawn. The store's USDA colour
  // claims stay in the store for checking; they never reach plants.csv.
  const db = makeStore();
  const speciesId = insertTaxon(db, { name: 'Passiflora incarnata' });
  insertClaim(db, { speciesId, field: 'flower_color', value: '#8f6fb3', source: 'usda-plants-characteristics' });
  const identityRows = [{ id: 'native-passionflower', common_name: 'Native passionflower', botanical_name: 'Passiflora incarnata' }];

  const { csvText } = buildPlantsCsv(db, identityRows);
  const [header, dataLine] = csvText.trim().split('\n');
  assert.deepEqual(header.split(',').filter((col) => DRAWING_COLUMNS.includes(col)), []);
  assert.ok(!dataLine.includes('#8f6fb3'));
});
