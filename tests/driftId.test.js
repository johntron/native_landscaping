import test from 'node:test';
import assert from 'node:assert/strict';
import { dropUndersizedDrifts, isValidDriftId, slugifyDriftLabel } from '../src/data/driftId.js';

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

// --- dropUndersizedDrifts (nl-o47.6.9) ------------------------------------------

test('dropUndersizedDrifts strips a driftId shared by fewer than 2 plants, leaving 2+-member drifts and plants in no drift alone', () => {
  const plants = [
    { id: 'lone', driftId: 'orphan' },
    { id: 'a', driftId: 'strip' },
    { id: 'b', driftId: 'strip' },
    { id: 'single' }, // no driftId at all
  ];
  const result = dropUndersizedDrifts(plants);
  assert.equal(result.find((p) => p.id === 'lone').driftId, undefined);
  assert.equal(result.find((p) => p.id === 'a').driftId, 'strip');
  assert.equal(result.find((p) => p.id === 'b').driftId, 'strip');
  assert.equal(result.find((p) => p.id === 'single').driftId, undefined);
  assert.notEqual(result, plants, 'a new array when something changed');
  assert.equal(plants[0].driftId, 'orphan', 'the input is never mutated');
});

test('dropUndersizedDrifts is a no-op (same array reference) when every drift already has 2+ members, or none carry one', () => {
  const uniform = [{ id: 'a', driftId: 'strip' }, { id: 'b', driftId: 'strip' }];
  assert.equal(dropUndersizedDrifts(uniform), uniform);
  const none = [{ id: 'a' }, { id: 'b' }];
  assert.equal(dropUndersizedDrifts(none), none);
});

test('dropUndersizedDrifts on a non-array input', () => {
  assert.equal(dropUndersizedDrifts(null), null);
  assert.equal(dropUndersizedDrifts(undefined), undefined);
});
