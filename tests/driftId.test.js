import test from 'node:test';
import assert from 'node:assert/strict';
import {
  driftMemberCountLabel,
  dropUndersizedDrifts,
  humanizeDriftId,
  isValidDriftId,
  slugifyDriftLabel,
} from '../src/data/driftId.js';

test('humanizeDriftId turns hyphens to spaces and capitalises the first letter only (nl-o47.6.2)', () => {
  assert.equal(humanizeDriftId('winecup'), 'Winecup');
  assert.equal(humanizeDriftId('winecup-2'), 'Winecup 2');
  assert.equal(humanizeDriftId('front-edge'), 'Front edge');
  assert.equal(humanizeDriftId(''), '');
  assert.equal(humanizeDriftId(null), '');
});

test('humanizeDriftId(slugifyDriftLabel(x)) round-trips a normal label\'s wording', () => {
  assert.equal(humanizeDriftId(slugifyDriftLabel('Front Edge')), 'Front edge');
});

test('isValidDriftId is unaffected (sanity: this file does not touch it)', () => {
  assert.equal(isValidDriftId('winecup-2'), true);
});

test('driftMemberCountLabel humanizes the id and pluralizes the count (nl-o47.6.7)', () => {
  assert.equal(driftMemberCountLabel('winecup', 12), 'Winecup · 12 plants');
  assert.equal(driftMemberCountLabel('winecup', 1), 'Winecup · 1 plant');
  assert.equal(driftMemberCountLabel('front-edge', 0), 'Front edge · 0 plants');
});

test('driftMemberCountLabel returns empty for an unhumanizable id', () => {
  assert.equal(driftMemberCountLabel('', 5), '');
  assert.equal(driftMemberCountLabel(null, 5), '');
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
