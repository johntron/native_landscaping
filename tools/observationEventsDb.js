// SQLite store for individual iNaturalist observation events (nl-1qy.1.1),
// gitignored (*.db) like data/ecosystem.db and data/probe-cache.db — this is
// rebuilt by re-running tools/fetch-observation-events.mjs, not hand-curated.
//
// Unlike data/ecosystem.db's species_observations table (one row per
// place+taxon, REPLACED wholesale on every run — a presence snapshot), this
// table is an EVENT LOG: one row per individual observation, keyed so re-
// fetching the same observation is idempotent (INSERT OR REPLACE) rather than
// a full-table replace. That's what lets a future "what's new since I last
// checked" query be a straightforward indexed lookup instead of a diff
// against a wholesale-replaced snapshot.
//
// Primary key is (observation_id, area_id), not observation_id alone: saved
// areas (nl-1qy.1.2) can overlap (e.g. two areas both covering a shared
// park), and the same iNaturalist observation can legitimately belong to more
// than one area's feed. Scoping the key by area also makes the incremental
// cursor query (MAX(observation_id) WHERE area_id = ?) correct per area
// rather than accidentally global.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveDataDir } from './dataDir.js';

// A function, not a module-level constant: DATA_DIR (tools/dataDir.js) must
// be resolved at OPEN time, since tests set process.env.DATA_DIR after this
// module is already imported (nl-3s5.27).
export function defaultObservationEventsPath(dataDir) {
  return join(resolveDataDir(dataDir), 'observation-events.db');
}

