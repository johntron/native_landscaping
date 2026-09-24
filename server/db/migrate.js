// A small numbered-migration runner: every file in migrations/ named
// NNN_description.sql is applied at most once, in order, tracked in a
// schema_version table. server.js calls openAppDb() (and so runMigrations)
// on every start, so re-running once the schema is current must be a
// cheap no-op rather than an error.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE_PATTERN = /^(\d{3})_.+\.sql$/;

/** List migrations/*.sql in numeric order, ignoring anything not named NNN_description.sql. */
function listMigrations(migrationsDir) {
  return readdirSync(migrationsDir)
    .map((name) => {
      const match = FILE_PATTERN.exec(name);
      return match ? { version: Number(match[1]), name, file: join(migrationsDir, name) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.version - b.version);
}

/** Highest NNN among the migration files, or 0 when there are none. */
export function latestMigrationVersion(migrationsDir) {
  const all = listMigrations(migrationsDir);
  return all.length ? all[all.length - 1].version : 0;
}

/** The highest version recorded in schema_version, or 0 if the table is absent or empty. */
export function currentSchemaVersion(db) {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'")
    .get();
  if (!table) return 0;
  return db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version').get().v;
}

/**
 * Bring `db` up to the latest migration in `migrationsDir`. Each migration
 * runs in its own transaction with its version recorded in schema_version;
 * a migration whose version is already recorded is skipped. Migrations are
 * plain SQL, run in file order — there is no down migration, matching the
 * rest of this repo's gitignored SQLite stores (see tools/ecosystemIndexDb.js).
 *
 * Safe when two processes run it against the same file at once (web and a
 * tools/ script both calling openAppDb during a deploy, nl-3s5.11): each
 * migration takes the write lock up front with BEGIN IMMEDIATE and re-reads
 * schema_version INSIDE that transaction, so a runner that lost the race sees
 * the winner's row and skips instead of applying the migration a second time.
 * The read before the lock is only a fast path: a version, once recorded, is
 * never removed, so "already applied" read outside the lock stays true.
 * `db` should have a busy_timeout set, so the loser waits for the lock rather
 * than failing with SQLITE_BUSY.
 */
export function runMigrations(db, migrationsDir) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  const isApplied = db.prepare('SELECT 1 FROM schema_version WHERE version = ?');
  for (const migration of listMigrations(migrationsDir)) {
    if (isApplied.get(migration.version)) continue;
    const sql = readFileSync(migration.file, 'utf-8');
    db.exec('BEGIN IMMEDIATE');
    try {
      if (isApplied.get(migration.version)) {
        db.exec('COMMIT');
        continue;
      }
      db.exec(sql);
      db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        new Date().toISOString()
      );
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // no transaction left to roll back (BEGIN itself failed)
      }
      throw err;
    }
  }
}
