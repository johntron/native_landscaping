import test from 'node:test';
import assert from 'node:assert/strict';
import { driftForExactSelection } from '../src/state/driftSelection.js';

// nl-o47.6.12: inferDriftContext, pruneDriftContext, currentDriftMemberIds,
// and existingDriftIds are gone — the selection is now a discriminated union
// owned by src/ui/plantSelection.js (tests/plantSelection.test.js), which is
// where their own behaviour is now tested. driftForExactSelection is the one
// pure decision left here.

const PLANTS = [
  { id: 'wc-1', driftId: 'winecup' },
  { id: 'wc-2', driftId: 'winecup' },
  { id: 'wc-3', driftId: 'winecup' },
  { id: 'lone-wc', driftId: 'winecup-solo' }, // a 1-member drift
  { id: 'hh-1' }, // not in a drift
];

test('driftForExactSelection matches a full membership, any size including 1', () => {
  assert.equal(driftForExactSelection(['wc-1', 'wc-2', 'wc-3'], PLANTS), 'winecup');
  assert.equal(driftForExactSelection(['lone-wc'], PLANTS), 'winecup-solo');
});

test('driftForExactSelection rejects a subset, a superset, a mix of drifts, and a plain plant', () => {
  assert.equal(driftForExactSelection(['wc-1', 'wc-2'], PLANTS), '', 'a subset');
  assert.equal(driftForExactSelection(['wc-1', 'wc-2', 'wc-3', 'hh-1'], PLANTS), '', 'a superset (plus an outsider)');
  assert.equal(driftForExactSelection(['wc-1', 'lone-wc'], PLANTS), '', 'spans two drifts');
  assert.equal(driftForExactSelection(['hh-1'], PLANTS), '', 'not in any drift');
  assert.equal(driftForExactSelection([], PLANTS), '', 'empty selection');
});

test('driftForExactSelection ignores id order and tolerates numeric/string mismatches', () => {
  assert.equal(driftForExactSelection(['wc-3', 'wc-1', 'wc-2'], PLANTS), 'winecup');
  const numericPlants = [{ id: 1, driftId: 'd' }, { id: 2, driftId: 'd' }];
  assert.equal(driftForExactSelection(['1', '2'], numericPlants), 'd');
});
