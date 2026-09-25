// nl-3s5.30: an owner sets their own yard's location in Setup mode.
//
// GET /api/project-location, POST /api/project-location/preview (geocode, show
// the match, write nothing) and POST /api/project-location (save the previewed
// match, or clear). Authorization rows for all three live in
// tests/projectAuthorization.test.js; this file covers what they store, what
// they send back, what they never send or log, the rate limits, and the
// covered-region warning.
//
// Nothing here reaches the network: globalThis.fetch is replaced by a fake
// Nominatim and a fake CEC ecoregion service for the whole file, and every call
// is recorded so a test can assert how many reached "upstream".
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { openAppDb } from '../server/db/appDb.js';
import { upsertUser } from '../server/identity.js';
import {
  EXAMPLE_OWNER_EMAIL,
  SETUP_LOCATION_SOURCE,
  findOwnedProject,
  insertProject,
  setProjectLocation,
} from '../server/db/projectStore.js';
import { listLocatedProjects } from '../server/db/projectSites.js';
import { createRateLimiter } from '../server/http.js';
import { handleProjectRoutes } from '../server/routes/project.js';
import { handleEcosystemRoutes } from '../server/routes/ecosystem.js';
import { locationKey, markBuildFinished, markBuildStarted, openEcosystemDb } from '../tools/ecosystemIndexDb.js';
import { dueIndexBuilds } from '../tools/ecosystemIndexQueue.js';
import { openProbeCache } from '../tools/usda-plants/probeCache.js';
import { COVERED_RADIUS_MI, coveredRegionVerdict } from '../src/analysis/coveredRegion.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// --- the fake upstream services ------------------------------------------------

/** Typed text -> the point the fake Nominatim answers with. */
const PLACES = {
  '100 Main St, Dallas, TX': { lat: '32.7812345', lon: '-96.8012345', display_name: '100 Main Street, Dallas, Dallas County, Texas, 75201, United States' },
  'Denton, TX': { lat: '33.2148412', lon: '-97.1330683', display_name: 'Denton, Denton County, Texas, United States' },
  'Tyler, TX': { lat: '32.3512601', lon: '-95.3010624', display_name: 'Tyler, Smith County, Texas, United States' },
  'Wichita, KS': { lat: '37.6922361', lon: '-97.3375448', display_name: 'Wichita, Sedgwick County, Kansas, United States' },
};
const EAST_OF = -95.6; // the fake ecoregion service answers Level I 8 east of this longitude

const upstream = { calls: [], ecoregionDown: false };

globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  upstream.calls.push(url.hostname);
  const reply = (body) => ({ ok: true, status: 200, json: async () => body });
  if (url.hostname === 'nominatim.openstreetmap.org') {
    const q = url.searchParams.get('q');
    if (q === 'upstream is down') return { ok: false, status: 503, json: async () => ({}) };
    const place = PLACES[q];
    return reply(place ? [{ ...place, address: { state: 'Texas', country: 'United States' } }] : []);
  }
  if (url.hostname === 'services7.arcgis.com') {
    if (upstream.ecoregionDown) return { ok: false, status: 500, json: async () => ({}) };
    const [lng] = url.searchParams.get('geometry').split(',').map(Number);
    const attributes = lng > EAST_OF ? { LEVEL1: 8, NameL1_En: 'EASTERN TEMPERATE FORESTS' } : { LEVEL1: 9, NameL1_En: 'GREAT PLAINS' };
    return reply({ features: [{ attributes }] });
  }
  throw new Error(`unexpected network call in tests: ${url.hostname}`);
};

const nominatimCalls = () => upstream.calls.filter((h) => h === 'nominatim.openstreetmap.org').length;

// --- harness ---------------------------------------------------------------------

