// A yard's site layers (nl-3s5.31): habitat anchors and nearby fauna, moved
// out of the committed place-keyed CSVs into data/ecosystem.db keyed by yard.
// The store, the three builds against stubbed upstreams (no test here reaches
// the network), the queue's per-upstream budget, the one-time import, and the
// region fetch behind the public page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAppDb } from '../server/db/appDb.js';
import { upsertUser } from '../server/identity.js';
import { EXAMPLE_OWNER_EMAIL, insertProject } from '../server/db/projectStore.js';
import {
  importLayer,
  layerStatus,
  listProjectAnchors,
  listProjectFauna,
  locationKey,
  markLayerStarted,
  openEcosystemDb,
  readLayerBuild,
  replaceLayerRows,
} from '../tools/ecosystemIndexDb.js';
import { dueSiteJobs, pruneDeletedProjects, runSiteQueue } from '../tools/ecosystemIndexQueue.js';
import { buildAndRecordFauna } from '../tools/fetch-nearby-fauna.mjs';
import { buildAndRecordStreams } from '../tools/fetch-nhd-creeks.mjs';
import { buildAndRecordGreenspace } from '../tools/fetch-osm-greenspace.mjs';
import { fetchRegionFauna, toRegionFaunaCsv, REGION_FAUNA_HEADER } from '../tools/fetch-region-fauna.mjs';
import { withoutQuotedText } from '../tools/siteLayerShared.mjs';
import { openProbeCache, setCached } from '../tools/usda-plants/probeCache.js';
import { parseCsv } from '../src/data/csvLoader.js';

// Any upstream call a test forgets to stub fails loudly instead of leaving.
globalThis.fetch = async (url) => {
  throw new Error(`network disabled in tests: ${String(url).split('?')[0]}`);
};

const HERE = { lat: 32.5, lng: -96.5 };
const quiet = { log() {}, warn() {} };

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'site-layers-test-'));
  const app = openAppDb({ dataDir, ownerEmail: '', importLegacy: false });
  const ecosystem = openEcosystemDb(join(dataDir, 'ecosystem.db'));
  const probeCache = openProbeCache(join(dataDir, 'probe-cache.db'));
  const env = { dataDir, app, ecosystem, probeCache };
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
    probeCache.close();
    ecosystem.close();
    app.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return env;
}

