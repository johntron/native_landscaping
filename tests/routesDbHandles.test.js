// Proves the route handlers read from ctx.db (the handles server.js opens
// once at startup) rather than opening their own handle per request
// (nl-3s5.14). Each test seeds a store directly through the shared handle,
// then calls the route handler with a stub req/res and asserts the seeded
// row comes back — which is only possible if the handler read the same
// handle the test wrote through, not a fresh one at DEFAULT_PATH.
//
// GET only: POST/PUT/DELETE on /api/saved-areas call exportSavedAreasJson(),
// which writes saved-areas.export.json under DATA_DIR (the repo's data/ when
// unset), so they are not exercised here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openServerDatabases } from '../server/dbHandles.js';
import { openAppDb } from '../server/db/appDb.js';
import { handleFeedRoutes } from '../server/routes/feed.js';
import { handleEcosystemRoutes } from '../server/routes/ecosystem.js';
import { handleClaimsRoutes } from '../server/routes/claims.js';
import { createSavedArea } from '../tools/savedAreas/savedAreasDb.js';
import { upsertEvents } from '../tools/observationEventsDb.js';
import { replaceTaxonRows } from '../tools/ecosystemIndexDb.js';
import { setCached } from '../tools/usda-plants/probeCache.js';

function tmpPaths() {
  const dir = mkdtempSync(join(tmpdir(), 'routes-db-handles-test-'));
  return {
    dir,
    observationEvents: join(dir, 'observation-events.db'),
    ecosystem: join(dir, 'ecosystem.db'),
    claims: join(dir, 'claims.db'),
  };
}

/** ctx.db as server.js builds it: app.db plus the tools/ stores, all under a temp dir. */
function openDb(paths) {
  return { app: openAppDb({ dataDir: paths.dir, ownerEmail: '' }), ...openServerDatabases(paths) };
}

/**
 * Minimal GET req/res + ctx a route handler needs, mirroring server.js's
 * shape. `user` defaults to null (anonymous); pass an admin user for the
 * claims routes, which 404 anyone else (nl-3s5.7).
 */
function stubRequest(pathnameAndQuery, db, publicDir, user = null) {
  const url = new URL(`http://localhost${pathnameAndQuery}`);
  const req = { method: 'GET', headers: {} };
  const res = {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(chunk) {
      if (chunk) this.body += chunk;
    },
  };
  const ctx = { url, pathname: url.pathname, publicDir, db, user };
  return { req, res, ctx };
}

