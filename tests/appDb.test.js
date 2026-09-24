import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAppDb, openAppDbWithoutMigrating, AppDbNotReadyError, resolveDataDir, seedOwner } from '../server/db/appDb.js';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../server/db/migrate.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../server/db/migrations', import.meta.url));

/** A throwaway data dir per test, so no test touches the repo's real data/. */
function tempDataDir() {
  return mkdtempSync(join(tmpdir(), 'native-landscaping-appdb-test-'));
}

test('resolveDataDir honours DATA_DIR and falls back to data/ under the repo', () => {
  const explicit = tempDataDir();
  assert.equal(resolveDataDir(explicit), explicit);

  // No explicit dir: falls back to process.env.DATA_DIR, and only then to
  // the repo's data/ directory. Save/restore the env var rather than assume
  // it is unset — the harness running this suite may itself set DATA_DIR.
  const savedEnv = process.env.DATA_DIR;
  try {
    delete process.env.DATA_DIR;
    assert.match(resolveDataDir(undefined), /\/data$/);
  } finally {
    if (savedEnv === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = savedEnv;
  }
});

test('the migration runner applies every migration once and records schema_version', () => {
  const dataDir = tempDataDir();
  const db = openAppDb({ dataDir, ownerEmail: '' });
  try {
    const versions = db.prepare('SELECT version, name FROM schema_version ORDER BY version').all();
    assert.deepEqual(
      versions.map((r) => r.version),
      [1, 2]
    );
    assert.match(versions[0].name, /^001_/);
    assert.match(versions[1].name, /^002_saved_areas_and_feed_state/);

    const columns = db
      .prepare("SELECT name FROM pragma_table_info('users')")
      .all()
      .map((r) => r.name)
      .sort();
    assert.deepEqual(columns, ['created_at', 'email', 'id', 'is_admin']);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('re-running the migration runner is a no-op', () => {
  const dataDir = tempDataDir();
  const db = openAppDb({ dataDir, ownerEmail: '' });
  try {
    // Calling it again must not error on already-applied migrations, and
    // must not record a second row for a version already seen.
    runMigrations(db, MIGRATIONS_DIR);
    runMigrations(db, MIGRATIONS_DIR);
    const versions = db.prepare('SELECT version FROM schema_version').all();
    assert.deepEqual(
      versions.map((r) => r.version),
      [1, 2]
    );
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('an unset OWNER_EMAIL seeds nothing, with no error', () => {
  const dataDir = tempDataDir();
  const db = openAppDb({ dataDir, ownerEmail: '' });
  try {
    const users = db.prepare('SELECT * FROM users').all();
    assert.deepEqual(users, []);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('OWNER_EMAIL seeds the owner as the first admin, idempotently', () => {
  const dataDir = tempDataDir();
  const db = openAppDb({ dataDir, ownerEmail: 'owner@example.com' });
  try {
    let users = db.prepare('SELECT email, is_admin FROM users').all().map((r) => ({ ...r }));
    assert.deepEqual(users, [{ email: 'owner@example.com', is_admin: 1 }]);

    // Re-seeding (a second server start, or a direct call) must not error on
    // the UNIQUE(email) constraint or create a duplicate row.
    seedOwner(db, 'owner@example.com');
    seedOwner(db, 'owner@example.com');
    users = db.prepare('SELECT email, is_admin FROM users').all().map((r) => ({ ...r }));
    assert.deepEqual(users, [{ email: 'owner@example.com', is_admin: 1 }]);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('whitespace-only OWNER_EMAIL is treated as unset', () => {
  const dataDir = tempDataDir();
  const db = openAppDb({ dataDir, ownerEmail: '   ' });
  try {
    assert.deepEqual(db.prepare('SELECT * FROM users').all(), []);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('pragmas are set: WAL, foreign_keys on, busy_timeout 5000', () => {
  const dataDir = tempDataDir();
  const db = openAppDb({ dataDir, ownerEmail: '' });
  try {
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('migration 002 creates saved_areas with a nullable owner_id foreign key to users, and feed_state and app_meta', () => {
  const dataDir = tempDataDir();
  const db = openAppDb({ dataDir, ownerEmail: '' });
  try {
    const cols = (t) => db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all().map((r) => r.name).sort();
    assert.deepEqual(cols('saved_areas'), [
      'created_at', 'filters_json', 'id', 'lat', 'lng', 'name', 'owner_id', 'radius_mi', 'updated_at',
    ]);
    assert.deepEqual(cols('feed_state'), ['area_id', 'dismissed', 'observation_id', 'read', 'updated_at']);
    assert.deepEqual(cols('app_meta'), ['key', 'updated_at', 'value']);
    const fk = db.prepare("SELECT \"table\", \"from\", \"to\" FROM pragma_foreign_key_list('saved_areas')").all().map((r) => ({ ...r }));
    assert.deepEqual(fk, [{ table: 'users', from: 'owner_id', to: 'id' }]);
    const ownerCol = db.prepare("SELECT \"notnull\" FROM pragma_table_info('saved_areas') WHERE name = 'owner_id'").get();
    assert.equal(ownerCol.notnull, 0);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('openAppDbWithoutMigrating refuses, without creating it, when app.db does not exist', () => {
  const dataDir = tempDataDir();
  try {
    assert.throws(() => openAppDbWithoutMigrating({ dataDir }), AppDbNotReadyError);
    assert.equal(existsSync(join(dataDir, 'app.db')), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('openAppDbWithoutMigrating refuses a schema behind this code, and applies nothing itself', () => {
  const dataDir = tempDataDir();
  try {
    // An app.db that only ever reached migration 001.
    const old = new DatabaseSync(join(dataDir, 'app.db'));
    const onlyFirst = join(dataDir, 'migrations-001');
    mkdirSync(onlyFirst);
    copyFileSync(join(MIGRATIONS_DIR, '001_users.sql'), join(onlyFirst, '001_users.sql'));
    runMigrations(old, onlyFirst);
    old.close();

    assert.throws(() => openAppDbWithoutMigrating({ dataDir }), (err) => err instanceof AppDbNotReadyError && /schema version 1/.test(err.message));
    const check = new DatabaseSync(join(dataDir, 'app.db'));
    assert.deepEqual(check.prepare('SELECT version FROM schema_version').all().map((r) => r.version), [1]);
    check.close();

    // Once web has migrated it, the same call opens it with busy_timeout set.
    openAppDb({ dataDir, ownerEmail: '' }).close();
    const db = openAppDbWithoutMigrating({ dataDir });
    assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM saved_areas').get().n, 0);
    db.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
