import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareElevationDepth,
  elevationAxisToViewBoxX,
  isValidViewFrom,
  resolveElevationOrientation,
} from '../src/render/elevationOrientation.js';

test('south and east reproduce the original hard-coded orientations', () => {
  // Standing south, looking north: x runs left-to-right, high y is farthest.
  assert.deepEqual(resolveElevationOrientation('south'), {
    viewFrom: 'south',
    axisKey: 'x',
    depthKey: 'y',
    mirrored: false,
    farIsHigh: true,
  });
  // Standing east, looking west: y runs left-to-right, low x is farthest.
  assert.deepEqual(resolveElevationOrientation('east'), {
    viewFrom: 'east',
    axisKey: 'y',
    depthKey: 'x',
    mirrored: false,
    farIsHigh: false,
  });
});

test('opposite directions mirror the horizontal axis and flip depth', () => {
  const south = resolveElevationOrientation('south');
  const north = resolveElevationOrientation('north');
  assert.equal(north.axisKey, south.axisKey);
  assert.equal(north.mirrored, !south.mirrored);
  assert.equal(north.farIsHigh, !south.farIsHigh);

  const east = resolveElevationOrientation('east');
  const west = resolveElevationOrientation('west');
  assert.equal(west.axisKey, east.axisKey);
  assert.equal(west.mirrored, !east.mirrored);
  assert.equal(west.farIsHigh, !east.farIsHigh);
});

test('rejects unknown directions', () => {
  assert.throws(() => resolveElevationOrientation('up'), /Unknown elevation viewFrom/);
  assert.equal(isValidViewFrom('WEST'), true);
  assert.equal(isValidViewFrom('sideways'), false);
});

test('mirrored views reflect the horizontal axis about the viewBox', () => {
  const toPixels = (feet) => feet * 10;
  const params = { leftOffsetPx: 20, viewBoxWidth: 800 };

  const unmirrored = elevationAxisToViewBoxX(5, toPixels, { ...params, mirrored: false });
  assert.equal(unmirrored, 70); // 5 ft -> 50 px, plus the 20 px inset

  const mirrored = elevationAxisToViewBoxX(5, toPixels, { ...params, mirrored: true });
  assert.equal(mirrored, 730); // same point measured from the opposite edge

  // A plant farther along the axis moves right when unmirrored, left when mirrored.
  assert.ok(elevationAxisToViewBoxX(9, toPixels, { ...params, mirrored: false }) > unmirrored);
  assert.ok(elevationAxisToViewBoxX(9, toPixels, { ...params, mirrored: true }) < mirrored);
});

test('depth comparison draws the farthest plant first', () => {
  // farIsHigh: the high-depth plant is farther away, so it sorts earlier.
  assert.ok(compareElevationDepth(10, 2, true) < 0);
  assert.ok(compareElevationDepth(2, 10, true) > 0);
  // Otherwise the low-depth plant is the far one.
  assert.ok(compareElevationDepth(2, 10, false) < 0);
  assert.equal(compareElevationDepth(4, 4, true), 0);
});
