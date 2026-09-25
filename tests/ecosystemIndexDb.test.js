import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  indexStatus,
  listSpeciesObservations,
  locationKey,
  markBuildFinished,
  markBuildStarted,
  openEcosystemDb,
  readIndexBuild,
  replaceTaxonRows,
} from '../tools/ecosystemIndexDb.js';

const row = (taxon_name, observation_count = 3) => ({
  taxon_name,
  genus: taxon_name.split(' ')[0],
  radius_mi: 1,
  observation_count,
  fetched_on: '2026-01-01',
  source: 'test',
});

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ecosystem-index-test-'));
  try {
    const path = join(dir, 'ecosystem.db');
    return fn(openEcosystemDb(path), path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('openEcosystemDb sets busy_timeout so a concurrent writer waits instead of failing immediately (nl-3s5.14)', () => {
  withDb((db) => {
    const { timeout } = db.prepare('PRAGMA busy_timeout').get();
    assert.equal(timeout, 5000);
  });
});

test('rows are keyed by yard: two yards never see or overwrite each other’s rows (nl-3s5.6)', () => {
  withDb((db) => {
    replaceTaxonRows(db, 1, 'Plantae', [row('Asclepias tuberosa')]);
    replaceTaxonRows(db, 2, 'Plantae', [row('Lupinus texensis')]);
    // Yard 2 replacing its Plantae leaves yard 1's alone.
    replaceTaxonRows(db, 2, 'Plantae', [row('Salvia farinacea')]);

    assert.deepEqual(listSpeciesObservations(db, { projectId: 1 }).map((r) => r.taxon_name), ['Asclepias tuberosa']);
    assert.deepEqual(listSpeciesObservations(db, { projectId: 2 }).map((r) => r.taxon_name), ['Salvia farinacea']);
  });
});

test('listSpeciesObservations refuses to run without a yard id, rather than returning every yard', () => {
  withDb((db) => {
    replaceTaxonRows(db, 1, 'Plantae', [row('Asclepias tuberosa')]);
    assert.throws(() => listSpeciesObservations(db, {}), /project id/);
    assert.throws(() => listSpeciesObservations(db, { projectId: 'home' }), /project id/);
  });
});

test('locationKey fingerprints a site without holding it, and tells a moved yard apart', () => {
  const here = locationKey({ lat: 32.123456, lng: -96.654321 });
  assert.match(here, /^[0-9a-f]{64}$/);
  assert.equal(here, locationKey({ lat: 32.1234561, lng: -96.6543209, source: 'geocoded' }), 'sub-decimetre noise is the same site');
  assert.notEqual(here, locationKey({ lat: 32.2, lng: -96.654321 }));
  assert.ok(!here.includes('32.12'));
  assert.equal(locationKey({ address: ' 1 Main  St ' }), locationKey({ address: '1 main st' }));
  assert.equal(locationKey(null), null);
  assert.equal(locationKey({}), null);
});

test('indexStatus: no-location, queued, building, ready, failed, and queued again after a move', () => {
  withDb((db) => {
    const a = locationKey({ lat: 32.5, lng: -96.5 });
    const b = locationKey({ lat: 33.5, lng: -97.5 });
    assert.equal(indexStatus(db, 7, null).state, 'no-location');
    assert.deepEqual(indexStatus(db, 7, a), { state: 'queued', rowsApply: false, fetchedOn: null });

    markBuildStarted(db, 7, a, '2026-01-01T00:00:00.000Z');
    assert.equal(indexStatus(db, 7, a).state, 'building');
    replaceTaxonRows(db, 7, 'Plantae', [row('Asclepias tuberosa')]);
    markBuildFinished(db, 7, { state: 'ready', fetchedOn: '2026-01-01' });
    assert.deepEqual(indexStatus(db, 7, a), { state: 'ready', rowsApply: true, fetchedOn: '2026-01-01' });
    assert.equal(readIndexBuild(db, 7).rowCount, 1);

    // The yard moved: its rows describe the old site, so they no longer apply.
    assert.deepEqual(indexStatus(db, 7, b), { state: 'queued', rowsApply: false, fetchedOn: null });
    markBuildStarted(db, 7, b);
    assert.equal(listSpeciesObservations(db, { projectId: 7 }).length, 0, 'a build for a new site drops the old site’s rows');
    markBuildFinished(db, 7, { state: 'failed', error: 'HTTP 503' });
    assert.equal(indexStatus(db, 7, b).state, 'failed');
    assert.equal(readIndexBuild(db, 7).attempts, 1);

    // A retry at the same site keeps what it had and counts the attempt.
    replaceTaxonRows(db, 7, 'Aves', [row('Cardinalis cardinalis')]);
    markBuildStarted(db, 7, b);
    assert.equal(readIndexBuild(db, 7).attempts, 2);
    assert.equal(listSpeciesObservations(db, { projectId: 7 }).length, 1);
    assert.throws(() => markBuildFinished(db, 7, { state: 'building' }));
  });
});

test('openEcosystemDb drops the pre-nl-3s5.6 place-keyed table if a database still has it (nl-3s5.32)', () => {
  withDb((_db, path) => {
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE species_observations (
      place TEXT NOT NULL, iconic_taxon TEXT NOT NULL, taxon_name TEXT NOT NULL, taxon_id INTEGER,
      common_name TEXT, genus TEXT NOT NULL, radius_mi REAL NOT NULL, observation_count INTEGER NOT NULL,
      photo_url TEXT, photo_attribution TEXT, fetched_on TEXT NOT NULL, source TEXT NOT NULL, establishment_means TEXT,
      PRIMARY KEY (place, iconic_taxon, taxon_name))`);
    legacy
      .prepare(`INSERT INTO species_observations (place, iconic_taxon, taxon_name, genus, radius_mi, observation_count, fetched_on, source)
                VALUES ('home', 'Plantae', 'Asclepias tuberosa', 'Asclepias', 1, 3, '2026-01-01', 'test')`)
      .run();
    legacy.close();

    const reopened = openEcosystemDb(path);
    assert.equal(
      reopened.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'species_observations'").get(),
      undefined
    );

    // Idempotent: opening an already-dropped (or never-had-it) database again does not throw.
    const reopenedAgain = openEcosystemDb(path);
    assert.equal(
      reopenedAgain.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'species_observations'").get(),
      undefined
    );
  });
});
