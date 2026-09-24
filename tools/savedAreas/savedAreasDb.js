// SQLite store for saved monitoring areas (nl-1qy.1.2). These are independent of
// yard projects: today only one 'place' exists per project (project.json +
// gitignored location.json), 1:1-ish with a yard, but the observation-feed epic
// (nl-1qy.1) needs to monitor arbitrary areas — a center point + radius, with
// per-area filter settings — that may have no yard behind them at all.
//
// The saved_areas table lives in data/app.db (nl-3s5.11; schema in
// server/db/migrations/002_saved_areas_and_feed_state.sql), so every function
// here takes the app.db handle: ctx.db.app in the web server, or
// openAppDbWithoutMigrating() in feed-poller. It used to be its own file,
// data/saved-areas.db, which server/db/legacyImport.js copies in once and
// otherwise leaves alone. `id` is a stable TEXT (UUID) primary key, so the
// observation event log (observation-events.db, area_id column) can join
// against it by value across database files.
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
//   owner_id      INTEGER users(id), nullable: who created the area, when known.
//                         Recorded, not enforced; nl-3s5.5 makes areas per-user.
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveDataDir } from '../../server/db/appDb.js';

// This project's git repo is PUBLIC (see the .gitignore note on
// projects/*/location.json), so unlike that file, this export is safe to
// commit only because lat/lng are rounded to 1 decimal place (~11km) before
// they're written — enough to recover which region an area covered, not
// enough to pinpoint a specific address. `id` is included since it's the
// join key the observation-event log's area_id column depends on, and
// losing it on restore would silently orphan any already-fetched events.
//
// Resolved under DATA_DIR at call time, like app.db itself, so the e2e
// scratch servers (which set DATA_DIR) never overwrite the tracked
// data/saved-areas.export.json. Retires with the backups bead (nl-3s5.13).
export function exportPath() {
  return join(resolveDataDir(), 'saved-areas.export.json');
}

function roundCoord(n) {
  return Math.round(n * 10) / 10;
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
    ownerId: row.owner_id ?? null,
  };
}

export function listSavedAreas(db) {
  return db.prepare('SELECT * FROM saved_areas ORDER BY name').all().map(rowToArea);
}

export function getSavedArea(db, id) {
  return rowToArea(db.prepare('SELECT * FROM saved_areas WHERE id = ?').get(id));
}

/**
 * @param {import('node:sqlite').DatabaseSync} db app.db
 * @param {object} input see validateSavedAreaInput
 * @param {{ ownerId?: number | null }} [options] the creating user's id
 *   (ctx.user.id), recorded as owner_id; omitted or null leaves it unowned
 */
export function createSavedArea(db, input, { ownerId = null } = {}) {
  const { name, lat, lng, radiusMi, filters } = validateSavedAreaInput(input);
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO saved_areas (id, name, lat, lng, radius_mi, filters_json, created_at, updated_at, owner_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, name, lat, lng, radiusMi, JSON.stringify(filters), now, now, ownerId ?? null);
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

/**
 * Snapshot every saved area to a git-trackable JSON file (coordinates
 * rounded per exportPath's note above), so an accidental loss of
 * app.db — a bad `rm`, a corrupted WAL file, a wiped disk — has a
 * recoverable record of what areas existed, even though restoring from it
 * loses exact placement and re-adopts existing observation-event history
 * only because `id` round-trips. Callers decide when this runs (the
 * /api/saved-areas route calls it after every create/update/delete); it is
 * NOT wired into the CRUD functions themselves so tests using a scratch db
 * never write to the real project path.
 */
export function exportSavedAreasJson(db, path = exportPath()) {
  const areas = listSavedAreas(db).map((a) => ({
    id: a.id,
    name: a.name,
    lat: roundCoord(a.lat),
    lng: roundCoord(a.lng),
    radiusMi: a.radiusMi,
    filters: a.filters,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  }));
  writeFileSync(path, `${JSON.stringify({ areas }, null, 2)}\n`);
}

/**
 * Manual recovery path for exportSavedAreasJson's snapshot — not called
 * automatically anywhere (an unattended silent restore could clobber
 * changes made after the snapshot without anyone noticing). Run by hand
 * after a real loss, e.g. `node -e "..."` or a future CLI wrapper.
 * INSERT OR IGNORE keyed on id: an id already present in `db` (including
 * one re-created with different lat/lng since the snapshot) is left alone
 * rather than overwritten, so this is safe to run against a db that still
 * has some rows. Recovered rows keep only ~11km-precision coordinates —
 * exportSavedAreasJson never had the exact ones to begin with.
 */
export function restoreSavedAreasFromExport(db, path = exportPath()) {
  const { areas } = JSON.parse(readFileSync(path, 'utf8'));
  const insert = db.prepare(
    `INSERT OR IGNORE INTO saved_areas (id, name, lat, lng, radius_mi, filters_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let restored = 0;
  for (const a of areas) {
    const result = insert.run(
      a.id,
      a.name,
      a.lat,
      a.lng,
      a.radiusMi,
      JSON.stringify(a.filters || {}),
      a.createdAt,
      a.updatedAt
    );
    if (result.changes > 0) restored += 1;
  }
  return { total: areas.length, restored };
}
