// The per-yard nearby index built without manual steps (nl-3s5.6): which yards
// are due, how many builds a tick runs, and the build itself against a
// stubbed iNaturalist (no test ever reaches the network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAppDb } from '../server/db/appDb.js';
import { upsertUser } from '../server/identity.js';
import { EXAMPLE_OWNER_EMAIL, insertProject } from '../server/db/projectStore.js';
import {
  indexStatus,
  listSpeciesObservations,
  locationKey,
  markBuildFinished,
  markBuildStarted,
  openEcosystemDb,
  readIndexBuild,
  replaceTaxonRows,
} from '../tools/ecosystemIndexDb.js';
import { dueIndexBuilds, pruneDeletedProjects, runIndexQueue, STALE_BUILD_MINUTES } from '../tools/ecosystemIndexQueue.js';
import { buildAndRecordEcosystemIndex, withoutQuotedText } from '../tools/fetch-ecosystem-index.mjs';
import { openProbeCache } from '../tools/usda-plants/probeCache.js';

const HERE = { lat: 32.5, lng: -96.5 };
const quiet = { log() {}, warn() {} };

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'ecosystem-queue-test-'));
  const app = openAppDb({ dataDir, ownerEmail: '', importLegacy: false });
  const ecosystem = openEcosystemDb(join(dataDir, 'ecosystem.db'));
  const env = { dataDir, app, ecosystem };
  env.alice = upsertUser(app, 'alice@example.com');
  env.bob = upsertUser(app, 'bob@example.com');
  env.yard = (owner, slug, { place = 'home', location = HERE } = {}) =>
    insertProject(app, {
      ownerId: owner.id,
      slug,
      name: slug,
      configJson: JSON.stringify({ name: slug, ...(place ? { place } : {}) }),
      locationJson: location ? JSON.stringify(location) : null,
    });
  env.cleanup = () => {
    ecosystem.close();
    app.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return env;
}

function markReady(env, id, location = HERE) {
  markBuildStarted(env.ecosystem, id, locationKey(location));
  markBuildFinished(env.ecosystem, id, { state: 'ready', fetchedOn: '2026-01-01' });
}

test('due: yards with a location and no index for it, never a yard without one or the example', () => {
  const env = setup();
  try {
    const a = env.yard(env.alice, 'a');
    env.yard(env.alice, 'no-location', { location: null });
    const b = env.yard(env.bob, 'b', { place: '' }); // no place label: still indexed, the key is the yard
    const example = upsertUser(env.app, EXAMPLE_OWNER_EMAIL);
    env.yard(example, 'example', { location: HERE });

    assert.deepEqual(
      dueIndexBuilds(env.app, env.ecosystem).map((p) => [p.id, p.reason]),
      [[a, 'new'], [b, 'new']]
    );
    markReady(env, a);
    assert.deepEqual(dueIndexBuilds(env.app, env.ecosystem).map((p) => p.id), [b]);

    // Moving a yard makes it due again.
    env.app.prepare('UPDATE projects SET location_json = ? WHERE id = ?').run(JSON.stringify({ lat: 33, lng: -97 }), a);
    assert.deepEqual(dueIndexBuilds(env.app, env.ecosystem).map((p) => [p.id, p.reason]), [[a, 'moved'], [b, 'new']]);
  } finally {
    env.cleanup();
  }
});

