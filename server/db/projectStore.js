// The design tool's yards in app.db (nl-3s5.3): the projects row (config,
// features, location, history cursor) and its history_entries. Replaces the
// read-modify-write of projects/<slug>/*.json and planting_layout.csv.
//
// Every function takes the DatabaseSync handle and is synchronous. Each write
// is one BEGIN IMMEDIATE transaction with no await inside it: ctx.db.app is one
// connection shared by every request, and a transaction left open across an
// await would let a second request's BEGIN fail with "cannot start a
// transaction within a transaction". Synchronous also means two tabs saving
// the same yard are serialized: each save reads the cursor and appends inside
// its own transaction, so neither entry is lost and no write is torn.
//
// History is the truth and the layout is the entry at the cursor. There is no
// stored planting_layout.csv any more; GET /api/layout exports one.
//
// Photos are files, not rows: DATA_DIR/projects/<projects.id>/img/<name>,
// outside the served root, served by GET /api/project-photo to the owner only.
// Keyed by the numeric id rather than the slug, so two owners' yards with the
// same slug never share a directory.
import path from 'node:path';
import { toPlacements } from '../../src/data/placements.js';

/** Where a yard's own files (today only img/) live under DATA_DIR. */
export function projectDataDir(dataDir, projectRowId) {
  const id = Number(projectRowId);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`Invalid project row id "${projectRowId}"`);
  return path.join(dataDir, 'projects', String(id));
}

/**
 * Run `fn` inside BEGIN IMMEDIATE ... COMMIT, rolling back on any throw.
 * IMMEDIATE takes the write lock up front, so a concurrent writer in another
 * process (a tools/ script) waits on busy_timeout instead of failing halfway.
 * `fn` must be synchronous.
 * @template T
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {() => T} fn
 * @returns {T}
 */
export function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // nothing to roll back
    }
    throw err;
  }
}

/**
 * Every value projects.visibility may hold (enforced by triggers, migration
 * 004). 'public' is reserved for the deferred public-view work (nl-3s5.10):
 * the database accepts it so that bead needs no migration, but nothing
 * assigns it yet and no route reads it.
 */
export const PROJECT_VISIBILITIES = Object.freeze(['private', 'public']);

/**
 * The values the application may write today. Only 'private': every route is
 * owner-only (nl-3s5.4), so a 'public' yard would promise a read path that does
 * not exist. No route takes a visibility from a request body; insertProject is
 * the only writer, and it refuses anything else.
 */
export const ASSIGNABLE_VISIBILITIES = Object.freeze(['private']);

/**
 * @typedef {{
 *   id: number, slug: string, ownerId: number, name: string, visibility: string,
 *   configJson: string, featuresJson: string | null, locationJson: string | null,
 *   historyCursor: number, createdAt: string, updatedAt: string
 * }} ProjectRecord
 */

function toRecord(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    slug: row.slug,
    ownerId: Number(row.owner_id),
    name: row.name,
    visibility: row.visibility,
    configJson: row.config_json,
    featuresJson: row.features_json ?? null,
    locationJson: row.location_json ?? null,
    historyCursor: Number(row.history_cursor),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const PROJECT_COLUMNS =
  'id, slug, owner_id, name, visibility, config_json, features_json, location_json, history_cursor, created_at, updated_at';

/**
 * The yard `slug` owned by `ownerId`, or null. Slugs are unique per owner only,
 * so there is deliberately no lookup by slug alone.
 * @returns {ProjectRecord | null}
 */
export function findOwnedProject(db, ownerId, slug) {
  if (!Number.isFinite(Number(ownerId)) || typeof slug !== 'string') return null;
  const row = db
    .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE owner_id = ? AND slug = ?`)
    .get(Number(ownerId), slug);
  return toRecord(row);
}

/** @returns {ProjectRecord | null} */
export function findProjectById(db, projectRowId) {
  return toRecord(db.prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ?`).get(Number(projectRowId)));
}

/**
 * The `findProject` server/http.js's loadOwnedProject is handed: the caller's
 * own yard by slug. loadOwnedProject has already required ctx.user.
 * @param {{ db: { app: import('node:sqlite').DatabaseSync }, user: { id: number } | null }} ctx
 * @param {string} slug
 */
