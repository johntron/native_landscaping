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
// History is the truth and the yard is the revision at the cursor. There is no
// stored planting_layout.csv any more; GET /api/layout exports one.
//
// Revisions (nl-3s5.20, migration 005): every save of the planting, the setup
// (config) or the features appends one row to history_entries, in one stream
// with one seq per yard, so undo and redo step across all three. Each row is a
// full snapshot (placements, config, features), so restoring any revision is
// one row read. projects.config_json / features_json / name are the current
// copy, rewritten from the revision at the cursor in the same transaction as
// every save and every cursor move.
//
// Photos are files, not rows: DATA_DIR/projects/<projects.id>/img/<name>,
// outside the served root, served by GET /api/project-photo to the owner only
// (and, for the shared example yard alone, to every signed-in user; nl-3s5.24).
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

// --- The shared example yard (nl-3s5.24) ------------------------------------
//
// One yard every signed-in user may READ: a copy of the owner's backyard with
// no location, owned by a system user no person can sign in as (the .invalid
// TLD is reserved by RFC 2606, so no Google account, and so no Cloudflare
// Access identity, can carry it). It is found by exactly one lookup, owner
// email plus slug, and that lookup is the whole allowlist: no visibility
// value, no admin flag, no other yard is ever readable by a non-owner. Writes
// to it are refused by row id whoever asks (server/http.js loadWritableProject),
// so only tools/refresh-example-yard.mjs and the startup seed change it
// (server/db/exampleYard.js).

/** The system user that owns the example. Never an admin (exampleYard.js ensures is_admin 0). */
export const EXAMPLE_OWNER_EMAIL = 'example@rewilder.invalid';

/** The example's slug, which is how every client addresses it: ?project=example. */
export const EXAMPLE_SLUG = 'example';

/**
 * Slugs a person may not give a new yard (POST /api/projects), so
 * ?project=example keeps meaning the shared example. A yard a user made with
 * one before this rule existed still resolves as theirs first (see
 * loadReadableProject), and the picker then leaves the shared one out.
 */
export const RESERVED_SLUGS = Object.freeze([EXAMPLE_SLUG]);

/** @returns {ProjectRecord | null} the shared example, or null when none has been seeded. */
export function findExampleProject(db) {
  const row = db
    .prepare(
      `SELECT ${PROJECT_COLUMNS} FROM projects
       WHERE owner_id = (SELECT id FROM users WHERE email = ?) AND slug = ?`
    )
    .get(EXAMPLE_OWNER_EMAIL, EXAMPLE_SLUG);
  return toRecord(row);
}

/**
 * The `findExample` server/http.js's loadReadableProject and
 * loadWritableProject are handed: the shared example when `slug` names it,
 * otherwise null. The only way a caller reaches a yard they do not own.
 * @param {{ db: { app: import('node:sqlite').DatabaseSync } }} ctx
 * @param {string} slug
 */
export function findExampleFor(ctx, slug) {
  if (slug !== EXAMPLE_SLUG) return null;
  return findExampleProject(ctx.db.app);
}

/**
 * The yard picker as GET /api/projects sends it: the caller's own yards
 * (projectIndexFor), then the shared example marked `readOnly: true`. A caller
 * with no yards of their own lands on the example (it is the default). Left
 * out when no example exists, and when the caller already has a yard with the
 * example's slug (theirs wins at ?project=example, so listing both would show
 * two entries that open the same yard).
 */
