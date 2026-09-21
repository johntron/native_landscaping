import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRarity } from '../src/analysis/rarity.js';

test('classifyRarity returns null when the taxon has no local count', () => {
  const speciesObservations = new Map([['Asclepias tuberosa', 12]]);
  const relevance = classifyRarity({ taxon_name: 'Danaus plexippus' }, { speciesObservations });
  assert.equal(relevance, null);
});

test('classifyRarity returns null against an empty index', () => {
  const relevance = classifyRarity({ taxon_name: 'Asclepias tuberosa' }, { speciesObservations: new Map() });
  assert.equal(relevance, null);
});

test('classifyRarity surfaces the raw count with no threshold set', () => {
  const speciesObservations = new Map([['Asclepias tuberosa', 3]]);
  const relevance = classifyRarity({ taxon_name: 'Asclepias tuberosa' }, { speciesObservations });
  assert.equal(relevance.kind, 'local-scarcity');
  assert.equal(relevance.observationCount, 3);
});

test('classifyRarity drops events over a caller-supplied threshold', () => {
  const speciesObservations = new Map([['Asclepias tuberosa', 50]]);
  const relevance = classifyRarity(
    { taxon_name: 'Asclepias tuberosa' },
    { speciesObservations, maxObservationCount: 10 }
  );
  assert.equal(relevance, null);
});

test('classifyRarity keeps events at or under the threshold', () => {
  const speciesObservations = new Map([['Asclepias tuberosa', 10]]);
  const relevance = classifyRarity(
    { taxon_name: 'Asclepias tuberosa' },
    { speciesObservations, maxObservationCount: 10 }
  );
  assert.equal(relevance.observationCount, 10);
});

test('classifyRarity surfaces conservation-status only when includeConservationStatus is set', () => {
  const event = { taxon_name: 'Something Unindexed', conservation_status: 'G2', conservation_status_name: 'Imperiled' };
  const withoutToggle = classifyRarity(event, { speciesObservations: new Map() });
  assert.equal(withoutToggle, null);

  const withToggle = classifyRarity(event, { speciesObservations: new Map(), includeConservationStatus: true });
  assert.deepEqual(withToggle, { kind: 'conservation-status', status: 'G2', statusName: 'Imperiled' });
});

test('classifyRarity prefers local-scarcity over conservation-status when both apply', () => {
  const speciesObservations = new Map([['Asclepias tuberosa', 3]]);
  const event = { taxon_name: 'Asclepias tuberosa', conservation_status: 'G2' };
  const relevance = classifyRarity(event, { speciesObservations, includeConservationStatus: true });
  assert.equal(relevance.kind, 'local-scarcity');
});

test('classifyRarity surfaces protected-species only when includeProtectedSpecies is set and taxon_geoprivacy is obscured/private', () => {
  const obscured = { taxon_name: 'Haliaeetus leucocephalus', taxon_geoprivacy: 'obscured' };
  assert.equal(classifyRarity(obscured, { speciesObservations: new Map() }), null);
  assert.deepEqual(
    classifyRarity(obscured, { speciesObservations: new Map(), includeProtectedSpecies: true }),
    { kind: 'protected-species', taxonGeoprivacy: 'obscured' }
  );

  const open = { taxon_name: 'Some Species', taxon_geoprivacy: 'open' };
  assert.equal(classifyRarity(open, { speciesObservations: new Map(), includeProtectedSpecies: true }), null);
});