const reply = (body, status = 200) => ({
  ok: status === 200,
  status,
  headers: { get: () => null },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const STREAM = { kind: 'stream', name: 'Test Creek', status: 'anchor', distance_mi: 0.5, detail: 'channel', fetched_on: '2026-01-01', source: 'test' };
const PARK = { kind: 'park', name: 'Test Park', status: 'candidate', distance_mi: 1, detail: 'leisure=park, ~3 acres', fetched_on: '2026-01-01', source: 'test' };
const MOTH = { iconic_taxon: 'Insecta', animal_species: 'Testia mothia', animal_common: 'Test Moth', nearest_radius_mi: 1, observation_count: 2, establishment_means: 'native', fetched_on: '2026-01-01', source: 'test' };

// --- the store ---------------------------------------------------------------------------

test('layer rows are refused without a source or in the wrong layer', () => {
  const env = setup();
  try {
    const id = env.yard(env.alice, 'a');
    assert.throws(() => replaceLayerRows(env.ecosystem, id, 'streams', [{ ...STREAM, source: '' }]), /no source/);
    assert.throws(() => replaceLayerRows(env.ecosystem, id, 'greenspace', [STREAM]), /belongs to layer streams/);
    assert.throws(() => replaceLayerRows(env.ecosystem, id, 'parcels', []), /site layer is one of/);
  } finally {
    env.cleanup();
  }
});

test('a layer applies only at the location it was built for, and a move drops its rows', () => {
  const env = setup();
  try {
    const id = env.yard(env.alice, 'a');
    const key = locationKey(HERE);
    assert.equal(layerStatus(env.ecosystem, id, 'streams', null).state, 'no-location');
    assert.equal(layerStatus(env.ecosystem, id, 'streams', key).state, 'queued');
    importLayer(env.ecosystem, id, 'streams', key, [STREAM], { fetchedOn: '2026-01-01' });
    importLayer(env.ecosystem, id, 'greenspace', key, [PARK], { fetchedOn: '2026-01-01' });
    assert.deepEqual(layerStatus(env.ecosystem, id, 'streams', key), { state: 'ready', rowsApply: true, fetchedOn: '2026-01-01' });
    assert.equal(layerStatus(env.ecosystem, id, 'streams', locationKey({ lat: 1, lng: 1 })).rowsApply, false);
    assert.equal(readLayerBuild(env.ecosystem, id, 'streams').rowCount, 1);

    // A build for a new site drops that layer's rows, and only that layer's.
    markLayerStarted(env.ecosystem, id, 'streams', locationKey({ lat: 1, lng: 1 }));
    assert.deepEqual(listProjectAnchors(env.ecosystem, id).map((r) => r.name), ['Test Park']);
  } finally {
    env.cleanup();
  }
});

test('rows and builds of deleted yards are pruned from the layer tables too', () => {
  const env = setup();
  try {
    const keep = env.yard(env.alice, 'keep');
    importLayer(env.ecosystem, keep, 'fauna', locationKey(HERE), [MOTH], {});
    importLayer(env.ecosystem, 999, 'fauna', locationKey(HERE), [MOTH], {});
    importLayer(env.ecosystem, 999, 'streams', locationKey(HERE), [STREAM], {});
    assert.deepEqual(pruneDeletedProjects(env.app, env.ecosystem), [999]);
    assert.equal(listProjectFauna(env.ecosystem, 999).length, 0);
    assert.equal(listProjectAnchors(env.ecosystem, 999).length, 0);
    assert.equal(readLayerBuild(env.ecosystem, 999, 'fauna'), null);
    assert.equal(listProjectFauna(env.ecosystem, keep).length, 1);
  } finally {
    env.cleanup();
  }
});

// --- the builds, against stubbed upstreams -----------------------------------------------

function fakeInaturalist({ fail = false } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname);
    if (fail) return reply({}, 404);
    if (u.pathname === '/v1/places/nearby') return reply({ results: { standard: [{ id: 18, place_type: 8 }] } });
    if (u.pathname === '/v1/observations/species_counts') {
      const taxon = u.searchParams.get('iconic_taxa[]');
      const radiusKm = Number(u.searchParams.get('radius'));
      // The far animal only turns up in the 8 mi band and beyond.
      const results = [{ count: 9, taxon: { id: taxon.length, name: `${taxon}ia nearbyensis`, preferred_common_name: `Nearby ${taxon}` } }];
      if (radiusKm > 8) results.push({ count: 1, taxon: { id: 1000 + taxon.length, name: `${taxon}ia farensis` } });
      return reply({ results });
    }
    if (u.pathname.startsWith('/v1/taxa/')) {
      const ids = u.pathname.slice('/v1/taxa/'.length).split(',').map(Number);
      return reply({ results: ids.map((id) => ({ id, preferred_establishment_means: id >= 1000 ? 'introduced' : 'native' })) });
    }
    return reply({}, 404);
  };
  return { fetchImpl, calls };
}

test('the fauna build writes one row per species at its nearest band, and replays from the cache', async () => {
  const env = setup();
  try {
    const id = env.yard(env.alice, 'a');
    const inat = fakeInaturalist();
    const args = { projectId: id, location: HERE, db: env.ecosystem, probeCache: env.probeCache, requestDelayMs: 0, logger: quiet };
    const first = await buildAndRecordFauna({ ...args, fetchImpl: inat.fetchImpl });
    assert.equal(first.state, 'ready');
    assert.ok(first.networkRequests > 0);
    const rows = listProjectFauna(env.ecosystem, id);
    assert.equal(rows.length, 10, 'five taxa, a near and a far animal each');
    const far = rows.find((r) => r.animal_species === 'Insectaia farensis');
    assert.equal(far.nearest_radius_mi, 8, 'the first band it turned up in');
    assert.equal(far.establishment_means, 'introduced', 'stored, not filtered');
    assert.ok(rows.every((r) => r.source === 'api.inaturalist.org species_counts'));
    assert.equal(layerStatus(env.ecosystem, id, 'fauna', locationKey(HERE)).state, 'ready');

    const offline = async () => assert.fail('a replay must not reach the network');
    const again = await buildAndRecordFauna({ ...args, fetchImpl: offline });
    assert.equal(again.state, 'ready');
    assert.equal(again.networkRequests, 0, 'free for the queue');
  } finally {
    env.cleanup();
  }
});

test('a failed fauna build is recorded as failed and keeps the rows it had', async () => {
  const env = setup();
  try {
    const id = env.yard(env.alice, 'a');
    importLayer(env.ecosystem, id, 'fauna', locationKey(HERE), [MOTH], { fetchedOn: '2026-01-01' });
    const result = await buildAndRecordFauna({
      projectId: id,
      location: HERE,
      db: env.ecosystem,
      probeCache: env.probeCache,
      fetchImpl: fakeInaturalist({ fail: true }).fetchImpl,
      requestDelayMs: 0,
      force: true,
      logger: quiet,
    });
    assert.equal(result.state, 'failed');
    assert.ok(result.networkRequests > 0);
    assert.equal(layerStatus(env.ecosystem, id, 'fauna', locationKey(HERE)).state, 'failed');
    assert.deepEqual(listProjectFauna(env.ecosystem, id).map((r) => r.animal_species), ['Testia mothia']);
  } finally {
    env.cleanup();
  }
});

