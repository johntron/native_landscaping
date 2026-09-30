import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidDriftId, normalizeDrifts, slugifyDriftLabel } from '../src/data/driftId.js';

test('isValidDriftId is unaffected (sanity: this file does not touch it)', () => {
  assert.equal(isValidDriftId('winecup-2'), true);
});

// nl-o47.6.11: a drift's own display label moved to driftLabel
// (src/render/labels.js, tests/labels.test.js); slugifyDriftLabel is now only
// ever fed a species name (buildDriftId), never a person-typed one, but its
// shape-making job is unchanged.
test('slugifyDriftLabel lower-cases, collapses non-alphanumeric runs to one hyphen, and trims', () => {
  assert.equal(slugifyDriftLabel('Callirhoe involucrata'), 'callirhoe-involucrata');
  assert.equal(slugifyDriftLabel('  --Front Edge!!--  '), 'front-edge');
});

test('slugifyDriftLabel never returns empty: a label with no usable characters slugs to "drift"', () => {
  assert.equal(slugifyDriftLabel(''), 'drift');
  assert.equal(slugifyDriftLabel('!!!'), 'drift');
  assert.equal(slugifyDriftLabel(null), 'drift');
});

// --- normalizeDrifts (nl-o47.6.12) ------------------------------------------

test('normalizeDrifts strips a driftId shared by fewer than 2 plants, leaving 2+-member drifts and plants in no drift alone', () => {
  const plants = [
    { id: 'lone', driftId: 'orphan' },
    { id: 'a', driftId: 'strip' },
    { id: 'b', driftId: 'strip' },
    { id: 'single' }, // no driftId at all
  ];
  const result = normalizeDrifts(plants);
  assert.equal(result.find((p) => p.id === 'lone').driftId, undefined);
  assert.equal(result.find((p) => p.id === 'a').driftId, 'strip');
  assert.equal(result.find((p) => p.id === 'b').driftId, 'strip');
  assert.equal(result.find((p) => p.id === 'single').driftId, undefined);
  assert.notEqual(result, plants, 'a new array when something changed');
  assert.equal(plants[0].driftId, 'orphan', 'the input is never mutated');
});

test('normalizeDrifts is a no-op (same array reference) when every drift already has 2+ members, one species, and one lifecycle', () => {
  const uniform = [{ id: 'a', driftId: 'strip' }, { id: 'b', driftId: 'strip' }];
  assert.equal(normalizeDrifts(uniform), uniform);
  const none = [{ id: 'a' }, { id: 'b' }];
  assert.equal(normalizeDrifts(none), none);
});

test('normalizeDrifts on a non-array input', () => {
  assert.equal(normalizeDrifts(null), null);
  assert.equal(normalizeDrifts(undefined), undefined);
});

test('normalizeDrifts drops a member whose species does not match the FIRST member sharing that driftId', () => {
  const plants = [
    { id: 'a', speciesId: 'winecup', driftId: 'strip' },
    { id: 'b', speciesId: 'horseherb', driftId: 'strip' }, // a mix-up: leaves the drift
    { id: 'c', speciesId: 'winecup', driftId: 'strip' },
  ];
  const result = normalizeDrifts(plants);
  assert.equal(result.find((p) => p.id === 'a').driftId, 'strip');
  assert.equal(result.find((p) => p.id === 'b').driftId, undefined);
  assert.equal(result.find((p) => p.id === 'c').driftId, 'strip');
});

test('normalizeDrifts drops the species check\'s own casualty taking a drift below 2 members too', () => {
  const plants = [
    { id: 'a', speciesId: 'winecup', driftId: 'strip' },
    { id: 'b', speciesId: 'horseherb', driftId: 'strip' }, // the only other member, and a different species
  ];
  const result = normalizeDrifts(plants);
  result.forEach((p) => assert.equal(p.driftId, undefined));
});

test('normalizeDrifts unifies every member\'s lifecycle onto the FIRST member\'s', () => {
  const plants = [
    { id: 'a', speciesId: 'winecup', driftId: 'strip', status: 'planted', plantedOn: '2026-03-01' },
    { id: 'b', speciesId: 'winecup', driftId: 'strip' }, // planned — disagrees
    { id: 'c', speciesId: 'winecup', driftId: 'strip', localEcotype: true }, // disagrees differently
  ];
  const result = normalizeDrifts(plants);
  result.forEach((p) => {
    assert.equal(p.status, 'planted');
    assert.equal(p.plantedOn, '2026-03-01');
    assert.equal(p.localEcotype ?? false, false);
  });
  // The first member (already matching the target) is untouched, not just equal.
  assert.equal(result[0], plants[0]);
});

test('normalizeDrifts leaves an already-uniform multi-drift plants list untouched by reference', () => {
  const plants = [
    { id: 'a', speciesId: 'winecup', driftId: 'one' },
    { id: 'b', speciesId: 'winecup', driftId: 'one' },
    { id: 'c', speciesId: 'horseherb', driftId: 'two' },
    { id: 'd', speciesId: 'horseherb', driftId: 'two' },
    { id: 'e', speciesId: 'carex' }, // no drift
  ];
  assert.equal(normalizeDrifts(plants), plants);
});
