import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openClaimsStore, createSchema } from '../tools/claims/claimsStore.js';
import {
  buildPlantsCsv,
  PLANTS_CSV_HEADER,
  validateAgainstParser,
  diffAgainstCommitted,
  writePlantsCsvExport,
} from '../tools/claims/exportPlantsCsv.js';
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

// --- nl-scx.15: validate against the parser design.html loads, and never
// silently overwrite a differing plants.csv. -------------------------------

function tempCsvPath() {
  const dir = mkdtempSync(join(tmpdir(), 'claims-export-guard-test-'));
  return join(dir, 'plants.csv');
}

test('validateAgainstParser accepts a clean export', () => {
  const db = makeStore();
  const speciesId = insertTaxon(db, { name: 'Passiflora incarnata' });
  insertClaim(db, { speciesId, field: 'sun_pref', value: 'part-sun', source: 'usda-plants-characteristics' });
  const identityRows = [{ id: 'x', common_name: 'X', botanical_name: 'Passiflora incarnata' }];

  const { csvText } = buildPlantsCsv(db, identityRows);
  assert.deepEqual(validateAgainstParser(csvText), []);
});

test('validateAgainstParser reports every offending cell, not just the first', () => {
  const db = makeStore();
  const a = insertTaxon(db, { name: 'Passiflora incarnata' });
  const b = insertTaxon(db, { name: 'Ilex vomitoria' });
  // sun_pref is a single value on a scale; a list is exactly what nl-scx.15
  // found the store holding and the parser rejects with a LayoutDataError.
  insertClaim(db, { speciesId: a, field: 'sun_pref', value: 'full-sun,part-sun', source: 'npin' });
  // soil_pref is a set, but every member must be a known soil.
  insertClaim(db, { speciesId: b, field: 'soil_pref', value: 'peaty', source: 'npin' });
  const identityRows = [
    { id: 'passionflower', common_name: 'X', botanical_name: 'Passiflora incarnata' },
    { id: 'yaupon', common_name: 'Y', botanical_name: 'Ilex vomitoria' },
  ];

  const { csvText } = buildPlantsCsv(db, identityRows);
  const errors = validateAgainstParser(csvText);
  assert.equal(errors.length, 2);
  const bySpecies = Object.fromEntries(errors.map((e) => [e.id, e]));
  assert.equal(bySpecies.passionflower.field, 'sun_pref');
  assert.equal(bySpecies.passionflower.value, 'full-sun,part-sun');
  assert.equal(bySpecies.yaupon.field, 'soil_pref');
  assert.equal(bySpecies.yaupon.value, 'peaty');
});

test('writePlantsCsvExport refuses to write any row when validation fails, force or not', () => {
  const db = makeStore();
  const speciesId = insertTaxon(db, { name: 'Passiflora incarnata' });
  insertClaim(db, { speciesId, field: 'sun_pref', value: 'full-sun,part-sun', source: 'npin' });
  const identityRows = [{ id: 'x', common_name: 'X', botanical_name: 'Passiflora incarnata' }];
  const { csvText } = buildPlantsCsv(db, identityRows);

  const outPath = tempCsvPath();
  writeFileSync(outPath, 'id,common_name,botanical_name\nx,X,Passiflora incarnata\n'); // pre-existing, distinct file

  for (const force of [false, true]) {
    const result = writePlantsCsvExport({ csvText, outPath, protectedPath: outPath, force });
    assert.equal(result.written, false);
    assert.equal(result.validationErrors.length, 1);
    assert.equal(result.validationErrors[0].field, 'sun_pref');
    // The diff against the protected path is computed regardless — a caller
    // refused for bad values still sees what else changed.
    assert.notEqual(result.diff, null);
    // No partial write: the file on disk is untouched.
    assert.equal(readFileSync(outPath, 'utf8'), 'id,common_name,botanical_name\nx,X,Passiflora incarnata\n');
  }
});

test('writePlantsCsvExport refuses when a blank cell gains a value, not only when a value is lost', () => {
  const db = makeStore();
  const speciesId = insertTaxon(db, { name: 'Passiflora incarnata' });
  insertClaim(db, { speciesId, field: 'height_ft', value: '20', source: 'usda-plants-characteristics' });
  const identityRows = [{ id: 'x', common_name: 'X', botanical_name: 'Passiflora incarnata' }];
  const { csvText } = buildPlantsCsv(db, identityRows);

  const protectedPath = tempCsvPath();
  // Committed height_ft is blank; the export would fill it. No value is lost,
  // but the file still differs and must still be refused.
  const committed = `${PLANTS_CSV_HEADER.join(',')}\nx,X,Passiflora incarnata,,,,,,,,,,,\n`;
  writeFileSync(protectedPath, committed);

  const result = writePlantsCsvExport({ csvText, outPath: protectedPath, protectedPath });
  assert.equal(result.written, false);
  assert.equal(result.diff.changed, true);
  const heightCol = result.diff.perColumn.find((c) => c.column === 'height_ft');
  assert.deepEqual(heightCol, { column: 'height_ft', changed: 1, blanked: 0, filled: 1, total: 1 });
  assert.equal(readFileSync(protectedPath, 'utf8'), committed); // untouched
});

