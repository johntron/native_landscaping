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
