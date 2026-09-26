// nl-2bw: admin-only free-form notes on plant sales, read later by hand into
// sourcing/plant-sales.csv. Covers: the route (admin CRUD, 404 to a
// non-admin/anonymous caller with no side effect, body validation), and the
// migration (a fresh database, and a database stopped at schema 5, the live
// app.db's schema before this change).
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../server/db/migrate.js';
import { openAppDb } from '../server/db/appDb.js';
import { upsertUser } from '../server/identity.js';
import { handleSaleNotesRoutes } from '../server/routes/saleNotes.js';
import { listSaleNotes, MAX_BODY_LENGTH } from '../server/db/saleNotesStore.js';

const MIGRATIONS_DIR = new URL('../server/db/migrations/', import.meta.url).pathname;

function makeReq(method, body, headers = { 'content-type': 'application/json' }) {
  const chunks = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))];
  const req = Readable.from(chunks);
  req.method = method;
  req.headers = headers;
  return req;
}

function makeRes() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    writeHead(status, headers) {
      this.statusCode = status;
      Object.assign(this.headers, headers || {});
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body) {
      this.body = body;
    },
    json() {
      return JSON.parse(String(this.body));
    },
  };
}

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'sale-notes-test-'));
  const db = openAppDb({ dataDir, ownerEmail: '', importLegacy: false });
  const admin = upsertUser(db, 'admin@example.com');
  db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(admin.id);
  const member = upsertUser(db, 'member@example.com');
  return {
    db,
    admin: { ...admin, isAdmin: true },
    member,
    cleanup: () => {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function call(db, user, method, pathAndQuery, body, headers) {
  const url = new URL(`http://localhost${pathAndQuery}`);
  const ctx = { url, pathname: url.pathname, db: { app: db }, user };
  const res = makeRes();
  const handled = await handleSaleNotesRoutes(makeReq(method, body, headers), res, ctx);
  return { handled, res };
}

// --- authorization -----------------------------------------------------------

test('a non-admin and an anonymous caller both get 404 (requireAdmin never distinguishes the two, nl-3s5.7) from every route, and nothing is written', async () => {
  const env = setup();
  try {
    const before = listSaleNotes(env.db);

    for (const [label, user, expected] of [
      ['anonymous', null, 404],
      ['a signed-in non-admin', env.member, 404],
    ]) {
      assert.equal((await call(env.db, user, 'GET', '/api/sale-notes')).res.statusCode, expected, `GET as ${label}`);
      const posted = await call(env.db, user, 'POST', '/api/sale-notes', { body: 'sneaky note' });
      assert.equal(posted.res.statusCode, expected, `POST as ${label}`);
      const deleted = await call(env.db, user, 'DELETE', '/api/sale-notes/1');
      assert.equal(deleted.res.statusCode, expected, `DELETE as ${label}`);
    }

    assert.deepEqual(listSaleNotes(env.db), before, 'no note was created by the attempts above');
  } finally {
    env.cleanup();
  }
});

test('a signed-in non-admin and anonymous both get exactly the "Not found" body a missing route gets', async () => {
  const env = setup();
  try {
    const asMember = await call(env.db, env.member, 'GET', '/api/sale-notes');
    assert.deepEqual(asMember.res.json(), { error: 'Not found' });
  } finally {
    env.cleanup();
  }
});

// --- admin CRUD ----------------------------------------------------------------

test('an admin can create, list (newest first) and delete notes', async () => {
  const env = setup();
  try {
    const empty = await call(env.db, env.admin, 'GET', '/api/sale-notes');
    assert.equal(empty.res.statusCode, 200);
    assert.deepEqual(empty.res.json(), { notes: [] });

    const first = await call(env.db, env.admin, 'POST', '/api/sale-notes', { body: 'Dallas chapter sale, spring 2027 — check the date' });
    assert.equal(first.res.statusCode, 201, first.res.body);
    const firstNote = first.res.json().note;
    assert.equal(firstNote.body, 'Dallas chapter sale, spring 2027 — check the date');
    assert.equal(typeof firstNote.createdAt, 'string');

    const second = await call(env.db, env.admin, 'POST', '/api/sale-notes', { body: 'Trinity Forks nursery — call to confirm hours' });
    assert.equal(second.res.statusCode, 201);
    const secondNote = second.res.json().note;

    const listed = await call(env.db, env.admin, 'GET', '/api/sale-notes');
    assert.equal(listed.res.statusCode, 200);
    assert.deepEqual(
      listed.res.json().notes.map((n) => n.id),
      [secondNote.id, firstNote.id],
      'newest first'
    );

    const del = await call(env.db, env.admin, 'DELETE', `/api/sale-notes/${firstNote.id}`);
    assert.equal(del.res.statusCode, 200);
    assert.deepEqual(del.res.json(), { id: firstNote.id, deleted: true });

    const afterDelete = await call(env.db, env.admin, 'GET', '/api/sale-notes');
    assert.deepEqual(afterDelete.res.json().notes.map((n) => n.id), [secondNote.id]);

    const missing = await call(env.db, env.admin, 'DELETE', `/api/sale-notes/${firstNote.id}`);
    assert.equal(missing.res.statusCode, 404, 'deleting an already-deleted (or never existing) id');
  } finally {
    env.cleanup();
  }
});

// --- body validation -------------------------------------------------------------

test('an empty or whitespace-only body is refused with 400 and writes nothing', async () => {
  const env = setup();
  try {
    for (const body of ['', '   ', '\n\n']) {
      const res = await call(env.db, env.admin, 'POST', '/api/sale-notes', { body });
      assert.equal(res.res.statusCode, 400, JSON.stringify(body));
    }
    assert.deepEqual(listSaleNotes(env.db), []);
  } finally {
    env.cleanup();
  }
});

test(`a body over ${MAX_BODY_LENGTH} characters is refused with 400 and writes nothing; exactly the cap is accepted`, async () => {
  const env = setup();
  try {
    const tooLong = 'x'.repeat(MAX_BODY_LENGTH + 1);
    const over = await call(env.db, env.admin, 'POST', '/api/sale-notes', { body: tooLong });
    assert.equal(over.res.statusCode, 400);
    assert.deepEqual(listSaleNotes(env.db), []);

    const exact = 'x'.repeat(MAX_BODY_LENGTH);
    const ok = await call(env.db, env.admin, 'POST', '/api/sale-notes', { body: exact });
    assert.equal(ok.res.statusCode, 201, ok.res.body);
    assert.equal(listSaleNotes(env.db).length, 1);
  } finally {
    env.cleanup();
  }
});

test('the body is trimmed before it is stored', async () => {
  const env = setup();
  try {
    const res = await call(env.db, env.admin, 'POST', '/api/sale-notes', { body: '  a real note  ' });
    assert.equal(res.res.json().note.body, 'a real note');
  } finally {
    env.cleanup();
  }
});

// --- migration -------------------------------------------------------------------

function schemaAt005(dir) {
  const stopped = join(dir, 'migrations-005');
  mkdirSync(stopped);
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    if (/^00[1-5]_.+\.sql$/.test(name)) copyFileSync(join(MIGRATIONS_DIR, name), join(stopped, name));
  }
  return stopped;
}

test('006 applies to a fresh database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sale-notes-migrate-fresh-'));
  const db = new DatabaseSync(join(dir, 'app.db'));
  try {
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    assert.ok(db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v >= 6);
    db.prepare("INSERT INTO users (email, is_admin, created_at) VALUES ('a@example.com', 1, 't')").run();
    db.prepare("INSERT INTO sale_notes (author_id, body, created_at) VALUES (1, 'note', 't')").run();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sale_notes').get().n, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('006 applies to a database stopped at schema 5 (the live app.db before this change), touching nothing else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sale-notes-migrate-005-'));
  const db = new DatabaseSync(join(dir, 'app.db'));
  try {
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, schemaAt005(dir));
    assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 5);

    db.prepare("INSERT INTO users (email, is_admin, created_at) VALUES ('a@example.com', 1, 't')").run();
    const insertProject = db.prepare(
      `INSERT INTO projects (owner_id, slug, name, config_json, history_cursor, created_at, updated_at)
       VALUES (1, 'yard', 'Yard', '{}', -1, 't', 't')`
    );
    insertProject.run();
    const projectsBefore = db.prepare('SELECT * FROM projects ORDER BY id').all();

    runMigrations(db, MIGRATIONS_DIR);

    // 6 or later: migrations added after 006 (007, nl-3on) apply on top.
    assert.ok(db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v >= 6);
    assert.deepEqual(db.prepare('SELECT * FROM projects ORDER BY id').all(), projectsBefore, 'existing tables untouched');

    db.prepare("INSERT INTO sale_notes (author_id, body, created_at) VALUES (1, 'note', 't')").run();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sale_notes').get().n, 1);

    // Re-running the full migration set on an already-current schema is a no-op.
    runMigrations(db, MIGRATIONS_DIR);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sale_notes').get().n, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
