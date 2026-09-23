import test from 'node:test';
import assert from 'node:assert/strict';
import {
  featurePoints,
  patchView,
  round2,
  scaleFeatures,
  translateFeaturesInside,
} from '../src/state/yardEdits.js';

const bed = {
  id: 'bed',
  type: 'surface',
  footprintFt: [
    { x: 2, y: 2 },
    { x: 6, y: 2 },
    { x: 6, y: 5 },
  ],
};
const fence = {
  id: 'fence',
  type: 'wall',
  pathFt: [
    { x: 0, y: 9 },
    { x: 10, y: 9 },
  ],
  heightFt: 6,
  baseFt: 0.5,
  style: { strokeWidthFt: 0.25 },
};

test('round2 keeps two decimal places', () => {
  assert.equal(round2(1.23456), 1.23);
  assert.equal(round2('3.14159'), 3.14);
});

test('featurePoints collects footprints and paths alike', () => {
  assert.equal(featurePoints([bed, fence]).length, 5);
  assert.deepEqual(featurePoints(null), []);
});

test('scaleFeatures scales points, height, base, and stroke about the yard corner', () => {
  const [scaledBed, scaledFence] = scaleFeatures([bed, fence], 0.5);
  assert.deepEqual(scaledBed.footprintFt[1], { x: 3, y: 1 });
  assert.deepEqual(scaledFence.pathFt[1], { x: 5, y: 4.5 });
  assert.equal(scaledFence.heightFt, 3);
  assert.equal(scaledFence.baseFt, 0.25);
  assert.equal(scaledFence.style.strokeWidthFt, 0.13);
  // Inputs are not mutated.
  assert.equal(fence.heightFt, 6);
  assert.deepEqual(bed.footprintFt[1], { x: 6, y: 2 });
});

test('scaleFeatures passes an empty or missing list through', () => {
  assert.deepEqual(scaleFeatures([], 2), []);
  assert.equal(scaleFeatures(undefined, 2), undefined);
});

test('translateFeaturesInside shifts a whole stranded feature, keeping its shape', () => {
  const stranded = { id: 'bed', footprintFt: [{ x: 8, y: 1 }, { x: 12, y: 1 }, { x: 12, y: 3 }] };
  const [moved] = translateFeaturesInside([stranded], new Set(['bed']), { width: 10, depth: 10 });
  assert.deepEqual(moved.footprintFt, [
    { x: 6, y: 1 },
    { x: 10, y: 1 },
    { x: 10, y: 3 },
  ]);
});

test('translateFeaturesInside moves a feature off the low edge and leaves unnamed ones alone', () => {
  const low = { id: 'low', pathFt: [{ x: -2, y: -1 }, { x: 3, y: 2 }] };
  const [moved, untouched] = translateFeaturesInside([low, bed], new Set(['low']), { width: 10, depth: 10 });
  assert.deepEqual(moved.pathFt, [{ x: 0, y: 0 }, { x: 5, y: 3 }]);
  assert.equal(untouched, bed);
});

test('patchView merges into the one matching view only', () => {
  const views = [{ id: 'plan', label: 'Plan' }, { id: 'south', label: 'South' }];
  const next = patchView(views, 'south', { label: 'From the kitchen' });
  assert.deepEqual(next, [{ id: 'plan', label: 'Plan' }, { id: 'south', label: 'From the kitchen' }]);
  assert.equal(next[0], views[0]);
  assert.notEqual(next, views);
});