test('due: a failed build waits before its retry, and a build abandoned mid-run is picked up again', () => {
  const env = setup();
  try {
    const failed = env.yard(env.alice, 'failed');
    const stuck = env.yard(env.alice, 'stuck');
    const key = locationKey(HERE);
    const t0 = Date.parse('2026-01-01T00:00:00Z');
    markBuildStarted(env.ecosystem, failed, key, new Date(t0).toISOString());
    markBuildFinished(env.ecosystem, failed, { state: 'failed', error: 'HTTP 503', now: new Date(t0).toISOString() });
    markBuildStarted(env.ecosystem, stuck, key, new Date(t0).toISOString());

    assert.deepEqual(dueIndexBuilds(env.app, env.ecosystem, { now: t0 + 10 * 60_000 }), []);
    const later = dueIndexBuilds(env.app, env.ecosystem, { now: t0 + Math.max(61, STALE_BUILD_MINUTES + 1) * 60_000 });
    assert.deepEqual(later.map((p) => [p.id, p.reason]).sort(), [[failed, 'retry'], [stuck, 'stale']].sort());
  } finally {
    env.cleanup();
  }
});

test('a tick runs builds until one touches the network; cache-only builds are free', async () => {
  const env = setup();
  try {
    const ids = [env.yard(env.alice, 'one'), env.yard(env.alice, 'two'), env.yard(env.bob, 'three')];
    const calls = [];
    const build = async ({ id }) => {
      calls.push(id);
      return { state: 'ready', rows: 1, networkRequests: id === ids[0] ? 0 : 12 };
    };
    const tick = await runIndexQueue({ appDb: env.app, ecosystemDb: env.ecosystem, build });
    assert.deepEqual(calls, [ids[0], ids[1]], 'the cached build is free, the second spends the tick');
    assert.equal(tick.due, 3);
    assert.deepEqual(tick.built.map((b) => b.projectId), [ids[0], ids[1]]);
  } finally {
    env.cleanup();
  }
});

test('rows and builds of deleted yards are pruned', () => {
  const env = setup();
  try {
    const keep = env.yard(env.alice, 'keep');
    const row = { taxon_name: 'Asclepias tuberosa', genus: 'Asclepias', radius_mi: 1, observation_count: 1, fetched_on: 'x', source: 't' };
    // A build started for a new site drops that yard's rows, so start first.
    markReady(env, keep);
    replaceTaxonRows(env.ecosystem, keep, 'Plantae', [row]);
    markReady(env, 999);
    replaceTaxonRows(env.ecosystem, 999, 'Plantae', [row]);
    assert.deepEqual(pruneDeletedProjects(env.app, env.ecosystem), [999]);
    assert.equal(readIndexBuild(env.ecosystem, 999), null);
    assert.equal(listSpeciesObservations(env.ecosystem, { projectId: 999 }).length, 0);
    assert.equal(listSpeciesObservations(env.ecosystem, { projectId: keep }).length, 1);
  } finally {
    env.cleanup();
  }
});

// --- the build, against a stubbed iNaturalist ------------------------------------------

/** A fetch that answers the three iNaturalist endpoints the build calls, and counts calls. */
function fakeInaturalist({ fail = false } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname);
    const reply = (body, status = 200) => ({
      ok: status === 200,
      status,
      headers: { get: () => null },
      json: async () => body,
    });
    if (fail) return reply({}, 404);
    if (u.pathname === '/v1/places/nearby') return reply({ results: { standard: [{ id: 18, place_type: 8 }] } });
    if (u.pathname === '/v1/observations/species_counts') {
      const taxon = u.searchParams.get('iconic_taxa[]');
      return reply({
        results: [
          { count: 9, taxon: { id: taxon.length, name: `${taxon}ia nearbyensis`, preferred_common_name: `Nearby ${taxon}` } },
          { count: 2, taxon: { id: 1000 + taxon.length, name: `${taxon}ia introducta`, preferred_common_name: 'Weed' } },
        ],
      });
    }
    if (u.pathname.startsWith('/v1/taxa/')) {
      const ids = u.pathname.slice('/v1/taxa/'.length).split(',').map(Number);
      return reply({ results: ids.map((id) => ({ id, preferred_establishment_means: id >= 1000 ? 'introduced' : 'native' })) });
    }
    return reply({}, 404);
  };
  return { fetchImpl, calls };
}

