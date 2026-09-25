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
import { importLayer, locationKey, markBuildFinished, markBuildStarted, openEcosystemDb, replaceTaxonRows } from '../tools/ecosystemIndexDb.js';
import { serveStaticFile } from '../server/static.js';
import { openProbeCache, setCached } from '../tools/usda-plants/probeCache.js';

// No test in this file may reach the network. The location routes (nl-3s5.30)
// geocode through the probe cache seeded below; anything that misses it (the
// CEC ecoregion lookup) fails here and is reported as "unchecked".
globalThis.fetch = async (url) => {
  throw new Error(`network disabled in tests: ${String(url).split('?')[0]}`);
};

/** The one address the location routes can resolve here: seeded into every env's probe cache. */
const LOCATION_QUERY = '1 Test St, Dallas, TX';
const NOMINATIM_MATCH = [
  { lat: '32.7812345', lon: '-96.8012345', display_name: '1 Test St, Dallas, Texas, USA', address: { city: 'Dallas', state: 'Texas', country: 'United States' } },
];

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
  env.ecosystem = openEcosystemDb(join(dataDir, 'ecosystem.db'));
  env.probeCache = openProbeCache(join(dataDir, 'probe-cache.db'));
  setCached(env.probeCache, 'nominatim', 'search', LOCATION_QUERY, NOMINATIM_MATCH);
  // A save must repeat the caller's own pending preview (nl-3s5.30): Bob has
  // just looked LOCATION_QUERY up for his yard, so the table's save succeeds
  // for him, and Alice's 404 is still authorization alone.
  env.pendingLocationPreviews = new Map([[`${env.bob.id}:${env.bobYardId}`, { query: LOCATION_QUERY, at: Date.now() }]]);
  env.cleanup = () => {
    env.probeCache.close();
    env.ecosystem.close();
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

/** Build a yard's nearby index for the location addYard gives every yard (nl-3s5.6). */
function buildIndex(env, projectId, taxonNames) {
  const key = locationKey({ lat: 32.5, lng: -96.5 });
  markBuildStarted(env.ecosystem, projectId, key);
  replaceTaxonRows(
    env.ecosystem,
    projectId,
    'Plantae',
    taxonNames.map((taxon_name) => ({
      taxon_name,
      genus: taxon_name.split(' ')[0],
      radius_mi: 1,
      observation_count: 3,
      fetched_on: '2026-01-01',
      source: 'test',
    }))
  );
  markBuildFinished(env.ecosystem, projectId, { state: 'ready', fetchedOn: '2026-01-01' });
}

/** Route the request the way server.js does: the first handler that takes it answers. */
async function call(env, user, method, pathAndQuery, body, headers) {
  const url = new URL(`http://localhost${pathAndQuery}`);
  const ctx = {
    url,
    pathname: url.pathname,
    dataDir: env.dataDir,
    db: { app: env.db, ecosystem: env.ecosystem, probeCache: env.probeCache },
    user,
    // A fresh limiter per call unless the test brings its own: user ids repeat
    // across these throwaway databases, so the module's shared one would
    // carry one test's copies into the next.
    copyExampleLimiter: env.copyExampleLimiter || createRateLimiter(),
    geocodeLimiter: env.geocodeLimiter || createRateLimiter(),
    ecoregionLimiter: env.ecoregionLimiter || createRateLimiter(),
    pendingLocationPreviews: env.pendingLocationPreviews,
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
  { method: 'GET', path: '/api/ecosystem' },
  // The yard's habitat anchors and nearby fauna (nl-3s5.31).
  { method: 'GET', path: '/api/ecosystem/site' },
  // The yard's location (nl-3s5.30): read, look up (writes nothing), save.
  { method: 'GET', path: '/api/project-location' },
  { method: 'POST', path: '/api/project-location/preview', body: () => ({ query: LOCATION_QUERY }) },
  { method: 'POST', path: '/api/project-location', body: () => ({ query: LOCATION_QUERY }) },
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
    covered.add('GET /api/me/storage'); // its own tests, below
    // The ecosystem routes that take no yard (nl-3s5.31 added this file to the scan).
    covered.add('POST /api/geocode'); // no yard; rate-limited, tests/adminAndRateLimits.test.js
    covered.add('GET /api/ecoregion'); // no yard; coordinates in, a code out
    covered.add('GET /api/ecosystem/places'); // the caller's own labels, tests/routesDbHandles.test.js
    const found = ['project.js', 'ecosystem.js'].flatMap((file) =>
      [...readFileSync(new URL(`../server/routes/${file}`, import.meta.url), 'utf-8').matchAll(
        /pathname === '([^']+)' && req\.method === '([A-Z]+)'/g
      )].map(([, path, method]) => `${method} ${path}`)
    );
    assert.ok(found.length >= 17, `found ${found.length} routes`);
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

test('GET /api/me/storage is owner-scoped: sums only the caller\'s own yards, 401s anonymous', async () => {
  const env = setup();
  try {
    assert.equal((await call(env, null, 'GET', '/api/me/storage')).statusCode, 401);

    const alice = await call(env, env.alice, 'GET', '/api/me/storage');
    assert.equal(alice.statusCode, 200);
    const aliceBody = alice.json();
    assert.equal(typeof aliceBody.usedBytes, 'number');
    assert.equal(typeof aliceBody.capBytes, 'number');
    assert.equal(aliceBody.usedBytes, WEBP.length, 'exactly her one yard\'s one photo');

    // Bob's own yard has the same single photo; the two totals must not
    // add up into each other.
    const bob = await call(env, env.bob, 'GET', '/api/me/storage');
    assert.equal(bob.json().usedBytes, WEBP.length);
    assert.equal(bob.json().capBytes, aliceBody.capBytes, 'same configured cap for everyone');

    // A second yard of Alice's, with a second photo, is counted too.
    const secondId = addYard(env, env.alice, 'alice-second');
    assert.equal(
      (await call(env, env.alice, 'GET', '/api/me/storage')).json().usedBytes,
      WEBP.length * 2,
      'summed across both of her yards'
    );
    void secondId;
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

test('POST /api/view-background: an upload that would exceed PHOTO_QUOTA_MB gets 413 and writes nothing', async () => {
  const env = setup();
  const originalQuota = process.env.PHOTO_QUOTA_MB;
  // Below what addYard's own 'top.webp' already uses, so usage alone exceeds
  // the cap and any upload — of any size — is refused.
  process.env.PHOTO_QUOTA_MB = String((WEBP.length - 1) / (1024 * 1024));
  try {
    const before = snapshot(env);
    const res = await call(env, env.bob, 'POST', '/api/view-background?project=bob-yard&view=plan', WEBP, {
      'content-type': 'image/webp',
    });
    assert.equal(res.statusCode, 413, res.body);
    const body = res.json();
    assert.match(body.error, /Photo storage limit reached/);
    assert.equal(typeof body.used, 'number');
    assert.equal(typeof body.cap, 'number');
    assert.deepEqual(snapshot(env), before, 'nothing written or recorded on a quota-exceeded upload');
  } finally {
    if (originalQuota === undefined) delete process.env.PHOTO_QUOTA_MB;
    else process.env.PHOTO_QUOTA_MB = originalQuota;
    env.cleanup();
  }
});

test('POST /api/view-background: usage after a successful upload is reported in the response', async () => {
  const env = setup();
  try {
    const res = await call(env, env.bob, 'POST', '/api/view-background?project=bob-yard&view=north', WEBP, {
      'content-type': 'image/webp',
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.ok(body.photoUsage, 'response includes photoUsage');
    // bob-yard already had one photo (top.webp, from addYard) before this upload.
    assert.equal(body.photoUsage.usedBytes, WEBP.length * 2);
    assert.equal(typeof body.photoUsage.capBytes, 'number');
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

test('/api/ecosystem: per yard, owner-only, even empty; a place label reaches nobody else’s rows (nl-3s5.6)', async () => {
  const env = setup();
  try {
    // No yard, no rows: the old open ?place= read is gone.
    assert.equal((await call(env, null, 'GET', '/api/ecosystem?place=home')).statusCode, 400);
    assert.equal((await call(env, env.alice, 'GET', '/api/ecosystem?place=home')).statusCode, 400);

    assert.equal((await call(env, null, 'GET', '/api/ecosystem?project=')).statusCode, 401);
    assert.equal((await call(env, env.alice, 'GET', '/api/ecosystem?project=')).statusCode, 404);

    // Bob has a location and no index yet: queued, no rows.
    let own = (await call(env, env.bob, 'GET', '/api/ecosystem?project=bob-yard')).json();
    assert.deepEqual(own.location, { lat: 32.5, lng: -96.5 }, 'the owner gets lat/lng and never the address');
    assert.deepEqual(own.index, { state: 'queued', fetchedOn: null });
    assert.deepEqual(own.rows, []);

    // Both yards say place "home". Bob's index is Bob's alone.
    buildIndex(env, env.bobYardId, ['Asclepias tuberosa']);
    own = (await call(env, env.bob, 'GET', '/api/ecosystem?project=bob-yard&place=elsewhere')).json();
    assert.deepEqual(own.index, { state: 'ready', fetchedOn: '2026-01-01' });
    assert.deepEqual(own.rows.map((r) => r.taxon_name), ['Asclepias tuberosa']);
    assert.equal('project_id' in own.rows[0], false, 'the row key is not sent');
    const alice = (await call(env, env.alice, 'GET', '/api/ecosystem?project=alice-yard&place=home')).json();
    assert.deepEqual(alice.rows, [], "Alice's yard with the same place label shows none of Bob's rows");
    assert.equal(alice.index.state, 'queued');

    // A yard with no location says so.
    env.db.prepare('UPDATE projects SET location_json = NULL WHERE id = ?').run(env.aliceYardId);
    assert.deepEqual((await call(env, env.alice, 'GET', '/api/ecosystem?project=alice-yard')).json().index, {
      state: 'no-location',
      fetchedOn: null,
    });

    // Bob moves: the old site's rows stop showing until the new site is built.
    env.db.prepare('UPDATE projects SET location_json = ? WHERE id = ?').run(JSON.stringify({ lat: 33, lng: -97 }), env.bobYardId);
    own = (await call(env, env.bob, 'GET', '/api/ecosystem?project=bob-yard')).json();
    assert.equal(own.index.state, 'queued');
    assert.deepEqual(own.rows, []);
  } finally {
    env.cleanup();
  }
});

// --- /api/ecosystem/site (nl-3s5.31) ----------------------------------------------------

/** Seed a yard's three site layers for the location addYard gives every yard. Obviously fake names. */
function seedSiteLayers(env, projectId, tag, location = { lat: 32.5, lng: -96.5 }) {
  const key = locationKey(location);
  const fetchedOn = '2026-01-01';
  importLayer(env.ecosystem, projectId, 'streams', key, [
    { kind: 'stream', name: `${tag} Test Creek`, status: 'anchor', distance_mi: 0.5, detail: 'channel', fetched_on: fetchedOn, source: 'test' },
  ], { fetchedOn });
  importLayer(env.ecosystem, projectId, 'greenspace', key, [
    { kind: 'park', name: `${tag} Test Park`, status: 'candidate', distance_mi: 1, detail: 'leisure=park, ~3 acres', fetched_on: fetchedOn, source: 'test' },
  ], { fetchedOn });
  importLayer(env.ecosystem, projectId, 'fauna', key, [
    { iconic_taxon: 'Insecta', animal_species: `${tag} testmoth`, animal_common: '', nearest_radius_mi: 1, observation_count: 2, establishment_means: '', fetched_on: fetchedOn, source: 'test' },
  ], { fetchedOn });
}

const siteNames = (body) => [...body.anchors.map((a) => a.name), ...body.fauna.map((f) => f.animal_species)].sort();

test('/api/ecosystem/site: per yard, owner-only; a yard at the same place and site never sees another owner’s rows', async () => {
  const env = setup();
  try {
    assert.equal((await call(env, null, 'GET', '/api/ecosystem/site')).statusCode, 400);
    assert.equal((await call(env, env.alice, 'GET', '/api/ecosystem/site?place=home')).statusCode, 400);
    assert.equal((await call(env, null, 'GET', '/api/ecosystem/site?project=bob-yard')).statusCode, 401);
    assert.equal((await call(env, env.alice, 'GET', '/api/ecosystem/site?project=bob-yard')).statusCode, 404);

    // Nothing built yet: every layer queued, no rows.
    let own = (await call(env, env.bob, 'GET', '/api/ecosystem/site?project=bob-yard')).json();
    assert.deepEqual(own.layers, {
      fauna: { state: 'queued', fetchedOn: null },
      streams: { state: 'queued', fetchedOn: null },
      greenspace: { state: 'queued', fetchedOn: null },
    });
    assert.deepEqual([own.anchors, own.fauna], [[], []]);

    // Both yards say place "home" at the same coordinates. Bob's rows are Bob's.
    seedSiteLayers(env, env.bobYardId, 'Bob');
    const res = await call(env, env.bob, 'GET', '/api/ecosystem/site?project=bob-yard');
    own = res.json();
    assert.deepEqual(siteNames(own), ['Bob Test Creek', 'Bob Test Park', 'Bob testmoth']);
    assert.equal(own.layers.fauna.state, 'ready');
    assert.equal(own.layers.streams.fetchedOn, '2026-01-01');
    assert.equal('project_id' in own.anchors[0] || 'project_id' in own.fauna[0], false, 'the row key is not sent');
    assert.equal('location' in own, false, 'this route sends no location at all');
    assert.equal(/32\.5|-96\.5|somewhere/.test(String(res.body)), false);

    const alice = (await call(env, env.alice, 'GET', '/api/ecosystem/site?project=alice-yard')).json();
    assert.deepEqual([alice.anchors, alice.fauna], [[], []], "Alice's yard shows none of Bob's rows");
    // The other way round too: Bob asking for Alice's slug is refused outright.
    assert.equal((await call(env, env.bob, 'GET', '/api/ecosystem/site?project=alice-yard')).statusCode, 404);

    // Bob moves: the old site's rows stop showing at once, every layer queued again.
    env.db.prepare('UPDATE projects SET location_json = ? WHERE id = ?').run(JSON.stringify({ lat: 33, lng: -97 }), env.bobYardId);
    own = (await call(env, env.bob, 'GET', '/api/ecosystem/site?project=bob-yard')).json();
    assert.deepEqual([own.anchors, own.fauna], [[], []]);
    assert.equal(own.layers.streams.state, 'queued');

    // No location at all says so.
    env.db.prepare('UPDATE projects SET location_json = NULL WHERE id = ?').run(env.bobYardId);
    own = (await call(env, env.bob, 'GET', '/api/ecosystem/site?project=bob-yard')).json();
    assert.equal(own.layers.fauna.state, 'no-location');
  } finally {
    env.cleanup();
  }
});

test('/api/ecosystem/site on the example shows its source yard’s layers, and a moved source shows none', async () => {
  const env = setupWithExample();
  try {
    let shown = (await call(env, env.alice, 'GET', `/api/ecosystem/site?project=${EXAMPLE_SLUG}`)).json();
    assert.deepEqual([shown.anchors, shown.fauna], [[], []]);
    seedSiteLayers(env, env.carolYardId, 'Carol');
    seedSiteLayers(env, env.bobYardId, 'Bob');
    for (const user of [env.alice, env.bob, env.carol]) {
      const res = await call(env, user, 'GET', `/api/ecosystem/site?project=${EXAMPLE_SLUG}`);
      assert.equal(res.statusCode, 200);
      shown = res.json();
      assert.deepEqual(siteNames(shown), ['Carol Test Creek', 'Carol Test Park', 'Carol testmoth'], `as ${user.email}`);
      assert.equal(/32\.5|-96\.5|somewhere/.test(String(res.body)), false);
    }
    assert.equal((await call(env, null, 'GET', `/api/ecosystem/site?project=${EXAMPLE_SLUG}`)).statusCode, 401);
    // Carol's own backyard stays hers.
    assert.equal((await call(env, env.alice, 'GET', '/api/ecosystem/site?project=backyard')).statusCode, 404);

    env.db.prepare('UPDATE projects SET location_json = ? WHERE id = ?').run(JSON.stringify({ lat: 33, lng: -97 }), env.carolYardId);
    shown = (await call(env, env.alice, 'GET', `/api/ecosystem/site?project=${EXAMPLE_SLUG}`)).json();
    assert.deepEqual([shown.anchors, shown.fauna], [[], []], 'rows for a site the source has left are not shown');
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
      const res = await call(env, user, 'GET', `/api/ecosystem?project=${EXAMPLE_SLUG}`);
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().location, null, `as ${user.email}`);
    }
    // The second lock: even a location written into the row by hand is not sent.
    env.db.prepare('UPDATE projects SET location_json = ? WHERE id = ?').run(JSON.stringify({ lat: 1, lng: 2 }), env.exampleId);
    assert.equal((await call(env, env.alice, 'GET', `/api/ecosystem?project=${EXAMPLE_SLUG}`)).json().location, null);

    // The example shows the index of the yard it was refreshed from (Carol's
    // backyard), read-only, still with no location (nl-3s5.6).
    assert.equal((await call(env, env.alice, 'GET', `/api/ecosystem?project=${EXAMPLE_SLUG}`)).json().index.state, 'queued');
    buildIndex(env, env.carolYardId, ['Cercis canadensis']);
    const shown = (await call(env, env.bob, 'GET', `/api/ecosystem?project=${EXAMPLE_SLUG}`)).json();
    assert.equal(shown.index.state, 'ready');
    assert.deepEqual(shown.rows.map((r) => r.taxon_name), ['Cercis canadensis']);
    assert.equal(shown.location, null);

    // Nothing the example serves carries the source's address or coordinates.
    for (const path of ['/api/project', '/api/history', '/api/features', '/api/layout', '/api/ecosystem', '/api/ecosystem/site', '/api/project-location']) {
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

test('POST /api/projects/copy-example: exceeding PHOTO_QUOTA_MB gets 413 and copies nothing', async () => {
  const env = setupWithExample();
  const originalQuota = process.env.PHOTO_QUOTA_MB;
  // The example carries one photo (top.webp, WEBP.length bytes); a cap below
  // that plus Alice's own existing usage (also one WEBP.length photo) refuses
  // the copy outright.
  process.env.PHOTO_QUOTA_MB = String((WEBP.length * 2 - 1) / (1024 * 1024));
  try {
    const before = snapshot(env);
    const res = await call(env, env.alice, 'POST', '/api/projects/copy-example', {});
    assert.equal(res.statusCode, 413, res.body);
    const body = res.json();
    assert.match(body.error, /Photo storage limit reached/);
    assert.deepEqual(snapshot(env), before, 'no yard, no revision, no file created');
    assert.equal(findOwnedProject(env.db, env.alice.id, 'example-yard'), null);
  } finally {
    if (originalQuota === undefined) delete process.env.PHOTO_QUOTA_MB;
    else process.env.PHOTO_QUOTA_MB = originalQuota;
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