function setup() {
  upstream.calls.length = 0;
  upstream.ecoregionDown = false;
  const dataDir = mkdtempSync(join(tmpdir(), 'project-location-test-'));
  const db = openAppDb({ dataDir, ownerEmail: '', importLegacy: false });
  const env = { dataDir, db };
  env.alice = upsertUser(db, 'alice@example.com');
  env.bob = upsertUser(db, 'bob@example.com');
  const yard = (owner, slug) =>
    insertProject(db, {
      ownerId: owner.id,
      slug,
      name: slug,
      configJson: JSON.stringify({ name: slug, place: 'home', views: [{ id: 'plan', type: 'plan' }] }),
      entries: [{ id: `${slug}-e0`, timestamp: '2026-01-01T00:00:00Z', description: 'first', plants: [] }],
    });
  env.aliceYardId = yard(env.alice, 'alice-yard');
  env.bobYardId = yard(env.bob, 'bob-yard');
  env.ecosystem = openEcosystemDb(join(dataDir, 'ecosystem.db'));
  env.probeCache = openProbeCache(join(dataDir, 'probe-cache.db'));
  env.pendingLocationPreviews = new Map(); // ids repeat across these throwaway databases
  env.cleanup = () => {
    env.probeCache.close();
    env.ecosystem.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return env;
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
    end(body, cb) {
      this.body = body;
      if (typeof cb === 'function') cb();
    },
    json() {
      return JSON.parse(String(this.body));
    },
  };
}

async function call(env, user, method, pathAndQuery, body) {
  const url = new URL(`http://localhost${pathAndQuery}`);
  const ctx = {
    url,
    pathname: url.pathname,
    dataDir: env.dataDir,
    db: { app: env.db, ecosystem: env.ecosystem, probeCache: env.probeCache },
    user,
    copyExampleLimiter: createRateLimiter(),
    geocodeLimiter: env.geocodeLimiter || createRateLimiter(),
    ecoregionLimiter: env.ecoregionLimiter || createRateLimiter(),
    pendingLocationPreviews: env.pendingLocationPreviews,
  };
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.headers = { 'content-type': 'application/json' };
  const res = makeRes();
  for (const handle of [handleProjectRoutes, handleEcosystemRoutes]) {
    if (await handle(req, res, ctx)) return res;
  }
  return null;
}

const preview = (env, user, slug, query) => call(env, user, 'POST', `/api/project-location/preview?project=${slug}`, { query });
const save = (env, user, slug, query) => call(env, user, 'POST', `/api/project-location?project=${slug}`, { query });
const stored = (env, id) => {
  const row = env.db.prepare('SELECT location_json FROM projects WHERE id = ?').get(id);
  return row.location_json === null ? null : JSON.parse(row.location_json);
};
const everything = (env) => ({
  projects: env.db.prepare('SELECT * FROM projects ORDER BY id').all(),
  history: env.db.prepare('SELECT * FROM history_entries ORDER BY project_id, seq').all(),
});

/** Run fn with console.log/warn/error captured; returns everything printed. */
async function captureLogs(fn) {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const name of Object.keys(saved)) console[name] = (...args) => lines.push(args.map(String).join(' '));
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  return lines.join('\n');
}

// --- the two-step flow -------------------------------------------------------------

