// nl-3s5.4: every route that reads or writes a yard is authorized by owner.
//
// Two users, A (alice) and B (bob), each own a yard, plus an anonymous caller.
// For every project route, called with B's slug:
//   - anonymous gets 401,
//   - A gets 404, the same response a slug nobody created gets (so ids are not
//     disclosed), and nothing changes: not B's row, not B's history, not a
//     file under DATA_DIR/projects,
//   - B gets a 2xx with the same request, which proves the request was valid
//     and A's 404 can only have come from authorization.
// Each route runs in a fresh environment: B's successful writes (a config save
// sweeps orphaned photos, a layout save moves the cursor) must not leak into
// the next row.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { openAppDb } from '../server/db/appDb.js';
import { upsertUser } from '../server/identity.js';
import {
  ASSIGNABLE_VISIBILITIES,
  EXAMPLE_OWNER_EMAIL,
  EXAMPLE_SLUG,
  PROJECT_VISIBILITIES,
  findExampleProject,
  findOwnedProject,
  insertProject,
  projectDataDir,
  projectIndexFor,
  readRevisions,
} from '../server/db/projectStore.js';
import { COPY_NAME, EXAMPLE_NAME, findGeoKeys, snapshotFromOwnerYard, writeExampleYard } from '../server/db/exampleYard.js';
import { createRateLimiter, EXAMPLE_READ_ONLY_ERROR } from '../server/http.js';
import { handleProjectRoutes } from '../server/routes/project.js';
import { handleEcosystemRoutes } from '../server/routes/ecosystem.js';
import { serveStaticFile } from '../server/static.js';

const PHOTO = 'img/top.webp';
const CONFIG = {
  name: 'Yard',
  yardFt: { width: 20, depth: 15 },
  place: 'home',
  views: [{ id: 'plan', type: 'plan', background: PHOTO }],
};
const placement = (id, x) => ({ id, speciesId: 'yaupon-holly', x, y: 1 });
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(32)]);

/** A yard with everything a route could touch: config, features, location, two history entries, a photo. */
function addYard(env, owner, slug) {
  const id = insertProject(env.db, {
    ownerId: owner.id,
    slug,
    name: slug,
    configJson: JSON.stringify(CONFIG),
    featuresJson: JSON.stringify({ features: [] }),
    locationJson: JSON.stringify({ lat: 32.5, lng: -96.5, address: 'somewhere' }),
    entries: [
      { id: `${slug}-e0`, timestamp: '2026-01-01T00:00:00Z', description: 'first', plants: [placement('p1', 1)] },
      { id: `${slug}-e1`, timestamp: '2026-01-02T00:00:00Z', description: 'second', plants: [placement('p1', 2)] },
    ],
  });
  const img = join(projectDataDir(env.dataDir, id), 'img');
  mkdirSync(img, { recursive: true });
  writeFileSync(join(img, 'top.webp'), WEBP);
  return id;
}

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'project-authz-test-'));
  const db = openAppDb({ dataDir, ownerEmail: '', importLegacy: false });
  const env = { dataDir, db };
  env.alice = upsertUser(db, 'alice@example.com');
  env.bob = upsertUser(db, 'bob@example.com');
  env.aliceYardId = addYard(env, env.alice, 'alice-yard');
  env.bobYardId = addYard(env, env.bob, 'bob-yard');
  env.cleanup = () => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return env;
}

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
    headersSent: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headersSent = true;
      Object.assign(this.headers, headers || {});
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body, cb) {
      this.body = body;
      if (typeof cb === 'function') cb();
    },
    json() {
      return JSON.parse(String(this.body));
    },
  };
}

// Empty rows, so /api/ecosystem needs no ecosystem.db; the place rows are not
// what this test is about.
const ECOSYSTEM_DB = { prepare: () => ({ all: () => [] }) };

