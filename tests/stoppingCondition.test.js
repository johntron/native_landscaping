import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openClaimsStore, createSchema } from '../tools/claims/claimsStore.js';
import { checkStoppingCondition, BLOCKING_FIELDS } from '../tools/claims/stoppingCondition.js';

function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'stopping-condition-test-'));
  return join(dir, 'claims.db');
}

function makeStore() {
  const db = openClaimsStore(tempDbPath());
  createSchema(db);
  return db;
}

function insertTaxon(db, { name, rank = 'species', parentId = null, usdaSymbol = null }) {
  const result = db
    .prepare('INSERT INTO taxa (scientific_name, rank, parent_id, usda_symbol) VALUES (?, ?, ?, ?)')
    .run(name, rank, parentId, usdaSymbol);
  return Number(result.lastInsertRowid);
}

function insertClaim(db, { speciesId, field, value, status = 'asserted', source = 'test-source' }) {
  db.prepare(
    `INSERT INTO claims (species_id, field, value, status, source, retrieved_at)
     VALUES (?, ?, ?, ?, ?, '2026-09-21T00:00:00Z')`,
  ).run(speciesId, field, value, status, source);
}

function addToPlantableCore(db, taxaId, source = 'plants.csv') {
  db.prepare('INSERT INTO plantable_core (taxa_id, source) VALUES (?, ?)').run(taxaId, source);
}

test('BLOCKING_FIELDS excludes genus (not a claims field) and includes width_ft per nl-scx.12 DESIGN', () => {
  assert.ok(!BLOCKING_FIELDS.includes('genus'));
  assert.ok(BLOCKING_FIELDS.includes('width_ft'));
  assert.ok(BLOCKING_FIELDS.includes('nativity_nctx'));
  assert.ok(BLOCKING_FIELDS.includes('county_presence_48113'));
});

test('a species with an asserted claim for every blocking field is fully sourced', () => {
  const db = makeStore();
  const id = insertTaxon(db, { name: 'Test speciesa' });
  addToPlantableCore(db, id);
  for (const field of BLOCKING_FIELDS) insertClaim(db, { speciesId: id, field, value: 'x' });

  const result = checkStoppingCondition(db);
  assert.equal(result.plantableSetSize, 1);
  assert.equal(result.totalCells, BLOCKING_FIELDS.length);
  assert.equal(result.sourced.length, BLOCKING_FIELDS.length);
  assert.equal(result.outstanding.length, 0);
  assert.equal(result.met, true);
});

test('an "unknown"-status claim counts as sourced, not outstanding — a source was checked and came back empty', () => {
  const db = makeStore();
  const id = insertTaxon(db, { name: 'Test speciesb' });
  addToPlantableCore(db, id);
  for (const field of BLOCKING_FIELDS) {
    insertClaim(db, { speciesId: id, field, value: null, status: 'unknown' });
  }
  const result = checkStoppingCondition(db);
  assert.equal(result.sourced.length, BLOCKING_FIELDS.length);
  assert.equal(result.outstanding.length, 0);
});

test('width_ft with zero claims is explained by the register, not outstanding', () => {
  const db = makeStore();
  const id = insertTaxon(db, { name: 'Test speciesc' });
  addToPlantableCore(db, id);
  for (const field of BLOCKING_FIELDS) {
    if (field === 'width_ft') continue; // deliberately no claim
    insertClaim(db, { speciesId: id, field, value: 'x' });
  }
  const result = checkStoppingCondition(db);
  assert.equal(result.outstanding.length, 0, 'width_ft should be explained, not outstanding');
  assert.equal(result.explained.length, 1);
  assert.equal(result.explained[0].field, 'width_ft');
  assert.equal(result.met, true);
});

test('a blocking field with no claim and no register entry is outstanding, and the condition is not met', () => {
  const db = makeStore();
  const id = insertTaxon(db, { name: 'Test speciesd' });
  addToPlantableCore(db, id);
  for (const field of BLOCKING_FIELDS) {
    if (field === 'sun_pref') continue; // deliberately no claim, and not registered
    insertClaim(db, { speciesId: id, field, value: 'x' });
  }
  const result = checkStoppingCondition(db);
  assert.equal(result.outstanding.length, 1);
  assert.equal(result.outstanding[0].field, 'sun_pref');
  assert.equal(result.met, false);
});

test('a cultivar with no own claims inherits coverage from its parent species (04 §2.3)', () => {
  const db = makeStore();
  const parentId = insertTaxon(db, { name: 'Ilex vomitoria' });
  const cultivarId = insertTaxon(db, { name: "Ilex vomitoria 'Nana'", rank: 'cultivar', parentId });
  addToPlantableCore(db, cultivarId);
  for (const field of BLOCKING_FIELDS) insertClaim(db, { speciesId: parentId, field, value: 'x' });

  const result = checkStoppingCondition(db);
  assert.equal(result.sourced.length, BLOCKING_FIELDS.length);
  assert.equal(result.outstanding.length, 0);
});

test('plantable_set excludes a species the flora screen confirms non-native (10 §2.1) — it never appears in the query at all', () => {
  const db = makeStore();
  const id = insertTaxon(db, { name: 'Chilopsis linearis' });
  addToPlantableCore(db, id);
  insertClaim(db, { speciesId: id, field: 'nativity_nctx', value: 'introduced', status: 'asserted', source: 'nctx-flora' });

  const result = checkStoppingCondition(db);
  assert.equal(result.plantableSetSize, 0);
  assert.equal(result.totalCells, 0);
  assert.equal(result.met, true, 'an empty plantable set trivially meets the condition');
});
