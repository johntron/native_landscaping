// nl-3s5.24: the shared example yard's refresh and seed (server/db/exampleYard.js,
// run by tools/refresh-example-yard.mjs and server.js). What gets copied, that
// nothing location-like survives, that a second run writes nothing, and that
// the owner's yard is only ever read. Who may read and write the example is
// tests/projectAuthorization.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAppDb } from '../server/db/appDb.js';
import { upsertUser } from '../server/identity.js';
import {
  EXAMPLE_OWNER_EMAIL,
  findExampleProject,
  insertProject,
  projectDataDir,
  readRevisions,
  recordLayout,
} from '../server/db/projectStore.js';
import {
  EXAMPLE_META_KEY,
  EXAMPLE_NAME,
  findGeoKeys,
  seedExampleYardIfMissing,
  snapshotFromOwnerYard,
  stripGeo,
  writeExampleYard,
} from '../server/db/exampleYard.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(32)]);
const OWNER = 'owner@example.com';

/** Location-ish keys planted at every level a yard stores, to prove they are stripped. */
const LEAKY_CONFIG = {
  name: 'Backyard',
  yardFt: { width: 20, depth: 15 },
  place: 'home',
  address: '1 Secret Lane',
  location: { lat: 32.123, lng: -96.456 },
  site: { sun: 'full-sun', latitude: 32.123 },
  views: [
    { id: 'plan', type: 'plan', background: 'img/top.webp', lat: 32.123, lng: -96.456 },
    { id: 'south', type: 'elevation', viewFrom: 'south', background: 'img/south.webp', viewerAtFt: 3 },
  ],
};
const LEAKY_FEATURES = {
  features: [{ id: 'trellis', type: 'trellis', pathFt: [{ x: 1, y: 1 }, { x: 4, y: 1 }], heightFt: 7, address: '1 Secret Lane' }],
};
const plants = (x) => [
  { id: 'p1', speciesId: 'yaupon-holly', x, y: 2, lat: 32.123, lng: -96.456 },
  { id: 'p2', speciesId: 'winecup', x: 5, y: 6 },
];

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'example-yard-test-'));
  const db = openAppDb({ dataDir, ownerEmail: OWNER, importLegacy: false });
  const owner = upsertUser(db, OWNER);
  const sourceId = insertProject(db, {
    ownerId: owner.id,
    slug: 'backyard',
    name: 'Backyard',
    configJson: JSON.stringify(LEAKY_CONFIG),
    featuresJson: JSON.stringify(LEAKY_FEATURES),
    locationJson: JSON.stringify({ lat: 32.123, lng: -96.456, address: '1 Secret Lane' }),
    entries: [
      { id: 'e0', timestamp: '2026-01-01T00:00:00Z', description: 'first', plants: plants(1) },
      { id: 'e1', timestamp: '2026-01-02T00:00:00Z', description: 'second', plants: plants(2) },
      { id: 'e2', timestamp: '2026-01-03T00:00:00Z', description: 'undone', plants: plants(3) },
    ],
    cursor: 1, // the yard shows e1; e2 is a redo tail the example must not take
  });
  const img = join(projectDataDir(dataDir, sourceId), 'img');
  mkdirSync(img, { recursive: true });
  writeFileSync(join(img, 'top.webp'), WEBP);
  writeFileSync(join(img, 'south.webp'), Buffer.concat([WEBP, Buffer.from('s')]));
  writeFileSync(join(img, 'top.xcf'), 'a working file nothing names');
  const refresh = (options = {}) => {
    const snap = snapshotFromOwnerYard(db, { dataDir, ownerEmail: OWNER, slug: 'backyard' });
    return writeExampleYard(db, { dataDir, ...snap, ...options });
  };
  const source = () => ({
    row: db.prepare('SELECT * FROM projects WHERE id = ?').get(sourceId),
    history: db.prepare('SELECT * FROM history_entries WHERE project_id = ?').all(sourceId),
    files: readdirSync(img).sort().map((f) => [f, readFileSync(join(img, f)).toString('hex')]),
  });
  const example = () => {
    const found = findExampleProject(db);
    return found && {
      row: db.prepare('SELECT * FROM projects WHERE id = ?').get(found.id),
      history: db.prepare('SELECT * FROM history_entries WHERE project_id = ?').all(found.id),
      meta: db.prepare('SELECT * FROM app_meta WHERE key = ?').get(EXAMPLE_META_KEY),
      files: readdirSync(join(projectDataDir(dataDir, found.id), 'img')).sort(),
    };
  };
  return {
    db,
    dataDir,
    owner,
    sourceId,
    refresh,
    source,
    example,
    cleanup() {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test('stripGeo and findGeoKeys: place keys go at any depth, yard feet stay', () => {
  const stripped = stripGeo({ a: { lat: 1, x: 2, list: [{ address: 'x', y: 3 }] }, Longitude: 4, originFt: { x: 1, y: 2 } });
  assert.deepEqual(stripped, { a: { x: 2, list: [{ y: 3 }] }, originFt: { x: 1, y: 2 } });
  assert.deepEqual(findGeoKeys(stripped), []);
  assert.deepEqual(findGeoKeys({ views: [{ lng: 1 }] }), ['$.views[0].lng']);
});

test('refresh: the example is a stripped copy of the state at the cursor, and the source is only read', () => {
  const env = setup();
  try {
    const before = env.source();
    const result = env.refresh();
    assert.equal(result.status, 'created');
    assert.deepEqual(env.source(), before, "the owner's yard, history and photos are untouched");

    const found = findExampleProject(env.db);
    assert.equal(found.name, EXAMPLE_NAME);
    assert.equal(found.locationJson, null);
    assert.equal(found.visibility, 'private', 'the allowlist, not visibility, makes it readable');
    const owner = env.db.prepare('SELECT email, is_admin FROM users WHERE id = ?').get(found.ownerId);
    assert.deepEqual({ ...owner }, { email: EXAMPLE_OWNER_EMAIL, is_admin: 0 });

    const revisions = readRevisions(env.db, found.id);
    assert.equal(revisions.length, 1);
    assert.equal(found.historyCursor, 0);
    assert.deepEqual(revisions[0].plants, [
      { id: 'p1', speciesId: 'yaupon-holly', x: 2, y: 2 },
      { id: 'p2', speciesId: 'winecup', x: 5, y: 6 },
    ], 'the revision at the cursor (e1), without its lat/lng');
    assert.equal(revisions[0].timestamp, '2026-01-02T00:00:00Z');

    const config = JSON.parse(found.configJson);
    assert.equal(config.id, 'example');
    assert.equal(config.place, 'home', 'the place label is kept (its ecology rows are already public)');
    assert.equal(config.views[1].viewerAtFt, 3, 'yard feet are kept');
    assert.equal(revisions[0].configJson, found.configJson);
    // Nothing that names a place on the earth, anywhere the example stores.
    const stored = [found.configJson, found.featuresJson, revisions[0].configJson, revisions[0].featuresJson, JSON.stringify(revisions[0].plants)];
    for (const text of stored) {
      assert.deepEqual(findGeoKeys(JSON.parse(text)), []);
      assert.equal(/Secret|32\.123|96\.456/.test(text), false, text);
    }

    // Only the photos the config names; never the .xcf.
    assert.deepEqual(env.example().files, ['south.webp', 'top.webp']);
    assert.deepEqual(result.photos.sort(), ['south.webp', 'top.webp']);

    const meta = JSON.parse(env.example().meta.value);
    assert.equal(meta.from, 'app.db');
    assert.equal(meta.projectId, env.sourceId);
    assert.deepEqual(meta.revision, { seq: 1, id: 'e1', timestamp: '2026-01-02T00:00:00Z' });
    assert.equal(JSON.stringify(meta).includes(OWNER), false, 'no email in the record');
  } finally {
    env.cleanup();
  }
});

test('refresh is idempotent: a second run writes nothing; a changed source updates the same row', () => {
  const env = setup();
  try {
    assert.equal(env.refresh({ now: '2026-02-01T00:00:00Z' }).status, 'created');
    const first = env.example();
    assert.equal(env.refresh({ now: '2026-02-02T00:00:00Z' }).status, 'unchanged');
    assert.deepEqual(env.example(), first, 'rows, updated_at, app_meta and photos all identical');
    assert.equal(env.refresh({ dryRun: true }).status, 'unchanged');

    // The owner moves a plant: the next refresh updates in place.
    recordLayout(env.db, env.sourceId, { id: 'e3', timestamp: '2026-01-04T00:00:00Z', description: 'moved', plants: plants(8) });
    assert.equal(env.refresh({ dryRun: true, now: '2026-02-03T00:00:00Z' }).status, 'would-update');
    assert.deepEqual(env.example(), first, 'a dry run writes nothing');
    const updated = env.refresh({ now: '2026-02-03T00:00:00Z' });
    assert.equal(updated.status, 'updated');
    assert.equal(updated.projectId, first.row.id, 'same row id, so the same photo directory and URL');
    const after = env.example();
    assert.equal(after.history.length, 1);
    assert.equal(JSON.parse(after.history[0].plants_json)[0].x, 8);
    assert.equal(after.row.updated_at, '2026-02-03T00:00:00Z');
    assert.deepEqual(after.files, first.files);
    assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = ?").get(EXAMPLE_OWNER_EMAIL).n, 1);
  } finally {
    env.cleanup();
  }
});

test('refresh refuses to copy from the example itself, or from a yard that does not exist', () => {
  const env = setup();
  try {
    env.refresh();
    assert.throws(() => snapshotFromOwnerYard(env.db, { dataDir: env.dataDir, ownerEmail: EXAMPLE_OWNER_EMAIL, slug: 'example' }), /itself/);
    assert.throws(() => snapshotFromOwnerYard(env.db, { dataDir: env.dataDir, ownerEmail: OWNER, slug: 'nope' }), /No yard/);
    assert.throws(() => snapshotFromOwnerYard(env.db, { dataDir: env.dataDir, ownerEmail: 'nobody@example.com' }), /No user/);
  } finally {
    env.cleanup();
  }
});

test('startup seed: from the tracked projects/backyard when there is no example, and never over one', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'example-seed-test-'));
  const db = openAppDb({ dataDir, ownerEmail: '', importLegacy: false });
  try {
    const seeded = seedExampleYardIfMissing(db, { dataDir });
    assert.equal(seeded.status, 'created', seeded.error);
    const found = findExampleProject(db);
    assert.equal(found.locationJson, null);
    assert.equal(readRevisions(db, found.id).length, 1);
    assert.ok(readRevisions(db, found.id)[0].plants.length > 0, 'the seed has a planting');
    assert.deepEqual(findGeoKeys(JSON.parse(found.configJson)), []);
    const photos = readdirSync(join(projectDataDir(dataDir, found.id), 'img'));
    assert.ok(photos.length > 0 && photos.every((f) => f.endsWith('.webp')), photos.join());
    assert.equal(JSON.parse(db.prepare('SELECT value FROM app_meta WHERE key = ?').get(EXAMPLE_META_KEY).value).from, 'seed');

    const before = db.prepare('SELECT * FROM projects WHERE id = ?').get(found.id);
    assert.equal(seedExampleYardIfMissing(db, { dataDir }).status, 'present');
    assert.deepEqual(db.prepare('SELECT * FROM projects WHERE id = ?').get(found.id), before);
    assert.equal(seedExampleYardIfMissing(db, { dataDir, seedDir: join(dataDir, 'nowhere') }).status, 'present');
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
  const empty = mkdtempSync(join(tmpdir(), 'example-seed-test-'));
  const db2 = openAppDb({ dataDir: empty, ownerEmail: '', importLegacy: false });
  try {
    assert.equal(seedExampleYardIfMissing(db2, { dataDir: empty, seedDir: join(empty, 'nowhere') }).status, 'no-seed');
    assert.equal(findExampleProject(db2), null);
  } finally {
    db2.close();
    rmSync(empty, { recursive: true, force: true });
  }
});

test('tools/refresh-example-yard.mjs: dry run, run, and a second run that changes nothing', () => {
  const env = setup();
  env.db.close();
  try {
    const run = (...args) =>
      spawnSync(process.execPath, [join(REPO_ROOT, 'tools', 'refresh-example-yard.mjs'), ...args], {
        env: { ...process.env, DATA_DIR: env.dataDir, OWNER_EMAIL: OWNER },
        encoding: 'utf-8',
      });
    const dry = run('--dry-run');
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /Would create/);
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Created the example yard/);
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /nothing written/);
    for (const out of [dry.stdout, first.stdout, second.stdout]) {
      assert.equal(/Secret|32\.123|96\.456|owner@example\.com/.test(out), false, out);
    }
  } finally {
    rmSync(env.dataDir, { recursive: true, force: true });
  }
});
