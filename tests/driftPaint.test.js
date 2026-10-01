import test from 'node:test';
import assert from 'node:assert/strict';
import { dropPositionsOutsideYard, MAX_PAINT_COUNT, resampleStroke } from '../src/state/driftPaint.js';

// --- resampleStroke --------------------------------------------------------

test('resampleStroke places points at every multiple of the spacing, start included', () => {
  const stroke = [{ x: 0, y: 0 }, { x: 10, y: 0 }]; // a straight 10 ft line
  const { positions, capped } = resampleStroke(stroke, 2);
  assert.equal(capped, false);
  assert.deepStrictEqual(
    positions.map((p) => p.x),
    [0, 2, 4, 6, 8, 10]
  );
  assert.ok(positions.every((p) => p.y === 0));
});

test('resampleStroke follows a bent polyline, interpolating within each segment', () => {
  // An L-shape: 4 ft east, then 3 ft north -> total length 7. Targets at
  // 0, 2, 4, 6 fall inside the path; the next one (8) exceeds its length.
  const stroke = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }];
  const { positions } = resampleStroke(stroke, 2);
  assert.deepStrictEqual(positions, [
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 2 },
  ]);
});

test('resampleStroke of a stroke shorter than one spacing still yields its single starting point', () => {
  const stroke = [{ x: 5, y: 5 }, { x: 5.4, y: 5 }]; // 0.4 ft of movement
  const { positions, capped } = resampleStroke(stroke, 2);
  assert.deepStrictEqual(positions, [{ x: 5, y: 5 }]);
  assert.equal(capped, false);
});

test('resampleStroke of a stroke with no net movement (every point coincides) yields nothing', () => {
  const stroke = [{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }];
  assert.deepStrictEqual(resampleStroke(stroke, 2), { positions: [], capped: false });
});

test('resampleStroke of fewer than two points yields nothing', () => {
  assert.deepStrictEqual(resampleStroke([], 2), { positions: [], capped: false });
  assert.deepStrictEqual(resampleStroke([{ x: 1, y: 1 }], 2), { positions: [], capped: false });
});

test('resampleStroke caps a long stroke and reports it', () => {
  const stroke = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const { positions, capped } = resampleStroke(stroke, 1, { maxCount: 5 });
  assert.equal(positions.length, 5);
  assert.equal(capped, true);
  assert.deepStrictEqual(
    positions.map((p) => p.x),
    [0, 1, 2, 3, 4]
  );
});

test('resampleStroke defaults its cap to MAX_PAINT_COUNT', () => {
  const stroke = [{ x: 0, y: 0 }, { x: 10000, y: 0 }];
  const { positions, capped } = resampleStroke(stroke, 1);
  assert.equal(positions.length, MAX_PAINT_COUNT);
  assert.equal(capped, true);
});

test('resampleStroke falls back to the stroke length as its own spacing when spacingFt is not positive', () => {
  const stroke = [{ x: 0, y: 0 }, { x: 6, y: 0 }];
  const { positions } = resampleStroke(stroke, 0);
  // Falls back to `total` as the spacing, so only the start (0) and the one
  // step at `total` (6) are within range.
  assert.deepStrictEqual(
    positions.map((p) => p.x),
    [0, 6]
  );
});

// --- dropPositionsOutsideYard ------------------------------------------------

const BOUNDS = { x: { min: 0, max: 10 }, y: { min: 0, max: 10 } };

test('dropPositionsOutsideYard drops only the points outside the declared yard', () => {
  const positions = [
    { x: 5, y: 5 }, // inside
    { x: -1, y: 5 }, // outside (west)
    { x: 10, y: 10 }, // on the boundary: inside
    { x: 5, y: 12 }, // outside (north)
  ];
  assert.deepStrictEqual(dropPositionsOutsideYard(positions, BOUNDS), [
    { x: 5, y: 5 },
    { x: 10, y: 10 },
  ]);
});

test('dropPositionsOutsideYard drops nothing when there is no declared yard', () => {
  const positions = [{ x: -100, y: 999 }];
  assert.deepStrictEqual(dropPositionsOutsideYard(positions, null), positions);
});

test('dropPositionsOutsideYard on an empty stroke returns an empty list', () => {
  assert.deepStrictEqual(dropPositionsOutsideYard([], BOUNDS), []);
});
