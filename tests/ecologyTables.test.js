import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEcologyTables } from '../src/data/ecologyTables.js';

const HOST_GENERA = 'genus,ecoregion,lep_host_species,bee_specialist_species,larval_hosts,synonym_of,source\nQuercus,9,253,,,,nwf-ecoregion-9\n';
const INTERACTIONS = 'genus,animal_species,animal_common,category,interaction_type,synonym_of,source\nQuercus,Erynnis horatius,Horace\'s Duskywing,feeds-on,eatenBy,,globi\n';
const NEARBY = 'place,animal_species,animal_common,iconic_taxon,nearest_radius_mi,observation_count,fetched_on,source\nhome,Erynnis horatius,Horace\'s Duskywing,Insecta,3,4,2026-09-13,inat\n';

/** Serve the three tables; any path listed in `missing` rejects instead. */
function fakeFetch(missing = []) {
  return async (url) => {
    const path = String(url);
    if (missing.some((m) => path.includes(m))) throw new Error(`404 ${path}`);
    if (path.includes('host-genera')) return HOST_GENERA;
    if (path.includes('plant-animal-interactions')) return INTERACTIONS;
    if (path.includes('nearby-fauna')) return NEARBY;
    throw new Error(`unexpected fetch ${path}`);
  };
}

const load = (missing) =>
  loadEcologyTables({ ecoregion: '9', baseUrl: 'http://test/', fetchCsvImpl: fakeFetch(missing) });

test('builds all three indexes and reports no warnings when every table loads', async () => {
  const { hostGenera, interactions, nearbyFauna, warnings } = await load();
  assert.equal(warnings.length, 0);
  assert.equal(hostGenera.size, 1);
  assert.equal(hostGenera.lookup('Quercus').lepHostSpecies, 253);
  assert.equal(interactions.forGenus('Quercus').length, 1);
  assert.equal(nearbyFauna.forPlace('home').size, 1);
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
  const { hostGenera, interactions, nearbyFauna, warnings } = await load(['nearby-fauna']);
  assert.equal(nearbyFauna.size, 0);
  assert.equal(hostGenera.size, 1, 'an unrelated failure must not empty this');
  assert.equal(interactions.size, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /nearby-fauna\.csv unavailable/);
});

test('every table failing still returns three usable indexes rather than throwing', async () => {
  const { hostGenera, interactions, nearbyFauna, warnings } = await load([
    'host-genera',
    'plant-animal-interactions',
    'nearby-fauna',
  ]);
  assert.equal(warnings.length, 3);
  assert.equal(hostGenera.size, 0);
  assert.equal(interactions.size, 0);
  assert.equal(nearbyFauna.size, 0);
  // Callers index into these without guarding, so the empty shapes must be real.
  assert.equal(hostGenera.lookup('Quercus'), null);
  assert.equal(hostGenera.isKeystone('Quercus'), false);
  assert.deepEqual(interactions.forGenus('Quercus'), []);
  assert.equal(nearbyFauna.forPlace('home').size, 0);
});
