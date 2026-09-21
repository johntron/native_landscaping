import test from 'node:test';
import assert from 'node:assert/strict';
import { UNSOURCEABLE_FIELDS, explainUnsourceable } from '../tools/claims/unsourceableRegister.js';

test('UNSOURCEABLE_FIELDS: every entry carries a reason, a measurement list, and a citation (10 §4\'s discipline)', () => {
  assert.ok(UNSOURCEABLE_FIELDS.length >= 2, 'width_ft and species-level insect associations are both required by nl-scx.12 AC');
  for (const entry of UNSOURCEABLE_FIELDS) {
    assert.equal(typeof entry.field, 'string');
    assert.ok(entry.field.length > 0);
    assert.ok(['all-species', 'species'].includes(entry.scope));
    assert.equal(typeof entry.reason, 'string');
    assert.ok(entry.reason.length > 20, 'reason must actually explain, not just label');
    assert.ok(Array.isArray(entry.measuredAbsentFrom) && entry.measuredAbsentFrom.length > 0, `${entry.field} needs measured-absent evidence`);
    assert.ok(Array.isArray(entry.citedIn) && entry.citedIn.length > 0, `${entry.field} needs a doc citation`);
    if (entry.scope === 'species') {
      assert.ok(Array.isArray(entry.species) && entry.species.length > 0);
    }
  }
});

test('width_ft is registered as all-species unsourceable, citing the measured 0% fill', () => {
  const entry = explainUnsourceable('width_ft');
  assert.ok(entry);
  assert.equal(entry.field, 'width_ft');
  assert.match(entry.reason, /spread/i);
  assert.ok(entry.citedIn.some((c) => c.includes('08-known-gaps.md')));
});

test('larval_host_species (species-level insect associations) is registered, citing the PlantPollinator measurement', () => {
  const entry = explainUnsourceable('larval_host_species');
  assert.ok(entry);
  assert.match(entry.reason, /PlantPollinator|API/i);
});

test('explainUnsourceable returns null for a field not in the register', () => {
  assert.equal(explainUnsourceable('sun_pref'), null);
  assert.equal(explainUnsourceable('nativity_nctx'), null);
});

test('explainUnsourceable: an all-species entry matches regardless of which taxon is passed', () => {
  const entry = explainUnsourceable('width_ft', { scientific_name: 'Quercus shumardii', usda_symbol: 'QUSH' });
  assert.ok(entry);
  assert.equal(entry.field, 'width_ft');
});

test('explainUnsourceable: a species-scoped entry matches only its named species, by scientific_name or usda_symbol', () => {
  const synthetic = [
    {
      field: 'flowering_season_months',
      scope: 'species',
      species: ['Matelea gonocarpos', 'ANQU'],
      reason: 'synthetic entry for this test only',
      measuredAbsentFrom: ['test'],
      citedIn: ['test'],
    },
  ];

  assert.ok(explainUnsourceable('flowering_season_months', { scientific_name: 'Matelea gonocarpos' }, synthetic));
  assert.ok(explainUnsourceable('flowering_season_months', { usda_symbol: 'ANQU' }, synthetic));
  assert.equal(explainUnsourceable('flowering_season_months', { scientific_name: 'Ilex vomitoria' }, synthetic), null);
  // no taxon passed at all: a species-scoped entry can never match.
  assert.equal(explainUnsourceable('flowering_season_months', undefined, synthetic), null);
});