test('a build error never stores or reports quoted text (a geocoder quotes the address back)', async () => {
  const env = setup();
  try {
    const id = env.yard(env.alice, 'a');
    // Nominatim "found nothing", from the cache: geocodeAddress then throws
    // 'Geocoding found nothing for "1 Secret Lane"', which is what must be scrubbed.
    setCached(env.probeCache, 'nominatim', 'search', '1 Secret Lane', []);
    const result = await buildAndRecordStreams({
      projectId: id,
      location: { address: '1 Secret Lane' },
      db: env.ecosystem,
      probeCache: env.probeCache,
      logger: quiet,
    });
    assert.equal(result.state, 'failed');
    assert.match(result.error, /Geocoding found nothing/, 'the geocoder was reached');
    assert.equal(/Secret/.test(result.error), false);
    assert.equal(/Secret/.test(readLayerBuild(env.ecosystem, id, 'streams').error || ''), false);
    assert.equal(withoutQuotedText('Geocoding found nothing for "1 Secret Lane"'), 'Geocoding found nothing for "…"');
  } finally {
    env.cleanup();
  }
});

test('an upstream error page that echoes the query never reaches the build record', async () => {
  const env = setup();
  try {
    const id = env.yard(env.alice, 'a');
    const echo = { ok: false, status: 400, headers: { get: () => null }, text: async () => `bad query: around:8047,${HERE.lat},${HERE.lng}`, json: async () => ({}) };
    const green = await buildAndRecordGreenspace({ projectId: id, location: HERE, db: env.ecosystem, probeCache: env.probeCache, fetchImpl: async () => echo, logger: quiet });
    const nhd = await buildAndRecordStreams({
      projectId: id,
      location: HERE,
      db: env.ecosystem,
      probeCache: env.probeCache,
      fetchImpl: async () => reply({ error: { code: 400, message: 'bad', details: [`geometry ${HERE.lng},${HERE.lat}`] } }),
      logger: quiet,
    });
    for (const [layer, result] of [['greenspace', green], ['streams', nhd]]) {
      assert.equal(result.state, 'failed', layer);
      const stored = readLayerBuild(env.ecosystem, id, layer).error;
      for (const text of [result.error, stored]) {
        assert.equal(text.includes(String(HERE.lat)) || text.includes(String(HERE.lng)), false, `${layer}: ${text}`);
      }
    }
    assert.equal(green.error, 'HTTP 400');
    assert.equal(nhd.error, 'NHD query failed: code 400');
  } finally {
    env.cleanup();
  }
});

test('the streams build keeps the nearest named streams, by real line geometry, rounded', async () => {
  const env = setup();
  try {
    const id = env.yard(env.alice, 'a');
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(new URL(url).hostname);
      // A north-south line ~0.01 deg (~0.58 mi) east of the yard, and an unnamed one.
      return reply({
        features: [
          { attributes: { gnis_name: 'Test Creek', ftype: 460 }, geometry: { paths: [[[HERE.lng + 0.01, HERE.lat - 1], [HERE.lng + 0.01, HERE.lat + 1]]] } },
          { attributes: { gnis_name: null, ftype: 460 }, geometry: { paths: [[[HERE.lng, HERE.lat], [HERE.lng, HERE.lat + 1]]] } },
        ],
      });
    };
    const result = await buildAndRecordStreams({ projectId: id, location: HERE, db: env.ecosystem, probeCache: env.probeCache, fetchImpl, logger: quiet });
    assert.equal(result.state, 'ready');
    assert.deepEqual(calls, ['hydro.nationalmap.gov']);
    const rows = listProjectAnchors(env.ecosystem, id);
    assert.deepEqual(rows.map((r) => [r.layer, r.kind, r.name, r.status, r.distance_mi, r.detail]), [
      ['streams', 'stream', 'Test Creek', 'anchor', 0.5, 'channel'],
    ]);
  } finally {
    env.cleanup();
  }
});

