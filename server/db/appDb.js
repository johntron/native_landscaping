// Opens data/app.db once at server startup and brings its schema up to date.
//
// Unlike the *.db files under "Data safety" in AGENTS.md that are rebuildable
// caches (ecosystem.db, probe-cache.db, observation-events.db, claims.db),
// app.db holds identity — users, and (from nl-3s5.3 onward) projects and
// revisions — entered by a person and not reconstructable by re-running a
// tools/ script. Back it up the same way as saved-areas.db and feed-state.db.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from './migrate.js';

const DEFAULT_DATA_DIR = fileURLToPath(new URL('../../data', import.meta.url));
const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

/**
 * Resolve the directory app.db lives in. DATA_DIR lets tests and the e2e
 * scratch server point at a throwaway directory instead of the repo's real
 * data/ — see tests-e2e/scratch-fixture.mjs and playwright.config.js, which
 * set DATA_DIR alongside PUBLIC_DIR for the scratch server. Falls back to
 * data/ under the repo, matching every other tools/*Db.js store.
 */
export function resolveDataDir(dataDir = process.env.DATA_DIR) {
  return dataDir ? resolve(dataDir) : DEFAULT_DATA_DIR;
}

/**
 * Open data/app.db with WAL, foreign keys on, and a busy timeout so a
 * concurrent reader and writer (the server plus, eventually, an admin
 * script) contend instead of failing outright on a locked file. Then run any
 * pending migrations and seed the owner as the first admin.
 *
 * Called once when the server starts; the handle is long-lived and passed
 * through ctx.db.app rather than reopened per request.
 */
export function openAppDb({ dataDir, ownerEmail = process.env.OWNER_EMAIL } = {}) {
  const dir = resolveDataDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'app.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  runMigrations(db, MIGRATIONS_DIR);
  seedOwner(db, ownerEmail);
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
