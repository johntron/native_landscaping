import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEcosystemDb, replaceTaxonRows, listPlaces } from '../tools/ecosystemIndexDb.js';

test('listPlaces returns the distinct, sorted places an index has rows for', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ecosystem-index-test-'));
  try {
    const db = openEcosystemDb(join(dir, 'ecosystem.db'));
    replaceTaxonRows(db, 'Dallas, TX', 'Plantae', [
      { taxon_name: 'Asclepias tuberosa', genus: 'Asclepias', radius_mi: 10, observation_count: 3, fetched_on: '2026-01-01', source: 'test' },
    ]);
    replaceTaxonRows(db, 'Dallas, TX', 'Aves', [
      { taxon_name: 'Cardinalis cardinalis', genus: 'Cardinalis', radius_mi: 5, observation_count: 8, fetched_on: '2026-01-01', source: 'test' },
    ]);
    replaceTaxonRows(db, 'Austin, TX', 'Plantae', [
      { taxon_name: 'Lupinus texensis', genus: 'Lupinus', radius_mi: 10, observation_count: 1, fetched_on: '2026-01-01', source: 'test' },
    ]);

    assert.deepEqual(listPlaces(db), ['Austin, TX', 'Dallas, TX']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listPlaces returns an empty array for a fresh index', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ecosystem-index-test-'));
  try {
    const db = openEcosystemDb(join(dir, 'ecosystem.db'));
    assert.deepEqual(listPlaces(db), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