test('preview geocodes and writes nothing; save stores the previewed match; nothing before a preview', async () => {
  const env = setup();
  try {
    const before = everything(env);

    // A save of text never looked up is refused, and reaches no geocoder.
    const blind = await save(env, env.alice, 'alice-yard', '100 Main St, Dallas, TX');
    assert.equal(blind.statusCode, 409, blind.body);
    assert.equal(nominatimCalls(), 0, 'a save never calls Nominatim');
    assert.deepEqual(everything(env), before);

    const shown = await preview(env, env.alice, 'alice-yard', '  100 Main St, Dallas, TX ');
    assert.equal(shown.statusCode, 200, shown.body);
    const { match, region } = shown.json();
    assert.equal(match.displayName, PLACES['100 Main St, Dallas, TX'].display_name);
    assert.deepEqual([match.lat, match.lng], [32.781, -96.801], 'rounded to 3 decimals for the owner');
    assert.equal(region.status, 'covered');
    assert.equal(nominatimCalls(), 1);
    assert.deepEqual(everything(env), before, 'a preview writes nothing');

    const saved = await save(env, env.alice, 'alice-yard', '100 Main St, Dallas, TX');
    assert.equal(saved.statusCode, 200, saved.body);
    const body = saved.json();
    assert.deepEqual(body.location, { set: true, lat: 32.781, lng: -96.801 });
    assert.equal(body.index.state, 'queued', "What's nearby shows the building state until the poller runs");
    assert.equal(body.pollMinutes, 30);
    assert.equal(nominatimCalls(), 1, 'the save was a probe-cache read');
    assert.equal(String(saved.body).includes('7812345'), false, 'full precision never leaves the server');

    // Stored at full precision, in the CLI's shape, and nothing else.
    assert.deepEqual(stored(env, env.aliceYardId), { lat: 32.7812345, lng: -96.8012345, source: SETUP_LOCATION_SOURCE });
    assert.equal(stored(env, env.bobYardId), null, "Bob's yard untouched");

    // The read route gives the same rounded point back.
    const read = (await call(env, env.alice, 'GET', '/api/project-location?project=alice-yard')).json();
    assert.deepEqual(read.location, { set: true, lat: 32.781, lng: -96.801 });
    assert.equal(read.region.status, 'covered');
  } finally {
    env.cleanup();
  }
});

test('clearing the location empties the column and takes the yard off the index queue', async () => {
  const env = setup();
  try {
    await preview(env, env.alice, 'alice-yard', 'Denton, TX');
    await save(env, env.alice, 'alice-yard', 'Denton, TX');
    assert.equal(listLocatedProjects(env.db).length, 1);
    const cleared = await call(env, env.alice, 'POST', '/api/project-location?project=alice-yard', { clear: true });
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.deepEqual(cleared.json().location, null);
    assert.equal(stored(env, env.aliceYardId), null);
    assert.equal(listLocatedProjects(env.db).length, 0);
    const nearby = (await call(env, env.alice, 'GET', '/api/ecosystem?project=alice-yard')).json();
    assert.equal(nearby.index.state, 'no-location');
    assert.deepEqual((await call(env, env.alice, 'GET', '/api/project-location?project=alice-yard')).json(), { location: null, region: null });
  } finally {
    env.cleanup();
  }
});

test('a lookup with no match or a failing geocoder is reported without echoing the text, and saves nothing', async () => {
  const env = setup();
  try {
    const before = everything(env);
    let none;
    let down;
    const logs = await captureLogs(async () => {
      none = await preview(env, env.alice, 'alice-yard', 'Nowhere Lane 99999');
      down = await preview(env, env.alice, 'alice-yard', 'upstream is down');
    });
    assert.equal(none.statusCode, 422);
    assert.equal(String(none.body).includes('Nowhere'), false);
    assert.equal(down.statusCode, 502);
    assert.equal(/Nowhere|upstream is down/.test(logs), false, `logs quote the typed text: ${logs}`);
    assert.deepEqual(everything(env), before);
    assert.equal((await preview(env, env.alice, 'alice-yard', '   ')).statusCode, 400);
    assert.equal((await preview(env, env.alice, 'alice-yard', 'x'.repeat(201))).statusCode, 400);
  } finally {
    env.cleanup();
  }
});

// --- shape and queue -----------------------------------------------------------------

