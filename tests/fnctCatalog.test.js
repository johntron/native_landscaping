import test from 'node:test';
import assert from 'node:assert/strict';
import { matchCatalogRow } from '../src/fnct/fnctCatalog.js';

const catalogRows = [
  { id: 'yaupon-holly', common_name: 'American Yaupon Holly', botanical_name: 'Ilex vomitoria' },
  { id: 'pink-turks-cap', common_name: "Pink Turk's cap", botanical_name: 'Malvaviscus arboreus var. drummondii' },
];

test('matches an exact rank-qualified scientific name', () => {
  const fnctRow = { genus: 'Malvaviscus', species: 'arboreus', scientific_name: 'Malvaviscus arboreus var. drummondii' };
  const match = matchCatalogRow(fnctRow, catalogRows);
  assert.equal(match?.id, 'pink-turks-cap');
});

test('falls back to the bare genus + species when the flora treats a variety', () => {
  const fnctRow = { genus: 'Ilex', species: 'vomitoria', scientific_name: 'Ilex vomitoria var. pendula' };
  const match = matchCatalogRow(fnctRow, catalogRows);
  assert.equal(match?.id, 'yaupon-holly');
});

test('returns undefined when nothing in the catalog matches', () => {
  const fnctRow = { genus: 'Quercus', species: 'alba', scientific_name: 'Quercus alba' };
  assert.equal(matchCatalogRow(fnctRow, catalogRows), undefined);
});

test('is case-insensitive', () => {
  const fnctRow = { genus: 'ilex', species: 'vomitoria', scientific_name: 'ilex vomitoria' };
  const match = matchCatalogRow(fnctRow, catalogRows);
  assert.equal(match?.id, 'yaupon-holly');
});
