// SQLite store for the nearby-species index (nl-a7e). Unlike ecology/*.csv,
// which are committed and read offline by src/analysis/, this is a *local*
// index — gitignored (*.db), same convention as data/probe-cache.db — because
// it's rebuilt by re-running the build (tools/fetch-ecosystem-index.mjs, or
// feed-poller's queue, tools/ecosystemIndexQueue.js), not hand-curated.
// feed-poller, the fetch script and the web server's /api/ecosystem all open
// this file.
//
// Keyed by yard (nl-3s5.6): every row belongs to one app.db projects.id, so
// two owners whose yards share a free-text `place` label (every yard used to
// say 'home') can never read or overwrite each other's rows. The id is not a
// secret; what protects the rows is that /api/ecosystem resolves ?project=
// against the caller before it reads any (server/routes/ecosystem.js).
//
// Two tables:
//   project_species_observations  the species rows, one per (yard, taxon)
//   project_index_builds          one row per yard: whether its index is
//                                 building, ready or failed, and for which
//                                 location (a fingerprint, never the location)
//
// The pre-nl-3s5.6 table, species_observations keyed by `place`, is no longer
// created or read here. A database that already has it keeps it untouched,
// so the previous code still works after a rollback;
// tools/rekey-ecosystem-index.mjs copies its rows to yards once.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveDataDir } from './dataDir.js';

// A function, not a module-level constant: DATA_DIR (tools/dataDir.js) must
// be resolved at OPEN time, since tests set process.env.DATA_DIR after this
// module is already imported (nl-3s5.27).
export function defaultEcosystemPath(dataDir) {
  return join(resolveDataDir(dataDir), 'ecosystem.db');
}

/** The build states a yard's index can be in. 'queued' and 'no-location' are derived, never stored. */
export const BUILD_STATES = Object.freeze(['building', 'ready', 'failed']);

export function openEcosystemDb(path = defaultEcosystemPath()) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  // busy_timeout makes a concurrent writer wait instead of failing at once
  // (nl-3s5.14): the web server and offline fetch scripts can write at the
  // same moment.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_species_observations (
      project_id INTEGER NOT NULL,
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
      establishment_means TEXT,
      PRIMARY KEY (project_id, iconic_taxon, taxon_name)
    )
  `);
  // location_key is locationKey() of the location the rows were built for:
  // a one-way fingerprint, so this cache never holds a coordinate or an
  // address. error is for the operator's logs only; the API never sends it
  // (a geocoder's message can quote the address back).
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_index_builds (
      project_id INTEGER PRIMARY KEY,
      location_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('building', 'ready', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      started_at TEXT,
      finished_at TEXT,
      fetched_on TEXT,
      row_count INTEGER,
      error TEXT
    )
  `);
  return db;
}

/**
 * A one-way fingerprint of a yard's location: equal for the same site, and
 * different when the owner moves it, so a moved yard is rebuilt. Coordinates
 * are rounded to 6 decimals (~0.1 m), so a re-save of the same point keeps its
 * index. null when the location says nowhere.
 *
 * @param {{ lat?: number, lng?: number, address?: string } | null} location
 * @returns {string | null}
 */
export function locationKey(location) {
  if (!location) return null;
  let basis = null;
  if (Number.isFinite(location.lat) && Number.isFinite(location.lng)) {
    basis = `ll:${location.lat.toFixed(6)},${location.lng.toFixed(6)}`;
  } else if (typeof location.address === 'string' && location.address.trim()) {
    basis = `addr:${location.address.trim().toLowerCase().replace(/\s+/g, ' ')}`;
  }
  return basis ? createHash('sha256').update(basis).digest('hex') : null;
}

