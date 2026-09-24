// nl-3s5.27: every gitignored cache DB the server opens (observation-events.db,
// ecosystem.db, claims.db, probe-cache.db) must honour DATA_DIR, and must
// resolve it at OPEN time rather than at import time — the Playwright e2e
// servers and this suite both set process.env.DATA_DIR after these modules
// are already imported.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { resolveDataDir } from '../tools/dataDir.js';
import { defaultObservationEventsPath } from '../tools/observationEventsDb.js';
import { defaultEcosystemPath } from '../tools/ecosystemIndexDb.js';
import { defaultClaimsPath } from '../tools/claims/claimsStore.js';
import { defaultProbeCachePath } from '../tools/usda-plants/probeCache.js';

function withEnv(name, value, fn) {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

test('resolveDataDir honours DATA_DIR and falls back to the repo data/ directory when unset', () => {
  withEnv('DATA_DIR', undefined, () => {
    assert.match(resolveDataDir(), /\/data$/);
  });
  withEnv('DATA_DIR', '/tmp/some-scratch-dir', () => {
    assert.equal(resolveDataDir(), resolve('/tmp/some-scratch-dir'));
  });
});

test('resolveDataDir(explicitDir) overrides DATA_DIR entirely', () => {
  withEnv('DATA_DIR', '/tmp/env-dir', () => {
    assert.equal(resolveDataDir('/tmp/explicit-dir'), resolve('/tmp/explicit-dir'));
  });
});

test('each store default path is resolved at call time, so setting DATA_DIR after import still redirects it', () => {
  withEnv('DATA_DIR', undefined, () => {
    // Unset: every default lands under the repo's real data/.
    assert.match(defaultObservationEventsPath(), /\/data\/observation-events\.db$/);
    assert.match(defaultEcosystemPath(), /\/data\/ecosystem\.db$/);
    assert.match(defaultClaimsPath(), /\/data\/claims\.db$/);
    assert.match(defaultProbeCachePath(), /\/data\/probe-cache\.db$/);
  });

  withEnv('DATA_DIR', '/tmp/native-landscaping-datadir-test', () => {
    // Set only now, well after every module above was imported at the top
    // of this file: each default*Path() call must still pick it up.
    assert.equal(
      defaultObservationEventsPath(),
      join(resolve('/tmp/native-landscaping-datadir-test'), 'observation-events.db')
    );
    assert.equal(
      defaultEcosystemPath(),
      join(resolve('/tmp/native-landscaping-datadir-test'), 'ecosystem.db')
    );
    assert.equal(
      defaultClaimsPath(),
      join(resolve('/tmp/native-landscaping-datadir-test'), 'claims.db')
    );
    assert.equal(
      defaultProbeCachePath(),
      join(resolve('/tmp/native-landscaping-datadir-test'), 'probe-cache.db')
    );
  });
});