test("location_json has exactly the CLI's shape (tools/project-location.mjs --lat --lng)", async () => {
  const env = setup();
  try {
    await preview(env, env.alice, 'alice-yard', 'Denton, TX');
    await save(env, env.alice, 'alice-yard', 'Denton, TX');
    const fromRoute = stored(env, env.aliceYardId);

    const cli = spawnSync(
      process.execPath,
      ['tools/project-location.mjs', '--project', 'bob-yard', '--owner', 'bob@example.com', '--lat', '33.2148412', '--lng', '-97.1330683'],
      { cwd: REPO_ROOT, env: { ...process.env, DATA_DIR: env.dataDir, OWNER_EMAIL: '' }, encoding: 'utf-8' }
    );
    assert.equal(cli.status, 0, cli.stderr);
    const fromCli = stored(env, env.bobYardId);

    assert.deepEqual(Object.keys(fromRoute).sort(), Object.keys(fromCli).sort());
    for (const key of ['lat', 'lng']) assert.equal(typeof fromRoute[key], typeof fromCli[key]);
    assert.equal(locationKey(fromRoute), locationKey(fromCli), 'the same point fingerprints the same, whoever saved it');
  } finally {
    env.cleanup();
  }
});

test('a new location is queued, and moving it changes the fingerprint so the index is rebuilt', async () => {
  const env = setup();
  try {
    await preview(env, env.alice, 'alice-yard', '100 Main St, Dallas, TX');
    await save(env, env.alice, 'alice-yard', '100 Main St, Dallas, TX');
    const first = stored(env, env.aliceYardId);
    assert.deepEqual(
      dueIndexBuilds(env.db, env.ecosystem).map((p) => [p.id, p.reason]),
      [[env.aliceYardId, 'new']]
    );

    // The poller builds it.
    markBuildStarted(env.ecosystem, env.aliceYardId, locationKey(first));
    markBuildFinished(env.ecosystem, env.aliceYardId, { state: 'ready', fetchedOn: '2026-09-01' });
    assert.deepEqual(dueIndexBuilds(env.db, env.ecosystem), []);
    assert.equal((await call(env, env.alice, 'GET', '/api/ecosystem?project=alice-yard')).json().index.state, 'ready');

    // Saving the same point again keeps the index.
    await preview(env, env.alice, 'alice-yard', '100 Main St, Dallas, TX');
    const again = await save(env, env.alice, 'alice-yard', '100 Main St, Dallas, TX');
    assert.equal(again.json().index.state, 'ready');
    assert.deepEqual(dueIndexBuilds(env.db, env.ecosystem), []);

    // Moving it: a different fingerprint, queued as moved, and What's nearby waits.
    await preview(env, env.alice, 'alice-yard', 'Denton, TX');
    const moved = await save(env, env.alice, 'alice-yard', 'Denton, TX');
    assert.equal(moved.json().index.state, 'queued');
    assert.notEqual(locationKey(stored(env, env.aliceYardId)), locationKey(first));
    assert.deepEqual(
      dueIndexBuilds(env.db, env.ecosystem).map((p) => [p.id, p.reason]),
      [[env.aliceYardId, 'moved']]
    );
    assert.equal((await call(env, env.alice, 'GET', '/api/ecosystem?project=alice-yard')).json().index.state, 'queued');
  } finally {
    env.cleanup();
  }
});

// --- privacy -----------------------------------------------------------------------

