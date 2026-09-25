import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEcologyTables } from '../src/data/ecologyTables.js';
import { loadYardSite } from '../src/data/yardSite.js';

const HOST_GENERA = 'genus,ecoregion,lep_host_species,bee_specialist_species,larval_hosts,synonym_of,source\nQuercus,9,253,,,,nwf-ecoregion-9\n';
const INTERACTIONS = 'genus,animal_species,animal_common,category,interaction_type,synonym_of,source\nQuercus,Erynnis horatius,Horace\'s Duskywing,feeds-on,eatenBy,,globi\n';

/** Serve the two tables; any path listed in `missing` rejects instead. */
function fakeFetch(missing = []) {
  return async (url) => {
    const path = String(url);
    if (missing.some((m) => path.includes(m))) throw new Error(`404 ${path}`);
    if (path.includes('host-genera')) return HOST_GENERA;
    if (path.includes('plant-animal-interactions')) return INTERACTIONS;
    throw new Error(`unexpected fetch ${path}`);
  };
}

const load = (missing) =>
  loadEcologyTables({ ecoregion: '9', baseUrl: 'http://test/', fetchCsvImpl: fakeFetch(missing) });

test('builds both indexes and reports no warnings when every table loads', async () => {
  const tables = await load();
  assert.equal(tables.warnings.length, 0);
  assert.equal(tables.hostGenera.size, 1);
  assert.equal(tables.hostGenera.lookup('Quercus').lepHostSpecies, 253);
  assert.equal(tables.interactions.forGenus('Quercus').length, 1);
  // nl-3s5.31: a yard's nearby fauna is not a committed table any more.
  assert.equal('nearbyFauna' in tables, false);
});

test('honours the ecoregion filter the host-genera table is keyed by', async () => {
  const { hostGenera } = await loadEcologyTables({
    ecoregion: '25',
    baseUrl: 'http://test/',
    fetchCsvImpl: fakeFetch(),
  });
  assert.equal(hostGenera.size, 0, 'a row for ecoregion 9 must not answer for 25');
});

// The whole point of the extraction: one missing table used to abort the
// ecosystem page's plant matches outright while the design page shrugged it
// off. Now both get an empty index and a warning, which is what the rules are
// written to report as not-declared.
test('one failed table empties only that index, and names what was lost', async () => {
  const { hostGenera, interactions, warnings } = await load(['plant-animal-interactions']);
  assert.equal(interactions.size, 0);
  assert.equal(hostGenera.size, 1, 'an unrelated failure must not empty this');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /plant-animal-interactions\.csv unavailable/);
});

test('every table failing still returns usable indexes rather than throwing', async () => {
  const { hostGenera, interactions, warnings } = await load(['host-genera', 'plant-animal-interactions']);
  assert.equal(warnings.length, 2);
  assert.equal(hostGenera.size, 0);
  assert.equal(interactions.size, 0);
  // Callers index into these without guarding, so the empty shapes must be real.
  assert.equal(hostGenera.lookup('Quercus'), null);
  assert.equal(hostGenera.isKeystone('Quercus'), false);
  assert.deepEqual(interactions.forGenus('Quercus'), []);
});

// --- the yard's own site layers (nl-3s5.31) ----------------------------------

const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('loadYardSite asks the owner-scoped route for this yard and indexes its fauna', async () => {
  const asked = [];
  const site = await loadYardSite('my yard', {
    fetchImpl: async (url) => {
      asked.push(url);
      return jsonResponse(200, {
        anchors: [{ kind: 'stream', name: 'Test Creek', status: 'anchor', distance_mi: 0.5, source: 'nhd' }],
        fauna: [{ animal_species: 'Erynnis horatius', iconic_taxon: 'Insecta', nearest_radius_mi: 3, observation_count: 4, source: 'inat' }],
        layers: { fauna: { state: 'ready', fetchedOn: '2026-09-13' } },
      });
    },
  });
  assert.deepEqual(asked, ['/api/ecosystem/site?project=my%20yard']);
  assert.equal(site.error, null);
  assert.equal(site.anchors.length, 1);
  assert.equal(site.nearbyFauna.size, 1);
  assert.equal(site.layers.fauna.state, 'ready');
});

test('loadYardSite degrades to an empty, usable result on a refusal or a network error', async () => {
  for (const fetchImpl of [
    async () => jsonResponse(404, {}),
    async () => {
      throw new Error('offline');
    },
  ]) {
    const site = await loadYardSite('y', { fetchImpl });
    assert.ok(site.error);
    assert.deepEqual(site.anchors, []);
    assert.equal(site.nearbyFauna.size, 0);
    assert.ok(site.nearbyFauna.animals instanceof Map);
  }
  assert.equal((await loadYardSite('', { fetchImpl: async () => assert.fail('no request without a yard') })).nearbyFauna.size, 0);
});
