import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAppDb, resolveDataDir, seedOwner } from '../server/db/appDb.js';
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

test('the migration runner applies migration 001 once and records schema_version', () => {
  const dataDir = tempDataDir();
  const db = openAppDb({ dataDir, ownerEmail: '' });
  try {
    const versions = db.prepare('SELECT version, name FROM schema_version ORDER BY version').all();
    assert.deepEqual(
      versions.map((r) => r.version),
      [1]
    );
    assert.match(versions[0].name, /^001_/);

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
      [1]
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
