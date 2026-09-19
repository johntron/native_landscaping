// The claim store (nl-scx.1), implementing docs/data-acquisition/04-data-model.md §2-3.
// SQLite via node:sqlite, WAL, gitignored (*.db) — decided on the epic 2026-08-27.
// Nothing else in nl-scx can ingest, arbitrate, or export until this schema exists.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PATH = fileURLToPath(new URL('../../data/claims.db', import.meta.url));

export function openClaimsStore(path = DEFAULT_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  return db;
}

// Drops and recreates every table this store owns. Called at the start of a
// rebuild (04 §3.4: claims.db is gitignored and rebuildable) — never call this
// against a store you want to keep rows in.
export function createSchema(db) {
  db.exec('BEGIN');
  try {
    db.exec('DROP VIEW IF EXISTS plantable_set');
    db.exec('DROP TABLE IF EXISTS plantable_core');
    db.exec('DROP TABLE IF EXISTS name_reconciliations');
    db.exec('DROP TABLE IF EXISTS claims');
    db.exec('DROP TABLE IF EXISTS licenses');
    db.exec('DROP TABLE IF EXISTS taxa');

    // 04 §2.2
    db.exec(`
      CREATE TABLE taxa (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        scientific_name TEXT NOT NULL UNIQUE,
        rank          TEXT NOT NULL CHECK (rank IN ('species', 'variety', 'subspecies', 'cultivar')),
        parent_id     INTEGER REFERENCES taxa(id),
        usda_symbol   TEXT,
        resolves_to   INTEGER REFERENCES taxa(id)
      )
    `);

    // 04 §3.2 — a license is a grant evaluated at export time, not a boolean baked in at extraction.
    db.exec(`
      CREATE TABLE licenses (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        source            TEXT NOT NULL,
        grant             TEXT NOT NULL,
        condition         TEXT,
        citation_required TEXT
      )
    `);

    // 04 §3.1
    db.exec(`
      CREATE TABLE claims (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        species_id    INTEGER NOT NULL REFERENCES taxa(id),
        field         TEXT NOT NULL,
        value         TEXT,
        status        TEXT NOT NULL CHECK (status IN ('asserted', 'review', 'unknown')),
        source        TEXT NOT NULL,
        citation      TEXT,
        retrieved_at  TEXT NOT NULL,
        confidence    REAL,
        license_id    INTEGER REFERENCES licenses(id),
        superseded_by INTEGER REFERENCES claims(id)
      )
    `);

    // 06 §5 — one row per taxa_id+corpus
    db.exec(`
      CREATE TABLE name_reconciliations (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        taxa_id     INTEGER NOT NULL REFERENCES taxa(id),
        corpus      TEXT NOT NULL,
        matched_via TEXT NOT NULL,
        reviewed    INTEGER NOT NULL DEFAULT 0,
        UNIQUE (taxa_id, corpus)
      )
    `);

    // 10 §2.2's measured core (plants.csv ∪ npsot_dfw_recommended=yes), materialized so
    // the plantable_set view (see below) has a real denominator per 04 §5 / 10 §4.
    db.exec(`
      CREATE TABLE plantable_core (
        taxa_id INTEGER PRIMARY KEY REFERENCES taxa(id),
        source  TEXT NOT NULL
      )
    `);

    // 04 §5's four indexes: (species_id, field), field, source, status.
    db.exec('CREATE INDEX idx_claims_species_field ON claims(species_id, field)');
    db.exec('CREATE INDEX idx_claims_field ON claims(field)');
    db.exec('CREATE INDEX idx_claims_source ON claims(source)');
    db.exec('CREATE INDEX idx_claims_status ON claims(status)');

    // 10 §2.1's gate/exclude layers, expressed as anti-joins against claims so an
    // empty store is a no-op (the full plantable_core passes) and they become real
    // filters the moment nl-scx.2 (county presence) and nl-scx.4 (flora nativity)
    // write rows — no schema change needed when that happens.
    db.exec(`
      CREATE VIEW plantable_set AS
      SELECT pc.taxa_id, pc.source
      FROM plantable_core pc
      WHERE NOT EXISTS (
        -- Gate: county presence (Dallas Co., FIPS 48113). Until nl-scx.2 lands, no
        -- claim can say "absent", so nothing is excluded here — fail-open, not
        -- fail-closed, matching 10 §2.1's note that a partial layer under-excludes,
        -- never wrongly admits.
        SELECT 1 FROM claims c
        WHERE c.species_id = pc.taxa_id
          AND c.field = 'county_presence_48113'
          AND c.status = 'asserted'
          AND c.value = 'absent'
      )
      AND NOT EXISTS (
        -- Exclude: flora nativity screen (10 §2.1 / 09 §1). Populated by nl-scx.4.
        SELECT 1 FROM claims c
        WHERE c.species_id = pc.taxa_id
          AND c.field = 'nativity_nctx'
          AND c.status = 'asserted'
          AND c.value = 'introduced'
      )
    `);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
