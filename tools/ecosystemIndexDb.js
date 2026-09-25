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
// And, since nl-3s5.31, the yard's habitat anchors and nearby fauna, which
// were committed place-keyed CSVs before (project_anchors,
// project_nearby_fauna, project_layer_builds; see openEcosystemDb).
//
// The pre-nl-3s5.6 table, species_observations keyed by `place`, is retired
// (nl-3s5.32): it is no longer created, read, or written, and openEcosystemDb
// drops it on open if a database still has it (the per-project index has been
// live and verified since nl-3s5.6, so there is nothing left to roll back to).
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
  // A yard's habitat anchors and nearby fauna (nl-3s5.31). Until then they
  // were committed CSVs keyed by the free-text place label
  // (ecology/anchors.csv, ecology/nearby-fauna.csv), which put one owner's
  // site in a public repo. Now they are per yard, like the species index,
  // and only reach a browser through the owner-scoped /api/ecosystem/site.
  //
  // Neither table holds a coordinate: an anchor is a public feature's name
  // and the straight-line distance to it, rounded to a quarter mile at fetch
  // time; a fauna row is a species and the smallest distance band it was
  // found in.
  //
  //   project_anchors       streams (USGS NHD, layer 'streams') and green
  //                         space (OpenStreetMap, layer 'greenspace')
  //   project_nearby_fauna  animals on iNaturalist near the yard (layer 'fauna')
  //   project_layer_builds  one row per (yard, layer): the same building |
  //                         ready | failed record, and location fingerprint,
  //                         as project_index_builds, so a moved yard's rows
  //                         stop applying at once and the queue refetches
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_anchors (
      project_id INTEGER NOT NULL,
      layer TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      distance_mi REAL NOT NULL,
      detail TEXT,
      fetched_on TEXT NOT NULL,
      source TEXT NOT NULL,
      PRIMARY KEY (project_id, kind, name)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_nearby_fauna (
      project_id INTEGER NOT NULL,
      iconic_taxon TEXT NOT NULL,
      animal_species TEXT NOT NULL,
      animal_common TEXT,
      nearest_radius_mi REAL NOT NULL,
      observation_count INTEGER NOT NULL,
      establishment_means TEXT,
      fetched_on TEXT NOT NULL,
      source TEXT NOT NULL,
      PRIMARY KEY (project_id, iconic_taxon, animal_species)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_layer_builds (
      project_id INTEGER NOT NULL,
      layer TEXT NOT NULL CHECK (layer IN ('fauna', 'streams', 'greenspace')),
      location_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('building', 'ready', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      started_at TEXT,
      finished_at TEXT,
      fetched_on TEXT,
      row_count INTEGER,
      error TEXT,
      PRIMARY KEY (project_id, layer)
    )
  `);
  // The pre-nl-3s5.6 place-keyed table (nl-3s5.32): dropped on open rather
  // than left for a rollback that will not happen. IF EXISTS makes this a
  // no-op on every database that never had the table (all of them, soon) or
  // has already been opened once since this change; DROP TABLE takes a brief
  // exclusive lock, which busy_timeout above covers if web and feed-poller
  // both open the file around the same moment.
  db.exec('DROP TABLE IF EXISTS species_observations');
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

// ---------------------------------------------------------------------------
// Site layers: habitat anchors and nearby fauna (nl-3s5.31)
// ---------------------------------------------------------------------------

/**
 * The per-yard site layers besides the species index, and the upstream each
 * one is fetched from (the queue's politeness budget is per upstream).
 */
export const SITE_LAYERS = Object.freeze({
  fauna: { upstream: 'inaturalist' },
  streams: { upstream: 'nhd' },
  greenspace: { upstream: 'overpass' },
});

function requireLayer(layer) {
  if (!Object.prototype.hasOwnProperty.call(SITE_LAYERS, layer)) {
    throw new Error(`A site layer is one of ${Object.keys(SITE_LAYERS).join(', ')}, not ${layer}`);
  }
  return layer;
}

/** Which layer an anchor kind belongs to: NHD streams, or OpenStreetMap green space. */
export function anchorLayerOf(kind) {
  return kind === 'stream' ? 'streams' : 'greenspace';
}

function layerRowCount(db, projectId, layer) {
  const sql =
    layer === 'fauna'
      ? 'SELECT COUNT(*) AS n FROM project_nearby_fauna WHERE project_id = ?'
      : 'SELECT COUNT(*) AS n FROM project_anchors WHERE project_id = ? AND layer = ?';
  const params = layer === 'fauna' ? [projectId] : [projectId, layer];
  return db.prepare(sql).get(...params).n;
}

function deleteLayerRows(db, projectId, layer) {
  if (layer === 'fauna') {
    db.prepare('DELETE FROM project_nearby_fauna WHERE project_id = ?').run(projectId);
  } else {
    db.prepare('DELETE FROM project_anchors WHERE project_id = ? AND layer = ?').run(projectId, layer);
  }
}

/**
 * Replace every row of one layer for one yard, in one transaction.
 *
 * Anchor rows: { kind, name, status, distance_mi, detail, fetched_on, source }.
 * Fauna rows: { iconic_taxon, animal_species, animal_common, nearest_radius_mi,
 * observation_count, establishment_means, fetched_on, source }.
 * A row with no `source` is refused: every stored fact says where it came from.
 */
export function replaceLayerRows(db, projectId, layer, rows) {
  const id = requireProjectId(projectId);
  requireLayer(layer);
  for (const row of rows) {
    if (!String(row.source || '').trim()) throw new Error(`A ${layer} row has no source: ${JSON.stringify(row)}`);
    if (layer !== 'fauna' && anchorLayerOf(row.kind) !== layer) {
      throw new Error(`An anchor of kind ${row.kind} belongs to layer ${anchorLayerOf(row.kind)}, not ${layer}`);
    }
  }
  db.exec('BEGIN');
  try {
    deleteLayerRows(db, id, layer);
    if (layer === 'fauna') {
      const insert = db.prepare(`
        INSERT INTO project_nearby_fauna
          (project_id, iconic_taxon, animal_species, animal_common, nearest_radius_mi, observation_count, establishment_means, fetched_on, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of rows) {
        insert.run(
          id,
          row.iconic_taxon,
          row.animal_species,
          row.animal_common || '',
          Number(row.nearest_radius_mi),
          Number(row.observation_count) || 0,
          row.establishment_means || null,
          row.fetched_on,
          row.source
        );
      }
    } else {
      const insert = db.prepare(`
        INSERT INTO project_anchors (project_id, layer, kind, name, status, distance_mi, detail, fetched_on, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of rows) {
        insert.run(
          id,
          layer,
          row.kind,
          row.name,
          row.status,
          Number(row.distance_mi),
          row.detail || '',
          row.fetched_on,
          row.source
        );
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** One yard's anchors (both layers), nearest first. */
export function listProjectAnchors(db, projectId) {
  return db
    .prepare('SELECT * FROM project_anchors WHERE project_id = ? ORDER BY distance_mi, name')
    .all(requireProjectId(projectId));
}

/** One yard's nearby fauna, by taxon then species. */
export function listProjectFauna(db, projectId) {
  return db
    .prepare('SELECT * FROM project_nearby_fauna WHERE project_id = ? ORDER BY iconic_taxon, animal_species')
    .all(requireProjectId(projectId));
}

/** @returns {(IndexBuild & { layer: string }) | null} */
export function readLayerBuild(db, projectId, layer) {
  const row = db
    .prepare('SELECT * FROM project_layer_builds WHERE project_id = ? AND layer = ?')
    .get(requireProjectId(projectId), requireLayer(layer));
  if (!row) return null;
  return {
    projectId: row.project_id,
    layer: row.layer,
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

/** markBuildStarted, for one site layer: a build for a new location first drops the old site's rows. */
export function markLayerStarted(db, projectId, layer, key, now = new Date().toISOString()) {
  const id = requireProjectId(projectId);
  requireLayer(layer);
  const previous = readLayerBuild(db, id, layer);
  const moved = !previous || previous.locationKey !== key;
  db.exec('BEGIN');
  try {
    if (moved) deleteLayerRows(db, id, layer);
    db.prepare(
      `INSERT INTO project_layer_builds (project_id, layer, location_key, state, attempts, started_at, finished_at, fetched_on, row_count, error)
       VALUES (?, ?, ?, 'building', 1, ?, NULL, NULL, NULL, NULL)
       ON CONFLICT(project_id, layer) DO UPDATE SET
         location_key = excluded.location_key,
         state = 'building',
         attempts = ${moved ? '1' : 'project_layer_builds.attempts + 1'},
         started_at = excluded.started_at,
         error = NULL`
    ).run(id, layer, key, now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** markBuildFinished, for one site layer. */
export function markLayerFinished(db, projectId, layer, { state, error = null, fetchedOn = null, now = new Date().toISOString() }) {
  if (state !== 'ready' && state !== 'failed') throw new Error(`A build finishes 'ready' or 'failed', not ${state}`);
  const id = requireProjectId(projectId);
  requireLayer(layer);
  db.prepare(
    `UPDATE project_layer_builds
       SET state = ?, finished_at = ?, error = ?, row_count = ?, fetched_on = COALESCE(?, fetched_on)
     WHERE project_id = ? AND layer = ?`
  ).run(state, now, error ? String(error).slice(0, 500) : null, layerRowCount(db, id, layer), fetchedOn, id, layer);
}

/**
 * Record a layer as built for `key` with rows that arrived some other way
 * than a fetch (the one-time nl-3s5.31 import of the old committed CSV rows
 * in): replaces the rows and marks the layer 'ready' in one step, so the
 * queue does not refetch what was just imported.
 */
export function importLayer(db, projectId, layer, key, rows, { fetchedOn, now = new Date().toISOString() } = {}) {
  if (!key) throw new Error(`Yard #${projectId} has no location to record layer ${layer} against`);
  markLayerStarted(db, projectId, layer, key, now);
  replaceLayerRows(db, projectId, layer, rows);
  markLayerFinished(db, projectId, layer, { state: 'ready', fetchedOn, now });
}

/** indexStatus, for one site layer of a yard whose current location has this fingerprint. */
export function layerStatus(db, projectId, layer, currentKey) {
  if (!currentKey) return { state: 'no-location', rowsApply: false, fetchedOn: null };
  const build = readLayerBuild(db, projectId, layer);
  if (!build || build.locationKey !== currentKey) return { state: 'queued', rowsApply: false, fetchedOn: null };
  return { state: build.state, rowsApply: true, fetchedOn: build.fetchedOn };
}

function requireProjectId(projectId) {
  const id = Number(projectId);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`A project id (app.db projects.id) is required, not ${projectId}`);
  return id;
}