/** Replace every row for (project, iconic_taxon) in one transaction; taxa are fetched independently. */
export function replaceTaxonRows(db, projectId, iconicTaxon, rows) {
  const id = requireProjectId(projectId);
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM project_species_observations WHERE project_id = ? AND iconic_taxon = ?').run(id, iconicTaxon);
    const insert = db.prepare(`
      INSERT INTO project_species_observations
        (project_id, iconic_taxon, taxon_name, taxon_id, common_name, genus, radius_mi, observation_count, photo_url, photo_attribution, fetched_on, source, establishment_means)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      insert.run(
        id,
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

/** Drop a yard's rows (its location moved, so they describe somewhere else). The build row stays. */
export function deleteProjectRows(db, projectId) {
  db.prepare('DELETE FROM project_species_observations WHERE project_id = ?').run(requireProjectId(projectId));
}

/** One yard's rows, most-observed first within each taxon. */
export function listSpeciesObservations(db, { projectId, iconicTaxon } = {}) {
  const clauses = ['project_id = ?'];
  const params = [requireProjectId(projectId)];
  if (iconicTaxon) {
    clauses.push('iconic_taxon = ?');
    params.push(iconicTaxon);
  }
  return db
    .prepare(
      `SELECT * FROM project_species_observations WHERE ${clauses.join(' AND ')} ORDER BY iconic_taxon, observation_count DESC`
    )
    .all(...params);
}

/**
 * @typedef {{ projectId: number, locationKey: string, state: 'building'|'ready'|'failed',
 *   attempts: number, startedAt: string|null, finishedAt: string|null,
 *   fetchedOn: string|null, rowCount: number|null, error: string|null }} IndexBuild
 */

/** @returns {IndexBuild | null} */
export function readIndexBuild(db, projectId) {
  const row = db.prepare('SELECT * FROM project_index_builds WHERE project_id = ?').get(requireProjectId(projectId));
  if (!row) return null;
  return {
    projectId: row.project_id,
    locationKey: row.location_key,
    state: row.state,
    attempts: row.attempts,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    fetchedOn: row.fetched_on,
    rowCount: row.row_count,
    error: row.error,
  };
}

/**
 * Record that a build of this yard, for this location, has started. A build
 * for a NEW location first drops the old site's rows and resets the attempt
 * count; a retry at the same location keeps the rows it already has (a retry
 * replays the requests that succeeded from the probe cache).
 */
export function markBuildStarted(db, projectId, key, now = new Date().toISOString()) {
  const id = requireProjectId(projectId);
  const previous = readIndexBuild(db, id);
  const moved = !previous || previous.locationKey !== key;
  db.exec('BEGIN');
  try {
    if (moved) deleteProjectRows(db, id);
    db.prepare(
      `INSERT INTO project_index_builds (project_id, location_key, state, attempts, started_at, finished_at, fetched_on, row_count, error)
       VALUES (?, ?, 'building', 1, ?, NULL, NULL, NULL, NULL)
       ON CONFLICT(project_id) DO UPDATE SET
         location_key = excluded.location_key,
         state = 'building',
         attempts = ${moved ? '1' : 'project_index_builds.attempts + 1'},
         started_at = excluded.started_at,
         error = NULL`
    ).run(id, key, now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Record how a build ended: 'ready', or 'failed' with a message for the operator's logs. */
export function markBuildFinished(db, projectId, { state, error = null, fetchedOn = null, now = new Date().toISOString() }) {
  if (state !== 'ready' && state !== 'failed') throw new Error(`A build finishes 'ready' or 'failed', not ${state}`);
  const id = requireProjectId(projectId);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM project_species_observations WHERE project_id = ?').get(id);
  db.prepare(
    `UPDATE project_index_builds
       SET state = ?, finished_at = ?, error = ?, row_count = ?, fetched_on = COALESCE(?, fetched_on)
     WHERE project_id = ?`
  ).run(state, now, error ? String(error).slice(0, 500) : null, n, fetchedOn, id);
}

/**
 * Where a yard's index stands, for a yard whose CURRENT location has this
 * fingerprint (null: it has none).
 *
 *   no-location  nothing to be near; the owner has not set a location
 *   queued       has a location, no build has started for it yet (or the
 *                yard moved since the last one)
 *   building     a build for this location is running
 *   ready        built for this location
 *   failed       the last build for this location failed; it is retried
 *
 * `rowsApply` says whether the stored rows describe this location, so a moved
 * yard never shows the old site's species while its new index builds.
 *
 * @returns {{ state: 'no-location'|'queued'|'building'|'ready'|'failed', rowsApply: boolean, fetchedOn: string|null }}
 */
export function indexStatus(db, projectId, currentKey) {
  if (!currentKey) return { state: 'no-location', rowsApply: false, fetchedOn: null };
  const build = readIndexBuild(db, projectId);
  if (!build || build.locationKey !== currentKey) return { state: 'queued', rowsApply: false, fetchedOn: null };
  return { state: build.state, rowsApply: true, fetchedOn: build.fetchedOn };
}

/** Whether this database still has the pre-nl-3s5.6 place-keyed table. */
export function hasLegacyPlaceTable(db) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'species_observations'").get()
  );
}

/** Rows of the pre-nl-3s5.6 table for one place label (tools/rekey-ecosystem-index.mjs). */
export function listLegacyPlaceRows(db, place) {
  if (!hasLegacyPlaceTable(db)) return [];
  return db.prepare('SELECT * FROM species_observations WHERE place = ? ORDER BY iconic_taxon, observation_count DESC').all(place);
}

function requireProjectId(projectId) {
  const id = Number(projectId);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`A project id (app.db projects.id) is required, not ${projectId}`);
  return id;
}
