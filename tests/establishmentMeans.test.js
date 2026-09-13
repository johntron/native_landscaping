import test from 'node:test';
import assert from 'node:assert/strict';
import { isExcludedEstablishment, excludeNonNative } from '../src/analysis/establishmentMeans.js';

test('isExcludedEstablishment flags introduced/naturalized/invasive, case-insensitively', () => {
  assert.equal(isExcludedEstablishment('introduced'), true);
  assert.equal(isExcludedEstablishment('Naturalized'), true);
  assert.equal(isExcludedEstablishment('INVASIVE'), true);
});

test('isExcludedEstablishment lets native, endemic, and unassessed (null/blank) through', () => {
  assert.equal(isExcludedEstablishment('native'), false);
  assert.equal(isExcludedEstablishment('endemic'), false);
  assert.equal(isExcludedEstablishment(null), false);
  assert.equal(isExcludedEstablishment(undefined), false);
  assert.equal(isExcludedEstablishment(''), false);
});

test('excludeNonNative drops only rows with a positive non-native/invasive flag', () => {
  const rows = [
    { taxon_name: 'Quercus virginiana', establishment_means: 'native' },
    { taxon_name: 'Ligustrum lucidum', establishment_means: 'introduced' },
    { taxon_name: 'Apis mellifera', establishment_means: 'introduced' },
    { taxon_name: 'Sherardia arvensis', establishment_means: 'naturalized' },
    { taxon_name: 'Harmonia axyridis', establishment_means: 'invasive' },
    { taxon_name: 'Danaus plexippus' }, // unassessed — kept
  ];
  const kept = excludeNonNative(rows);
  assert.deepEqual(
    kept.map((r) => r.taxon_name),
    ['Quercus virginiana', 'Danaus plexippus']
  );
});