/** Route the request the way server.js does: the first handler that takes it answers. */
async function call(env, user, method, pathAndQuery, body, headers) {
  const url = new URL(`http://localhost${pathAndQuery}`);
  const ctx = {
    url,
    pathname: url.pathname,
    dataDir: env.dataDir,
    db: { app: env.db, ecosystem: ECOSYSTEM_DB },
    user,
    // A fresh limiter per call unless the test brings its own: user ids repeat
    // across these throwaway databases, so the module's shared one would
    // carry one test's copies into the next.
    copyExampleLimiter: env.copyExampleLimiter || createRateLimiter(),
  };
  const res = makeRes();
  for (const handle of [handleProjectRoutes, handleEcosystemRoutes]) {
    if (await handle(makeReq(method, body, headers), res, ctx)) return res;
  }
  return null;
}

/** Every file under DATA_DIR/projects with a hash of its bytes. */
function fileTree(dataDir) {
  const root = join(dataDir, 'projects');
  const out = {};
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        out[`${relative(root, full)}/`] = 'dir';
        walk(full);
      } else {
        out[relative(root, full)] = crypto.createHash('sha256').update(readFileSync(full)).digest('hex');
      }
    }
  };
  walk(root);
  return out;
}

/** Everything a route could change: both tables in full, and the photo files. */
function snapshot(env) {
  return {
    projects: env.db.prepare('SELECT * FROM projects ORDER BY id').all(),
    history: env.db.prepare('SELECT * FROM history_entries ORDER BY project_id, seq').all(),
    files: fileTree(env.dataDir),
  };
}

// The enumeration: every route that reads or writes a yard. Each takes the
// yard as ?project=<slug>; none takes it from a JSON body or the path.
const JSON_HEADERS = { 'content-type': 'application/json' };
const ROUTES = [
  { method: 'GET', path: '/api/project' },
  { method: 'POST', path: '/api/project', body: () => ({ ...CONFIG, name: 'Renamed' }) },
  { method: 'GET', path: '/api/history' },
  { method: 'GET', path: '/api/layout' },
  { method: 'POST', path: '/api/layout', body: () => ({ plants: [placement('p1', 3)], description: 'third', id: 'e-new' }) },
  { method: 'POST', path: '/api/history/cursor', body: () => ({ cursor: 0 }) },
  { method: 'GET', path: '/api/features' },
  { method: 'POST', path: '/api/features', body: () => ({ features: [] }) },
  { method: 'GET', path: '/api/project-photo', query: `&path=${encodeURIComponent(PHOTO)}` },
  { method: 'POST', path: '/api/view-background', query: '&view=plan', body: () => WEBP, headers: { 'content-type': 'image/webp' } },
  { method: 'GET', path: '/api/ecosystem', query: '&place=home' },
];

for (const route of ROUTES) {
  const label = `${route.method} ${route.path}`;
  test(`${label}: anonymous 401, A 404 on B's yard with no side effect, B succeeds`, async () => {
    const env = setup();
    try {
      const request = (user, slug) =>
        call(env, user, route.method, `${route.path}?project=${slug}${route.query || ''}`, route.body?.(), route.headers || JSON_HEADERS);

      const before = snapshot(env);

      const anonymous = await request(null, 'bob-yard');
      assert.ok(anonymous, `${label} was handled`);
      assert.equal(anonymous.statusCode, 401, `${label} anonymous`);

      const asAlice = await request(env.alice, 'bob-yard');
      assert.equal(asAlice.statusCode, 404, `${label} as A on B's yard`);
      // Indistinguishable from a slug that was never created.
      const neverMade = await request(env.alice, 'never-made');
      assert.equal(neverMade.statusCode, 404);
      assert.equal(String(asAlice.body), String(neverMade.body), `${label}: B's slug and a missing one answer alike`);
      assert.deepEqual(asAlice.json(), { error: 'Project not found' });

      assert.deepEqual(snapshot(env), before, `${label}: nothing changed after A and anonymous`);

      const asBob = await request(env.bob, 'bob-yard');
      assert.ok(asBob.statusCode >= 200 && asBob.statusCode < 300, `${label} as B: ${asBob.statusCode} ${asBob.body}`);
    } finally {
      env.cleanup();
    }
  });
}