test('the location never enters revisions, the config, or anything another user can read', async () => {
  const env = setup();
  try {
    const history = () => env.db.prepare('SELECT * FROM history_entries ORDER BY project_id, seq').all();
    const row = () => env.db.prepare('SELECT config_json, features_json, history_cursor FROM projects WHERE id = ?').get(env.aliceYardId);
    const historyBefore = history();
    const rowBefore = row();

    await preview(env, env.alice, 'alice-yard', '100 Main St, Dallas, TX');
    await save(env, env.alice, 'alice-yard', '100 Main St, Dallas, TX');

    assert.deepEqual(history(), historyBefore, 'no revision added or changed');
    assert.deepEqual(row(), rowBefore, 'config, features and history cursor untouched');
    const leak = /32\.78|96\.80|Main St/;
    assert.equal(leak.test(JSON.stringify(history())), false);
    for (const path of ['/api/history', '/api/project', '/api/features', '/api/layout']) {
      const body = String((await call(env, env.alice, 'GET', `${path}?project=alice-yard`)).body);
      assert.equal(leak.test(body), false, `${path} carries the location`);
    }

    // A later setup save (a revision) still carries none of it.
    const config = (await call(env, env.alice, 'GET', '/api/project?project=alice-yard')).json();
    assert.equal((await call(env, env.alice, 'POST', '/api/project?project=alice-yard', config)).statusCode, 200);
    assert.equal(leak.test(JSON.stringify(history())), false);

    // Bob: 404 on Alice's yard for every location route, and nothing of hers in his own answers.
    for (const [method, path, body] of [
      ['GET', '/api/project-location?project=alice-yard'],
      ['POST', '/api/project-location/preview?project=alice-yard', { query: 'Denton, TX' }],
      ['POST', '/api/project-location?project=alice-yard', { query: '100 Main St, Dallas, TX' }],
      ['POST', '/api/project-location?project=alice-yard', { clear: true }],
    ]) {
      const res = await call(env, env.bob, method, path, body);
      assert.equal(res.statusCode, 404, `${method} ${path}`);
      assert.equal(leak.test(String(res.body)), false);
    }
    assert.deepEqual(stored(env, env.aliceYardId).lat, 32.7812345, "Bob's clear did not reach Alice's yard");
    for (const path of ['/api/project-location', '/api/ecosystem', '/api/projects']) {
      const res = await call(env, env.bob, 'GET', `${path}?project=bob-yard`);
      assert.equal(leak.test(String(res.body)), false, `${path} as Bob`);
    }
  } finally {
    env.cleanup();
  }
});

test('nothing the location routes log carries the typed text, the match, or a coordinate', async () => {
  const env = setup();
  try {
    const logs = await captureLogs(async () => {
      await preview(env, env.alice, 'alice-yard', '100 Main St, Dallas, TX');
      await save(env, env.alice, 'alice-yard', '100 Main St, Dallas, TX');
      await call(env, env.alice, 'GET', '/api/project-location?project=alice-yard');
      upstream.ecoregionDown = true;
      await preview(env, env.alice, 'alice-yard', 'Tyler, TX');
      await call(env, env.alice, 'POST', '/api/project-location?project=alice-yard', { clear: true });
    });
    assert.match(logs, /alice-yard/, 'the slug is logged');
    assert.equal(/Main|Dallas|Tyler|32\.|-96\.|-95\./.test(logs), false, `a log line leaks the location: ${logs}`);
  } finally {
    env.cleanup();
  }
});

test('the example yard can never be given a location', async () => {
  const env = setup();
  try {
    const system = upsertUser(env.db, EXAMPLE_OWNER_EMAIL);
    const exampleLike = insertProject(env.db, { ownerId: system.id, slug: 'example', name: 'Example', configJson: '{}' });
    assert.throws(() => setProjectLocation(env.db, exampleLike, { lat: 32.8, lng: -96.8 }), /example/);
    assert.equal(stored(env, exampleLike), null);
    assert.throws(() => setProjectLocation(env.db, env.aliceYardId, { lat: 95, lng: 0 }), /in range/);
  } finally {
    env.cleanup();
  }
});

// --- rate limits ---------------------------------------------------------------------

