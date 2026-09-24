// Opens data/app.db once at server startup and brings its schema up to date.
//
// Unlike the *.db files under "Data safety" in AGENTS.md that are rebuildable
// caches (ecosystem.db, probe-cache.db, observation-events.db, claims.db),
// app.db holds what a person entered by hand and no tools/ script can
// reconstruct: users, saved monitoring areas and the feed's read/dismissed
// flags (moved here from saved-areas.db and feed-state.db in nl-3s5.11), and
// every yard with its undo history (nl-3s5.3, server/db/projectStore.js). Back
// it up together with the yard photos beside it, DATA_DIR/projects/.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations, currentSchemaVersion, latestMigrationVersion } from './migrate.js';
import { importLegacyData } from './legacyImport.js';
import { resolveDataDir } from '../../tools/dataDir.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

/**
 * Resolve the directory app.db lives in. DATA_DIR lets tests and the e2e
 * scratch server point at a throwaway directory instead of the repo's real
 * data/ — see tests-e2e/scratch-fixture.mjs and playwright.config.js, which
 * set DATA_DIR alongside PUBLIC_DIR for the scratch server. Falls back to
 * data/ under the repo, matching every other tools/*Db.js store. Re-exported
 * here so existing importers of server/db/appDb.js's resolveDataDir keep
 * working; the actual logic lives in tools/dataDir.js, shared with every
 * gitignored cache DB the server opens (nl-3s5.27).
 */
export { resolveDataDir };

/**
 * Open data/app.db with WAL, foreign keys on, and a busy timeout so a
 * concurrent reader and writer (web, feed-poller, a tools/ script) contend
 * instead of failing outright on a locked file. Then run any pending
 * migrations, seed the owner as the first admin, and run the one-time copy of
 * the legacy saved-areas.db and feed-state.db (server/db/legacyImport.js; a
 * no-op once recorded in app_meta).
 *
 * Called once when the server starts; the handle is long-lived and passed
 * through ctx.db.app rather than reopened per request. feed-poller does not
 * call this: see openAppDbWithoutMigrating.
 *
 * @param {object} [options]
 * @param {string} [options.dataDir] defaults to DATA_DIR, then data/
 * @param {string} [options.ownerEmail] defaults to OWNER_EMAIL
 * @param {boolean} [options.importLegacy] run the legacy import (default true)
 * @param {(results: object[]) => void} [options.onLegacyImport] receives the
 *   import results; defaults to logging any table that was actually copied
 */
export function openAppDb({
  dataDir,
  ownerEmail = process.env.OWNER_EMAIL,
  importLegacy = true,
  onLegacyImport = logLegacyImport,
} = {}) {
  const dir = resolveDataDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'app.db'));
  // busy_timeout first: switching to WAL takes a lock too, and two processes
  // opening a fresh file at once would otherwise fail on it with SQLITE_BUSY.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, MIGRATIONS_DIR);
  seedOwner(db, ownerEmail);
  if (importLegacy) onLegacyImport(importLegacyData(db, { dataDir: dir, ownerEmail }));
  return db;
}

function logLegacyImport(results) {
  for (const r of results) {
    if (r.status === 'imported' && r.copied > 0) {
      const owner = r.table === 'saved_areas' ? `, owner_id ${r.ownerId ?? 'NULL'}` : '';
      console.log(`app.db: imported ${r.copied} ${r.table} row(s) from legacy ${r.from}${owner} (legacy file left untouched)`);
    } else if (r.status === 'skipped-not-empty') {
      console.warn(
        `app.db: did NOT import legacy ${r.from}: ${r.table} already had ${r.existingRows} row(s); ${r.legacyRows} legacy row(s) left in ${r.from}`
      );
    }
  }
}

/** Raised by openAppDbWithoutMigrating when app.db is missing or behind this code's migrations. */
export class AppDbNotReadyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AppDbNotReadyError';
  }
}

/**
 * Open an existing app.db for a second process (feed-poller) without running
 * migrations, seeding, or the legacy import: those belong to web alone, which
 * has OWNER_EMAIL and so gives imported areas their owner. Throws
 * AppDbNotReadyError, without creating the file, when app.db does not exist
 * yet or its schema is older than the newest migration in this checkout, so
 * the caller can wait for web to migrate it. A NEWER schema is fine: web may
 * have been deployed with a migration this process has not been restarted for.
 */
export function openAppDbWithoutMigrating({ dataDir } = {}) {
  const path = join(resolveDataDir(dataDir), 'app.db');
  if (!existsSync(path)) {
    throw new AppDbNotReadyError(`${path} does not exist yet; web creates and migrates it on start`);
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  const have = currentSchemaVersion(db);
  const need = latestMigrationVersion(MIGRATIONS_DIR);
  if (have < need) {
    db.close();
    throw new AppDbNotReadyError(
      `${path} is at schema version ${have}, but this code needs ${need}; web applies migrations on start`
    );
  }
  return db;
}

/**
 * Seed the repo owner as the first admin from OWNER_EMAIL. Unset or empty
 * seeds nothing, with no error: a fresh checkout, a test run, or CI with no
 * OWNER_EMAIL configured is the normal case, not a fault. The address is
 * never read from a tracked file — this repo is public — so it only ever
 * comes from the environment (.env locally, the compose service in
 * production).
 *
 * Idempotent: openAppDb runs on every server start, so this upserts the same
 * row via the UNIQUE(email) constraint rather than erroring or duplicating.
 */
export function seedOwner(db, ownerEmail) {
  const email = (ownerEmail || '').trim().toLowerCase();
  if (!email) return;
  db.prepare(
    `INSERT INTO users (email, is_admin, created_at)
     VALUES (?, 1, ?)
     ON CONFLICT(email) DO UPDATE SET is_admin = 1`
  ).run(email, new Date().toISOString());
}
