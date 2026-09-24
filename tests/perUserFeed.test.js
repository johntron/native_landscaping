// Saved areas and the observation feed are per-user (nl-3s5.5). Two users,
// A and B, each own one area; every route that names an area must answer
// B's area to A exactly as it answers an area that does not exist (404), and
// every list must hold only the caller's own. Anonymous callers get 401. An
// admin gets no bypass, and an unowned area (owner_id NULL) is nobody's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAppDb } from '../server/db/appDb.js';
import { openObservationEventsDb, upsertEvents } from '../tools/observationEventsDb.js';
import { handleFeedRoutes } from '../server/routes/feed.js';
import {
  createSavedArea,
  deleteSavedArea,
  exportPath,
  getSavedArea,
  getSavedAreaOwnedBy,
  listSavedAreasOwnedBy,
  updateSavedArea,
} from '../tools/savedAreas/savedAreasDb.js';
import { getFeedState, setFeedState } from '../tools/feedState/feedStateDb.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

function makeRes() {
  return {
    statusCode: null,
    body: '',
    writeHead(status) {
      this.statusCode = status;
    },
    end(chunk) {
      if (chunk) this.body += chunk;
    },
    get json() {
      return JSON.parse(this.body);
    },
  };
}

function insertUser(appDb, email, isAdmin = false) {
  const id = appDb
    .prepare('INSERT INTO users (email, is_admin, created_at) VALUES (?, ?, ?) RETURNING id')
    .get(email, isAdmin ? 1 : 0, 'now').id;
  return { id, email, isAdmin };
}

/**
 * A temp DATA_DIR holding app.db and observation-events.db, with users A, B
 * and admin C, one area each for A and B, one unowned area, and one logged
 * observation per area. DATA_DIR is pointed at it for the test's duration so
 * the export a write triggers never lands in the repo's data/.
 */
