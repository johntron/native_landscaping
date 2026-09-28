import test from 'node:test';
import assert from 'node:assert/strict';
import {
  containingDriftIdsByDistance,
  isPointInsideDrift,
  resolveDriftAction,
  resolveGapTapAction,
} from '../src/interaction/driftHitTest.js';

const NONE = { selectedDriftId: '', driftDrilledIn: false };

const PLANTS = [
  { id: 'wc-1', driftId: 'winecup', x: 0, y: 0, width: 2 },
  { id: 'wc-2', driftId: 'winecup', x: 4, y: 0, width: 2 },
  { id: 'wc-3', driftId: 'winecup', x: 2, y: 3, width: 2 },
  { id: 'hh-1', x: 30, y: 30 }, // not in a drift
];

// --- resolveDriftAction ---------------------------------------------------------

test('resolveDriftAction: no hit at all clears', () => {
  assert.deepEqual(resolveDriftAction({ selectedId: null, driftContext: NONE, plants: PLANTS }), { type: 'clear' });
});

test('resolveDriftAction: not isolated, hitting a plain plant just selects it', () => {
  assert.deepEqual(resolveDriftAction({ selectedId: 'hh-1', driftContext: NONE, plants: PLANTS }), {
    type: 'selectPlant',
    plantId: 'hh-1',
  });
});

test('resolveDriftAction: not isolated, hitting a drift member enters the whole drift', () => {
  assert.deepEqual(resolveDriftAction({ selectedId: 'wc-1', driftContext: NONE, plants: PLANTS }), {
    type: 'selectDrift',
    driftId: 'winecup',
  });
});

test('resolveDriftAction: isolated (whole or drilled), hitting ANY member drills into it', () => {
  const whole = { selectedDriftId: 'winecup', driftDrilledIn: false };
  const drilled = { selectedDriftId: 'winecup', driftDrilledIn: true };
  assert.deepEqual(resolveDriftAction({ selectedId: 'wc-2', driftContext: whole, plants: PLANTS }), {
    type: 'drillInto',
    plantId: 'wc-2',
    driftId: 'winecup',
  });
  assert.deepEqual(resolveDriftAction({ selectedId: 'wc-3', driftContext: drilled, plants: PLANTS }), {
    type: 'drillInto',
    plantId: 'wc-3',
    driftId: 'winecup',
  });
});

test('resolveDriftAction normalizes a numeric selectedId to a string', () => {
  const numericPlants = [{ id: 5, x: 0, y: 0 }];
  assert.deepEqual(resolveDriftAction({ selectedId: 5, driftContext: NONE, plants: numericPlants }), {
    type: 'selectPlant',
    plantId: '5',
  });
});

// --- containingDriftIdsByDistance -----------------------------------------------

test('containingDriftIdsByDistance: no point, or a point in no outline, is empty', () => {
  assert.deepEqual(containingDriftIdsByDistance(PLANTS, null), []);
  assert.deepEqual(containingDriftIdsByDistance(PLANTS, { x: 100, y: 100 }), []);
});

test('containingDriftIdsByDistance: a gap between members, inside the outline, finds the drift', () => {
  // The winecup triangle's centroid area, well clear of every member's own radius.
  assert.deepEqual(containingDriftIdsByDistance(PLANTS, { x: 2, y: 1 }), ['winecup']);
});

test('containingDriftIdsByDistance orders overlapping outlines by nearest centroid', () => {
  const overlapping = [
    ...PLANTS,
    { id: 'far-1', driftId: 'far-drift', x: 2.5, y: 1.2, width: 2 },
    { id: 'far-2', driftId: 'far-drift', x: 2.5, y: 20, width: 2 },
  ];
  // (2, 1) sits inside both winecup's outline and far-drift's much bigger one
  // (far-drift spans y=1.2..20, centroid near y=10.6); winecup's centroid is
  // nearer to (2,1), so it should come first.
  const order = containingDriftIdsByDistance(overlapping, { x: 2, y: 1 });
  assert.deepEqual(order, ['winecup', 'far-drift']);
});

// --- resolveGapTapAction ---------------------------------------------------------

test('resolveGapTapAction: no containing drift clears', () => {
  assert.deepEqual(resolveGapTapAction(null, NONE), { type: 'clear' });
});

test('resolveGapTapAction: entering a fresh drift from no context selects it', () => {
  assert.deepEqual(resolveGapTapAction('winecup', NONE), { type: 'selectDrift', driftId: 'winecup' });
});

test('resolveGapTapAction: a gap still inside the SAME isolated drift is a no-op', () => {
  const context = { selectedDriftId: 'winecup', driftDrilledIn: false };
  assert.deepEqual(resolveGapTapAction('winecup', context), { type: 'noop' });
});

test('resolveGapTapAction: cycling into a DIFFERENT overlapping drift switches to it', () => {
  const context = { selectedDriftId: 'winecup', driftDrilledIn: false };
  assert.deepEqual(resolveGapTapAction('far-drift', context), { type: 'selectDrift', driftId: 'far-drift' });
});

// --- isPointInsideDrift -----------------------------------------------------------

test('isPointInsideDrift: true inside the outline, false outside, false for an unknown drift', () => {
  assert.equal(isPointInsideDrift(PLANTS, 'winecup', { x: 2, y: 1 }), true);
  assert.equal(isPointInsideDrift(PLANTS, 'winecup', { x: 100, y: 100 }), false);
  assert.equal(isPointInsideDrift(PLANTS, 'nope', { x: 2, y: 1 }), false);
  assert.equal(isPointInsideDrift(PLANTS, '', { x: 2, y: 1 }), false);
  assert.equal(isPointInsideDrift(PLANTS, 'winecup', null), false);
});
