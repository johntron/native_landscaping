import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHostGeneraIndex, emptyHostGeneraIndex } from '../src/analysis/hostGenera.js';
import { buildInteractionsIndex, emptyInteractionsIndex } from '../src/analysis/faunaMatches.js';
import {
  groupPlantaeByGenus,
  catalogGenusKeys,
  buildEcosystemFaunaIndex,
  matchNearbyKeystoneGenera,
} from '../src/analysis/plantMatches.js';

const HOST_GENERA_CSV = `genus,ecoregion,lep_host_species,bee_specialist_species,larval_hosts,synonym_of,source
Quercus,9,253,,,,nwf-ecoregion-9
Salix,9,214,20,,,nwf-ecoregion-9
Rubus,9,10,,,,nwf-ecoregion-9
Helianthus,9,,15,,,nwf-ecoregion-9
Senecio,9,,22,,,nwf-ecoregion-9
Packera,9,,,,Senecio,derived
`;

const INTERACTIONS_CSV = `genus,animal_species,animal_common,category,interaction_type,synonym_of,source
Rubus,Bombus pensylvanicus,American bumblebee,pollinator,visitsFlowersOf,,test
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

test('buildEcosystemFaunaIndex ignores Plantae rows and keeps the nearest radius per animal', () => {
  const rows = [
    observation({ taxon: 'Insecta', name: 'Bombus pensylvanicus', radius: 8 }),
    observation({ taxon: 'Insecta', name: 'Bombus pensylvanicus', radius: 1 }), // nearer sighting should win
    observation({ name: 'Quercus shumardii', genus: 'Quercus' }), // Plantae — excluded
  ];
  const index = buildEcosystemFaunaIndex(rows);
  assert.equal(index.size, 1);
  assert.equal(index.animals.get('bombus pensylvanicus').nearestRadiusMi, 1);
});

test('a genus with no host-genera.csv row never surfaces, even if observed nearby', () => {
  const { candidates, alreadyInCatalog } = matchNearbyKeystoneGenera({
    observationRows: [observation({ name: 'Daucus carota', genus: 'Daucus' })],
    hostGenera: emptyHostGeneraIndex(),
    catalogGenusKeys: new Set(),
    interactions: emptyInteractionsIndex(),
  });
  assert.equal(candidates.length, 0);
  assert.equal(alreadyInCatalog.length, 0);
});

test('candidates include the FULL ecoregion keystone list, not just genera with local evidence', () => {
  const hostGenera = buildHostGeneraIndex(HOST_GENERA_CSV, { ecoregion: '9' });
  const { candidates } = matchNearbyKeystoneGenera({
    observationRows: [], // nothing observed nearby at all — no Plantae, no fauna
    hostGenera,
    catalogGenusKeys: new Set(),
    interactions: emptyInteractionsIndex(),
  });
  // All six ecoregion-9 keystone genera in the fixture must appear (catalog is empty here)
  // — purely on the strength of the ecoregion-wide list, with zero local evidence.
  assert.deepEqual(
    candidates.map((c) => c.genus).sort(),
    ['Helianthus', 'Packera', 'Quercus', 'Rubus', 'Salix', 'Senecio']
  );
  candidates.forEach((c) => {
    assert.deepEqual(c.nearbySpecies, []);
    assert.deepEqual(c.associatedFauna, []);
  });
});

test('a genus whose associated fauna is confirmed nearby outranks a higher-keystone-count genus with none — the plant itself need not be observed', () => {
  const hostGenera = buildHostGeneraIndex(HOST_GENERA_CSV, { ecoregion: '9' });
  const interactions = buildInteractionsIndex(INTERACTIONS_CSV);
  // Only the ANIMAL is observed nearby — no Rubus (or any other genus here) Plantae row at all.
  const rows = [observation({ taxon: 'Insecta', name: 'Bombus pensylvanicus', radius: 1 })];

  const { candidates } = matchNearbyKeystoneGenera({
    observationRows: rows,
    hostGenera,
    catalogGenusKeys: new Set(),
    interactions,
  });

  // Rubus (rank 20) has a nearby-confirmed pollinator and must rank above Quercus (rank
  // 506), Salix (rank 448), and Senecio (rank 22) — all of which have no local evidence.
  const order = candidates.map((c) => c.genus);
  assert.equal(order[0], 'Rubus');
  assert.deepEqual(
    order.filter((g) => ['Quercus', 'Salix', 'Senecio'].includes(g)),
    ['Quercus', 'Salix', 'Senecio']
  );
  assert.equal(candidates[0].associatedFauna.length, 1);
  assert.equal(candidates[0].associatedFauna[0].animalSpecies, 'Bombus pensylvanicus');
  assert.deepEqual(candidates[0].nearbySpecies, []); // the plant itself was never observed
});

test('an associated-fauna match outside its taxon range does not count', () => {
  const hostGenera = buildHostGeneraIndex(HOST_GENERA_CSV, { ecoregion: '9' });
  const interactions = buildInteractionsIndex(INTERACTIONS_CSV);
  // Insecta's range threshold is 3mi (see RANGE_THRESHOLD_MI in faunaMatches.js) — 25mi is out of range.
  const rows = [observation({ taxon: 'Insecta', name: 'Bombus pensylvanicus', radius: 25 })];

  const { candidates } = matchNearbyKeystoneGenera({
    observationRows: rows,
    hostGenera,
    catalogGenusKeys: new Set(),
    interactions,
  });

  const rubus = candidates.find((c) => c.genus === 'Rubus');
  assert.equal(rubus.associatedFauna.length, 0);
  // No genus has a matched associated animal, so it's rank all the way down: Quercus (506) >
  // Salix (448) > Senecio (22) > Rubus (20).
  const order = candidates.map((c) => c.genus).filter((g) => ['Quercus', 'Salix', 'Senecio', 'Rubus'].includes(g));
  assert.deepEqual(order, ['Quercus', 'Salix', 'Senecio', 'Rubus']);
});

test('splits candidates (catalog-absent) from ones already carried', () => {
  const hostGenera = buildHostGeneraIndex(HOST_GENERA_CSV, { ecoregion: '9' });
  const { candidates, alreadyInCatalog } = matchNearbyKeystoneGenera({
    observationRows: [],
    hostGenera,
    catalogGenusKeys: catalogGenusKeys(CATALOG_ROWS), // Helianthus, Packera
    interactions: emptyInteractionsIndex(),
  });
  assert.deepEqual(
    candidates.map((c) => c.genus).sort(),
    ['Quercus', 'Rubus', 'Salix', 'Senecio']
  );
  assert.deepEqual(
    alreadyInCatalog.map((c) => c.genus).sort(),
    ['Helianthus', 'Packera']
  );
});

test('synonym_of resolves so Packera carries Senecio\'s keystone counts', () => {
  const hostGenera = buildHostGeneraIndex(HOST_GENERA_CSV, { ecoregion: '9' });
  const { alreadyInCatalog } = matchNearbyKeystoneGenera({
    observationRows: [],
    hostGenera,
    catalogGenusKeys: catalogGenusKeys(CATALOG_ROWS),
    interactions: emptyInteractionsIndex(),
  });
  const packera = alreadyInCatalog.find((c) => c.genus === 'Packera');
  assert.equal(packera.hostGeneraRow.beeSpecialistSpecies, 22);
});

test('within the associated-fauna tier, a closer-for-its-taxon match outranks a farther one, overriding keystone rank', () => {
  const hostGenera = buildHostGeneraIndex(HOST_GENERA_CSV, { ecoregion: '9' });
  const interactionsCsv = `genus,animal_species,animal_common,category,interaction_type,synonym_of,source
