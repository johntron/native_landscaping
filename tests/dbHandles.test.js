import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openServerDatabases, CLAIM_STORE_NOT_BUILT_MESSAGE } from '../server/dbHandles.js';
import { openClaimsStore, createSchema } from '../tools/claims/claimsStore.js';

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
