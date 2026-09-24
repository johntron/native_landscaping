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

/**
 * Bring `db` up to the latest migration in `migrationsDir`. Each migration
 * runs in its own transaction with its version recorded in schema_version;
 * a migration whose version is already recorded is skipped. Migrations are
 * plain SQL, run in file order — there is no down migration, matching the
 * rest of this repo's gitignored SQLite stores (see tools/ecosystemIndexDb.js).
 */
export function runMigrations(db, migrationsDir) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  const applied = new Set(
    db.prepare('SELECT version FROM schema_version').all().map((row) => row.version)
  );
  for (const migration of listMigrations(migrationsDir)) {
    if (applied.has(migration.version)) continue;
    const sql = readFileSync(migration.file, 'utf-8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        new Date().toISOString()
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