test('previews share one Nominatim bucket across users; refused callers spend no token; saves are throttled per caller', async () => {
  const env = setup();
  try {
    // capacity 1, next to no refill: one geocode for the whole server.
    env.geocodeLimiter = createRateLimiter({ capacity: 1, refillPerSecond: 0.0001 });
    // Refused before the limiter: anonymous, and Bob on Alice's yard.
    assert.equal((await preview(env, null, 'alice-yard', 'Denton, TX')).statusCode, 401);
    assert.equal((await preview(env, env.bob, 'alice-yard', 'Denton, TX')).statusCode, 404);
    assert.equal((await preview(env, env.alice, 'alice-yard', 'Denton, TX')).statusCode, 200, 'the token was still there');
    const second = await preview(env, env.bob, 'bob-yard', 'Tyler, TX');
    assert.equal(second.statusCode, 429, "Bob's own first lookup waits on the shared bucket");
    assert.ok(Number(second.headers['Retry-After']) > 0);
    assert.equal(nominatimCalls(), 1);

    // The save needs no Nominatim token, so the empty bucket does not block it...
    env.ecoregionLimiter = createRateLimiter({ capacity: 1, refillPerSecond: 0.0001 });
    assert.equal((await save(env, env.alice, 'alice-yard', 'Denton, TX')).statusCode, 200);
    // ...but saves are limited per caller (checked before the body is read).
    assert.equal((await save(env, env.alice, 'alice-yard', 'Denton, TX')).statusCode, 429);
  } finally {
    env.cleanup();
  }
});

// --- the covered region --------------------------------------------------------------

test('out-of-region locations are saved with a warning, never refused', async () => {
  const env = setup();
  try {
    // Tyler: 90-some miles from Dallas, but East Texas (Level I 8).
    await preview(env, env.alice, 'alice-yard', 'Tyler, TX');
    const tyler = await save(env, env.alice, 'alice-yard', 'Tyler, TX');
    assert.equal(tyler.statusCode, 200);
    assert.equal(tyler.json().region.status, 'outside');
    assert.equal(tyler.json().region.ecoregion.code, '8');
    assert.match(tyler.json().region.message, /EASTERN TEMPERATE FORESTS/);

    // Wichita: Great Plains like Dallas, but far past our radius.
    await preview(env, env.bob, 'bob-yard', 'Wichita, KS');
    const wichita = await save(env, env.bob, 'bob-yard', 'Wichita, KS');
    assert.equal(wichita.statusCode, 200);
    assert.equal(wichita.json().region.status, 'outside');
    assert.equal(wichita.json().region.ecoregion.code, '9');
    assert.match(wichita.json().region.message, /our own cut-off/);
    assert.ok(stored(env, env.bobYardId).lat > 37, 'saved anyway');

    // Denton: covered.
    await preview(env, env.alice, 'alice-yard', 'Denton, TX');
    assert.equal((await save(env, env.alice, 'alice-yard', 'Denton, TX')).json().region.status, 'covered');
  } finally {
    env.cleanup();
  }
});

test('coveredRegionVerdict: sourced ecoregion check, judgement radius, unknown when the lookup fails', () => {
  const dallas = { lat: 32.78, lng: -96.8 };
  assert.equal(coveredRegionVerdict(dallas, { code: '9', name: 'GREAT PLAINS' }).status, 'covered');
  assert.equal(coveredRegionVerdict(dallas, { code: '8', name: 'EASTERN TEMPERATE FORESTS' }).status, 'outside');
  const unknown = coveredRegionVerdict(dallas, null);
  assert.equal(unknown.status, 'unknown');
  assert.match(unknown.message, /could not be looked up/);
  // Far away is outside on distance alone, whatever the ecoregion lookup did.
  const kansas = coveredRegionVerdict({ lat: 37.69, lng: -97.34 }, null);
  assert.equal(kansas.status, 'outside');
  assert.ok(kansas.distanceMi > COVERED_RADIUS_MI);
  assert.throws(() => coveredRegionVerdict({ lat: NaN, lng: 0 }, null));
});

test('an ecoregion service that is down leaves the verdict unchecked and the save goes through', async () => {
  const env = setup();
  try {
    upstream.ecoregionDown = true;
    await preview(env, env.alice, 'alice-yard', 'Denton, TX');
    const res = await save(env, env.alice, 'alice-yard', 'Denton, TX');
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().region.status, 'unknown');
    assert.ok(stored(env, env.aliceYardId));
  } finally {
    env.cleanup();
  }
});

