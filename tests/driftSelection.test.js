import test from 'node:test';
import assert from 'node:assert/strict';
import {
  currentDriftMemberIds,
  driftForExactSelection,
  existingDriftIds,
  inferDriftContext,
  pruneDriftContext,
} from '../src/state/driftSelection.js';

const PLANTS = [
  { id: 'wc-1', driftId: 'winecup' },
  { id: 'wc-2', driftId: 'winecup' },
  { id: 'wc-3', driftId: 'winecup' },
  { id: 'lone-wc', driftId: 'winecup-solo' }, // a 1-member drift
  { id: 'hh-1' }, // not in a drift
];

// --- driftForExactSelection ---------------------------------------------------

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

// --- inferDriftContext (selectPlants' own decision) ---------------------------

test('inferDriftContext: exact full membership enters whole mode, even coming from no prior context', () => {
  assert.deepEqual(inferDriftContext(['wc-1', 'wc-2', 'wc-3'], PLANTS, ''), {
    selectedDriftId: 'winecup',
    driftDrilledIn: false,
  });
});

test('inferDriftContext: exact match wins even for a 1-member drift (not read as "drilled")', () => {
  assert.deepEqual(inferDriftContext(['lone-wc'], PLANTS, ''), {
    selectedDriftId: 'winecup-solo',
    driftDrilledIn: false,
  });
});

test('inferDriftContext: a single member of the drift ALREADY active stays in it, drilled', () => {
  assert.deepEqual(inferDriftContext(['wc-2'], PLANTS, 'winecup'), {
    selectedDriftId: 'winecup',
    driftDrilledIn: true,
  });
});

test('inferDriftContext: a single member with NO prior context (a cold right-click) invents nothing', () => {
  assert.deepEqual(inferDriftContext(['wc-2'], PLANTS, ''), { selectedDriftId: '', driftDrilledIn: false });
});

test('inferDriftContext: a single member of a DIFFERENT drift than the active one invents nothing either', () => {
  // 'wc-2' is not a full-membership match on its own (winecup has 3 members),
  // and the active context names a different drift entirely.
  assert.deepEqual(inferDriftContext(['wc-2'], PLANTS, 'winecup-solo'), { selectedDriftId: '', driftDrilledIn: false });
});

test('inferDriftContext: a plain plant, an empty selection, or a mixed multi-select carries no drift context', () => {
  assert.deepEqual(inferDriftContext(['hh-1'], PLANTS, ''), { selectedDriftId: '', driftDrilledIn: false });
  assert.deepEqual(inferDriftContext([], PLANTS, 'winecup'), { selectedDriftId: '', driftDrilledIn: false });
  assert.deepEqual(inferDriftContext(['wc-1', 'hh-1'], PLANTS, ''), { selectedDriftId: '', driftDrilledIn: false });
});

// --- pruneDriftContext ---------------------------------------------------------

test('pruneDriftContext: whole mode re-syncs to the drift\'s CURRENT membership, not the pruned snapshot', () => {
  // "+" added wc-4 to winecup elsewhere; prunedIds is a stale 3-id snapshot.
  const grown = [...PLANTS, { id: 'wc-4', driftId: 'winecup' }];
  const context = pruneDriftContext(
    { selectedDriftId: 'winecup', driftDrilledIn: false },
    new Set(['wc-1', 'wc-2', 'wc-3']),
    grown
  );
  assert.deepEqual(context, { selectedDriftId: 'winecup', driftDrilledIn: false });
});

test('pruneDriftContext: whole mode falls back to inferring from the pruned ids once the drift itself is gone', () => {
  const dissolved = PLANTS.map((p) => (p.driftId === 'winecup' ? { id: p.id } : p));
  const context = pruneDriftContext(
    { selectedDriftId: 'winecup', driftDrilledIn: false },
    new Set(['wc-1', 'wc-2', 'wc-3']),
    dissolved
  );
  // Nothing left to match 'winecup' to (its members no longer carry it), and
  // the pruned ids themselves are now plain plants: no drift context.
  assert.deepEqual(context, { selectedDriftId: '', driftDrilledIn: false });
});

test('pruneDriftContext: drilled mode survives pruning as long as the SAME member and drift remain', () => {
  const context = pruneDriftContext({ selectedDriftId: 'winecup', driftDrilledIn: true }, new Set(['wc-2']), PLANTS);
  assert.deepEqual(context, { selectedDriftId: 'winecup', driftDrilledIn: true });
});

test('pruneDriftContext: drilled mode clears if the drilled-into plant was removed, or moved to a different drift', () => {
  assert.deepEqual(
    pruneDriftContext({ selectedDriftId: 'winecup', driftDrilledIn: true }, new Set(), PLANTS),
    { selectedDriftId: '', driftDrilledIn: false }
  );
  const movedOut = PLANTS.map((p) => (p.id === 'wc-2' ? { id: p.id } : p));
  assert.deepEqual(
    pruneDriftContext({ selectedDriftId: 'winecup', driftDrilledIn: true }, new Set(['wc-2']), movedOut),
    { selectedDriftId: '', driftDrilledIn: false }
  );
});

test('pruneDriftContext: no prior drift context stays none', () => {
  assert.deepEqual(
    pruneDriftContext({ selectedDriftId: '', driftDrilledIn: false }, new Set(['hh-1']), PLANTS),
    { selectedDriftId: '', driftDrilledIn: false }
  );
});

// --- small helpers --------------------------------------------------------------

test('currentDriftMemberIds and existingDriftIds', () => {
  assert.deepEqual(currentDriftMemberIds('winecup', PLANTS), ['wc-1', 'wc-2', 'wc-3']);
  assert.deepEqual(currentDriftMemberIds('nope', PLANTS), []);
  assert.deepEqual(existingDriftIds(PLANTS), ['winecup', 'winecup-solo']);
});