export function findCallerProject(ctx, slug) {
  if (!ctx.user) return null;
  return findOwnedProject(ctx.db.app, ctx.user.id, slug);
}

/**
 * The yard picker's index for one owner: `{ defaultProject, projects: [{ id, name }] }`,
 * where `id` is the slug (the name every client already uses). Oldest first,
 * and the oldest is the default, so an imported owner keeps the order and the
 * default projects/index.json had. An owner with no yards gets an empty list
 * and a null default.
 */
export function projectIndexFor(db, ownerId) {
  const rows = db
    .prepare('SELECT slug, name FROM projects WHERE owner_id = ? ORDER BY id')
    .all(Number(ownerId));
  const projects = rows.map((row) => ({ id: row.slug, name: row.name }));
  return { defaultProject: projects.length ? projects[0].id : null, projects };
}

/**
 * Insert a yard. Throws on a slug the owner already has (UNIQUE), which the
 * create route reports. History starts empty unless `entries` are given (the
 * import passes the old file's).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ ownerId: number, slug: string, name: string, configJson: string,
 *   featuresJson?: string | null, locationJson?: string | null,
 *   entries?: Array<{ id: string, timestamp: string, description: string, plants: object[] }>,
 *   cursor?: number, now?: string, visibility?: string }} project
 * @returns {number} the new projects.id
 *
 * Not wrapped in its own transaction: the caller decides (the create route
 * wraps it in withTransaction, the import runs many inside one).
 */