test('writePlantsCsvExport refuses a clean export that differs from the protected path, and reports a per-column diff', () => {
  const db = makeStore();
  const speciesId = insertTaxon(db, { name: 'Passiflora incarnata' });
  insertClaim(db, { speciesId, field: 'height_ft', value: '20', source: 'usda-plants-characteristics' });
  const identityRows = [{ id: 'x', common_name: 'X', botanical_name: 'Passiflora incarnata' }];
  const { csvText } = buildPlantsCsv(db, identityRows);

  const protectedPath = tempCsvPath();
  const committed = `${PLANTS_CSV_HEADER.join(',')}\nx,X,Passiflora incarnata,,,,,,,,,10,,\n`;
  writeFileSync(protectedPath, committed);

  const result = writePlantsCsvExport({ csvText, outPath: protectedPath, protectedPath });
  assert.equal(result.written, false);
  assert.equal(result.validationErrors.length, 0);
  assert.equal(result.diff.changed, true);
  const heightCol = result.diff.perColumn.find((c) => c.column === 'height_ft');
  assert.deepEqual(heightCol, { column: 'height_ft', changed: 1, blanked: 0, filled: 0, total: 1 });
  assert.equal(readFileSync(protectedPath, 'utf8'), committed); // untouched
});

test('writePlantsCsvExport writes when --force is given, and when writing to a different path', () => {
  const db = makeStore();
  const speciesId = insertTaxon(db, { name: 'Passiflora incarnata' });
  insertClaim(db, { speciesId, field: 'height_ft', value: '20', source: 'usda-plants-characteristics' });
  const identityRows = [{ id: 'x', common_name: 'X', botanical_name: 'Passiflora incarnata' }];
  const { csvText } = buildPlantsCsv(db, identityRows);

  const protectedPath = tempCsvPath();
  const committed = `${PLANTS_CSV_HEADER.join(',')}\nx,X,Passiflora incarnata,,,,,,,,,10,,\n`;
  writeFileSync(protectedPath, committed);

  const forced = writePlantsCsvExport({ csvText, outPath: protectedPath, protectedPath, force: true });
  assert.equal(forced.written, true);
  assert.equal(readFileSync(protectedPath, 'utf8'), csvText);

  writeFileSync(protectedPath, committed); // reset
  const elsewherePath = tempCsvPath();
  const elsewhere = writePlantsCsvExport({ csvText, outPath: elsewherePath, protectedPath });
  assert.equal(elsewhere.written, true);
  assert.equal(readFileSync(elsewherePath, 'utf8'), csvText);
  assert.equal(readFileSync(protectedPath, 'utf8'), committed); // still untouched
});

test('writePlantsCsvExport allows the write when the export matches the committed file exactly', () => {
  const db = makeStore();
  const speciesId = insertTaxon(db, { name: 'Passiflora incarnata' });
  insertClaim(db, { speciesId, field: 'height_ft', value: '20', source: 'usda-plants-characteristics' });
  const identityRows = [{ id: 'x', common_name: 'X', botanical_name: 'Passiflora incarnata' }];
  const { csvText } = buildPlantsCsv(db, identityRows);

  const protectedPath = tempCsvPath();
  writeFileSync(protectedPath, csvText); // already up to date

  const result = writePlantsCsvExport({ csvText, outPath: protectedPath, protectedPath });
  assert.equal(result.written, true);
  assert.equal(result.diff.changed, false);
});

test('diffAgainstCommitted keys by id, not row position, and reports added/removed ids', () => {
  const exported = `${PLANTS_CSV_HEADER.join(',')}\na,A,Species a,,,,,,,,,5,,\nc,C,Species c,,,,,,,,,,,\n`;
  const committed = `${PLANTS_CSV_HEADER.join(',')}\nb,B,Species b,,,,,,,,,,,\na,A,Species a,,,,,,,,,3,,\n`;

  const diff = diffAgainstCommitted(exported, committed);
  assert.deepEqual(diff.addedIds, ['c']);
  assert.deepEqual(diff.removedIds, ['b']);
  const heightCol = diff.perColumn.find((c) => c.column === 'height_ft');
  assert.deepEqual(heightCol, { column: 'height_ft', changed: 1, blanked: 0, filled: 0, total: 1 });
});