test('the build writes the yard’s rows under its id and records it ready; a rebuild replays from the cache', async () => {
  const env = setup();
  try {
    const id = env.yard(env.alice, 'a');
    const probeCache = openProbeCache(join(env.dataDir, 'probe-cache.db'));
    const inat = fakeInaturalist();
    const args = { projectId: id, location: HERE, db: env.ecosystem, probeCache, requestDelayMs: 0, logger: quiet };

    const first = await buildAndRecordEcosystemIndex({ ...args, fetchImpl: inat.fetchImpl });
    assert.equal(first.state, 'ready');
    assert.ok(first.networkRequests > 0);
    assert.equal(first.networkRequests, inat.calls.length);
    assert.equal(indexStatus(env.ecosystem, id, locationKey(HERE)).state, 'ready');
    const rows = listSpeciesObservations(env.ecosystem, { projectId: id });
    assert.equal(rows.length, first.rows);
    assert.ok(rows.some((r) => r.taxon_name === 'Plantaeia nearbyensis' && r.establishment_means === 'native' && r.radius_mi === 0.25));
    assert.ok(rows.some((r) => r.establishment_means === 'introduced'), 'non-natives are stored and excluded on read');

    // Same site again: nothing leaves the machine.
    const offline = async () => {
      throw new Error('network used');
    };
    const again = await buildAndRecordEcosystemIndex({ ...args, fetchImpl: offline });
    assert.equal(again.state, 'ready');
    assert.equal(again.networkRequests, 0);
    assert.equal(listSpeciesObservations(env.ecosystem, { projectId: id }).length, rows.length);
    probeCache.close();
  } finally {
    env.cleanup();
  }
});

test('a build whose requests fail is recorded failed, spends the tick, and never sends coordinates to the log', async () => {
  const env = setup();
  try {
    const id = env.yard(env.alice, 'a');
    const probeCache = openProbeCache(join(env.dataDir, 'probe-cache.db'));
    const lines = [];
    const logger = { log: (l) => lines.push(String(l)), warn: (l) => lines.push(String(l)) };
    const result = await buildAndRecordEcosystemIndex({
      projectId: id,
      location: HERE,
      db: env.ecosystem,
      probeCache,
      fetchImpl: fakeInaturalist({ fail: true }).fetchImpl,
      requestDelayMs: 0,
      logger,
    });
    assert.equal(result.state, 'failed');
    assert.ok(result.networkRequests > 0);
    assert.equal(readIndexBuild(env.ecosystem, id).state, 'failed');
    assert.equal(lines.some((l) => l.includes('32.5') || l.includes('-96.5')), false);
    probeCache.close();
  } finally {
    env.cleanup();
  }
});

test('a failed build never stores or returns the address a geocoder quoted back', async () => {
  const env = setup();
  try {
    const id = env.yard(env.alice, 'a', { location: { address: '1 Secret Lane, Dallas' } });
    const probeCache = openProbeCache(join(env.dataDir, 'probe-cache.db'));
    // Seed the geocode cache with "no match", so geocodeAddress throws without the network.
    probeCache
      .prepare("INSERT INTO probe_cache (source, endpoint, cache_key, raw, fetched_at) VALUES ('nominatim', 'search', ?, '[]', 'now')")
      .run('1 Secret Lane, Dallas');
    const result = await buildAndRecordEcosystemIndex({
      projectId: id,
      location: { address: '1 Secret Lane, Dallas' },
      db: env.ecosystem,
      probeCache,
      fetchImpl: async () => {
        throw new Error('network used');
      },
      requestDelayMs: 0,
      logger: quiet,
    });
    assert.equal(result.state, 'failed');
    assert.equal(result.error.includes('Secret'), false);
    assert.equal(readIndexBuild(env.ecosystem, id).error.includes('Secret'), false);
    assert.equal(withoutQuotedText('found nothing for "1 Secret Lane"'), 'found nothing for "…"');
    probeCache.close();
  } finally {
    env.cleanup();
  }
});
