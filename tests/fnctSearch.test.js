import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesFnctQuery, filterFnctRows } from '../src/fnct/fnctSearch.js';

const rows = [
  { genus: 'Quercus', scientific_name: 'Quercus alba', common_names: 'White Oak; Stave Oak' },
  { genus: 'Quercus', scientific_name: 'Quercus stellata', common_names: 'Post Oak; Iron Oak' },
  { genus: 'Ambrosia', scientific_name: 'Ambrosia artemisiifolia', common_names: 'Common Ragweed; Altamisa' },
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
