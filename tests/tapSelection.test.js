import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TAP_MOVEMENT_THRESHOLD_PX,
  exceedsTapThreshold,
  isSameSpot,
  resolveTapSelection,
  sameMembership,
} from '../src/interaction/tapSelection.js';

test('exceedsTapThreshold is false for movement at or under the threshold', () => {
  assert.equal(exceedsTapThreshold(0, 0), false);
  assert.equal(exceedsTapThreshold(TAP_MOVEMENT_THRESHOLD_PX, 0), false);
  assert.equal(exceedsTapThreshold(5, 5), false); // hypot(5,5) ≈ 7.07, under the 8px default
});

test('exceedsTapThreshold is true once the pointer moved far enough', () => {
  assert.equal(exceedsTapThreshold(6, 6, 8), true); // hypot(6,6) > 8
  assert.equal(exceedsTapThreshold(20, 0), true);
});

test('isSameSpot is true within the threshold and false beyond it', () => {
  assert.equal(isSameSpot({ x: 10, y: 10 }, { x: 14, y: 10 }), true); // 4px
  assert.equal(isSameSpot({ x: 10, y: 10 }, { x: 30, y: 10 }), false); // 20px
});

test('isSameSpot is false when either point is missing', () => {
  assert.equal(isSameSpot(null, { x: 0, y: 0 }), false);
  assert.equal(isSameSpot({ x: 0, y: 0 }, null), false);
});

test('sameMembership ignores order', () => {
  assert.equal(sameMembership(['a', 'b'], ['b', 'a']), true);
});

test('sameMembership is false on a different set or a different size', () => {
  assert.equal(sameMembership(['a', 'b'], ['a', 'c']), false);
  assert.equal(sameMembership(['a'], ['a', 'b']), false);
});

test('resolveTapSelection on empty ground clears: null selection, null next tap', () => {
  const result = resolveTapSelection([], { x: 10, y: 10 }, { point: { x: 10, y: 10 }, order: ['a'], index: 0 });
  assert.equal(result.selectedId, null);
  assert.equal(result.nextTap, null);
});

test('resolveTapSelection with no previous tap selects the nearest candidate (first in order)', () => {
  const candidates = [{ id: 'near' }, { id: 'far' }];
  const result = resolveTapSelection(candidates, { x: 5, y: 5 }, null);
  assert.equal(result.selectedId, 'near');
  assert.deepEqual(result.nextTap, { point: { x: 5, y: 5 }, order: ['near', 'far'], index: 0 });
});

test('resolveTapSelection a fresh tap elsewhere (different spot) restarts at the nearest candidate', () => {
  const candidates = [{ id: 'b' }, { id: 'a' }];
  const previousTap = { point: { x: 0, y: 0 }, order: ['a', 'b'], index: 0 };
  const result = resolveTapSelection(candidates, { x: 500, y: 500 }, previousTap);
  assert.equal(result.selectedId, 'b');
  assert.equal(result.nextTap.index, 0);
});

test('resolveTapSelection a repeat tap at the same spot with the same candidates cycles to the next one', () => {
  const candidates = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const previousTap = { point: { x: 10, y: 10 }, order: ['a', 'b', 'c'], index: 0 };
  const result = resolveTapSelection(candidates, { x: 12, y: 10 }, previousTap);
  assert.equal(result.selectedId, 'b');
  assert.equal(result.nextTap.index, 1);
  // The order carries over unchanged, not recomputed from this tap's list.
  assert.deepEqual(result.nextTap.order, ['a', 'b', 'c']);
});

test('resolveTapSelection cycling wraps back to the first candidate after the last', () => {
  const candidates = [{ id: 'a' }, { id: 'b' }];
  const previousTap = { point: { x: 10, y: 10 }, order: ['a', 'b'], index: 1 };
  const result = resolveTapSelection(candidates, { x: 10, y: 10 }, previousTap);
  assert.equal(result.selectedId, 'a');
  assert.equal(result.nextTap.index, 0);
});

test('resolveTapSelection cycles on membership even when pickPlantHit reordered the candidates', () => {
  // Distance-sort jitter: a tap 3px from the last one can flip which candidate
  // is nearest without changing which plants overlap the point.
  const candidates = [{ id: 'b' }, { id: 'a' }]; // reordered vs. the first tap
  const previousTap = { point: { x: 10, y: 10 }, order: ['a', 'b'], index: 0 };
  const result = resolveTapSelection(candidates, { x: 13, y: 10 }, previousTap);
  assert.equal(result.selectedId, 'b'); // next after 'a' in the STORED order
  assert.deepEqual(result.nextTap.order, ['a', 'b']); // stored order preserved
});

test('resolveTapSelection a same-spot tap with DIFFERENT overlapping plants does not cycle', () => {
  const candidates = [{ id: 'x' }, { id: 'y' }];
  const previousTap = { point: { x: 10, y: 10 }, order: ['a', 'b'], index: 0 };
  const result = resolveTapSelection(candidates, { x: 10, y: 10 }, previousTap);
  assert.equal(result.selectedId, 'x');
  assert.equal(result.nextTap.index, 0);
  assert.deepEqual(result.nextTap.order, ['x', 'y']);
});