export function insertProject(db, {
  ownerId,
  slug,
  name,
  configJson,
  featuresJson = null,
  locationJson = null,
  entries = [],
  cursor = entries.length - 1,
  now = new Date().toISOString(),
  visibility = 'private',
}) {
  if (!ASSIGNABLE_VISIBILITIES.includes(visibility)) {
    throw new Error(`Project visibility must be one of ${ASSIGNABLE_VISIBILITIES.join(', ')}`);
  }
  const result = db
    .prepare(
      `INSERT INTO projects (owner_id, slug, name, visibility, config_json, features_json, location_json, history_cursor, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(Number(ownerId), slug, name, visibility, configJson, featuresJson, locationJson, entries.length ? cursor : -1, now, now);
  const projectRowId = Number(result.lastInsertRowid);
  const insert = db.prepare(
    `INSERT INTO history_entries (project_id, seq, entry_id, description, plants_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  entries.forEach((entry, seq) => {
    insert.run(projectRowId, seq, entry.id, entry.description, JSON.stringify(entry.plants), entry.timestamp);
  });
  return projectRowId;
}

/** Replace a yard's config (and its picker name, which lives beside it). */
export function saveProjectConfig(db, projectRowId, { name, configJson }) {
  withTransaction(db, () => {
    db.prepare('UPDATE projects SET name = ?, config_json = ?, updated_at = ? WHERE id = ?').run(
      name,
      configJson,
      new Date().toISOString(),
      Number(projectRowId)
    );
  });
}

export function saveProjectFeatures(db, projectRowId, featuresJson) {
  withTransaction(db, () => {
    db.prepare('UPDATE projects SET features_json = ?, updated_at = ? WHERE id = ?').run(
      featuresJson,
      new Date().toISOString(),
      Number(projectRowId)
    );
  });
}

/**
 * Set (or with null, clear) a yard's location: `{ lat, lng }` and/or
 * `{ address }`, plus any provenance, exactly what location.json held.
 */
export function saveProjectLocation(db, projectRowId, location) {
  withTransaction(db, () => {
    db.prepare('UPDATE projects SET location_json = ?, updated_at = ? WHERE id = ?').run(
      location == null ? null : JSON.stringify(location),
      new Date().toISOString(),
      Number(projectRowId)
    );
  });
}

/** The parsed location, or null when none was ever set. */
export function parseLocation(record) {
  if (!record?.locationJson) return null;
  try {
    return JSON.parse(record.locationJson);
  } catch {
    return null;
  }
}

function readEntries(db, projectRowId) {
  return db
    .prepare(
      'SELECT seq, entry_id, description, plants_json, created_at FROM history_entries WHERE project_id = ? ORDER BY seq'
    )
    .all(Number(projectRowId))
    .map((row) => ({
      id: row.entry_id,
      timestamp: row.created_at,
      description: row.description,
      plants: JSON.parse(row.plants_json),
    }));
}

function readCursor(db, projectRowId) {
  const row = db.prepare('SELECT history_cursor FROM projects WHERE id = ?').get(Number(projectRowId));
  if (!row) throw new Error('Project not found');
  return Number(row.history_cursor);
}

/**
 * The whole undo stack: `{ entries: [{ id, timestamp, description, plants }], cursor }`,
 * cursor -1 when there are no entries.
 */
export function readHistory(db, projectRowId) {
  const entries = readEntries(db, projectRowId);
  const stored = readCursor(db, projectRowId);
  const cursor = entries.length ? Math.max(0, Math.min(stored, entries.length - 1)) : -1;
  return { entries, cursor };
}

/** The placements the yard shows now: the entry at the cursor, or [] with no history. */
export function currentPlacements(db, projectRowId) {
  const { entries, cursor } = readHistory(db, projectRowId);
  return cursor >= 0 ? entries[cursor].plants : [];
}

export const INITIAL_ENTRY_DESCRIPTION = 'Initial layout';

/**
 * Record one layout change: drop the redo tail past the cursor, append
 * `entry`, and move the cursor onto it, in one transaction.
 *
 * `previousPlants` seeds an 'Initial layout' entry when the yard has no
 * history yet, so the client's local stack (which starts with the layout it
 * loaded) and the stored one keep the same indices. An empty array counts: a
 * brand-new yard starts from nothing, and without that entry the first save
 * would leave the client's cursor one ahead of the server's.
 *
 * @param {{ id: string, timestamp: string, description: string, plants: object[] }} entry
 * @param {object[] | undefined} previousPlants
 * @returns {{ entry: object, cursor: number, count: number }}
 */
export function recordLayout(db, projectRowId, entry, previousPlants) {
  return withTransaction(db, () => {
    const id = Number(projectRowId);
    const cursor = readCursor(db, id);
    let keep = Math.max(cursor + 1, 0);
    db.prepare('DELETE FROM history_entries WHERE project_id = ? AND seq >= ?').run(id, keep);
    const insert = db.prepare(
      `INSERT INTO history_entries (project_id, seq, entry_id, description, plants_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    if (keep === 0 && Array.isArray(previousPlants)) {
      insert.run(
        id,
        0,
        `${entry.id}-initial`,
        INITIAL_ENTRY_DESCRIPTION,
        JSON.stringify(toPlacements(previousPlants)),
        entry.timestamp
      );
      keep = 1;
    }
    insert.run(id, keep, entry.id, entry.description, JSON.stringify(entry.plants), entry.timestamp);
    db.prepare('UPDATE projects SET history_cursor = ?, updated_at = ? WHERE id = ?').run(
      keep,
      new Date().toISOString(),
      id
    );
    return { entry, cursor: keep, count: keep + 1 };
  });
}

/**
 * Move the cursor (undo, redo) without touching any entry.
 * @returns {{ entry: object, cursor: number }}
 */
export function moveHistoryCursor(db, projectRowId, cursor) {
  return withTransaction(db, () => {
    const id = Number(projectRowId);
    const target = Number(cursor);
    const row = db
      .prepare(
        'SELECT entry_id, description, plants_json, created_at FROM history_entries WHERE project_id = ? AND seq = ?'
      )
      .get(id, Number.isInteger(target) ? target : -1);
    if (!row) throw new Error('Invalid cursor');
    db.prepare('UPDATE projects SET history_cursor = ?, updated_at = ? WHERE id = ?').run(
      target,
      new Date().toISOString(),
      id
    );
    return {
      entry: { id: row.entry_id, timestamp: row.created_at, description: row.description, plants: JSON.parse(row.plants_json) },
      cursor: target,
    };
  });
}
