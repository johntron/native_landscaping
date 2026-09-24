// The one-time copy of data/saved-areas.db and data/feed-state.db into app.db
// (nl-3s5.11, server/db/legacyImport.js). Every test builds its legacy files
// in a throwaway DATA_DIR with the schemas those files had before the move.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openAppDb } from '../server/db/appDb.js';
import { importLegacyData, previewLegacyImport } from '../server/db/legacyImport.js';
import { listSavedAreas } from '../tools/savedAreas/savedAreasDb.js';
import { listFeedStates } from '../tools/feedState/feedStateDb.js';

const OWNER = 'owner@example.com';
const quiet = () => {};

function tempDataDir() {
  return mkdtempSync(join(tmpdir(), 'legacy-import-test-'));
}

/** The pre-nl-3s5.11 schemas, verbatim from the old open*Db functions. */
const LEGACY_SAVED_AREAS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS saved_areas (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    lat          REAL NOT NULL,
    lng          REAL NOT NULL,
    radius_mi    REAL NOT NULL,
    filters_json TEXT NOT NULL DEFAULT '{}',
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  )`;
const LEGACY_FEED_STATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS feed_state (
    observation_id INTEGER NOT NULL,
    area_id        TEXT NOT NULL,
    read           INTEGER NOT NULL DEFAULT 0,
    dismissed      INTEGER NOT NULL DEFAULT 0,
    updated_at     TEXT NOT NULL,
    PRIMARY KEY (observation_id, area_id)
  )`;

/**
 * Write legacy saved-areas.db and feed-state.db under `dir`, in WAL mode like
 * the live ones. With keepOpen, the writer connections are returned still
 * open with autocheckpoint off, so the rows sit only in the -wal files.
 */
function writeLegacy(dir, { areas = 2, states = 3, keepOpen = false } = {}) {
  const sa = new DatabaseSync(join(dir, 'saved-areas.db'));
  sa.exec('PRAGMA journal_mode = WAL');
  sa.exec(LEGACY_SAVED_AREAS_SCHEMA);
  if (keepOpen) sa.exec('PRAGMA wal_autocheckpoint = 0');
  const insertArea = sa.prepare('INSERT INTO saved_areas VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  for (let i = 1; i <= areas; i += 1) {
    insertArea.run(`area-${i}`, `Area ${i}`, 32.7 + i / 100, -96.8, i, JSON.stringify({ place: `P${i}` }), `c${i}`, `u${i}`);
  }
  const fs = new DatabaseSync(join(dir, 'feed-state.db'));
  fs.exec('PRAGMA journal_mode = WAL');
  fs.exec(LEGACY_FEED_STATE_SCHEMA);
  if (keepOpen) fs.exec('PRAGMA wal_autocheckpoint = 0');
  const insertState = fs.prepare('INSERT INTO feed_state VALUES (?, ?, ?, ?, ?)');
  for (let i = 1; i <= states; i += 1) {
    // The last one belongs to an area deleted long ago: it must still copy.
    insertState.run(100 + i, i === states ? 'area-gone' : 'area-1', 1, i % 2, `t${i}`);
  }
  if (keepOpen) return { sa, fs };
  sa.close();
  fs.close();
  return null;
}

function sha(path) {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
}

/** Hashes of each legacy .db and -wal (not -shm, which a read-only open may touch). */
function legacyHashes(dir) {
  const out = {};
  for (const f of ['saved-areas.db', 'saved-areas.db-wal', 'feed-state.db', 'feed-state.db-wal']) {
    out[f] = sha(join(dir, f));
  }
  return out;
}

function ownerId(db) {
  return db.prepare('SELECT id FROM users WHERE email = ?').get(OWNER).id;
}

