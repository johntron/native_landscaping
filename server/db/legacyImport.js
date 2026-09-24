// One-time copy of the hand-entered tables that used to live in their own
// files, data/saved-areas.db and data/feed-state.db, into app.db (nl-3s5.11).
//
// Copy, never move: the legacy files are opened read-only and are never
// deleted, renamed or written, so they stay behind as a backup. Each table is
// imported at most once, recorded in app_meta, inside a BEGIN IMMEDIATE
// transaction that re-checks that record and verifies the row count before it
// commits. openAppDb runs importLegacyData on every web start (a no-op once
// recorded), and tools/import-legacy-app-data.mjs runs it, or its read-only
// preview, by hand.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** @typedef {{ table: string, file: string, metaKey: string, columns: string[] }} LegacySource */

/** @type {LegacySource[]} */
export const LEGACY_SOURCES = [
  {
    table: 'saved_areas',
    file: 'saved-areas.db',
    metaKey: 'legacy_import.saved_areas',
    columns: ['id', 'name', 'lat', 'lng', 'radius_mi', 'filters_json', 'created_at', 'updated_at'],
  },
  {
    table: 'feed_state',
    file: 'feed-state.db',
    metaKey: 'legacy_import.feed_state',
    columns: ['observation_id', 'area_id', 'read', 'dismissed', 'updated_at'],
  },
];

