import test from 'node:test';
import assert from 'node:assert/strict';
import { findKeystoneRow, lepidopteraHostsForGenus, interactionsForGenus } from '../src/fnct/fnctEcology.js';

const hostGeneraRows = [
  { genus: 'Quercus', ecoregion: '9', lep_host_species: '253', bee_specialist_species: '', larval_hosts: '' },
  { genus: 'Salix', ecoregion: '9', lep_host_species: '214', bee_specialist_species: '20', larval_hosts: '' },
];

const lepRows = [
  { plant_genus: 'Quercus', lep_common: 'GRAY HAIRSTREAK', lep_species: 'Strymon melinus', section: 'butterflies', fnct_page: '1396' },
  { plant_genus: 'Quercus', lep_common: '', lep_species: 'Anisota stigma', section: 'moths', fnct_page: '1401' },
  { plant_genus: 'Carya', lep_common: 'LUNA MOTH', lep_species: 'Actias luna', section: 'moths', fnct_page: '1400' },
];

const interactionRows = [
  { genus: 'Quercus', animal_species: 'Agrilus auroguttatus', animal_common: '', category: 'feeds-on', interaction_type: 'eatenBy' },
  { genus: 'Quercus', animal_species: 'Amphibolips confluenta', animal_common: '', category: 'feeds-on', interaction_type: 'hostOf' },
  { genus: 'Quercus', animal_species: 'Amphibolips melanocera', animal_common: '', category: 'feeds-on', interaction_type: 'hostOf' },
  { genus: 'Salix', animal_species: 'Something else', animal_common: '', category: 'feeds-on', interaction_type: 'eatenBy' },
];

test('findKeystoneRow finds the row for a genus, undefined otherwise', () => {
  assert.equal(findKeystoneRow('Quercus', hostGeneraRows)?.lep_host_species, '253');
  assert.equal(findKeystoneRow('Betula', hostGeneraRows), undefined);
});

test('lepidopteraHostsForGenus filters to the genus and sorts by species', () => {
  const hosts = lepidopteraHostsForGenus('Quercus', lepRows);
  assert.equal(hosts.length, 2);
  assert.equal(hosts[0].species, 'Anisota stigma');
  assert.equal(hosts[1].species, 'Strymon melinus');
});

test('lepidopteraHostsForGenus returns empty for a genus with no records', () => {
  assert.deepEqual(lepidopteraHostsForGenus('Betula', lepRows), []);
});

test('interactionsForGenus groups by interaction_type, largest group first', () => {
  const groups = interactionsForGenus('Quercus', interactionRows);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].type, 'hostOf');
  assert.equal(groups[0].animals.length, 2);
  assert.equal(groups[1].type, 'eatenBy');
  assert.equal(groups[1].animals.length, 1);
});

test('interactionsForGenus excludes other genera', () => {
  const groups = interactionsForGenus('Quercus', interactionRows);
  const allAnimals = groups.flatMap((g) => g.animals.map((a) => a.species));
  assert.ok(!allAnimals.includes('Something else'));
});