test('every project route in the handler is covered by the table above', async () => {
  // A route added to server/routes/project.js without a row here would escape
  // this test. Probe the handler for each known pathname and method, and
  // fail on any /api/project* or /api/history* or /api/layout path it takes
  // that the table does not list.
  const env = setup();
  try {
    const covered = new Set(ROUTES.map((r) => `${r.method} ${r.path}`));
    covered.add('GET /api/projects');
    covered.add('POST /api/projects');
    covered.add('POST /api/projects/copy-example'); // its own tests, below
    const source = readFileSync(new URL('../server/routes/project.js', import.meta.url), 'utf-8');
    const found = [...source.matchAll(/pathname === '([^']+)' && req\.method === '([A-Z]+)'/g)].map(
      ([, path, method]) => `${method} ${path}`
    );
    assert.ok(found.length >= 12, `found ${found.length} routes`);
    for (const route of found) assert.ok(covered.has(route), `${route} has no authorization row`);
  } finally {
    env.cleanup();
  }
});

// --- the yard list and create --------------------------------------------------

test('GET /api/projects lists only the caller\'s yards, and 401s anonymous', async () => {
  const env = setup();
  try {
    assert.equal((await call(env, null, 'GET', '/api/projects')).statusCode, 401);
    assert.deepEqual((await call(env, env.alice, 'GET', '/api/projects')).json(), {
      defaultProject: 'alice-yard',
      projects: [{ id: 'alice-yard', name: 'alice-yard' }],
    });
    assert.deepEqual((await call(env, env.bob, 'GET', '/api/projects')).json(), {
      defaultProject: 'bob-yard',
      projects: [{ id: 'bob-yard', name: 'bob-yard' }],
    });
  } finally {
    env.cleanup();
  }
});

test('POST /api/projects creates in the caller\'s own namespace, never touching another owner\'s same slug', async () => {
  const env = setup();
  try {
    assert.equal((await call(env, null, 'POST', '/api/projects', { id: 'bob-yard', name: 'x' })).statusCode, 401);
    const bobBefore = env.db.prepare('SELECT * FROM projects WHERE id = ?').get(env.bobYardId);
    const historyBefore = env.db.prepare('SELECT * FROM history_entries WHERE project_id = ?').all(env.bobYardId);
    const filesBefore = fileTree(env.dataDir);

    // A body that tries to make the new yard public: ignored.
    const res = await call(env, env.alice, 'POST', '/api/projects', { id: 'bob-yard', name: 'Mine', visibility: 'public' });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json().index.projects.map((p) => p.id), ['alice-yard', 'bob-yard']);

    const alices = findOwnedProject(env.db, env.alice.id, 'bob-yard');
    assert.notEqual(alices.id, env.bobYardId);
    assert.equal(alices.name, 'Mine');
    assert.equal(alices.visibility, 'private');
    assert.equal('visibility' in JSON.parse(alices.configJson), false, 'no shadow visibility in the stored config');

    assert.deepEqual(env.db.prepare('SELECT * FROM projects WHERE id = ?').get(env.bobYardId), bobBefore);
    assert.deepEqual(env.db.prepare('SELECT * FROM history_entries WHERE project_id = ?').all(env.bobYardId), historyBefore);
    assert.deepEqual(fileTree(env.dataDir), filesBefore, 'a create writes no files');
    assert.deepEqual(projectIndexFor(env.db, env.bob.id).projects, [{ id: 'bob-yard', name: 'bob-yard' }]);

    // A second create of the same slug is the caller's own duplicate, not B's.
    assert.equal((await call(env, env.alice, 'POST', '/api/projects', { id: 'bob-yard' })).statusCode, 400);
  } finally {
    env.cleanup();
  }
});