test('the poll interval the save reports follows FEED_POLL_INTERVAL_MINUTES', async () => {
  const env = setup();
  const original = process.env.FEED_POLL_INTERVAL_MINUTES;
  try {
    process.env.FEED_POLL_INTERVAL_MINUTES = '15';
    await preview(env, env.alice, 'alice-yard', 'Denton, TX');
    assert.equal((await save(env, env.alice, 'alice-yard', 'Denton, TX')).json().pollMinutes, 15);
  } finally {
    if (original === undefined) delete process.env.FEED_POLL_INTERVAL_MINUTES;
    else process.env.FEED_POLL_INTERVAL_MINUTES = original;
    env.cleanup();
  }
});

test('findOwnedProject still sees an address-only location from the CLI, and the read route says it is set', async () => {
  const env = setup();
  try {
    env.db.prepare('UPDATE projects SET location_json = ? WHERE id = ?').run(
      JSON.stringify({ address: 'somewhere', source: 'tools/project-location.mjs' }),
      env.aliceYardId
    );
    assert.ok(findOwnedProject(env.db, env.alice.id, 'alice-yard').locationJson);
    const read = await call(env, env.alice, 'GET', '/api/project-location?project=alice-yard');
    assert.deepEqual(read.json(), { location: { set: true, lat: null, lng: null }, region: null });
    assert.equal(String(read.body).includes('somewhere'), false, 'the address itself is not sent');
  } finally {
    env.cleanup();
  }
});

test("a save must repeat the caller's own preview: another user's lookup of the same text does not count, and says nothing", async () => {
  const env = setup();
  try {
    const text = '100 Main St, Dallas, TX';
    // Bob tries a text nobody has looked up, then the same text after Alice has.
    const cold = await save(env, env.bob, 'bob-yard', text);
    assert.equal((await preview(env, env.alice, 'alice-yard', text)).statusCode, 200);
    const warm = await save(env, env.bob, 'bob-yard', text);
    assert.equal(cold.statusCode, 409);
    assert.equal(warm.statusCode, 409, "Alice's lookup is not Bob's");
    assert.equal(String(warm.body), String(cold.body), 'the two refusals are identical');
    assert.equal(stored(env, env.bobYardId), null);

    // Alice's preview is for her yard: it does not carry to her other yard,
    // nor to different text.
    const second = insertProject(env.db, { ownerId: env.alice.id, slug: 'alice-two', name: 'two', configJson: '{}' });
    assert.equal((await save(env, env.alice, 'alice-two', text)).statusCode, 409);
    assert.equal((await save(env, env.alice, 'alice-yard', 'Denton, TX')).statusCode, 409);
    assert.equal(stored(env, second), null);

    // Her own, for this yard: saved, and spent.
    assert.equal((await save(env, env.alice, 'alice-yard', text)).statusCode, 200);
    assert.equal((await save(env, env.alice, 'alice-yard', text)).statusCode, 409, 'one preview, one save');
  } finally {
    env.cleanup();
  }
});

test('an undo or redo never touches the location, and no restored setup carries it', async () => {
  const env = setup();
  try {
    // A second revision to move between.
    const config = (await call(env, env.alice, 'GET', '/api/project?project=alice-yard')).json();
    assert.equal((await call(env, env.alice, 'POST', '/api/project?project=alice-yard', { ...config, name: 'Renamed' })).statusCode, 200);
    await preview(env, env.alice, 'alice-yard', '100 Main St, Dallas, TX');
    await save(env, env.alice, 'alice-yard', '100 Main St, Dallas, TX');
    const location = stored(env, env.aliceYardId);

    for (const cursor of [0, 1]) {
      const moved = await call(env, env.alice, 'POST', '/api/history/cursor?project=alice-yard', { cursor });
      assert.equal(moved.statusCode, 200, moved.body);
      assert.equal(/32\.78|96\.80|Main St/.test(String(moved.body)), false, 'the restored revision carries no location');
      assert.deepEqual(stored(env, env.aliceYardId), location, `cursor ${cursor} left the location alone`);
    }
  } finally {
    env.cleanup();
  }
});
