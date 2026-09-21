import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesFnctQuery, filterFnctRows, searchFnctResults } from '../src/fnct/fnctSearch.js';

const rows = [
  { genus: 'Quercus', scientific_name: 'Quercus alba', common_names: 'White Oak; Stave Oak' },
  { genus: 'Quercus', scientific_name: 'Quercus stellata', common_names: 'Post Oak; Iron Oak' },
  { genus: 'Ambrosia', scientific_name: 'Ambrosia artemisiifolia', common_names: 'Common Ragweed; Altamisa' },
];

const genusRows = [
  { genus: 'Ambrosia', scientific_name: 'Ambrosia', common_names: 'Common Ragweed; Altamisa' },
  { genus: 'Quercus', scientific_name: 'Quercus', common_names: 'White Oak; Stave Oak; Post Oak; Iron Oak' },
];

test('empty query matches everything', () => {
  assert.equal(filterFnctRows(rows, '').length, 3);
  assert.equal(filterFnctRows(rows, '   ').length, 3);
});

test('genus-only query matches every species in that genus', () => {
  const matches = filterFnctRows(rows, 'Quercus');
  assert.equal(matches.length, 2);
});

test('genus + epithet query narrows to one species', () => {
  const matches = filterFnctRows(rows, 'quercus alba');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].scientific_name, 'Quercus alba');
});

test('common name query is case-insensitive and matches a substring', () => {
  assert.ok(matchesFnctQuery(rows[0], 'stave'));
  assert.ok(matchesFnctQuery(rows[2], 'ragweed'));
  assert.ok(!matchesFnctQuery(rows[1], 'ragweed'));
});

test('common name query matches within a multi-name field', () => {
  const matches = filterFnctRows(rows, 'altamisa');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].scientific_name, 'Ambrosia artemisiifolia');
});

test('searchFnctResults puts every matching genus row before any species row', () => {
  const results = searchFnctResults(genusRows, rows, 'quercus');
  assert.deepEqual(results.map((r) => r.scientific_name), ['Quercus', 'Quercus alba', 'Quercus stellata']);
});

test('searchFnctResults with an empty query still lists genus rows first', () => {
  const results = searchFnctResults(genusRows, rows, '');
  assert.equal(results.length, genusRows.length + rows.length);
  assert.equal(results[0].kind, undefined); // genusRows in this fixture don't set kind; real ones do (fnctGenus.test.js)
  assert.deepEqual(results.slice(0, 2).map((r) => r.scientific_name), ['Ambrosia', 'Quercus']);
});