test('two owners with the same slug: every write by A lands on A\'s yard only', async () => {
  const env = setup();
  try {
    const aId = addYard(env, env.alice, 'backyard');
    const bId = addYard(env, env.bob, 'backyard');
    const bRow = () => env.db.prepare('SELECT * FROM projects WHERE id = ?').get(bId);
    const bHistory = () => env.db.prepare('SELECT * FROM history_entries WHERE project_id = ?').all(bId);
    const bFiles = () => readdirSync(join(projectDataDir(env.dataDir, bId), 'img')).sort();
    const before = { row: bRow(), history: bHistory(), files: bFiles() };

    const ok = async (method, path, body, headers) => {
      const res = await call(env, env.alice, method, path, body, headers);
      assert.equal(res.statusCode, 200, `${method} ${path}: ${res.body}`);
      return res;
    };
    await ok('POST', '/api/project?project=backyard', { ...CONFIG, name: 'A renamed' });
    await ok('POST', '/api/layout?project=backyard', { plants: [placement('p9', 9)], id: 'a-entry' });
    // Revision 2 is A's rename (0 and 1 came with the yard, 3 is the layout):
    // a cursor move restores the setup of the revision it lands on (nl-3s5.20).
    await ok('POST', '/api/history/cursor?project=backyard', { cursor: 2 });
    await ok('POST', '/api/features?project=backyard', { features: [] });
    await ok('POST', '/api/view-background?project=backyard&view=north', WEBP, { 'content-type': 'image/webp' });

    assert.deepEqual({ row: bRow(), history: bHistory(), files: bFiles() }, before, 'B\'s backyard untouched');
    assert.equal(findOwnedProject(env.db, env.alice.id, 'backyard').name, 'A renamed');
    assert.equal(readdirSync(join(projectDataDir(env.dataDir, aId), 'img')).some((f) => f.startsWith('north-')), true);
  } finally {
    env.cleanup();
  }
});

// --- path and id tricks ----------------------------------------------------------

test('/api/project-photo cannot reach another yard\'s photo through the path or the project id', async () => {
  const env = setup();
  try {
    const b = env.bobYardId;
    const before = snapshot(env);
    const photoAsAlice = (query) => call(env, env.alice, 'GET', `/api/project-photo?${query}`);

    // Alice's own yard, with a path that climbs into Bob's directory.
    for (const raw of [
      `../${b}/img/top.webp`,
      `img/../../${b}/img/top.webp`,
      `img/../img/top.webp`,
      `/etc/passwd`,
      join(projectDataDir(env.dataDir, b), 'img', 'top.webp'), // absolute path
      `img\\..\\..\\${b}\\img\\top.webp`,
      `img/top.webp/../../../${b}/img/top.webp`,
    ]) {
      const res = await photoAsAlice(`project=alice-yard&path=${encodeURIComponent(raw)}`);
      assert.equal(res.statusCode, 404, raw);
    }
    // Encoded and double-encoded slashes, left for the server to decode.
    for (const encoded of [`..%2F${b}%2Fimg%2Ftop.webp`, `img%2F..%2F..%2F${b}%2Fimg%2Ftop.webp`, `..%252F${b}%252Fimg%252Ftop.webp`]) {
      assert.equal((await photoAsAlice(`project=alice-yard&path=${encoded}`)).statusCode, 404, encoded);
    }
    // Tricks in the project parameter: a numeric id, a traversal, case, an
    // encoded slash, a trailing segment. None resolves to Bob's yard.
    for (const project of [String(b), `../${b}`, '..%2Fbob-yard', 'Bob-Yard', 'bob-yard%2F..', 'bob-yard/', ' bob-yard', 'bob-yard%00']) {
      const res = await photoAsAlice(`project=${project}&path=${encodeURIComponent(PHOTO)}`);
      assert.equal(res.statusCode, 404, project);
      assert.deepEqual(res.json(), { error: 'Project not found' }, project);
    }
    // A project id in the path is not a route at all.
    assert.equal(await call(env, env.alice, 'GET', `/api/project-photo/${b}/img/top.webp`), null);

    assert.deepEqual(snapshot(env), before);
  } finally {
    env.cleanup();
  }
});