test('copies every saved area and feed-state row, assigning saved areas to the owner seeded from OWNER_EMAIL', () => {
  const dir = tempDataDir();
  try {
    writeLegacy(dir);
    let results;
    const db = openAppDb({ dataDir: dir, ownerEmail: OWNER, onLegacyImport: (r) => (results = r) });
    try {
      const areas = listSavedAreas(db);
      assert.deepEqual(areas.map((a) => a.id), ['area-1', 'area-2']);
      assert.deepEqual(areas[0].filters, { place: 'P1' });
      assert.equal(areas[0].createdAt, 'c1');
      assert.equal(areas[0].updatedAt, 'u1');
      assert.ok(areas.every((a) => a.ownerId === ownerId(db)));

      assert.equal(listFeedStates(db, 'area-1').size, 2);
      assert.deepEqual(listFeedStates(db, 'area-gone').get(103), { read: true, dismissed: true, updatedAt: 't3' });

      assert.deepEqual(
        results.map((r) => [r.table, r.status, r.copied]),
        [
          ['saved_areas', 'imported', 2],
          ['feed_state', 'imported', 3],
        ]
      );
      assert.equal(results[0].ownerId, ownerId(db));
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runs exactly once: a second open neither duplicates rows nor re-imports what was deleted since', () => {
  const dir = tempDataDir();
  try {
    writeLegacy(dir);
    openAppDb({ dataDir: dir, ownerEmail: OWNER, onLegacyImport: quiet }).close();

    const db = openAppDb({ dataDir: dir, ownerEmail: OWNER, onLegacyImport: quiet });
    try {
      assert.equal(listSavedAreas(db).length, 2);
      db.prepare('DELETE FROM saved_areas').run();
      db.prepare('DELETE FROM feed_state').run();
      const again = importLegacyData(db, { dataDir: dir, ownerEmail: OWNER });
      assert.deepEqual(again.map((r) => r.status), ['already-imported', 'already-imported']);
      assert.equal(listSavedAreas(db).length, 0);
      const markers = db.prepare("SELECT key FROM app_meta WHERE key LIKE 'legacy_import.%' ORDER BY key").all();
      assert.deepEqual(markers.map((m) => m.key), ['legacy_import.feed_state', 'legacy_import.saved_areas']);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with no owner row, imported saved areas are left unowned', () => {
  const dir = tempDataDir();
  try {
    writeLegacy(dir);
    const db = openAppDb({ dataDir: dir, ownerEmail: '', onLegacyImport: quiet });
    try {
      const areas = listSavedAreas(db);
      assert.equal(areas.length, 2);
      assert.ok(areas.every((a) => a.ownerId === null));
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('never modifies the legacy files, and sees rows that exist only in their -wal files', () => {
  const dir = tempDataDir();
  let writers = null;
  try {
    writers = writeLegacy(dir, { keepOpen: true });
    assert.ok(existsSync(join(dir, 'saved-areas.db-wal')), 'fixture: rows are in the WAL');
    const before = legacyHashes(dir);

    const db = openAppDb({ dataDir: dir, ownerEmail: OWNER, onLegacyImport: quiet });
    try {
      assert.equal(listSavedAreas(db).length, 2);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM feed_state').get().n, 3);
    } finally {
      db.close();
    }
    previewLegacyImport({ dataDir: dir, ownerEmail: OWNER });

    assert.deepEqual(legacyHashes(dir), before);
    assert.equal(writers.sa.prepare('SELECT COUNT(*) AS n FROM saved_areas').get().n, 2);
    assert.equal(writers.fs.prepare('SELECT COUNT(*) AS n FROM feed_state').get().n, 3);
  } finally {
    if (writers) {
      writers.sa.close();
      writers.fs.close();
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing legacy files import nothing, create no files, and are recorded so they are not retried', () => {
  const dir = tempDataDir();
  try {
    let results;
    const db = openAppDb({ dataDir: dir, ownerEmail: OWNER, onLegacyImport: (r) => (results = r) });
    try {
      assert.deepEqual(
        results.map((r) => [r.status, r.legacyExists, r.copied]),
        [
          ['imported', false, 0],
          ['imported', false, 0],
        ]
      );
      assert.equal(existsSync(join(dir, 'saved-areas.db')), false);
      assert.equal(existsSync(join(dir, 'feed-state.db')), false);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy files that are empty, or have no table at all, import zero rows', () => {
  const dir = tempDataDir();
  try {
    writeLegacy(dir, { areas: 0, states: 0 });
    // feed-state.db exists but is an empty SQLite file with no feed_state table.
    rmSync(join(dir, 'feed-state.db'));
    rmSync(join(dir, 'feed-state.db-wal'), { force: true });
    rmSync(join(dir, 'feed-state.db-shm'), { force: true });
    writeFileSync(join(dir, 'feed-state.db'), '');
    let results;
    const db = openAppDb({ dataDir: dir, ownerEmail: OWNER, onLegacyImport: (r) => (results = r) });
    try {
      assert.deepEqual(
        results.map((r) => [r.table, r.status, r.legacyExists, r.copied]),
        [
          ['saved_areas', 'imported', true, 0],
          ['feed_state', 'imported', true, 0],
        ]
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an app.db that already has saved areas is not merged with the legacy rows', () => {
  const dir = tempDataDir();
  try {
    const first = openAppDb({ dataDir: dir, ownerEmail: OWNER, importLegacy: false });
    first
      .prepare("INSERT INTO saved_areas (id, name, lat, lng, radius_mi, created_at, updated_at) VALUES ('new', 'New', 0, 0, 1, 'c', 'u')")
      .run();
    first.close();
    writeLegacy(dir);

    let results;
    const db = openAppDb({ dataDir: dir, ownerEmail: OWNER, onLegacyImport: (r) => (results = r) });
    try {
      assert.equal(results[0].status, 'skipped-not-empty');
      assert.equal(results[0].legacyRows, 2);
      assert.deepEqual(listSavedAreas(db).map((a) => a.id), ['new']);
      assert.equal(results[1].status, 'imported', 'feed_state is decided on its own');
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failure part-way through rolls the whole table back and records nothing, so the next open retries', () => {
  const dir = tempDataDir();
  try {
    // A legacy file whose second row cannot be copied (NULL name): the first
    // row must not be left behind in app.db.
    const sa = new DatabaseSync(join(dir, 'saved-areas.db'));
    sa.exec('CREATE TABLE saved_areas (id, name, lat, lng, radius_mi, filters_json, created_at, updated_at)');
    sa.exec("INSERT INTO saved_areas VALUES ('ok', 'Ok', 0, 0, 1, '{}', 'c', 'u'), ('bad', NULL, 0, 0, 1, '{}', 'c', 'u')");
    sa.close();

    assert.throws(() => openAppDb({ dataDir: dir, ownerEmail: OWNER, onLegacyImport: quiet }), /NOT NULL/);
    const db = openAppDb({ dataDir: dir, ownerEmail: OWNER, importLegacy: false });
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM saved_areas').get().n, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM app_meta WHERE key = 'legacy_import.saved_areas'").get().n, 0);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('previewLegacyImport is read-only: it neither migrates app.db nor creates one, and reports what would copy', () => {
  const dir = tempDataDir();
  try {
    writeLegacy(dir);
    const none = previewLegacyImport({ dataDir: dir, ownerEmail: OWNER });
    assert.equal(none.appDb.exists, false);
    assert.equal(existsSync(join(dir, 'app.db')), false);
    assert.deepEqual(none.tables.map((t) => [t.table, t.legacyRows, t.wouldImport]), [
      ['saved_areas', 2, 2],
      ['feed_state', 3, 3],
    ]);
    assert.equal(none.tables[1].legacyRowsForMissingAreas, 1);

    // An app.db still at migration 001 (the live one before this change).
    const v1 = new DatabaseSync(join(dir, 'app.db'));
    v1.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL); INSERT INTO schema_version VALUES (1, '001_users.sql', 'x')");
    v1.exec(readFileSync(new URL('../server/db/migrations/001_users.sql', import.meta.url), 'utf8'));
    v1.exec(`INSERT INTO users (email, is_admin, created_at) VALUES ('${OWNER}', 1, 'x')`);
    v1.close();
    const before = previewLegacyImport({ dataDir: dir, ownerEmail: OWNER });
    assert.equal(before.appDb.schemaVersion, 1);
    assert.equal(before.owner.email, OWNER);
    assert.equal(before.tables[0].appRows, null);
    assert.equal(before.tables[0].wouldImport, 2);
    const check = new DatabaseSync(join(dir, 'app.db'));
    assert.equal(check.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 1, 'preview must not migrate');
    check.close();

    openAppDb({ dataDir: dir, ownerEmail: OWNER, onLegacyImport: quiet }).close();
    const after = previewLegacyImport({ dataDir: dir, ownerEmail: OWNER });
    assert.deepEqual(after.tables.map((t) => [t.appRows, t.legacyRows, t.wouldImport, t.marker.status]), [
      [2, 2, 0, 'imported'],
      [3, 3, 0, 'imported'],
    ]);
    assert.equal(after.tables[0].appRowsWithOwner, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
