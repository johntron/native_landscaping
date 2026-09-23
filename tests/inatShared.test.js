import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchTaxaFacts, fetchEstablishmentMeans, restrictToWildPreciseRecords } from '../tools/inatShared.mjs';

test('fetchTaxaFacts returns both establishment_means and conservation_status from one batched /v1/taxa request', async () => {
  const calls = [];
  const fetchJson = async (endpoint, url) => {
    calls.push({ endpoint, url: url.toString() });
    return {
      results: [
        { id: 1, preferred_establishment_means: 'native', conservation_status: { status: 'G2', status_name: 'Imperiled', authority: 'NatureServe' } },
        { id: 2, preferred_establishment_means: 'introduced' }, // no conservation_status
        { id: 3 }, // neither fact
      ],
    };
  };

  const { establishmentMeansById, conservationStatusById } = await fetchTaxaFacts([1, 2, 3], 42, { fetchJson });

  assert.equal(calls.length, 1, 'both facts must come from the same batched request');
  assert.equal(establishmentMeansById.get(1), 'native');
  assert.equal(establishmentMeansById.get(2), 'introduced');
  assert.equal(establishmentMeansById.has(3), false);
  assert.deepEqual(conservationStatusById.get(1), { status: 'G2', statusName: 'Imperiled', authority: 'NatureServe' });
  assert.equal(conservationStatusById.has(2), false);
  assert.equal(conservationStatusById.has(3), false);
});

test('fetchTaxaFacts chunks at 30 ids per request', async () => {
  const chunkSizes = [];
  const fetchJson = async (endpoint, url) => {
    chunkSizes.push(url.pathname.split('/').pop().split(',').length);
    return { results: [] };
  };
  const ids = Array.from({ length: 35 }, (_, i) => i + 1);
  await fetchTaxaFacts(ids, 1, { fetchJson });
  assert.deepEqual(chunkSizes, [30, 5]);
});

test('fetchEstablishmentMeans stays a thin wrapper returning only the means map (backward compat)', async () => {
  const fetchJson = async () => ({
    results: [{ id: 1, preferred_establishment_means: 'native', conservation_status: { status: 'G2' } }],
  });
  const meansById = await fetchEstablishmentMeans([1], 1, { fetchJson });
  assert.equal(meansById.get(1), 'native');
  assert.equal(meansById instanceof Map, true);
});

test('restrictToWildPreciseRecords appends the four filters after existing params, in cache-key order', () => {
  const url = new URL('https://api.inaturalist.org/v1/observations/species_counts');
  url.searchParams.set('lat', '32.8');
  url.searchParams.set('order_by', 'observation_count');
  restrictToWildPreciseRecords(url);
  // The probe cache keys on url.toString(), so this exact order is what keeps
  // fetch-ecosystem-index.mjs's cached responses reachable (it set these same
  // four inline, in this order, before nl-hr5 moved them here).
  assert.equal(
    url.search,
    '?lat=32.8&order_by=observation_count&captive=false&quality_grade=research&taxon_geoprivacy=open&geoprivacy=open'
  );
});
