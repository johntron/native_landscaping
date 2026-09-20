// SQLite store for saved monitoring areas (nl-1qy.1.2). These are independent of
// yard projects: today only one 'place' exists per project (project.json +
// gitignored location.json), 1:1-ish with a yard, but the observation-feed epic
// (nl-1qy.1) needs to monitor arbitrary areas — a center point + radius, with
// per-area filter settings — that may have no yard behind them at all.
//
// SQLite via node:sqlite, WAL, gitignored (*.db) — same convention as
// tools/ecosystemIndexDb.js and tools/claims/claimsStore.js. `id` is a stable
// TEXT (UUID) primary key, chosen specifically so a sibling store (nl-1qy.1.1's
// observation event log, area_id column) can join against it by value even
// though it lives in its own database file — this module owns no opinion about
// where that other table lives.
//
// Row shape (stable, documented for that join):
//   id            TEXT    primary key, uuid
//   name          TEXT    required, non-empty
//   lat           REAL    required, -90..90
//   lng           REAL    required, -180..180
//   radius_mi     REAL    required, > 0
//   filters_json  TEXT    JSON-encoded object; per-area filter settings such as
//                         { taxonScope, invasiveOnly, rarityThreshold, yardRelevantGenera }.
//                         Deliberately loose here — the feature lanes that read
//                         it (nl-1qy.2/.3/.4) are still being designed, so this
//                         store only requires "a plain object", not a fixed key
//                         set, and stores whatever it's given.
//   created_at    TEXT    ISO 8601, set on insert, never changed
//   updated_at    TEXT    ISO 8601, set on insert and every update
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const DEFAULT_PATH = fileURLToPath(new URL('../../data/saved-areas.db', import.meta.url));

export function openSavedAreasDb(path = DEFAULT_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS saved_areas (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      lat          REAL NOT NULL,
      lng          REAL NOT NULL,
      radius_mi    REAL NOT NULL,
      filters_json TEXT NOT NULL DEFAULT '{}',
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    )
  `);
  return db;
}

/**
 * Validate a saved-area input (create or the fields present in an update) and
 * return a normalized `{ name, lat, lng, radiusMi, filters }`. Throws with a
 * human-readable message on the first problem found — callers (the CRUD
 * functions below, and the /api/saved-areas route) all surface this message
 * as-is to the client.
 *
 * @param {object} input
 * @param {object} [options]
 * @param {boolean} [options.partial] when true, a field missing from `input`
 *   is skipped rather than required — used by updateSavedArea, where only the
 *   fields the caller wants to change are present.
 */
export function validateSavedAreaInput(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Saved area must be an object');
  }
  const result = {};

  if (!partial || Object.prototype.hasOwnProperty.call(input, 'name')) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) {
      throw new Error('Saved area requires a non-empty "name"');
    }
    result.name = name;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(input, 'lat')) {
    const lat = Number(input.lat);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      throw new Error('"lat" must be a number between -90 and 90');
    }
    result.lat = lat;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(input, 'lng')) {
    const lng = Number(input.lng);
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
      throw new Error('"lng" must be a number between -180 and 180');
    }
    result.lng = lng;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(input, 'radiusMi')) {
    const radiusMi = Number(input.radiusMi);
    if (!Number.isFinite(radiusMi) || radiusMi <= 0) {
      throw new Error('"radiusMi" must be a positive number');
    }
    result.radiusMi = radiusMi;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(input, 'filters')) {
    const filters = input.filters === undefined ? {} : input.filters;
    if (typeof filters !== 'object' || filters === null || Array.isArray(filters)) {
      throw new Error('"filters" must be an object');
    }
    result.filters = filters;
  }

  return result;
}

function rowToArea(row) {
  if (!row) return null;
  let filters = {};
  try {
    filters = JSON.parse(row.filters_json);
  } catch {
    filters = {};
  }
  return {
    id: row.id,
    name: row.name,
    lat: row.lat,
    lng: row.lng,
    radiusMi: row.radius_mi,
    filters,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listSavedAreas(db) {
  return db.prepare('SELECT * FROM saved_areas ORDER BY name').all().map(rowToArea);
}

export function getSavedArea(db, id) {
  return rowToArea(db.prepare('SELECT * FROM saved_areas WHERE id = ?').get(id));
}

export function createSavedArea(db, input) {
  const { name, lat, lng, radiusMi, filters } = validateSavedAreaInput(input);
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO saved_areas (id, name, lat, lng, radius_mi, filters_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, name, lat, lng, radiusMi, JSON.stringify(filters), now, now);
  return getSavedArea(db, id);
}

/**
 * Apply only the fields present in `patch`. Unknown/absent fields are left
 * untouched — this is PATCH semantics, not PUT: a client updating just
 * `filters` does not have to resend lat/lng/radius it never fetched, and a
 * dropped `filters` key can never silently blank out the geometry (or vice
 * versa).
 */
export function updateSavedArea(db, id, patch) {
  const existing = db.prepare('SELECT * FROM saved_areas WHERE id = ?').get(id);
  if (!existing) {
    throw new Error(`No saved area with id "${id}"`);
  }
  const changes = validateSavedAreaInput(patch, { partial: true });
  const merged = {
    name: changes.name ?? existing.name,
    lat: changes.lat ?? existing.lat,
    lng: changes.lng ?? existing.lng,
    radiusMi: changes.radiusMi ?? existing.radius_mi,
    filters: changes.filters ?? JSON.parse(existing.filters_json || '{}'),
  };
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE saved_areas SET name = ?, lat = ?, lng = ?, radius_mi = ?, filters_json = ?, updated_at = ?
     WHERE id = ?`
  ).run(merged.name, merged.lat, merged.lng, merged.radiusMi, JSON.stringify(merged.filters), now, id);
  return getSavedArea(db, id);
}

/** Returns true if a row was deleted, false if `id` did not exist. */
export function deleteSavedArea(db, id) {
  const result = db.prepare('DELETE FROM saved_areas WHERE id = ?').run(id);
  return result.changes > 0;
}