function addColumnIfMissing(db, table, column, type) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all();
  if (existing.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

export function openObservationEventsDb(path = defaultObservationEventsPath()) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  // busy_timeout makes a concurrent writer wait instead of failing at once
  // (nl-3s5.14): web and feed-poller can write at the same moment.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS observation_events (
      observation_id INTEGER NOT NULL,
      area_id TEXT NOT NULL,
      taxon_id INTEGER,
      taxon_name TEXT,
      common_name TEXT,
      iconic_taxon TEXT,
      observed_on TEXT,
      lat REAL,
      lng REAL,
      quality_grade TEXT,
      establishment_means TEXT,
      photo_url TEXT,
      photo_attribution TEXT,
      url TEXT,
      ingested_at TEXT NOT NULL,
      PRIMARY KEY (observation_id, area_id)
    )
  `);
  // Added after the table's initial ship (nl-1qy.4.2/.4.3) — SQLite has no
  // "ADD COLUMN IF NOT EXISTS", so an existing data/observation-events.db is
  // migrated in place here rather than requiring a manual rebuild.
  addColumnIfMissing(db, 'observation_events', 'conservation_status', 'TEXT');
  addColumnIfMissing(db, 'observation_events', 'conservation_status_name', 'TEXT');
  addColumnIfMissing(db, 'observation_events', 'taxon_geoprivacy', 'TEXT');
  // Supports both directions of "what's new" lookup: by area+taxon
  // (yard-relevance/invasive-monitor lanes filter to specific taxa) and by
  // area+date (a plain chronological feed, nl-1qy.1's "trivial all-new-
  // observations feed" validation step).
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_observation_events_area_taxon
      ON observation_events (area_id, taxon_id, observed_on)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_observation_events_area_observed
      ON observation_events (area_id, observed_on)
  `);
  // Separate from observation_events on purpose: deriving the fetch cursor
  // from MAX(observation_id) in the event table itself breaks the moment a
  // poll finds zero new observations, which is the common case for a small
  // area polled frequently — with no row written, the next poll would have
  // nothing to derive a cursor from and would re-seed "now" all over again,
  // silently losing everything observed in between. This table persists
  // "how far this area has been polled" independent of whether that polling
  // ever found anything to log.
  db.exec(`
    CREATE TABLE IF NOT EXISTS area_cursor (
      area_id TEXT PRIMARY KEY,
      last_polled_id INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  return db;
}

/** The cursor to resume polling an area from (the highest observation_id already checked, whether or not it was logged), or null if the area has never been polled. */
export function getAreaCursor(db, areaId) {
  const row = db.prepare('SELECT last_polled_id FROM area_cursor WHERE area_id = ?').get(areaId);
  return row?.last_polled_id ?? null;
}

/** Record how far an area's poll actually reached, so the next poll resumes from there even if this poll logged nothing new. */
export function setAreaCursor(db, areaId, lastPolledId, updatedAt = new Date().toISOString()) {
  db.prepare(
    `INSERT INTO area_cursor (area_id, last_polled_id, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(area_id) DO UPDATE SET last_polled_id = excluded.last_polled_id, updated_at = excluded.updated_at`
  ).run(areaId, lastPolledId, updatedAt);
}

/**
 * Insert or update a batch of observation rows for one area, in one
 * transaction. INSERT OR REPLACE keyed on (observation_id, area_id) makes
 * re-fetching an overlapping id_above range (e.g. after a failed run retried
 * from a slightly earlier cursor) idempotent rather than erroring or
 * duplicating, and also picks up edits iNaturalist users make to an
 * observation already in the log (a corrected ID, an upgraded quality_grade)
 * the next time it happens to be re-fetched.
 */
export function upsertEvents(db, rows) {
  if (!rows.length) return;
  db.exec('BEGIN');
  try {
    const insert = db.prepare(`
      INSERT OR REPLACE INTO observation_events
        (observation_id, area_id, taxon_id, taxon_name, common_name, iconic_taxon,
         observed_on, lat, lng, quality_grade, establishment_means, photo_url,
         photo_attribution, url, ingested_at, conservation_status,
         conservation_status_name, taxon_geoprivacy)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      insert.run(
        row.observation_id,
        row.area_id,
        row.taxon_id ?? null,
        row.taxon_name || '',
        row.common_name || '',
        row.iconic_taxon || '',
        row.observed_on || null,
        row.lat ?? null,
        row.lng ?? null,
        row.quality_grade || '',
        row.establishment_means || null,
        row.photo_url || '',
        row.photo_attribution || '',
        row.url || '',
        row.ingested_at,
        row.conservation_status || null,
        row.conservation_status_name || null,
        row.taxon_geoprivacy || null
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Highest observation_id already logged for an area, or null if the area has
 * no rows yet. The incremental fetch script passes this straight through as
 * the `id_above` request parameter, so a poll only asks iNaturalist for
 * observations newer than what's already in the log.
 */
export function getMaxObservationId(db, areaId) {
  const row = db
    .prepare('SELECT MAX(observation_id) AS max_id FROM observation_events WHERE area_id = ?')
    .get(areaId);
  return row?.max_id ?? null;
}

/** Diffing helper: rows for one area, optionally narrowed to a taxon and/or an observed_on/ingested_at floor. Straightforward indexed lookup per this bead's design note. */
export function listEvents(db, { areaId, taxonId, sinceObservedOn, sinceIngestedAt } = {}) {
  const clauses = [];
  const params = [];
  if (areaId) {
    clauses.push('area_id = ?');
    params.push(areaId);
  }
  if (taxonId != null) {
    clauses.push('taxon_id = ?');
    params.push(taxonId);
  }
  if (sinceObservedOn) {
    clauses.push('observed_on >= ?');
    params.push(sinceObservedOn);
  }
  if (sinceIngestedAt) {
    clauses.push('ingested_at >= ?');
    params.push(sinceIngestedAt);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db
    .prepare(`SELECT * FROM observation_events ${where} ORDER BY observed_on DESC, observation_id DESC`)
    .all(...params);
}

export function countEvents(db, areaId) {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM observation_events WHERE area_id = ?')
    .get(areaId);
  return row?.n ?? 0;
}
