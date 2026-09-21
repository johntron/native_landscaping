import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openClaimsStore, createSchema } from '../tools/claims/claimsStore.js';
import { coverageView, conflictsView } from '../tools/claims/humanViews.js';

function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'human-views-test-'));
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

function insertClaim(db, { speciesId, field, value, status = 'asserted', source, retrievedAt = '2026-09-21T00:00:00Z', supersededBy = null }) {
  const result = db
    .prepare(
      `INSERT INTO claims (species_id, field, value, status, source, retrieved_at, superseded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(speciesId, field, value, status, source, retrievedAt, supersededBy);
  return Number(result.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// coverageView
// ---------------------------------------------------------------------------

test('coverageView groups by species with a per-species asserted count, sorted alphabetically', () => {
  const db = makeStore();
  const zebra = insertTaxon(db, { name: 'Zebra plant' });
  const agave = insertTaxon(db, { name: 'Agave americana' });

  insertClaim(db, { speciesId: zebra, field: 'sun_pref', value: 'full-sun', source: 'npin' });
  insertClaim(db, { speciesId: zebra, field: 'water_pref', value: null, status: 'unknown', source: 'nctx-flora' });
  insertClaim(db, { speciesId: agave, field: 'sun_pref', value: 'full-sun', source: 'npin' });

  const rows = coverageView(db);

  // Sorted by species name, not insertion order.
  assert.deepEqual(rows.map((r) => r.species), ['Agave americana', 'Zebra plant']);

  const zebraRow = rows.find((r) => r.species === 'Zebra plant');
  assert.equal(zebraRow.totalFields, 2);
  assert.equal(zebraRow.assertedCount, 1, 'unknown does not count toward completeness');
  assert.deepEqual(
    zebraRow.fields.map((f) => f.field),
    ['sun_pref', 'water_pref'],
    'fields within a species are sorted too',
  );
});

test('coverageView: review and missing also do not count toward the asserted total', () => {
  const db = makeStore();
  const s = insertTaxon(db, { name: 'Species Mixed' });
  insertClaim(db, { speciesId: s, field: 'sun_pref', value: 'full-sun', status: 'asserted', source: 'npin' });
  insertClaim(db, { speciesId: s, field: 'water_pref', value: 'medium', status: 'review', source: 'npin' });
  // 'height_ft' gets no claim at all -> reported as missing by claims_coverage's own "all fields" scope
  // once another taxon has claimed it.
  const other = insertTaxon(db, { name: 'Species Other' });
  insertClaim(db, { speciesId: other, field: 'height_ft', value: '10', status: 'asserted', source: 'usda-plants-characteristics' });

  const [row] = coverageView(db, { species: s });
  assert.equal(row.totalFields, 3);
  assert.equal(row.assertedCount, 1);
  const heightField = row.fields.find((f) => f.field === 'height_ft');
  assert.equal(heightField.status, 'missing');
});

// ---------------------------------------------------------------------------
// conflictsView
// ---------------------------------------------------------------------------

test('conflictsView surfaces disputed candidates without ever picking a winner', () => {
  const db = makeStore();
  const s = insertTaxon(db, { name: 'Passiflora lutea' });
  insertClaim(db, { speciesId: s, field: 'sun_pref', value: 'full-sun', status: 'asserted', source: 'usda-plants-characteristics' });
  insertClaim(db, { speciesId: s, field: 'sun_pref', value: 'part-sun', status: 'asserted', source: 'npin' });

  const rows = conflictsView(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].species, 'Passiflora lutea');
  assert.equal(rows[0].field, 'sun_pref');
  assert.deepEqual(
    rows[0].candidates.map((c) => c.value).sort(),
    ['full-sun', 'part-sun'],
  );
  // No "resolved" or "value" field anywhere on the row — 09 §4: nothing shows as a fact.
  assert.equal(rows[0].resolved, undefined);
  assert.equal(rows[0].value, undefined);
});

test('conflictsView includes an unadjudicated review row even with a single claim', () => {
  const db = makeStore();
  const s = insertTaxon(db, { name: 'Species Review Only' });
  insertClaim(db, { speciesId: s, field: 'water_pref', value: 'dry', status: 'review', source: 'npin' });

  const rows = conflictsView(db, { field: 'water_pref' });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].candidates, [{ value: 'dry', source: 'npin', status: 'review' }]);
});

test('conflictsView respects the field filter', () => {
  const db = makeStore();
  const s = insertTaxon(db, { name: 'Species Two Fields' });
  insertClaim(db, { speciesId: s, field: 'sun_pref', value: 'full-sun', status: 'asserted', source: 'usda-plants-characteristics' });
  insertClaim(db, { speciesId: s, field: 'sun_pref', value: 'part-sun', status: 'asserted', source: 'npin' });
  insertClaim(db, { speciesId: s, field: 'water_pref', value: 'dry', status: 'asserted', source: 'usda-plants-characteristics' });
  insertClaim(db, { speciesId: s, field: 'water_pref', value: 'medium', status: 'asserted', source: 'npin' });

  const rows = conflictsView(db, { field: 'sun_pref' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].field, 'sun_pref');
});
