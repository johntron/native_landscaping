// nl-3on: species a person marks favorite / most wanted. Covers the route
// (signed-in only, the caller's own rows, ids checked against plants.csv) and
// the migration on a database stopped at schema 6, the live app.db's schema
// before this change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../server/db/migrate.js';
import { openAppDb } from '../server/db/appDb.js';
import { upsertUser } from '../server/identity.js';
import { handleFavoritesRoutes } from '../server/routes/favorites.js';
import { listFavorites } from '../server/db/favoritesStore.js';

const MIGRATIONS_DIR = new URL('../server/db/migrations/', import.meta.url).pathname;

function makeReq(method, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.headers = { 'content-type': 'application/json' };
  return req;
}

function makeRes() {
  return {
    statusCode: null,
    body: null,
    writeHead(status) {
      this.statusCode = status;
    },
    setHeader() {},
    end(body) {
      this.body = body;
    },
    json() {
      return JSON.parse(String(this.body));
    },
  };
}

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'favorites-test-'));
  const publicDir = mkdtempSync(join(tmpdir(), 'favorites-public-'));
  writeFileSync(join(publicDir, 'plants.csv'), 'id,common_name,botanical_name\nyarrow,Yarrow,Achillea millefolium\nbluebonnet,Bluebonnet,Lupinus texensis\n');
  const db = openAppDb({ dataDir, ownerEmail: '', importLegacy: false });
  return {
    db,
    publicDir,
    alice: upsertUser(db, 'alice@example.com'),
    bob: upsertUser(db, 'bob@example.com'),
    cleanup: () => {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(publicDir, { recursive: true, force: true });
    },
  };
}

async function call(env, user, method, body, pathname = '/api/favorites') {
  const res = makeRes();
  const ctx = { url: new URL(`http://localhost${pathname}`), pathname, db: { app: env.db }, user, publicDir: env.publicDir };
  const handled = await handleFavoritesRoutes(makeReq(method, body), res, ctx);
  return { handled, res };
}

test('an anonymous caller gets 401 and nothing is written; other paths are not handled', async () => {
  const env = setup();
  try {
    assert.equal((await call(env, null, 'GET')).res.statusCode, 401);
    assert.equal((await call(env, null, 'PUT', { speciesId: 'yarrow', favorite: true })).res.statusCode, 401);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM species_favorites').get().n, 0);
    assert.equal((await call(env, env.alice, 'GET', undefined, '/api/favorites/x')).handled, false);
  } finally {
    env.cleanup();
  }
});

test('a person marks and unmarks favorites, idempotently, and sees only their own', async () => {
  const env = setup();
  try {
    let r = await call(env, env.alice, 'PUT', { speciesId: 'yarrow', favorite: true });
    assert.deepEqual(r.res.json(), { speciesIds: ['yarrow'] });
    r = await call(env, env.alice, 'PUT', { speciesId: 'yarrow', favorite: true });
    assert.deepEqual(r.res.json(), { speciesIds: ['yarrow'] });
    await call(env, env.bob, 'PUT', { speciesId: 'bluebonnet', favorite: true });
    assert.deepEqual((await call(env, env.alice, 'GET')).res.json(), { speciesIds: ['yarrow'] });
    assert.deepEqual((await call(env, env.bob, 'GET')).res.json(), { speciesIds: ['bluebonnet'] });
    r = await call(env, env.alice, 'PUT', { speciesId: 'yarrow', favorite: false });
    assert.deepEqual(r.res.json(), { speciesIds: [] });
    assert.deepEqual(listFavorites(env.db, env.bob.id), ['bluebonnet']);
  } finally {
    env.cleanup();
  }
});

test('an id that is not in plants.csv, or a favorite that is not a boolean, is refused and not stored', async () => {
  const env = setup();
  try {
    for (const body of [{ speciesId: 'no-such-plant', favorite: true }, { speciesId: '', favorite: true }, { speciesId: 'yarrow', favorite: 'yes' }]) {
      assert.equal((await call(env, env.alice, 'PUT', body)).res.statusCode, 400, JSON.stringify(body));
    }
    assert.equal((await call(env, env.alice, 'DELETE')).res.statusCode, 405);
    assert.deepEqual(listFavorites(env.db, env.alice.id), []);
  } finally {
    env.cleanup();
  }
});

test('migration 007 applies to a database stopped at schema 6 and keeps its rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'favorites-migrate-'));
  try {
    // The migrations up to 006 only, copied aside: the live app.db's schema before 007.
    const upTo006 = join(dir, 'migrations-006');
    mkdirSync(upTo006);
    readdirSync(MIGRATIONS_DIR)
      .filter((name) => /^00[1-6]_/.test(name))
      .forEach((name) => copyFileSync(join(MIGRATIONS_DIR, name), join(upTo006, name)));
    const db = new DatabaseSync(join(dir, 'app.db'));
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, upTo006);
    assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 6);
    db.prepare("INSERT INTO users (email, created_at) VALUES ('a@example.com', '2026-01-01')").run();
    runMigrations(db, MIGRATIONS_DIR);
    assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 7);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
    db.prepare("INSERT INTO species_favorites (user_id, species_id, created_at) VALUES (1, 'yarrow', '2026-09-26')").run();
    db.prepare('DELETE FROM users WHERE id = 1').run();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM species_favorites').get().n, 0, 'a user’s favorites go with the user');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
