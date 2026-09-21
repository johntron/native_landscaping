import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateGenusRows, filterGenusSpecies } from '../src/fnct/fnctGenus.js';

const speciesRows = [
  { genus: 'Quercus', scientific_name: 'Quercus alba', common_names: 'White Oak; Stave Oak', life_form: 'tree', duration: '', habitat_tags: 'woods; streamside', fnct_page: '714', source: 'Diggs et al., p. 714' },
  { genus: 'Quercus', scientific_name: 'Quercus stellata', common_names: 'Post Oak', life_form: 'tree', duration: '', habitat_tags: 'woods', fnct_page: '720', source: 'Diggs et al., p. 720' },
  { genus: 'Quercus', scientific_name: 'Quercus sinuata', common_names: '', life_form: 'shrub', duration: '', habitat_tags: 'rocky-limestone', fnct_page: '710', source: 'Diggs et al., p. 710' },
  { genus: 'Ambrosia', scientific_name: 'Ambrosia artemisiifolia', common_names: 'Common Ragweed', life_form: '', duration: 'annual', habitat_tags: 'disturbed-ground', fnct_page: '309', source: 'Diggs et al., p. 309' },
];

test('aggregateGenusRows produces one row per genus, alphabetically sorted', () => {
  const genusRows = aggregateGenusRows(speciesRows);
  assert.deepEqual(genusRows.map((g) => g.genus), ['Ambrosia', 'Quercus']);
});

test('a genus row aggregates species count, common names and fact vocabularies', () => {
  const genusRows = aggregateGenusRows(speciesRows);
  const quercus = genusRows.find((g) => g.genus === 'Quercus');
  assert.equal(quercus.species_count, 3);
  assert.deepEqual(quercus.life_forms, ['shrub', 'tree']);
  assert.deepEqual(quercus.habitat_tags, ['rocky-limestone', 'streamside', 'woods']);
  assert.ok(quercus.common_names.includes('White Oak'));
  assert.ok(quercus.common_names.includes('Post Oak'));
});

test('a genus row cites its species\' earliest flora page', () => {
  const genusRows = aggregateGenusRows(speciesRows);
  const quercus = genusRows.find((g) => g.genus === 'Quercus');
  assert.equal(quercus.min_page, 710);
});

test('a genus row is shaped so the species-search matcher works on it (scientific_name = genus)', () => {
  const genusRows = aggregateGenusRows(speciesRows);
  const quercus = genusRows.find((g) => g.genus === 'Quercus');
  assert.equal(quercus.scientific_name, 'Quercus');
  assert.equal(quercus.kind, 'genus');
});

test('filterGenusSpecies with no filters returns every species in the genus', () => {
  const result = filterGenusSpecies('Quercus', speciesRows);
  assert.equal(result.length, 3);
});

test('filterGenusSpecies narrows by life form', () => {
  const result = filterGenusSpecies('Quercus', speciesRows, { lifeForm: 'shrub' });
  assert.deepEqual(result.map((s) => s.scientific_name), ['Quercus sinuata']);
});

test('filterGenusSpecies narrows by habitat tag', () => {
  const result = filterGenusSpecies('Quercus', speciesRows, { habitatTag: 'streamside' });
  assert.deepEqual(result.map((s) => s.scientific_name), ['Quercus alba']);
});

test('filterGenusSpecies combines multiple filters (AND, not OR)', () => {
  const result = filterGenusSpecies('Quercus', speciesRows, { lifeForm: 'tree', habitatTag: 'woods' });
  assert.deepEqual(result.map((s) => s.scientific_name).sort(), ['Quercus alba', 'Quercus stellata']);
});

test('filterGenusSpecies never crosses genus boundaries', () => {
  const result = filterGenusSpecies('Ambrosia', speciesRows, {});
  assert.equal(result.length, 1);
  assert.equal(result[0].scientific_name, 'Ambrosia artemisiifolia');
});