test('/api/view-background cannot write outside the caller\'s own img/ directory', async () => {
  const env = setup();
  try {
    const before = snapshot(env);
    const upload = (query) =>
      call(env, env.alice, 'POST', `/api/view-background?${query}`, WEBP, { 'content-type': 'image/webp' });

    for (const view of ['../x', '..%2Fx', '..%252Fx', `..%2F..%2F${env.bobYardId}%2Fimg%2Fplan`, '.', '', 'Plan', 'a/b']) {
      const res = await upload(`project=alice-yard&view=${view}`);
      assert.equal(res.statusCode, 400, view);
    }
    for (const project of [String(env.bobYardId), `../${env.bobYardId}`, '..%2Fbob-yard', 'Bob-Yard']) {
      const res = await upload(`project=${project}&view=plan`);
      assert.equal(res.statusCode, 404, project);
    }
    assert.deepEqual(snapshot(env), before, 'no file written anywhere');
  } finally {
    env.cleanup();
  }
});

test('the static fallback never serves a yard photo under DATA_DIR, even when DATA_DIR is inside the served root', async () => {
  // The default DATA_DIR is the repo's data/, and the repo root is the served
  // root, so this is the default layout.
  const env = setup();
  try {
    const publicDir = env.dataDir;
    for (const pathname of [
      `/projects/${env.bobYardId}/img/top.webp`,
      `/projects/${env.bobYardId}%2Fimg%2Ftop.webp`,
      `/app.db`,
    ]) {
      const res = makeRes();
      await serveStaticFile(res, pathname, publicDir);
      assert.equal(res.statusCode, 404, pathname);
    }
  } finally {
    env.cleanup();
  }
});

// --- /api/ecosystem -----------------------------------------------------------------

test('/api/ecosystem: place rows are open without a project; ?project= is owner-only, even empty', async () => {
  const env = setup();
  try {
    const open = await call(env, null, 'GET', '/api/ecosystem?place=home');
    assert.equal(open.statusCode, 200);
    assert.deepEqual(open.json(), { place: 'home', rows: [], location: null });

    assert.equal((await call(env, null, 'GET', '/api/ecosystem?place=home&project=')).statusCode, 401);
    assert.equal((await call(env, env.alice, 'GET', '/api/ecosystem?place=home&project=')).statusCode, 404);

    const own = await call(env, env.bob, 'GET', '/api/ecosystem?place=home&project=bob-yard');
    assert.deepEqual(own.json().location, { lat: 32.5, lng: -96.5 }, 'the owner gets lat/lng and never the address');
  } finally {
    env.cleanup();
  }
});

// --- visibility ------------------------------------------------------------------------

test('visibility: the database allows private and public, the application assigns only private', () => {
  const env = setup();
  try {
    assert.deepEqual([...PROJECT_VISIBILITIES], ['private', 'public']);
    assert.deepEqual([...ASSIGNABLE_VISIBILITIES], ['private']);
    assert.equal(findOwnedProject(env.db, env.bob.id, 'bob-yard').visibility, 'private');

    assert.throws(
      () => insertProject(env.db, { ownerId: env.alice.id, slug: 'pub', name: 'pub', configJson: '{}', visibility: 'public' }),
      /visibility/
    );
    assert.equal(findOwnedProject(env.db, env.alice.id, 'pub'), null);

    // The triggers, below the store: an unknown value is refused on insert and update.
    const update = env.db.prepare('UPDATE projects SET visibility = ? WHERE id = ?');
    assert.throws(() => update.run('shared', env.bobYardId), /visibility/);
    assert.throws(() => update.run('', env.bobYardId), /visibility/);
    assert.throws(
      () =>
        env.db
          .prepare(
            "INSERT INTO projects (owner_id, slug, name, visibility, config_json, created_at, updated_at) VALUES (?, 'raw', 'raw', 'everyone', '{}', 'now', 'now')"
          )
          .run(env.alice.id),
      /visibility/
    );
    update.run('public', env.bobYardId); // reserved for nl-3s5.10, accepted by the database
    assert.equal(findOwnedProject(env.db, env.bob.id, 'bob-yard').visibility, 'public');
  } finally {
    env.cleanup();
  }
});

// --- the shared example yard (nl-3s5.24) -----------------------------------------
//
// Carol (the site owner, an admin) has a backyard with a location; the example
// is refreshed from it. Alice and Bob are ordinary users. The example is the
// only yard a non-owner can read, it is read-only to everyone, and its
// location is never returned.

