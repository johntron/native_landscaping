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
      taxon_id INTEGER,
      common_name TEXT,
      genus TEXT NOT NULL,
      radius_mi REAL NOT NULL,
      observation_count INTEGER NOT NULL,
      photo_url TEXT,
      photo_attribution TEXT,
      fetched_on TEXT NOT NULL,
      source TEXT NOT NULL,
      PRIMARY KEY (place, iconic_taxon, taxon_name)
    )
  `);
  // Added after the table already existed in the wild (gitignored, local —
  // no migration needed beyond this guard). native/introduced/invasive/etc,
  // per iNaturalist's preferred_establishment_means; see establishmentMeans.js.
  const hasColumn = db
    .prepare("SELECT 1 FROM pragma_table_info('species_observations') WHERE name = 'establishment_means'")
    .get();
  if (!hasColumn) {
    db.exec('ALTER TABLE species_observations ADD COLUMN establishment_means TEXT');
  }
  return db;
}

/** Replace every row for (place, iconic_taxon) in one transaction — mirrors fetch-nearby-fauna.mjs's per-place merge, scoped one taxon finer since taxa are fetched independently. */
export function replaceTaxonRows(db, place, iconicTaxon, rows) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM species_observations WHERE place = ? AND iconic_taxon = ?').run(place, iconicTaxon);
    const insert = db.prepare(`
      INSERT INTO species_observations
        (place, iconic_taxon, taxon_name, taxon_id, common_name, genus, radius_mi, observation_count, photo_url, photo_attribution, fetched_on, source, establishment_means)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      insert.run(
        place,
        iconicTaxon,
        row.taxon_name,
        row.taxon_id ?? null,
        row.common_name || '',
        row.genus,
        row.radius_mi,
        row.observation_count,
        row.photo_url || '',
        row.photo_attribution || '',
        row.fetched_on,
        row.source,
        row.establishment_means || null
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Distinct places this index already has rows for — lets a caller (the saved-areas UI, nl-5nm) tell "indexed" from "not indexed yet" for a place name it's suggesting, before the rarity lane silently returns zero items for it. */
export function listPlaces(db) {
  return db
    .prepare('SELECT DISTINCT place FROM species_observations ORDER BY place')
    .all()
    .map((row) => row.place);
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