export function projectPickerFor(db, userId) {
  const own = projectIndexFor(db, userId);
  const example = findExampleProject(db);
  if (!example) return own;
  if (example.ownerId === Number(userId)) {
    return { ...own, projects: own.projects.map((p) => (p.id === EXAMPLE_SLUG ? { ...p, readOnly: true } : p)) };
  }
  if (own.projects.some((p) => p.id === EXAMPLE_SLUG)) return own;
  return {
    defaultProject: own.defaultProject ?? EXAMPLE_SLUG,
    projects: [...own.projects, { id: EXAMPLE_SLUG, name: example.name, readOnly: true }],
  };
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


/** What a revision records a save of (history_entries.kind, CHECKed by migration 005). */
export const REVISION_KINDS = Object.freeze(['planting', 'setup', 'features']);

export const INITIAL_ENTRY_DESCRIPTION = 'Initial layout';
export const SETUP_REVISION_DESCRIPTION = 'Saved views';
export const FEATURES_REVISION_DESCRIPTION = 'Saved features';

const INSERT_REVISION_SQL = `INSERT INTO history_entries
  (project_id, seq, entry_id, description, plants_json, created_at, kind, config_json, features_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * Insert a yard. Throws on a slug the owner already has (UNIQUE), which the
 * create route reports. History starts empty unless `entries` are given (the
 * import passes the old file's). Given entries are planting revisions unless
 * they say otherwise, and carry the yard's config and features: an imported
 * yard has no older setup or features to give them.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ ownerId: number, slug: string, name: string, configJson: string,
 *   featuresJson?: string | null, locationJson?: string | null,
 *   entries?: Array<{ id: string, timestamp: string, description: string, plants: object[],
 *     kind?: string, configJson?: string, featuresJson?: string | null }>,
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
  const insert = db.prepare(INSERT_REVISION_SQL);
  entries.forEach((entry, seq) => {
    insert.run(
      projectRowId,
      seq,
      entry.id,
      entry.description,
      JSON.stringify(entry.plants),
      entry.timestamp,
      entry.kind || 'planting',
      entry.configJson ?? configJson,
      entry.featuresJson !== undefined ? entry.featuresJson : featuresJson
    );
  });
  return projectRowId;
}

/**
 * Set (or with null, clear) a yard's location: `{ lat, lng }` and/or
 * `{ address }`, plus any provenance, exactly what location.json held.
 * Not a revision: the location is not part of the design and never reaches
 * the browser (it is set with tools/project-location.mjs).
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

/**
 * @typedef {{ id: string, timestamp: string, description: string, kind: string,
 *   plants: object[], configJson: string, featuresJson: string | null }} Revision
 */

function toRevision(row) {
  return {
    id: row.entry_id,
    timestamp: row.created_at,
    description: row.description,
    kind: row.kind,
    plants: JSON.parse(row.plants_json),
    configJson: row.config_json,
    featuresJson: row.features_json ?? null,
  };
}

const REVISION_COLUMNS = 'seq, entry_id, description, plants_json, created_at, kind, config_json, features_json';

/**
 * Every revision of a yard, oldest first, with the full snapshot each holds.
 * @returns {Revision[]}
 */
export function readRevisions(db, projectRowId) {
  return db
    .prepare(`SELECT ${REVISION_COLUMNS} FROM history_entries WHERE project_id = ? ORDER BY seq`)
    .all(Number(projectRowId))
    .map(toRevision);
}

/** One revision by seq, or null: a single-row read (the O(1) restore). */
export function readRevision(db, projectRowId, seq) {
  const target = Number(seq);
  if (!Number.isInteger(target)) return null;
  const row = db
    .prepare(`SELECT ${REVISION_COLUMNS} FROM history_entries WHERE project_id = ? AND seq = ?`)
    .get(Number(projectRowId), target);
  return row ? toRevision(row) : null;
}

function readCursor(db, projectRowId) {
  const row = db.prepare('SELECT history_cursor FROM projects WHERE id = ?').get(Number(projectRowId));
  if (!row) throw new Error('Project not found');
  return Number(row.history_cursor);
}

/**
 * The planting view of the stack, the shape the import and older callers
 * read: `{ entries: [{ id, timestamp, description, plants }], cursor }`,
 * cursor -1 when there are no entries. Every revision is listed, whatever its
 * kind; readRevisions has the kind and the setup and features of each.
 */
export function readHistory(db, projectRowId) {
  const entries = readRevisions(db, projectRowId).map(({ id, timestamp, description, plants }) => ({
    id,
    timestamp,
    description,
    plants,
  }));
  const stored = readCursor(db, projectRowId);
  const cursor = entries.length ? Math.max(0, Math.min(stored, entries.length - 1)) : -1;
  return { entries, cursor };
}

/** The placements the yard shows now: the revision at the cursor, or [] with no history. */
export function currentPlacements(db, projectRowId) {
  const cursor = readCursor(db, projectRowId);
  const revision = cursor >= 0 ? readRevision(db, projectRowId, cursor) : null;
  return revision ? revision.plants : [];
}

/** The name a config declares, else `fallback`: the picker label restored with a setup. */
function nameFromConfig(configJson, fallback) {
  try {
    const name = JSON.parse(configJson)?.name;
    return typeof name === 'string' && name.trim() ? name : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Append one revision: drop the redo tail past the cursor, seed an initial
 * revision when the stream is empty and `seed` says to, insert, move the
 * cursor onto it, and rewrite the projects row's current copy. The caller
 * holds the transaction.
 *
 * Whatever part the save did not change is carried from the current state:
 * the projects row's config and features (equal to the revision at the
 * cursor, or the only copy when there is none) and the placements at the
 * cursor ([] with no history).
 *
 * @param {{ kind: string, entry: { id: string, timestamp: string, description: string },
 *   plants?: object[], configJson?: string, name?: string, featuresJson?: string | null,
 *   seedPlants?: object[] | null }} change
 *   `featuresJson` undefined means "carry"; null means "no features". `seedPlants`
 *   is the initial revision's placements, or null for no seed.
 */
function appendRevision(db, projectRowId, { kind, entry, plants, configJson, name, featuresJson, seedPlants }) {
  if (!REVISION_KINDS.includes(kind)) throw new Error(`Unknown revision kind "${kind}"`);
  const id = Number(projectRowId);
  const row = db.prepare('SELECT name, config_json, features_json, history_cursor FROM projects WHERE id = ?').get(id);
  if (!row) throw new Error('Project not found');
  const cursor = Number(row.history_cursor);
  const current = cursor >= 0 ? readRevision(db, id, cursor) : null;
  const before = {
    plantsJson: current ? JSON.stringify(current.plants) : '[]',
    configJson: row.config_json,
    featuresJson: row.features_json ?? null,
  };
  const next = {
    plantsJson: plants === undefined ? before.plantsJson : JSON.stringify(plants),
    configJson: configJson === undefined ? before.configJson : configJson,
    featuresJson: featuresJson === undefined ? before.featuresJson : featuresJson,
    name: name ?? row.name,
  };

  let keep = Math.max(cursor + 1, 0);
  db.prepare('DELETE FROM history_entries WHERE project_id = ? AND seq >= ?').run(id, keep);
  const insert = db.prepare(INSERT_REVISION_SQL);
  // The client's stack always starts with the yard it loaded, so the first
  // save of a yard with no history seeds that state as revision 0 and both
  // stacks keep the same indices.
  if (keep === 0 && Array.isArray(seedPlants)) {
    insert.run(
      id,
      0,
      `${entry.id}-initial`,
      INITIAL_ENTRY_DESCRIPTION,
      JSON.stringify(toPlacements(seedPlants)),
      entry.timestamp,
      'planting',
      before.configJson,
      before.featuresJson
    );
    keep = 1;
  }
  insert.run(id, keep, entry.id, entry.description, next.plantsJson, entry.timestamp, kind, next.configJson, next.featuresJson);
  db.prepare(
    'UPDATE projects SET history_cursor = ?, name = ?, config_json = ?, features_json = ?, updated_at = ? WHERE id = ?'
  ).run(keep, next.name, next.configJson, next.featuresJson, new Date().toISOString(), id);
  return { entry: { ...entry, kind }, cursor: keep, count: keep + 1 };
}

/** A new revision's id, timestamp and description. */
function revisionMeta(meta, fallbackDescription) {
  return {
    id: meta?.id || `entry-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    timestamp: meta?.timestamp || new Date().toISOString(),
    description: meta?.description || fallbackDescription,
  };
}

