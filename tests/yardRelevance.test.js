import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHostGeneraIndex } from '../src/analysis/hostGenera.js';
import { buildInteractionsIndex } from '../src/analysis/faunaMatches.js';
import { buildAnimalGeneraIndex, classifyYardRelevance } from '../src/analysis/yardRelevance.js';

const HOST_GENERA_CSV = `genus,ecoregion,lep_host_species,bee_specialist_species,larval_hosts,synonym_of,source
Quercus,9,253,,,,test
Asclepias,9,,20,,,test`;

const INTERACTIONS_CSV = `genus,animal_species,animal_common,category,interaction_type,synonym_of,source
Asclepias,Danaus plexippus,Monarch,feeds-on,hostOf,,test`;

function tables(catalogGenera = []) {
  const hostGenera = buildHostGeneraIndex(HOST_GENERA_CSV, { ecoregion: '9' });
  const interactions = buildInteractionsIndex(INTERACTIONS_CSV);
  const animalGeneraIndex = buildAnimalGeneraIndex(interactions);
  const catalogGenusKeys = new Set(catalogGenera.map((g) => g.toLowerCase()));
  return { hostGenera, interactions, animalGeneraIndex, catalogGenusKeys };
}

test('classifyYardRelevance flags a missing keystone genus observed directly', () => {
  const relevance = classifyYardRelevance(
    { iconic_taxon: 'Plantae', taxon_name: 'Quercus virginiana' },
    tables()
  );
  assert.equal(relevance.kind, 'missing-genus');
  assert.equal(relevance.genus, 'Quercus');
});

test('classifyYardRelevance is silent when the genus is already in the catalog', () => {
  const relevance = classifyYardRelevance(
    { iconic_taxon: 'Plantae', taxon_name: 'Quercus virginiana' },
    tables(['Quercus'])
  );
  assert.equal(relevance, null);
});

test('classifyYardRelevance flags an animal documented to use a missing keystone genus', () => {
  const relevance = classifyYardRelevance(
    { iconic_taxon: 'Insecta', taxon_name: 'Danaus plexippus' },
    tables()
  );
  assert.equal(relevance.kind, 'associated-fauna');
  assert.equal(relevance.matches.length, 1);
  assert.equal(relevance.matches[0].genus, 'Asclepias');
});

test('classifyYardRelevance ignores an animal with no documented genus match', () => {
  const relevance = classifyYardRelevance(
    { iconic_taxon: 'Aves', taxon_name: 'Cardinalis cardinalis' },
    tables()
  );
  assert.equal(relevance, null);
});

test('classifyYardRelevance returns null for an unrelated plant genus', () => {
  const relevance = classifyYardRelevance(
    { iconic_taxon: 'Plantae', taxon_name: 'Bouteloua curtipendula' },
    tables()
  );
  assert.equal(relevance, null);
});
