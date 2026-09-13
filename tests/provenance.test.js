import test from 'node:test';
import assert from 'node:assert/strict';
import { TIERS, classifySource, tierInfo, bestTier } from '../src/analysis/provenance.js';

test('the four tiers are ordered strongest first', () => {
  assert.equal(TIERS['primary-flora'].rank, 1);
  assert.ok(TIERS['primary-flora'].rank < TIERS['agency-database'].rank);
  assert.ok(TIERS['agency-database'].rank < TIERS.aggregator.rank);
  assert.ok(TIERS.aggregator.rank < TIERS.tertiary.rank);
});

test('classifies the source strings actually present in the ecology tables', () => {
  assert.equal(classifySource("Diggs, Lipscomb & O'Kennon 1999, Appendix Ten"), 'primary-flora');
  assert.equal(classifySource('nwf-ecoregion-9'), 'agency-database');
  assert.equal(classifySource('globalbioticinteractions.org, fetched 2026-09-13'), 'aggregator');
  assert.equal(classifySource('api.inaturalist.org species_counts'), 'aggregator');
  assert.equal(classifySource('Wikipedia, Danaus plexippus — larvae feed obligately on Asclepias'), 'tertiary');
  assert.equal(
    classifySource('The Xerces Society (2016), Gardening for Butterflies (via Wikipedia)'),
    'tertiary'
  );
});

// The failure that matters is a source silently reading as more authoritative
// than it is, so an unrecognised string must fall to the bottom, not the middle.
test('an unrecognised or empty source is unattributed, never promoted', () => {
  assert.equal(classifySource('some blog post'), 'unknown');
  assert.equal(classifySource(''), 'unknown');
  assert.equal(classifySource(undefined), 'unknown');
  assert.equal(tierInfo('unknown').rank, 5);
  assert.ok(tierInfo('unknown').rank > TIERS.tertiary.rank);
});

test('bestTier takes the strongest evidence a row has', () => {
  assert.equal(bestTier(['aggregator', 'primary-flora', 'tertiary']), 'primary-flora');
  assert.equal(bestTier(['tertiary', 'aggregator']), 'aggregator');
  assert.equal(bestTier([]), 'unknown');
  assert.equal(bestTier(['nonsense']), 'unknown');
});