function setupWithExample() {
  const env = setup();
  env.carol = upsertUser(env.db, 'carol@example.com');
  env.db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(env.carol.id);
  env.carolYardId = addYard(env, env.carol, 'backyard');
  const { snapshot, provenance, revisionTimestamp } = snapshotFromOwnerYard(env.db, {
    dataDir: env.dataDir,
    ownerEmail: 'carol@example.com',
    slug: 'backyard',
  });
  const written = writeExampleYard(env.db, { dataDir: env.dataDir, snapshot, provenance, revisionTimestamp });
  assert.equal(written.status, 'created');
  env.exampleId = written.projectId;
  return env;
}

const READ_ROUTES = ROUTES.filter((r) => r.method === 'GET');
const WRITE_ROUTES = ROUTES.filter((r) => r.method !== 'GET');

test('the example: every read route answers any signed-in user, and 401s anonymous', async () => {
  const env = setupWithExample();
  try {
    const before = snapshot(env);
    for (const route of READ_ROUTES) {
      const label = `${route.method} ${route.path}`;
      const path = `${route.path}?project=${EXAMPLE_SLUG}${route.query || ''}`;
      assert.equal((await call(env, null, route.method, path)).statusCode, 401, `${label} anonymous`);
      for (const user of [env.alice, env.bob, env.carol]) {
        const res = await call(env, user, route.method, path);
        assert.ok(res.statusCode >= 200 && res.statusCode < 300, `${label} as ${user.email}: ${res.statusCode} ${res.body}`);
      }
    }
    assert.deepEqual(snapshot(env), before, 'reading the example changes nothing');

    const config = (await call(env, env.alice, 'GET', `/api/project?project=${EXAMPLE_SLUG}`)).json();
    assert.equal(config.name, EXAMPLE_NAME);
    const history = (await call(env, env.alice, 'GET', `/api/history?project=${EXAMPLE_SLUG}`)).json();
    assert.equal(history.entries.length, 1, 'the example holds one revision');
    assert.deepEqual(history.entries[0].plants, [placement('p1', 2)], "the source's state at its cursor");
  } finally {
    env.cleanup();
  }
});

test('the example: every write route answers 403 to everyone, its own system owner included, and changes nothing', async () => {
  const env = setupWithExample();
  try {
    const before = snapshot(env);
    const systemOwner = upsertUser(env.db, EXAMPLE_OWNER_EMAIL);
    assert.equal(systemOwner.isAdmin, false, 'the system owner is never an admin');
    for (const route of WRITE_ROUTES) {
      const label = `${route.method} ${route.path}`;
      const path = `${route.path}?project=${EXAMPLE_SLUG}${route.query || ''}`;
      assert.equal((await call(env, null, route.method, path, route.body?.(), route.headers || JSON_HEADERS)).statusCode, 401);
      for (const user of [env.alice, env.carol, systemOwner]) {
        const res = await call(env, user, route.method, path, route.body?.(), route.headers || JSON_HEADERS);
        assert.equal(res.statusCode, 403, `${label} as ${user.email}`);
        assert.deepEqual(res.json(), { error: EXAMPLE_READ_ONLY_ERROR });
      }
    }
    assert.deepEqual(snapshot(env), before, 'no write reached the example, its history or its photos');
  } finally {
    env.cleanup();
  }
});

