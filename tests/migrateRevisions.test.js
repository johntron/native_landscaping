// nl-3s5.20: migration 005 turns every existing history entry into a planting
// revision carrying the yard's current setup and features, and changes
// nothing else: not a seq, an id, a description, a timestamp, a placement, a
// cursor, nor any column of projects. Built on a schema stopped at 004, as
// the live app.db is before the deploy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../server/db/migrate.js';
import { currentPlacements, readRevisions } from '../server/db/projectStore.js';

const MIGRATIONS_DIR = new URL('../server/db/migrations/', import.meta.url).pathname;

function schemaAt004(dir) {
  // runMigrations applies every file in the directory it is given, so a copy
  // of 001..004 alone stops the schema where the live file is.
  const stopped = join(dir, 'migrations-004');
  mkdirSync(stopped);
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    if (/^00[1-4]_.+\.sql$/.test(name)) copyFileSync(join(MIGRATIONS_DIR, name), join(stopped, name));
  }
  return stopped;
}

test('005 on a 004 database: every entry becomes a planting revision with the current setup and features; nothing else moves', () => {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-revisions-'));
  const db = new DatabaseSync(join(dir, 'app.db'));
  try {
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, schemaAt004(dir));
    assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 4);

    db.prepare("INSERT INTO users (email, is_admin, created_at) VALUES ('o@example.com', 1, 't')").run();
    const insertProject = db.prepare(
      `INSERT INTO projects (owner_id, slug, name, config_json, features_json, history_cursor, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, 't', 't')`
    );
    const insertEntry = db.prepare(
      'INSERT INTO history_entries (project_id, seq, entry_id, description, plants_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const yards = [
      { slug: 'a', config: '{"name":"A","views":[{"id":"plan","type":"plan","background":"img/plan-0123456789ab.webp"}]}\n', features: '{"features":[]}\n', n: 5, cursor: 2 },
      { slug: 'b', config: '{"name":"B","views":[{"id":"plan","type":"plan"}]}', features: null, n: 3, cursor: 2 },
      { slug: 'c', config: '{"name":"C","views":[{"id":"plan","type":"plan"}]}', features: null, n: 0, cursor: -1 },
    ];
    for (const yard of yards) {
      const id = Number(insertProject.run(yard.slug, yard.slug, yard.config, yard.features, yard.cursor).lastInsertRowid);
      for (let seq = 0; seq < yard.n; seq += 1) {
        insertEntry.run(id, seq, `${yard.slug}-${seq}`, `step ${seq}`, JSON.stringify([{ id: 'p', speciesId: 's', x: seq, y: 1 }]), `2026-01-0${seq + 1}T00:00:00Z`);
      }
    }
    const projectsBefore = db.prepare('SELECT * FROM projects ORDER BY id').all();
    const entriesBefore = db.prepare('SELECT * FROM history_entries ORDER BY project_id, seq').all();
    // Read with plain SQL: the store's readers expect the 005 columns.
    const shownBefore = projectsBefore.map((p) => {
      const row = db.prepare('SELECT plants_json FROM history_entries WHERE project_id = ? AND seq = ?').get(p.id, p.history_cursor);
      return row ? JSON.parse(row.plants_json) : [];
    });

    runMigrations(db, MIGRATIONS_DIR);

    assert.deepEqual(db.prepare('SELECT * FROM projects ORDER BY id').all(), projectsBefore, 'projects untouched');
    const entriesAfter = db.prepare('SELECT * FROM history_entries ORDER BY project_id, seq').all();
    assert.equal(entriesAfter.length, entriesBefore.length);
    entriesAfter.forEach((after, i) => {
      const before = entriesBefore[i];
      for (const key of Object.keys(before)) assert.equal(after[key], before[key], `${key} of entry ${i}`);
      const project = projectsBefore.find((p) => p.id === after.project_id);
      assert.equal(after.kind, 'planting');
      assert.equal(after.config_json, project.config_json);
      assert.equal(after.features_json, project.features_json);
    });
    assert.deepEqual(projectsBefore.map((p) => currentPlacements(db, p.id)), shownBefore, 'every yard shows what it showed');
    assert.deepEqual(readRevisions(db, projectsBefore[0].id).map((r) => r.kind), Array(5).fill('planting'));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
