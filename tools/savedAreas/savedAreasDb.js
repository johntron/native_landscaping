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
//   owner_id      INTEGER users(id), nullable: the one user who owns the area
//                         (nl-3s5.5). Every web route goes through the *OwnedBy
//                         functions below, which filter `owner_id = ?` in SQL, so
//                         an area with a NULL owner (its user was deleted, or the
//                         legacy import found no owner) is visible to nobody over
//                         HTTP, admins included. The unscoped functions are for
//                         feed-poller, which polls every area, and the export.
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveDataDir } from '../../server/db/appDb.js';

// A local, gitignored backup of every area (nl-3s5.5). It used to be tracked
// in git, rounded to 1 decimal place so it was "safe" in a public repo, but
// area names ("Home", a street, a park next to someone's house) can still
// identify people, and once areas are per-user one user's snapshot would
// publish every other user's. So it now lives only under DATA_DIR, beside
// app.db, and is ignored by git (.gitignore: data/saved-areas.export.json).
// It carries ownerId so a restore gives each area back to its owner instead
// of leaving it unowned and so invisible to everyone. Coordinates stay
// rounded: it is a last-resort record of what existed, not the backup of
// app.db itself. `id` is included since it is the join key the
// observation-event log's area_id column depends on, and losing it on restore
// would silently orphan any already-fetched events.
//
// Resolved under DATA_DIR at call time, like app.db itself, so the e2e
// scratch servers (which set DATA_DIR) never overwrite the dev one. Retires
// with the backups bead (nl-3s5.13).
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

/**
 * Every area, whoever owns it. For feed-poller (tools/feedState/pollAreas.js)
 * and the local export only: a web route must use listSavedAreasOwnedBy.
 */
export function listSavedAreas(db) {
  return db.prepare('SELECT * FROM saved_areas ORDER BY name').all().map(rowToArea);
}

/** One area by id, whoever owns it. Not for web routes: see getSavedAreaOwnedBy. */
export function getSavedArea(db, id) {
  return rowToArea(db.prepare('SELECT * FROM saved_areas WHERE id = ?').get(id));
}

/**
 * The owner-scoped functions below throw rather than fall back to "every
 * area" when the owner is missing, so a route that forgot to pass ctx.user.id
 * fails loudly instead of leaking every user's areas.
 */
function assertOwnerId(ownerId) {
  if (!Number.isInteger(ownerId)) {
    throw new TypeError(`ownerId must be an integer user id, got ${ownerId}`);
  }
}

/** The areas `ownerId` owns, ordered by name. */
export function listSavedAreasOwnedBy(db, ownerId) {
  assertOwnerId(ownerId);
  return db
    .prepare('SELECT * FROM saved_areas WHERE owner_id = ? ORDER BY name')
    .all(ownerId)
    .map(rowToArea);
}

/**
 * The area `id` if `ownerId` owns it, else null: a missing area and someone
 * else's area are indistinguishable, so a route can 404 both the same way.
 */
export function getSavedAreaOwnedBy(db, id, ownerId) {
  assertOwnerId(ownerId);
  return rowToArea(db.prepare('SELECT * FROM saved_areas WHERE id = ? AND owner_id = ?').get(id, ownerId));
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
 *
 * With `ownerId`, only an area that user owns is touched (the SELECT and the
 * UPDATE both filter on owner_id), and someone else's area throws the same
 * "No saved area" error as a missing one. Web routes always pass it.
 *
 * @param {{ ownerId?: number }} [options]
 */
export function updateSavedArea(db, id, patch, options = {}) {
  const scoped = Object.prototype.hasOwnProperty.call(options, 'ownerId');
  if (scoped) assertOwnerId(options.ownerId);
  const ownerClause = scoped ? ' AND owner_id = ?' : '';
  const ownerArgs = scoped ? [options.ownerId] : [];
  const existing = db.prepare(`SELECT * FROM saved_areas WHERE id = ?${ownerClause}`).get(id, ...ownerArgs);
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
     WHERE id = ?${ownerClause}`
  ).run(merged.name, merged.lat, merged.lng, merged.radiusMi, JSON.stringify(merged.filters), now, id, ...ownerArgs);
  return getSavedArea(db, id);
}

/**
 * Returns true if a row was deleted, false if `id` did not exist (or, with
 * `ownerId`, is not that user's).
 *
 * @param {{ ownerId?: number }} [options]
 */
export function deleteSavedArea(db, id, options = {}) {
  const scoped = Object.prototype.hasOwnProperty.call(options, 'ownerId');
  if (scoped) assertOwnerId(options.ownerId);
  const result = scoped
    ? db.prepare('DELETE FROM saved_areas WHERE id = ? AND owner_id = ?').run(id, options.ownerId)
    : db.prepare('DELETE FROM saved_areas WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Snapshot every saved area to a local, gitignored JSON file (coordinates
 * rounded, owner kept; see exportPath's note above), so an accidental loss of
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
    ownerId: a.ownerId,
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
 * exportSavedAreasJson never had the exact ones to begin with. Each area
 * goes back to its exported ownerId when that user still exists in `db`;
 * otherwise (or from an export written before owners were recorded) it is
 * restored unowned, invisible over HTTP until someone sets owner_id by hand.
 */
export function restoreSavedAreasFromExport(db, path = exportPath()) {
  const { areas } = JSON.parse(readFileSync(path, 'utf8'));
  const insert = db.prepare(
    `INSERT OR IGNORE INTO saved_areas (id, name, lat, lng, radius_mi, filters_json, created_at, updated_at, owner_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT id FROM users WHERE id = ?))`
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
      a.updatedAt,
      Number.isInteger(a.ownerId) ? a.ownerId : null
    );
    if (result.changes > 0) restored += 1;
  }
  return { total: areas.length, restored };
}