test("the example never returns a location, and the owner's real backyard stays 404 to everyone else", async () => {
  const env = setupWithExample();
  try {
    assert.equal(findExampleProject(env.db).locationJson, null);
    for (const user of [env.alice, env.carol]) {
      const res = await call(env, user, 'GET', `/api/ecosystem?place=home&project=${EXAMPLE_SLUG}`);
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().location, null, `as ${user.email}`);
    }
    // The second lock: even a location written into the row by hand is not sent.
    env.db.prepare('UPDATE projects SET location_json = ? WHERE id = ?').run(JSON.stringify({ lat: 1, lng: 2 }), env.exampleId);
    assert.equal((await call(env, env.alice, 'GET', `/api/ecosystem?place=home&project=${EXAMPLE_SLUG}`)).json().location, null);

    // Nothing the example serves carries the source's address or coordinates.
    for (const path of ['/api/project', '/api/history', '/api/features', '/api/layout']) {
      const body = String((await call(env, env.alice, 'GET', `${path}?project=${EXAMPLE_SLUG}`)).body);
      assert.equal(/somewhere|32\.5|-96\.5/.test(body), false, `${path} leaks the source location`);
    }
    for (const r of readRevisions(env.db, env.exampleId)) {
      assert.deepEqual(findGeoKeys([JSON.parse(r.configJson), r.plants, JSON.parse(r.featuresJson ?? 'null')]), []);
    }

    // Carol's own backyard is hers alone, exactly as before.
    for (const route of ROUTES) {
      const res = await call(env, env.alice, route.method, `${route.path}?project=backyard${route.query || ''}`, route.body?.(), route.headers || JSON_HEADERS);
      assert.equal(res.statusCode, 404, `${route.method} ${route.path}`);
    }
    // Nor can the example's numeric id or its owner's other slugs be used to reach anything.
    assert.equal((await call(env, env.alice, 'GET', `/api/project?project=${env.exampleId}`)).statusCode, 404);
    assert.equal((await call(env, env.alice, 'GET', `/api/project?project=Example`)).statusCode, 404);
  } finally {
    env.cleanup();
  }
});

test('the picker lists the caller\'s yards plus the example, which is the default for a caller with none', async () => {
  const env = setupWithExample();
  try {
    assert.deepEqual((await call(env, env.alice, 'GET', '/api/projects')).json(), {
      defaultProject: 'alice-yard',
      projects: [
        { id: 'alice-yard', name: 'alice-yard' },
        { id: EXAMPLE_SLUG, name: EXAMPLE_NAME, readOnly: true },
      ],
    });
    const dave = upsertUser(env.db, 'dave@example.com');
    assert.deepEqual((await call(env, dave, 'GET', '/api/projects')).json(), {
      defaultProject: EXAMPLE_SLUG,
      projects: [{ id: EXAMPLE_SLUG, name: EXAMPLE_NAME, readOnly: true }],
    });
  } finally {
    env.cleanup();
  }
});

test("a user's own 'example' yard does not collide with the shared one", async () => {
  const env = setupWithExample();
  try {
    // New yards cannot take the slug.
    const refused = await call(env, env.alice, 'POST', '/api/projects', { id: EXAMPLE_SLUG, name: 'Mine' });
    assert.equal(refused.statusCode, 400);
    assert.match(refused.json().error, /reserved/);

    // One made before the slug was reserved stays its owner's, for reads and writes.
    const ownId = addYard(env, env.bob, EXAMPLE_SLUG);
    const exampleBefore = {
      row: env.db.prepare('SELECT * FROM projects WHERE id = ?').get(env.exampleId),
      history: env.db.prepare('SELECT * FROM history_entries WHERE project_id = ?').all(env.exampleId),
    };
    const own = await call(env, env.bob, 'GET', `/api/history?project=${EXAMPLE_SLUG}`);
    assert.equal(own.json().entries.length, 2, "Bob sees his own two-revision yard, not the example's one");
    const saved = await call(env, env.bob, 'POST', `/api/layout?project=${EXAMPLE_SLUG}`, { plants: [placement('p1', 7)], id: 'bob-own' });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(readRevisions(env.db, ownId).at(-1).id, 'bob-own');
    assert.deepEqual(
      {
        row: env.db.prepare('SELECT * FROM projects WHERE id = ?').get(env.exampleId),
        history: env.db.prepare('SELECT * FROM history_entries WHERE project_id = ?').all(env.exampleId),
      },
      exampleBefore,
      'the shared example is untouched'
    );
    // His picker lists his own 'example' once, not a second entry for the shared one.
    assert.deepEqual((await call(env, env.bob, 'GET', '/api/projects')).json().projects.map((p) => p.id), ['bob-yard', EXAMPLE_SLUG]);
    assert.equal((await call(env, env.bob, 'GET', '/api/projects')).json().projects[1].readOnly, undefined);
    // Everyone else still reads the shared example there.
    assert.equal((await call(env, env.alice, 'GET', `/api/history?project=${EXAMPLE_SLUG}`)).json().entries.length, 1);
    assert.equal((await call(env, env.alice, 'POST', `/api/layout?project=${EXAMPLE_SLUG}`, { plants: [] })).statusCode, 403);
  } finally {
    env.cleanup();
  }
});