/**
 * Record one layout change as a planting revision, in one transaction. The
 * setup and features are carried from the current state.
 *
 * `previousPlants` seeds an 'Initial layout' revision when the yard has no
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
    const { plants, ...meta } = entry;
    const result = appendRevision(db, projectRowId, {
      kind: 'planting',
      entry: meta,
      plants,
      seedPlants: Array.isArray(previousPlants) ? previousPlants : null,
    });
    return { ...result, entry: { ...result.entry, plants } };
  });
}

/**
 * Save a yard's config (and its picker name, which lives beside it) as a
 * setup revision. A yard with no history is seeded first with the state
 * before this save (no plants, the stored config and features), for the
 * same index alignment recordLayout keeps.
 * @param {{ name: string, configJson: string }} config
 * @param {{ id?: string, timestamp?: string, description?: string }} [meta]
 * @returns {{ entry: object, cursor: number, count: number }}
 */
export function saveProjectConfig(db, projectRowId, { name, configJson }, meta = {}) {
  return withTransaction(db, () =>
    appendRevision(db, projectRowId, {
      kind: 'setup',
      entry: revisionMeta(meta, SETUP_REVISION_DESCRIPTION),
      configJson,
      name,
      seedPlants: [],
    })
  );
}

/**
 * Save a yard's features as a features revision; seeded like saveProjectConfig.
 * @returns {{ entry: object, cursor: number, count: number }}
 */