Senecio,Bombus pensylvanicus,American bumblebee,pollinator,visitsFlowersOf,,test
Rubus,Cardinalis cardinalis,Northern cardinal,feeds-on,eats,,test
`;
  const interactions = buildInteractionsIndex(interactionsCsv);
  const rows = [
    // Senecio (higher keystone rank, 22): one insect at the edge of Insecta's ~3mi range — weight 0.5.
    observation({ taxon: 'Insecta', name: 'Bombus pensylvanicus', radius: 3 }),
    // Rubus (lower keystone rank, 20): one bird close for Aves's much wider ~15mi range — weight 0.9375.
    observation({ taxon: 'Aves', name: 'Cardinalis cardinalis', radius: 1 }),
  ];

  const { candidates } = matchNearbyKeystoneGenera({
    observationRows: rows,
    hostGenera,
    catalogGenusKeys: new Set(),
    interactions,
  });

  const rubus = candidates.find((c) => c.genus === 'Rubus');
  const senecio = candidates.find((c) => c.genus === 'Senecio');
  assert.equal(rubus.associatedFauna.length, 1);
  assert.equal(senecio.associatedFauna.length, 1);
  // Both have exactly one associated-fauna match, so the OLD count-then-rank
  // tiebreak would have put Senecio (rank 22) ahead of Rubus (rank 20).
  // Proximity-weighted, Rubus's close-for-a-bird match (0.9375) outweighs
  // Senecio's at-the-edge-of-range insect (0.5), flipping the order.
  const order = candidates.map((c) => c.genus);
  assert.ok(order.indexOf('Rubus') < order.indexOf('Senecio'));
});

test('nearby Plantae observations still show as secondary evidence when present', () => {
  const hostGenera = buildHostGeneraIndex(HOST_GENERA_CSV, { ecoregion: '9' });
  const rows = [observation({ name: 'Quercus shumardii', genus: 'Quercus', radius: 1 })];
  const { candidates } = matchNearbyKeystoneGenera({
    observationRows: rows,
    hostGenera,
    catalogGenusKeys: new Set(),
    interactions: emptyInteractionsIndex(),
  });
  const quercus = candidates.find((c) => c.genus === 'Quercus');
  assert.equal(quercus.nearbySpecies.length, 1);
  assert.equal(quercus.nearbySpecies[0].taxonName, 'Quercus shumardii');
});