test('GET /api/saved-areas reads ctx.db.app, not a fresh handle', async () => {
  const paths = tmpPaths();
  try {
    const db = openDb(paths);
    createSavedArea(db.app, { name: 'Backyard', lat: 32.78, lng: -96.8, radiusMi: 5 });

    const { req, res, ctx } = stubRequest('/api/saved-areas', db, paths.dir);
    const handled = await handleFeedRoutes(req, res, ctx);

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.areas.length, 1);
    assert.equal(parsed.areas[0].name, 'Backyard');
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test('GET /api/observation-events reads ctx.db.observationEvents', async () => {
  const paths = tmpPaths();
  try {
    const db = openDb(paths);
    upsertEvents(db.observationEvents, [
      { observation_id: 1, area_id: 'area-1', taxon_name: 'Asclepias tuberosa', observed_on: '2026-01-01', ingested_at: 't1' },
    ]);

    const { req, res, ctx } = stubRequest('/api/observation-events?area_id=area-1', db, paths.dir);
    const handled = await handleFeedRoutes(req, res, ctx);

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.rows[0].taxon_name, 'Asclepias tuberosa');
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test('GET /api/feed?lane=rarity reads ctx.db.ecosystem through the rarity lane without opening a fresh handle', async () => {
  const paths = tmpPaths();
  try {
    const db = openDb(paths);
    const area = createSavedArea(db.app, {
      name: 'Rare spot',
      lat: 32.78,
      lng: -96.8,
      radiusMi: 5,
      filters: { place: 'Dallas, TX' },
    });
    upsertEvents(db.observationEvents, [
      { observation_id: 30, area_id: area.id, taxon_name: 'Asclepias tuberosa', observed_on: '2026-01-01', ingested_at: 't1' },
    ]);
    replaceTaxonRows(db.ecosystem, 'Dallas, TX', 'Plantae', [
      { taxon_name: 'Asclepias tuberosa', genus: 'Asclepias', radius_mi: 10, observation_count: 3, fetched_on: '2026-01-01', source: 'test' },
    ]);

    const { req, res, ctx } = stubRequest(`/api/feed?area_id=${area.id}&lane=rarity`, db, paths.dir);
    const handled = await handleFeedRoutes(req, res, ctx);

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.total, 1);
    assert.equal(parsed.items[0].relevance.kind, 'local-scarcity');
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test('GET /api/ecosystem/places reads ctx.db.ecosystem', async () => {
  const paths = tmpPaths();
  try {
    const db = openDb(paths);
    replaceTaxonRows(db.ecosystem, 'Dallas, TX', 'Plantae', [
      { taxon_name: 'Asclepias tuberosa', genus: 'Asclepias', radius_mi: 10, observation_count: 3, fetched_on: '2026-01-01', source: 'test' },
    ]);

    const { req, res, ctx } = stubRequest('/api/ecosystem/places', db, paths.dir);
    const handled = await handleEcosystemRoutes(req, res, ctx);

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body).places, ['Dallas, TX']);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

/**
 * Minimal POST req/res + ctx, mirroring server.js's shape for a JSON body
 * (collectPayload reads req via 'data'/'end' listeners).
 */
function stubPostRequest(pathnameAndQuery, body, db, publicDir) {
  const url = new URL(`http://localhost${pathnameAndQuery}`);
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    on(event, cb) {
      if (event === 'data') cb(Buffer.from(JSON.stringify(body)));
      if (event === 'end') cb();
    },
  };
  const res = {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    setHeader() {},
    end(chunk) {
      if (chunk) this.body += chunk;
    },
  };
  const ctx = { url, pathname: url.pathname, publicDir, db, user: null };
  return { req, res, ctx };
}

test('POST /api/geocode reads ctx.db.probeCache, not a fresh handle: a value seeded through the shared handle is served with no network call', async () => {
  const paths = tmpPaths();
  try {
    const db = openDb(paths);
    setCached(db.probeCache, 'nominatim', 'search', 'Seeded City', [
      { lat: '1.5', lon: '2.5', display_name: 'Seeded City, TX, USA', address: { city: 'Seeded City', state: 'Texas', country: 'USA' } },
    ]);
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: true, status: 200, json: async () => [] };
    };
    try {
      const { req, res, ctx } = stubPostRequest('/api/geocode', { query: 'Seeded City' }, db, paths.dir);
      const handled = await handleEcosystemRoutes(req, res, ctx);

      assert.equal(handled, true);
      assert.equal(res.statusCode, 200);
      assert.equal(fetchCalled, false, 'a cache hit through ctx.db.probeCache must not touch the network');
      const parsed = JSON.parse(res.body);
      assert.equal(parsed.city, 'Seeded City');
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test('GET /api/ecoregion reads ctx.db.probeCache, not a fresh handle: a value seeded through the shared handle is served with no network call', async () => {
  const paths = tmpPaths();
  try {
    const db = openDb(paths);
    setCached(db.probeCache, 'cec-ecoregions', 'level1-query', '32.777,-96.797', {
      features: [{ attributes: { LEVEL1: '9', NameL1_En: 'Great Plains' } }],
    });
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: true, status: 200, json: async () => ({ features: [] }) };
    };
    try {
      const { req, res, ctx } = stubRequest('/api/ecoregion?lat=32.777&lng=-96.797', db, paths.dir);
      const handled = await handleEcosystemRoutes(req, res, ctx);

      assert.equal(handled, true);
      assert.equal(res.statusCode, 200);
      assert.equal(fetchCalled, false, 'a cache hit through ctx.db.probeCache must not touch the network');
      const parsed = JSON.parse(res.body);
      assert.equal(parsed.code, '9');
      assert.equal(parsed.name, 'Great Plains');
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test('GET /api/claims-coverage against an unbuilt claim store returns the exact "not built" message, via db.claims(), and creates no file', async () => {
  const paths = tmpPaths();
  try {
    const db = openDb(paths);
    const { req, res, ctx } = stubRequest('/api/claims-coverage', db, paths.dir, { id: 1, email: 'admin@example.com', isAdmin: true });
    const handled = await handleClaimsRoutes(req, res, ctx);

    assert.equal(handled, true);
    assert.equal(res.statusCode, 400);
    assert.match(
      JSON.parse(res.body).error,
      /Claim store not built — run tools\/claims\/rebuild\.js to create data\/claims\.db/
    );
    assert.equal(existsSync(paths.claims), false, 'a failed claims() call must not create data/claims.db');
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});