// --- copy to my yards ------------------------------------------------------------

test('POST /api/projects/copy-example: a private copy in the caller\'s namespace, with its photos and no location', async () => {
  const env = setupWithExample();
  try {
    assert.equal((await call(env, null, 'POST', '/api/projects/copy-example', {})).statusCode, 401);
    const exampleBefore = snapshot(env);

    const res = await call(env, env.alice, 'POST', '/api/projects/copy-example', {});
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().id, 'example-yard');
    assert.deepEqual(res.json().index.projects.map((p) => p.id), ['alice-yard', 'example-yard', EXAMPLE_SLUG]);

    const copy = findOwnedProject(env.db, env.alice.id, 'example-yard');
    assert.equal(copy.visibility, 'private');
    assert.equal(copy.name, COPY_NAME);
    assert.equal(copy.locationJson, null);
    assert.equal(JSON.parse(copy.configJson).id, 'example-yard');
    const revisions = readRevisions(env.db, copy.id);
    assert.equal(revisions.length, 1, 'one revision');
    assert.equal(copy.historyCursor, 0);
    assert.deepEqual(revisions[0].plants, readRevisions(env.db, env.exampleId)[0].plants);
    assert.deepEqual(readdirSync(join(projectDataDir(env.dataDir, copy.id), 'img')), ['top.webp']);

    // The copy is an ordinary yard of Alice's: she can write it, Bob cannot see it.
    assert.equal((await call(env, env.alice, 'POST', '/api/layout?project=example-yard', { plants: [placement('p1', 9)] })).statusCode, 200);
    assert.equal((await call(env, env.bob, 'GET', '/api/project?project=example-yard')).statusCode, 404);
    assert.equal((await call(env, env.alice, 'GET', '/api/project-photo?project=example-yard&path=img/top.webp')).statusCode, 200);

    // A second copy takes the next free slug; the example itself never moved.
    assert.equal((await call(env, env.alice, 'POST', '/api/projects/copy-example', {})).json().id, 'example-yard-2');
    const after = snapshot(env);
    assert.deepEqual(
      after.projects.filter((p) => p.id === env.exampleId),
      exampleBefore.projects.filter((p) => p.id === env.exampleId)
    );
    assert.deepEqual(
      after.history.filter((h) => h.project_id === env.exampleId),
      exampleBefore.history.filter((h) => h.project_id === env.exampleId)
    );
  } finally {
    env.cleanup();
  }
});

test('POST /api/projects/copy-example is rate limited, and 404s when there is no example', async () => {
  const env = setupWithExample();
  try {
    env.copyExampleLimiter = createRateLimiter({ capacity: 2, refillPerSecond: 0.001 });
    assert.equal((await call(env, env.bob, 'POST', '/api/projects/copy-example', {})).statusCode, 200);
    assert.equal((await call(env, env.bob, 'POST', '/api/projects/copy-example', {})).statusCode, 200);
    const limited = await call(env, env.bob, 'POST', '/api/projects/copy-example', {});
    assert.equal(limited.statusCode, 429);
    assert.equal(projectIndexFor(env.db, env.bob.id).projects.length, 3, 'the refused copy made nothing');
  } finally {
    env.cleanup();
  }
  const bare = setup();
  try {
    assert.equal((await call(bare, bare.alice, 'POST', '/api/projects/copy-example', {})).statusCode, 404);
    assert.equal((await call(bare, bare.alice, 'GET', `/api/project?project=${EXAMPLE_SLUG}`)).statusCode, 404);
  } finally {
    bare.cleanup();
  }
});