export function saveProjectFeatures(db, projectRowId, featuresJson, meta = {}) {
  return withTransaction(db, () =>
    appendRevision(db, projectRowId, {
      kind: 'features',
      entry: revisionMeta(meta, FEATURES_REVISION_DESCRIPTION),
      featuresJson,
      seedPlants: [],
    })
  );
}

/**
 * Move the cursor (undo, redo) without touching any revision, and restore the
 * setup and features of the revision it lands on into the projects row (the
 * placements need no copy: they are always read at the cursor). One row read
 * and one row write, whatever the distance moved.
 * @returns {{ entry: Revision, cursor: number }}
 */
export function moveHistoryCursor(db, projectRowId, cursor) {
  return withTransaction(db, () => {
    const id = Number(projectRowId);
    const target = Number(cursor);
    const revision = readRevision(db, id, Number.isInteger(target) ? target : -1);
    if (!revision) throw new Error('Invalid cursor');
    const row = db.prepare('SELECT name FROM projects WHERE id = ?').get(id);
    db.prepare(
      'UPDATE projects SET history_cursor = ?, name = ?, config_json = ?, features_json = ?, updated_at = ? WHERE id = ?'
    ).run(
      target,
      nameFromConfig(revision.configJson, row.name),
      revision.configJson,
      revision.featuresJson,
      new Date().toISOString(),
      id
    );
    return { entry: revision, cursor: target };
  });
}

/**
 * The basename of every `background` any revision's config, or the current
 * config, names. A photo in this set must not be swept: an undo can bring
 * back the setup that shows it. Scans every `background` key at any depth, so
 * a legacy config shape ({ plan, elevations }) is covered too.
 * @returns {Set<string>}
 */
export function referencedBackgroundNames(db, projectRowId) {
  const id = Number(projectRowId);
  const texts = db
    .prepare(
      `SELECT config_json AS c FROM history_entries WHERE project_id = ?
       UNION SELECT config_json AS c FROM projects WHERE id = ?`
    )
    .all(id, id)
    .map((row) => row.c);
  const names = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        if (key === 'background' && typeof inner === 'string' && inner) names.add(path.basename(inner));
        else visit(inner);
      }
    }
  };
  for (const text of texts) {
    try {
      visit(JSON.parse(text));
    } catch {
      // A config that does not parse names nothing we can keep; the sweep
      // below only ever removes content-hashed uploads, never shipped files.
    }
  }
  return names;
}