async function withFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'per-user-feed-test-'));
  const savedDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  const app = openAppDb({ dataDir: dir, ownerEmail: '' });
  const observationEvents = openObservationEventsDb(join(dir, 'observation-events.db'));
  try {
    const a = insertUser(app, 'a@example.com');
    const b = insertUser(app, 'b@example.com');
    const admin = insertUser(app, 'admin@example.com', true);
    const areaA = createSavedArea(app, { name: 'A yard', lat: 32.7, lng: -96.8, radiusMi: 1 }, { ownerId: a.id });
    const areaB = createSavedArea(app, { name: 'B yard', lat: 33.1, lng: -96.6, radiusMi: 1 }, { ownerId: b.id });
    const unowned = createSavedArea(app, { name: 'Nobody', lat: 33.0, lng: -97.0, radiusMi: 1 });
    upsertEvents(observationEvents, [
      { observation_id: 1, area_id: areaA.id, taxon_name: 'Asclepias tuberosa', observed_on: '2026-01-01', ingested_at: 't1' },
      { observation_id: 2, area_id: areaB.id, taxon_name: 'Quercus stellata', observed_on: '2026-01-02', ingested_at: 't1' },
      { observation_id: 3, area_id: unowned.id, taxon_name: 'Ulmus crassifolia', observed_on: '2026-01-03', ingested_at: 't1' },
    ]);
    const db = { app, observationEvents };

    /** Call handleFeedRoutes as `user` (null for anonymous) and return the stub response. */
    async function call(user, method, pathAndQuery, body) {
      const url = new URL(`http://localhost${pathAndQuery}`);
      const req = {
        method,
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.50' },
        on(event, cb) {
          if (event === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)));
          if (event === 'end') cb();
        },
      };
      const res = makeRes();
      const handled = await handleFeedRoutes(req, res, { url, pathname: url.pathname, db, user });
      assert.equal(handled, true, `${method} ${pathAndQuery} was handled`);
      return res;
    }

    await fn({ dir, db, a, b, admin, areaA, areaB, unowned, call });
  } finally {
    if (savedDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = savedDataDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('anonymous callers get 401 from every saved-area and feed route', async () => {
  await withFixture(async ({ areaA, call }) => {
    const calls = [
      ['GET', '/api/saved-areas'],
      ['GET', `/api/saved-areas/${areaA.id}`],
      ['POST', '/api/saved-areas', { name: 'x', lat: 1, lng: 1, radiusMi: 1 }],
      ['PUT', `/api/saved-areas/${areaA.id}`, { name: 'x' }],
      ['DELETE', `/api/saved-areas/${areaA.id}`],
      ['POST', `/api/saved-areas/${areaA.id}`, {}], // would be 405 when signed in
      ['GET', `/api/feed?area_id=${areaA.id}`],
      ['POST', '/api/feed/state', { areaId: areaA.id, observationId: 1, read: true }],
      ['POST', '/api/feed/refresh', { areaId: areaA.id }],
      ['GET', `/api/observation-events?area_id=${areaA.id}`],
    ];
    for (const [method, path, body] of calls) {
      const res = await call(null, method, path, body);
      assert.equal(res.statusCode, 401, `${method} ${path}`);
    }
  });
});

test('GET /api/saved-areas lists only the caller\'s areas, never another user\'s or an unowned one', async () => {
  await withFixture(async ({ a, b, admin, areaA, areaB, call }) => {
    assert.deepEqual((await call(a, 'GET', '/api/saved-areas')).json.areas.map((x) => x.id), [areaA.id]);
    assert.deepEqual((await call(b, 'GET', '/api/saved-areas')).json.areas.map((x) => x.id), [areaB.id]);
    assert.deepEqual((await call(admin, 'GET', '/api/saved-areas')).json.areas, [], 'admins get no bypass');
  });
});

test('another user\'s area answers exactly like a missing one: GET, PUT and DELETE all 404', async () => {
  await withFixture(async ({ db, a, admin, areaB, unowned, call }) => {
    for (const user of [a, admin]) {
      for (const id of [areaB.id, unowned.id]) {
        const missing = await call(user, 'GET', '/api/saved-areas/no-such-area');
        const got = await call(user, 'GET', `/api/saved-areas/${id}`);
        assert.equal(got.statusCode, 404);
        assert.equal(got.json.error, missing.json.error.replace('no-such-area', id), 'same body shape as a missing id');

        assert.equal((await call(user, 'PUT', `/api/saved-areas/${id}`, { name: 'Hijacked' })).statusCode, 404);
        assert.equal((await call(user, 'DELETE', `/api/saved-areas/${id}`)).statusCode, 404);
      }
    }
    // Nothing was changed or removed underneath.
    assert.equal(getSavedArea(db.app, areaB.id).name, 'B yard');
    assert.equal(getSavedArea(db.app, unowned.id).name, 'Nobody');
  });
});

test('the owner can still get, update and delete their own area', async () => {
  await withFixture(async ({ db, a, areaA, call }) => {
    assert.equal((await call(a, 'GET', `/api/saved-areas/${areaA.id}`)).json.area.name, 'A yard');
    const put = await call(a, 'PUT', `/api/saved-areas/${areaA.id}`, { name: 'A yard, renamed' });
    assert.equal(put.statusCode, 200);
    assert.equal(put.json.area.name, 'A yard, renamed');
    assert.equal((await call(a, 'DELETE', `/api/saved-areas/${areaA.id}`)).statusCode, 200);
    assert.equal(getSavedArea(db.app, areaA.id), null);
  });
});

test('POST /api/saved-areas gives the new area to its creator only', async () => {
  await withFixture(async ({ a, b, call }) => {
    const created = await call(a, 'POST', '/api/saved-areas', { name: 'A second', lat: 32, lng: -97, radiusMi: 2 });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json.area.ownerId, a.id);
    assert.equal((await call(b, 'GET', `/api/saved-areas/${created.json.area.id}`)).statusCode, 404);
    assert.ok(!(await call(b, 'GET', '/api/saved-areas')).json.areas.some((x) => x.id === created.json.area.id));
  });
});

test('feed, observation events, state and refresh on another user\'s area all 404', async () => {
  await withFixture(async ({ db, a, admin, areaA, areaB, unowned, call }) => {
    for (const user of [a, admin]) {
      for (const id of [areaB.id, unowned.id]) {
        assert.equal((await call(user, 'GET', `/api/feed?area_id=${id}`)).statusCode, 404);
        assert.equal((await call(user, 'GET', `/api/feed?area_id=${id}&lane=rarity`)).statusCode, 404);
        assert.equal((await call(user, 'GET', `/api/observation-events?area_id=${id}`)).statusCode, 404);
        const mark = await call(user, 'POST', '/api/feed/state', { areaId: id, observationId: 2, read: true, dismissed: true });
        assert.equal(mark.statusCode, 404);
      }
    }
    // Refresh 404s before pollSavedAreas, so no iNaturalist call is made.
    assert.equal((await call(a, 'POST', '/api/feed/refresh', { areaId: areaB.id })).statusCode, 404);

    // B's flag was never written.
    assert.deepEqual(getFeedState(db.app, 2, areaB.id), { read: false, dismissed: false, updatedAt: null });

    // A's own area still works end to end.
    const feed = await call(a, 'GET', `/api/feed?area_id=${areaA.id}`);
    assert.equal(feed.statusCode, 200);
    assert.deepEqual(feed.json.items.map((i) => i.observation_id), [1]);
    const events = await call(a, 'GET', `/api/observation-events?area_id=${areaA.id}`);
    assert.deepEqual(events.json.rows.map((r) => r.observation_id), [1]);
    const mark = await call(a, 'POST', '/api/feed/state', { areaId: areaA.id, observationId: 1, read: true });
    assert.equal(mark.statusCode, 200);
    assert.equal(getFeedState(db.app, 1, areaA.id).read, true);
  });
});

test('B cannot read A\'s feed flags: they come only through A\'s area', async () => {
  await withFixture(async ({ db, a, b, areaA, call }) => {
    setFeedState(db.app, 1, areaA.id, { read: true });
    assert.equal((await call(b, 'GET', `/api/feed?area_id=${areaA.id}&include_dismissed=true`)).statusCode, 404);
    assert.equal((await call(a, 'GET', `/api/feed?area_id=${areaA.id}`)).json.items[0].read, true);
  });
});

test('ownership is enforced in SQL: scoped reads and writes never touch another owner\'s row', async () => {
  await withFixture(async ({ db, a, b, areaA, areaB }) => {
    assert.deepEqual(listSavedAreasOwnedBy(db.app, a.id).map((x) => x.id), [areaA.id]);
    assert.equal(getSavedAreaOwnedBy(db.app, areaB.id, a.id), null);
    assert.throws(() => updateSavedArea(db.app, areaB.id, { name: 'x' }, { ownerId: a.id }), /No saved area/);
    assert.equal(deleteSavedArea(db.app, areaB.id, { ownerId: a.id }), false);
    assert.equal(getSavedArea(db.app, areaB.id).name, 'B yard');
    assert.equal(getSavedAreaOwnedBy(db.app, areaB.id, b.id).name, 'B yard');

    // A missing owner fails loudly rather than falling back to every area.
    assert.throws(() => listSavedAreasOwnedBy(db.app, undefined), /ownerId/);
    assert.throws(() => getSavedAreaOwnedBy(db.app, areaB.id, null), /ownerId/);
    assert.throws(() => updateSavedArea(db.app, areaB.id, { name: 'x' }, { ownerId: undefined }), /ownerId/);
    assert.throws(() => deleteSavedArea(db.app, areaB.id, { ownerId: null }), /ownerId/);
  });
});

test('the saved-areas export stays out of git: written under DATA_DIR, gitignored, untracked', async () => {
  await withFixture(async ({ dir, a, call }) => {
    await call(a, 'POST', '/api/saved-areas', { name: 'Trigger export', lat: 32, lng: -97, radiusMi: 2 });
    assert.equal(exportPath(), join(dir, 'saved-areas.export.json'));
    const written = JSON.parse(readFileSync(exportPath(), 'utf8'));
    // A local backup of every area, with owners, so a restore returns each to its owner.
    assert.ok(written.areas.some((x) => x.name === 'Trigger export' && x.ownerId === a.id));
  });

  const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n');
  assert.ok(gitignore.includes('data/saved-areas.export.json'), '.gitignore lists the export');

  let tracked;
  try {
    tracked = execFileSync('git', ['ls-files', 'data/saved-areas.export.json'], { cwd: ROOT, encoding: 'utf8' });
  } catch {
    return; // not a git checkout (e.g. a container image): nothing is tracked there anyway
  }
  assert.equal(tracked.trim(), '', 'data/saved-areas.export.json must not be tracked in git');
});
