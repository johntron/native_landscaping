import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHostGeneraIndex, emptyHostGeneraIndex } from '../src/analysis/hostGenera.js';
import {
  groupPlantaeByGenus,
  catalogGenusKeys,
  matchNearbyKeystoneGenera,
} from '../src/analysis/plantMatches.js';

const HOST_GENERA_CSV = `genus,ecoregion,lep_host_species,bee_specialist_species,larval_hosts,synonym_of,source
Quercus,9,253,,,,nwf-ecoregion-9
Salix,9,214,20,,,nwf-ecoregion-9
Helianthus,9,,15,,,nwf-ecoregion-9
Senecio,9,,22,,,nwf-ecoregion-9
Packera,9,,,,Senecio,derived
`;

const CATALOG_ROWS = [{ botanical_name: 'Helianthus maximiliani' }, { botanical_name: 'Packera obovata' }];

function observation({ taxon = 'Plantae', name, genus, radius = 5, count = 10 }) {
  return {
    iconic_taxon: taxon,
    taxon_name: name,
    common_name: name,
    genus,
    radius_mi: radius,
    observation_count: count,
  };
}

test('groupPlantaeByGenus keeps only Plantae rows, grouped by genus', () => {
  const rows = [
    observation({ name: 'Quercus shumardii', genus: 'Quercus' }),
    observation({ name: 'Quercus fusiformis', genus: 'Quercus', radius: 3 }),
    observation({ taxon: 'Aves', name: 'Cardinalis cardinalis', genus: 'Cardinalis' }),
  ];
  const byGenus = groupPlantaeByGenus(rows);
  assert.equal(byGenus.size, 1);
  assert.equal(byGenus.get('quercus').species.length, 2);
});

test('catalogGenusKeys reads the first token of botanical_name, normalized', () => {
  const keys = catalogGenusKeys(CATALOG_ROWS);
  assert.ok(keys.has('helianthus'));
  assert.ok(keys.has('packera'));
  assert.equal(keys.size, 2);
});

test('matchNearbyKeystoneGenera splits catalog-absent genera from ones already carried, keystone-only', () => {
  const hostGenera = buildHostGeneraIndex(HOST_GENERA_CSV, { ecoregion: '9' });
  const rows = [
    observation({ name: 'Quercus shumardii', genus: 'Quercus', radius: 3 }),
    observation({ name: 'Quercus fusiformis', genus: 'Quercus', radius: 8 }),
    observation({ name: 'Salix nigra', genus: 'Salix', radius: 15 }),
    observation({ name: 'Helianthus maximiliani', genus: 'Helianthus', radius: 1 }),
    observation({ name: 'Daucus carota', genus: 'Daucus', radius: 1 }), // not on host-genera.csv — must not surface
  ];

  const { candidates, alreadyInCatalog } = matchNearbyKeystoneGenera({
    observationRows: rows,
    hostGenera,
    catalogGenusKeys: catalogGenusKeys(CATALOG_ROWS),
  });

  assert.deepEqual(candidates.map((c) => c.genus), ['Quercus', 'Salix']);
  assert.equal(candidates[0].nearbySpecies[0].taxonName, 'Quercus shumardii'); // nearest radius first
  assert.deepEqual(alreadyInCatalog.map((c) => c.genus), ['Helianthus']);
});

test('matchNearbyKeystoneGenera ranks candidates by host-genera.csv counts, not observation_count', () => {
  const hostGenera = buildHostGeneraIndex(HOST_GENERA_CSV, { ecoregion: '9' });
  const rows = [
    observation({ name: 'Quercus shumardii', genus: 'Quercus', count: 1 }),
    observation({ name: 'Salix nigra', genus: 'Salix', count: 9999 }),
  ];
  const { candidates } = matchNearbyKeystoneGenera({
    observationRows: rows,
    hostGenera,
    catalogGenusKeys: new Set(),
  });
  // Quercus (253 caterpillar species, rank 506) outranks Salix (214*2+20=448)
  // despite Salix having a far higher iNaturalist observation_count.
  assert.deepEqual(candidates.map((c) => c.genus), ['Quercus', 'Salix']);
});

test('a genus with no host-genera.csv row never surfaces, even if observed nearby', () => {
  const { candidates, alreadyInCatalog } = matchNearbyKeystoneGenera({
    observationRows: [observation({ name: 'Daucus carota', genus: 'Daucus' })],
    hostGenera: emptyHostGeneraIndex(),
    catalogGenusKeys: new Set(),
  });
  assert.equal(candidates.length, 0);
  assert.equal(alreadyInCatalog.length, 0);
});

test('synonym_of resolves so a nearby Packera counts as keystone via Senecio', () => {
  const hostGenera = buildHostGeneraIndex(HOST_GENERA_CSV, { ecoregion: '9' });
  const { alreadyInCatalog } = matchNearbyKeystoneGenera({
    observationRows: [observation({ name: 'Packera obovata', genus: 'Packera' })],
    hostGenera,
    catalogGenusKeys: catalogGenusKeys(CATALOG_ROWS),
  });
  assert.equal(alreadyInCatalog.length, 1);
  assert.equal(alreadyInCatalog[0].hostGeneraRow.beeSpecialistSpecies, 22);
});
