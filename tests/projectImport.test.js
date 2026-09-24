// nl-3s5.3: the one-time copy of projects/<slug>/ into app.db
// (server/db/projectImport.js). Copy, never move; once; fail closed; and the
// imported yard shows exactly what the old app showed from its files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openAppDb } from '../server/db/appDb.js';
import { runMigrations } from '../server/db/migrate.js';
import { upsertUser } from '../server/identity.js';
import { importLegacyProjects, previewProjectImport, OUTSIDE_EDIT_DESCRIPTION } from '../server/db/projectImport.js';
import { findOwnedProject, projectDataDir, readHistory, currentPlacements, projectIndexFor } from '../server/db/projectStore.js';
import { buildLayoutCsv } from '../src/data/layoutExporter.js';

const OWNER = 'owner@example.com';
const p = (id, x) => ({ id, speciesId: 'yaupon-holly', x, y: 2 });
const entry = (id, plants) => ({ id, timestamp: `2026-01-0${id.length}T00:00:00Z`, description: `step ${id}`, plants });

function writeYard(projectsDir, slug, { config = { name: slug, views: [] }, history, csvPlants, features, location, photos = {} }) {
  const dir = join(projectsDir, slug);
  mkdirSync(join(dir, 'img'), { recursive: true });
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify(config, null, 2)}\n`);
  if (history !== undefined) writeFileSync(join(dir, 'layout-history.json'), typeof history === 'string' ? history : JSON.stringify(history));
  if (csvPlants !== undefined) writeFileSync(join(dir, 'planting_layout.csv'), buildLayoutCsv(csvPlants));
  if (features !== undefined) writeFileSync(join(dir, 'features.json'), features);
  if (location !== undefined) writeFileSync(join(dir, 'location.json'), location);
  Object.entries(photos).forEach(([name, bytes]) => writeFileSync(join(dir, 'img', name), bytes));
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'project-import-test-'));
  const projectsDir = join(root, 'projects');
  const dataDir = join(root, 'store');
  mkdirSync(projectsDir, { recursive: true });
  return { root, projectsDir, dataDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function openStore(dataDir) {
  const db = openAppDb({ dataDir, ownerEmail: OWNER, importLegacy: false });
  return db;
}

/** Every file under a directory with its hash and mtime, to prove the source was only read. */
function snapshot(dir) {
  const out = {};
  const walk = (d) =>
    readdirSync(d, { withFileTypes: true }).forEach((e) => {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out[full] = [createHash('sha256').update(readFileSync(full)).digest('hex'), statSync(full).mtimeMs];
    });
  walk(dir);
  return out;
}

function fourYards(projectsDir) {
  const h = [entry('a', [p('x', 1)]), entry('bb', [p('x', 2)]), entry('ccc', [p('x', 3)])];
  // current: the CSV is the entry at the cursor (to 3 decimals).
  writeYard(projectsDir, 'current', {
    history: { entries: h, cursor: 2 },
    csvPlants: [p('x', 3.0001)],
    features: '{"features":[]}\n',
    location: '{"lat":1,"lng":2,"address":"secret"}\n',
    photos: { 'top.webp': Buffer.from('webp-bytes'), 'top.xcf': Buffer.from('gimp') },
  });
  // moved: the CSV is an earlier entry; the cursor moves there, redo kept.
  writeYard(projectsDir, 'moved', { history: { entries: h, cursor: 2 }, csvPlants: [p('x', 1)] });
  // diverged: the CSV matches nothing; appended after the cursor.
  writeYard(projectsDir, 'diverged', { history: { entries: h, cursor: 1 }, csvPlants: [p('x', 7.5)] });
  // empty: no history file; the CSV becomes the first entry.
  writeYard(projectsDir, 'empty', { csvPlants: [p('x', 4)] });
  writeFileSync(
    join(projectsDir, 'index.json'),
    JSON.stringify({ defaultProject: 'current', projects: [{ id: 'current', name: 'Current!' }, 'moved', 'diverged', 'empty'] })
  );
}

test('imports every yard once, reconciled exactly as the old client did, and never writes the source', () => {
  const env = setup();
  try {
    fourYards(env.projectsDir);
    const before = snapshot(env.projectsDir);
    const db = openStore(env.dataDir);
    try {
      const result = importLegacyProjects(db, { projectsDir: env.projectsDir, dataDir: env.dataDir, ownerEmail: OWNER });
      assert.equal(result.status, 'imported');
      assert.deepEqual(
        result.projects.map((r) => [r.slug, r.verdict, r.entries, r.cursor, r.status]),
        [
          ['current', 'current', 3, 2, 'imported'],
          ['moved', 'moved', 3, 0, 'imported'],
          ['diverged', 'diverged', 3, 2, 'imported'],
          ['empty', 'empty', 1, 0, 'imported'],
        ]
      );
      const owner = db.prepare('SELECT id FROM users WHERE email = ?').get(OWNER).id;
      // index.json's order and names: the first listed is still the default.
      assert.deepEqual(projectIndexFor(db, owner).projects.map((x) => [x.id, x.name]), [
        ['current', 'Current!'],
        ['moved', 'moved'],
        ['diverged', 'diverged'],
        ['empty', 'empty'],
      ]);

      const current = findOwnedProject(db, owner, 'current');
      assert.equal(current.configJson, readFileSync(join(env.projectsDir, 'current', 'project.json'), 'utf8'));
      assert.equal(current.featuresJson, '{"features":[]}\n');
      assert.equal(current.locationJson, '{"lat":1,"lng":2,"address":"secret"}\n');
      // Full precision from history, not the CSV's three decimals.
      assert.deepEqual(currentPlacements(db, current.id), [p('x', 3)]);
      const history = readHistory(db, current.id);
      assert.deepEqual(history.entries[0], entry('a', [p('x', 1)]), 'ids, timestamps and descriptions kept');
      const photos = join(projectDataDir(env.dataDir, current.id), 'img');
      assert.deepEqual(readdirSync(photos).sort(), ['top.webp', 'top.xcf']);
      assert.equal(readFileSync(join(photos, 'top.webp'), 'utf8'), 'webp-bytes');

      const moved = findOwnedProject(db, owner, 'moved');
      assert.deepEqual(currentPlacements(db, moved.id), [p('x', 1)]);
      assert.equal(readHistory(db, moved.id).entries.length, 3, 'redo still reaches the later entries');

      const diverged = readHistory(db, findOwnedProject(db, owner, 'diverged').id);
      assert.deepEqual(diverged.entries.map((e) => e.description), ['step a', 'step bb', OUTSIDE_EDIT_DESCRIPTION]);
      assert.deepEqual(diverged.entries[2].plants, [p('x', 7.5)]);

      const empty = findOwnedProject(db, owner, 'empty');
      assert.equal(empty.featuresJson, null);
      assert.equal(empty.locationJson, null);
      assert.deepEqual(currentPlacements(db, empty.id), [p('x', 4)]);

      // Once: a second run changes nothing.
      const again = importLegacyProjects(db, { projectsDir: env.projectsDir, dataDir: env.dataDir, ownerEmail: OWNER });
      assert.equal(again.status, 'already-imported');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 4);
    } finally {
      db.close();
    }
    assert.deepEqual(snapshot(env.projectsDir), before, 'the source files were only read');
  } finally {
    env.cleanup();
  }
});

test('fails closed, writing nothing and no marker, on a source it cannot copy faithfully', () => {
  const cases = {
    'a listed yard without project.json': (dir) => {
      fourYards(dir);
      rmSync(join(dir, 'moved', 'project.json'));
    },
    'a history that does not parse': (dir) => {
      fourYards(dir);
      writeFileSync(join(dir, 'moved', 'layout-history.json'), '{"entries": [');
    },
    'a layout row with no species id': (dir) => {
      fourYards(dir);
      writeFileSync(join(dir, 'moved', 'planting_layout.csv'), 'id,botanical_name,x_ft,y_ft\nq,Ilex vomitoria,1,1\n');
    },
    'a duplicate plant id': (dir) => {
      fourYards(dir);
      writeFileSync(join(dir, 'moved', 'planting_layout.csv'), 'id,species_id,x_ft,y_ft\nq,yaupon-holly,1,1\nq,yaupon-holly,2,2\n');
    },
    'yards on disk but no index.json': (dir) => {
      fourYards(dir);
      rmSync(join(dir, 'index.json'));
    },
  };
  for (const [name, arrange] of Object.entries(cases)) {
    const env = setup();
    try {
      arrange(env.projectsDir);
      const db = openStore(env.dataDir);
      try {
        assert.throws(() => importLegacyProjects(db, { projectsDir: env.projectsDir, dataDir: env.dataDir, ownerEmail: OWNER }), name);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 0, name);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM app_meta WHERE key = 'legacy_import.projects'").get().n, 0, name);
      } finally {
        db.close();
      }
      assert.deepEqual(readdirSync(env.dataDir).filter((f) => f === 'projects'), [], `${name}: no photo directory left behind`);
    } finally {
      env.cleanup();
    }
  }
});

test('a copy that does not verify rolls back everything, photos included', () => {
  const env = setup();
  try {
    fourYards(env.projectsDir);
    const db = openStore(env.dataDir);
    try {
      // A trigger that corrupts one config on insert stands in for a copy gone wrong.
      db.exec(`CREATE TRIGGER corrupt AFTER INSERT ON projects WHEN NEW.slug = 'empty'
               BEGIN UPDATE projects SET config_json = 'x' WHERE id = NEW.id; END`);
      assert.throws(
        () => importLegacyProjects(db, { projectsDir: env.projectsDir, dataDir: env.dataDir, ownerEmail: OWNER }),
        /empty: config differs; rolled back/
      );
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM history_entries').get().n, 0);
      assert.deepEqual(readdirSync(join(env.dataDir, 'projects')), [], 'photo directories this run made are removed');
    } finally {
      db.close();
    }
  } finally {
    env.cleanup();
  }
});

test('no owner, no import and no marker; a yard the owner already has is left alone', () => {
  const env = setup();
  try {
    fourYards(env.projectsDir);
    const db = openAppDb({ dataDir: env.dataDir, ownerEmail: '', importLegacy: false });
    try {
      const nobody = importLegacyProjects(db, { projectsDir: env.projectsDir, dataDir: env.dataDir });
      assert.equal(nobody.status, 'no-owner');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM app_meta').get().n, 0);

      const owner = upsertUser(db, OWNER);
      db.prepare(
        "INSERT INTO projects (owner_id, slug, name, config_json, created_at, updated_at) VALUES (?, 'moved', 'Made in the app', '{}', 't', 't')"
      ).run(owner.id);
      const result = importLegacyProjects(db, { projectsDir: env.projectsDir, dataDir: env.dataDir, ownerEmail: OWNER });
      assert.equal(result.projects.find((r) => r.slug === 'moved').status, 'skipped-exists');
      assert.equal(findOwnedProject(db, owner.id, 'moved').name, 'Made in the app');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 4);
    } finally {
      db.close();
    }
  } finally {
    env.cleanup();
  }
});

test('the dry run is read-only, works on a schema-002 app.db, and prints no location', () => {
  const env = setup();
  try {
    fourYards(env.projectsDir);
    mkdirSync(env.dataDir, { recursive: true });
    // app.db as production has it before this migration: 001 and 002 only.
    const migrations = join(env.root, 'old-migrations');
    mkdirSync(migrations);
    const real = fileURLToPath(new URL('../server/db/migrations/', import.meta.url));
    ['001_users.sql', '002_saved_areas_and_feed_state.sql'].forEach((f) =>
      writeFileSync(join(migrations, f), readFileSync(join(real, f)))
    );
    const old = new DatabaseSync(join(env.dataDir, 'app.db'));
    runMigrations(old, migrations);
    upsertUser(old, OWNER);
    old.exec("UPDATE users SET is_admin = 1");
    old.close();
    const appBefore = readFileSync(join(env.dataDir, 'app.db'));

    const report = previewProjectImport({ projectsDir: env.projectsDir, dataDir: env.dataDir });
    assert.equal(report.appDb.schemaVersion, 2);
    assert.equal(report.appDb.hasProjectsTable, false);
    assert.equal(report.owner.email, OWNER, 'the sole admin');
    assert.deepEqual(report.wouldImport, ['current', 'moved', 'diverged', 'empty']);
    assert.deepEqual(report.errors, []);
    assert.equal(report.projects[0].hasLocation, true);
    assert.doesNotMatch(JSON.stringify(report), /secret|"lat"/);
    assert.deepEqual(readFileSync(join(env.dataDir, 'app.db')), appBefore, 'app.db untouched');

    rmSync(join(env.projectsDir, 'moved', 'project.json'));
    const broken = previewProjectImport({ projectsDir: env.projectsDir, dataDir: env.dataDir });
    assert.match(broken.errors[0], /moved: project.json is missing/);
    assert.deepEqual(broken.wouldImport, []);
  } finally {
    env.cleanup();
  }
});
