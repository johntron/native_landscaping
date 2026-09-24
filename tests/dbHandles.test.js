import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openServerDatabases, CLAIM_STORE_NOT_BUILT_MESSAGE } from '../server/dbHandles.js';
import { openClaimsStore, createSchema } from '../tools/claims/claimsStore.js';
import { openProbeCache } from '../tools/usda-plants/probeCache.js';

function tmpPaths() {
  const dir = mkdtempSync(join(tmpdir(), 'db-handles-test-'));
  return {
    dir,
    observationEvents: join(dir, 'observation-events.db'),
    ecosystem: join(dir, 'ecosystem.db'),
    claims: join(dir, 'claims.db'),
  };
}

test('openServerDatabases eagerly opens observation events and ecosystem, each with busy_timeout set', () => {
  const paths = tmpPaths();
  try {
    const db = openServerDatabases(paths);
    for (const key of ['observationEvents', 'ecosystem']) {
      const { timeout } = db[key].prepare('PRAGMA busy_timeout').get();
      assert.equal(timeout, 5000, `${key} should have busy_timeout set`);
    }
    // Opening itself creates each file (mkdir + CREATE TABLE IF NOT EXISTS),
    // matching every other open*Db function's existing behaviour.
    assert.ok(existsSync(paths.observationEvents));
    assert.ok(existsSync(paths.ecosystem));
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test('openServerDatabases no longer opens saved-areas.db or feed-state.db: those tables live in app.db (nl-3s5.11)', () => {
  const paths = tmpPaths();
  try {
    const db = openServerDatabases(paths);
    assert.equal('savedAreas' in db, false);
    assert.equal('feedState' in db, false);
    assert.equal(existsSync(join(paths.dir, 'saved-areas.db')), false);
    assert.equal(existsSync(join(paths.dir, 'feed-state.db')), false);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test('db.claims() throws the exact "not built" message and never creates data/claims.db when the store does not exist yet', () => {
  const paths = tmpPaths();
  try {
    const db = openServerDatabases(paths);
    assert.throws(() => db.claims(), new RegExp(CLAIM_STORE_NOT_BUILT_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(existsSync(paths.claims), false, 'merely calling db.claims() must not manufacture an empty claims.db');
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test('db.claims() throws the same message, and still does not cache, when the file exists without a taxa table', () => {
  const paths = tmpPaths();
  try {
    // Simulate a stray/empty claims.db: opened once (e.g. by an old bug) but
    // createSchema() never ran.
    openClaimsStore(paths.claims);
    const db = openServerDatabases(paths);
    assert.throws(() => db.claims(), /Claim store not built/);
    assert.throws(() => db.claims(), /Claim store not built/, 'a second call must not cache the failure either');
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

// nl-3s5.27: openServerDatabases() with NO path overrides is exactly what
// server.js calls at startup. Every store it opens must honour DATA_DIR, and
// unset DATA_DIR must still mean the repo's real data/ — the two halves of
// this bead's deliverable.
test('openServerDatabases(), called with no path overrides, opens observation-events.db and ecosystem.db under DATA_DIR', () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-handles-datadir-test-'));
  const savedEnv = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  try {
    const db = openServerDatabases();
    assert.ok(existsSync(join(dir, 'observation-events.db')), 'observation-events.db should land under DATA_DIR');
    assert.ok(existsSync(join(dir, 'ecosystem.db')), 'ecosystem.db should land under DATA_DIR');

    // Build claims.db in the same DATA_DIR and confirm db.claims() (called
    // with no override either) finds it there, not at the repo's data/.
    const claimsDb = openClaimsStore(join(dir, 'claims.db'));
    createSchema(claimsDb);
    assert.doesNotThrow(() => db.claims().prepare('SELECT 1 FROM taxa LIMIT 1').get());
  } finally {
    if (savedEnv === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  }
});

// The probe cache isn't part of openServerDatabases (server/routes/ecosystem.js
// opens it per request, nl-3s5.26), but it must honour DATA_DIR the same way,
// since it's a store the server opens.
test('openProbeCache(), called with no path override, opens probe-cache.db under DATA_DIR', () => {
  const dir = mkdtempSync(join(tmpdir(), 'probe-cache-datadir-test-'));
  const savedEnv = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  try {
    openProbeCache();
    assert.ok(existsSync(join(dir, 'probe-cache.db')), 'probe-cache.db should land under DATA_DIR');
  } finally {
    if (savedEnv === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('db.claims() opens and caches the store once it has been built, and picks up a rebuild that happens after startup', () => {
  const paths = tmpPaths();
  try {
    const db = openServerDatabases(paths);
    assert.throws(() => db.claims(), /Claim store not built/, 'not built yet at startup');

    // Simulate tools/claims/rebuild.js running after the server started.
    const rebuilt = openClaimsStore(paths.claims);
    createSchema(rebuilt);

    const claims = db.claims();
    assert.doesNotThrow(() => claims.prepare('SELECT 1 FROM taxa LIMIT 1').get());

    // Once opened successfully, the same handle is cached and reused.
    assert.strictEqual(db.claims(), claims);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});
