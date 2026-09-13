// SQLite store for the nearby-species index (nl-a7e). Unlike ecology/*.csv,
// which are committed and read offline by src/analysis/, this is a *local*
// index — gitignored (*.db), same convention as data/probe-cache.db — because
// it's rebuilt by re-running tools/fetch-ecosystem-index.mjs, not hand-curated.
// Both the fetch script and server.js's /api/ecosystem route open this file.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PATH = fileURLToPath(new URL('../data/ecosystem.db', import.meta.url));

export function openEcosystemDb(path = DEFAULT_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS species_observations (
      place TEXT NOT NULL,
      iconic_taxon TEXT NOT NULL,
      taxon_name TEXT NOT NULL,
      common_name TEXT,
      genus TEXT NOT NULL,
      radius_mi REAL NOT NULL,
      observation_count INTEGER NOT NULL,
      fetched_on TEXT NOT NULL,
      source TEXT NOT NULL,
      PRIMARY KEY (place, iconic_taxon, taxon_name)
    )
  `);
  return db;
}

/** Replace every row for (place, iconic_taxon) in one transaction — mirrors fetch-nearby-fauna.mjs's per-place merge, scoped one taxon finer since taxa are fetched independently. */
export function replaceTaxonRows(db, place, iconicTaxon, rows) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM species_observations WHERE place = ? AND iconic_taxon = ?').run(place, iconicTaxon);
    const insert = db.prepare(`
      INSERT INTO species_observations
        (place, iconic_taxon, taxon_name, common_name, genus, radius_mi, observation_count, fetched_on, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      insert.run(
        place,
        iconicTaxon,
        row.taxon_name,
        row.common_name || '',
        row.genus,
        row.radius_mi,
        row.observation_count,
        row.fetched_on,
        row.source
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function listSpeciesObservations(db, { place, iconicTaxon } = {}) {
  const clauses = [];
  const params = [];
  if (place) {
    clauses.push('place = ?');
    params.push(place);
  }
  if (iconicTaxon) {
    clauses.push('iconic_taxon = ?');
    params.push(iconicTaxon);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db
    .prepare(
      `SELECT * FROM species_observations ${where} ORDER BY iconic_taxon, observation_count DESC`
    )
    .all(...params);
}