test('the green-space build writes named candidates above the size floor, never anchors', async () => {
  const env = setup();
  try {
    const id = env.yard(env.alice, 'a');
    const square = (dLng, sizeDeg) => [
      { lon: HERE.lng + dLng, lat: HERE.lat },
      { lon: HERE.lng + dLng + sizeDeg, lat: HERE.lat },
      { lon: HERE.lng + dLng + sizeDeg, lat: HERE.lat + sizeDeg },
      { lon: HERE.lng + dLng, lat: HERE.lat + sizeDeg },
    ];
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push([new URL(url).hostname, options.method]);
      return reply({
        elements: [
          { type: 'way', tags: { leisure: 'park', name: 'Test Park' }, geometry: square(0.02, 0.005) },
          { type: 'way', tags: { leisure: 'park', name: 'Traffic Island' }, geometry: square(0.01, 0.00005) },
          { type: 'way', tags: { landuse: 'cemetery' }, geometry: square(0.03, 0.005) },
        ],
      });
    };
    const result = await buildAndRecordGreenspace({ projectId: id, location: HERE, db: env.ecosystem, probeCache: env.probeCache, fetchImpl, logger: quiet });
    assert.equal(result.state, 'ready');
    assert.deepEqual(calls, [['overpass-api.de', 'POST']]);
    const rows = listProjectAnchors(env.ecosystem, id);
    assert.deepEqual(rows.map((r) => [r.layer, r.kind, r.name, r.status]), [['greenspace', 'park', 'Test Park', 'candidate']]);
    assert.match(rows[0].detail, /^leisure=park, ~\d+ acres$/);
  } finally {
    env.cleanup();
  }
});

// --- the queue ----------------------------------------------------------------------------

test('the queue builds every layer of a new yard, spending one network build per upstream per tick', async () => {
  const env = setup();
  try {
    const a = env.yard(env.alice, 'a');
    const b = env.yard(env.bob, 'b');
    env.yard(env.alice, 'nowhere', { location: null });
    assert.deepEqual(
      dueSiteJobs(env.app, env.ecosystem).map((j) => [j.id, j.job]),
      [[a, 'index'], [a, 'fauna'], [a, 'streams'], [a, 'greenspace'], [b, 'index'], [b, 'fauna'], [b, 'streams'], [b, 'greenspace']]
    );
    const calls = [];
    const builder = (job) => async ({ id }) => {
      calls.push([id, job]);
      if (job !== 'index') importLayer(env.ecosystem, id, job, locationKey(HERE), [], {});
      return { state: 'ready', rows: 0, networkRequests: 3 };
    };
    const builders = Object.fromEntries(['index', 'fauna', 'streams', 'greenspace'].map((job) => [job, builder(job)]));
    const tick = await runSiteQueue({ appDb: env.app, ecosystemDb: env.ecosystem, builders });
    assert.deepEqual(calls, [[a, 'index'], [a, 'streams'], [a, 'greenspace']], 'iNaturalist is spent by the index; fauna waits');
    assert.equal(tick.due, 8);
    assert.deepEqual(tick.built.map((x) => x.job), ['index', 'streams', 'greenspace']);

    calls.length = 0;
    await runSiteQueue({ appDb: env.app, ecosystemDb: env.ecosystem, builders });
    // The index build above was a stub that recorded nothing, so it is due again first.
    assert.deepEqual(calls, [[a, 'index'], [b, 'streams'], [b, 'greenspace']]);
  } finally {
    env.cleanup();
  }
});

test('the example yard is never queued for layers of its own', () => {
  const env = setup();
  try {
    const system = upsertUser(env.app, EXAMPLE_OWNER_EMAIL);
    env.yard(system, 'example', { location: HERE });
    assert.deepEqual(dueSiteJobs(env.app, env.ecosystem), []);
  } finally {
    env.cleanup();
  }
});

// --- the region table behind the public page (tools/fetch-region-fauna.mjs) ----------------

test('the region fetch pages species_counts to the end and writes sourced rows', async () => {
  const env = setup();
  try {
    const pages = [];
    const fetchImpl = async (url) => {
      const u = new URL(url);
      assert.equal(u.searchParams.get('place_id'), '1');
      assert.equal(u.searchParams.get('taxon_id'), '47157');
      assert.equal(u.searchParams.get('quality_grade'), 'research');
      assert.equal(u.searchParams.get('lat'), null, 'a region, never a point');
      const page = Number(u.searchParams.get('page'));
      pages.push(page);
      const results = Array.from({ length: page === 1 ? 500 : 3 }, (_, i) => ({
        count: 1,
        taxon: { id: page * 1000 + i, name: `Testia p${page}n${i}`, preferred_common_name: '' },
      }));
      return reply({ total_results: 503, results });
    };
    const { rows, complete } = await fetchRegionFauna(
      { region: 'Test County', inatPlaceId: 1 },
      { probeCache: env.probeCache, fetchImpl, requestDelayMs: 0, logger: quiet }
    );
    assert.deepEqual(pages, [1, 2]);
    assert.equal(complete, true);
    assert.equal(rows.length, 503);
    const csv = parseCsv(toRegionFaunaCsv(rows));
    assert.deepEqual(Object.keys(csv[0]), REGION_FAUNA_HEADER);
    assert.ok(csv.every((r) => r.source && r.region === 'Test County'));
  } finally {
    env.cleanup();
  }
});