function tableExists(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

/**
 * Open a legacy file read-only. Read-only still sees rows that sit only in
 * its -wal file (the live files were never checkpointed after the last
 * write), and it can never checkpoint, truncate or delete that WAL.
 */
function openLegacyReadOnly(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/**
 * Read every row of `source.table` from its legacy file under `dataDir`.
 * A missing file, or one without the table, reads as `exists: false` or zero
 * rows rather than an error.
 *
 * @returns {{ path: string, exists: boolean, rows: object[] }}
 */
function readLegacyRows(dataDir, source) {
  const path = join(dataDir, source.file);
  if (!existsSync(path)) return { path, exists: false, rows: [] };
  const legacy = openLegacyReadOnly(path);
  try {
    if (!tableExists(legacy, source.table)) return { path, exists: true, rows: [] };
    const rows = legacy
      .prepare(`SELECT ${source.columns.join(', ')} FROM ${source.table}`)
      .all()
      .map((row) => ({ ...row }));
    return { path, exists: true, rows };
  } finally {
    legacy.close();
  }
}

/**
 * The user imported saved areas are assigned to: the users row for
 * `ownerEmail` (OWNER_EMAIL, seeded as admin by openAppDb) when one exists;
 * with no email given, the sole admin if there is exactly one; otherwise
 * null, and the areas are imported unowned.
 *
 * @returns {{ id: number, email: string } | null}
 */
export function findOwner(db, ownerEmail) {
  if (!tableExists(db, 'users')) return null;
  const email = (ownerEmail || '').trim().toLowerCase();
  if (email) {
    const row = db.prepare('SELECT id, email FROM users WHERE email = ?').get(email);
    return row ? { id: row.id, email: row.email } : null;
  }
  const admins = db.prepare('SELECT id, email FROM users WHERE is_admin = 1').all();
  return admins.length === 1 ? { id: admins[0].id, email: admins[0].email } : null;
}

function readMarker(db, key) {
  if (!tableExists(db, 'app_meta')) return null;
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : null;
}

function writeMarker(db, key, value) {
  db.prepare(
    `INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, JSON.stringify(value), new Date().toISOString());
}

/**
 * Import one legacy table into `db` (already migrated to 002). Returns what
 * happened, as recorded in app_meta:
 *   status 'already-imported'   the marker was there (as `recorded`); nothing touched
 *   status 'imported'           rows copied (possibly 0: missing or empty legacy file)
 *   status 'skipped-not-empty'  app.db already had rows; nothing copied, so
 *                               the two sets are never merged by accident
 */
function importOne(db, dataDir, source, owner) {
  const recorded = readMarker(db, source.metaKey);
  if (recorded) return { table: source.table, status: 'already-imported', recorded };
  // Read before taking the write lock: the legacy file is a different
  // database, and nothing writes it any more once this code is deployed.
  const legacy = readLegacyRows(dataDir, source);

  db.exec('BEGIN IMMEDIATE');
  try {
    // Re-check inside the lock: a second process may have imported while
    // this one was reading.
    const existing = readMarker(db, source.metaKey);
    if (existing) {
      db.exec('COMMIT');
      return { table: source.table, status: 'already-imported', recorded: existing };
    }
    const before = db.prepare(`SELECT COUNT(*) AS n FROM ${source.table}`).get().n;
    const base = {
      from: source.file,
      legacyExists: legacy.exists,
      legacyRows: legacy.rows.length,
      at: new Date().toISOString(),
    };
    let result;
    if (before > 0) {
      result = { status: 'skipped-not-empty', ...base, existingRows: before, copied: 0 };
    } else {
      const withOwner = source.table === 'saved_areas';
      const columns = withOwner ? [...source.columns, 'owner_id'] : source.columns;
      const insert = db.prepare(
        `INSERT INTO ${source.table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
      );
      for (const row of legacy.rows) {
        const values = source.columns.map((c) => row[c]);
        if (withOwner) values.push(owner ? owner.id : null);
        insert.run(...values);
      }
      const after = db.prepare(`SELECT COUNT(*) AS n FROM ${source.table}`).get().n;
      if (after !== legacy.rows.length) {
        throw new Error(
          `Legacy import of ${source.table} copied ${after} rows but ${source.file} has ${legacy.rows.length}; rolled back`
        );
      }
      result = { status: 'imported', ...base, copied: after };
      if (withOwner) result.ownerId = owner ? owner.id : null;
    }
    writeMarker(db, source.metaKey, result);
    db.exec('COMMIT');
    return { table: source.table, ...result };
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
 * Copy saved_areas and feed_state from their legacy files under `dataDir`
 * into `db`, each exactly once. Throws, having committed nothing for that
 * table, if a copy's row count does not match its source.
 *
 * @param {import('node:sqlite').DatabaseSync} db app.db, migrated to 002 or later
 * @param {{ dataDir: string, ownerEmail?: string }} options
 * @returns {Array<object>} one result per table (see importOne)
 */
export function importLegacyData(db, { dataDir, ownerEmail }) {
  const owner = findOwner(db, ownerEmail);
  return LEGACY_SOURCES.map((source) => importOne(db, dataDir, source, owner));
}

/**
 * Report what importLegacyData would do, opening every file read-only and
 * running no migration: app.db's schema version, row counts and import
 * markers, each legacy file's row count, and the owner imported areas would
 * get. Safe to run against the live data/ while web and feed-poller are up.
 *
 * @param {{ dataDir: string, ownerEmail?: string }} options
 */
export function previewLegacyImport({ dataDir, ownerEmail }) {
  const appPath = join(dataDir, 'app.db');
  const report = { dataDir, appDb: { path: appPath, exists: existsSync(appPath) }, tables: [], owner: null };
  let app = null;
  try {
    if (report.appDb.exists) {
      app = openLegacyReadOnly(appPath);
      report.appDb.schemaVersion = tableExists(app, 'schema_version')
        ? app.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version').get().v
        : 0;
      report.owner = findOwner(app, ownerEmail);
    }
    for (const source of LEGACY_SOURCES) {
      const legacy = readLegacyRows(dataDir, source);
      const entry = {
        table: source.table,
        legacyFile: legacy.path,
        legacyExists: legacy.exists,
        legacyRows: legacy.rows.length,
        appRows: app && tableExists(app, source.table)
          ? app.prepare(`SELECT COUNT(*) AS n FROM ${source.table}`).get().n
          : null,
        marker: app ? readMarker(app, source.metaKey) : null,
      };
      if (source.table === 'saved_areas' && app && tableExists(app, 'saved_areas')) {
        entry.appRowsWithOwner = app.prepare('SELECT COUNT(*) AS n FROM saved_areas WHERE owner_id IS NOT NULL').get().n;
      }
      if (source.table === 'feed_state') {
        // Flags for areas that no longer exist are copied as-is (deleting an
        // area never cleared them); counted here so a surprise is visible.
        const areaIds = new Set(readLegacyRows(dataDir, LEGACY_SOURCES[0]).rows.map((r) => r.id));
        entry.legacyRowsForMissingAreas = legacy.rows.filter((r) => !areaIds.has(r.area_id)).length;
      }
      entry.wouldImport = entry.marker ? 0 : entry.appRows ? 0 : legacy.rows.length;
      report.tables.push(entry);
    }
  } finally {
    if (app) app.close();
  }
  return report;
}
