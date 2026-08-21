import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveYardBounds, resolveYardConflicts } from '../src/render/yardBounds.js';

const plan = (overrides = {}) => ({
  id: 'plan',
  type: 'plan',
  viewBox: { width: 800, height: 600 },
  originFt: { x: 0, y: 0 },
  extentFt: { width: 40, height: 30 },
  ...overrides,
});

const elevation = (viewFrom, overrides = {}) => ({
  id: viewFrom,
  type: 'elevation',
  viewFrom,
  viewBox: { width: 800, height: 600 },
  originFt: { x: 0, y: 0 },
  extentFt: { width: 40, height: 30 },
  ...overrides,
});

test('with no elevations the yard is exactly the plan view', () => {
  assert.deepEqual(resolveYardBounds([plan()]), {
    x: { min: 0, max: 40 },
    y: { min: 0, max: 30 },
  });
});

test("an elevation's near-edge margin does not extend the yard", () => {
  // This is the bug the bead was filed for: the east elevation starts 2.96 ft
  // before the yard's zero, and a plant dragged there fell off the plan view.
  const views = [plan(), elevation('east', { originFt: { x: -2.96, y: -3.7 } })];
  const bounds = resolveYardBounds(views);
  assert.equal(bounds.y.min, 0);
  // East runs along y and reaches -2.96..37.04, so the plan's 30 still caps it.
  assert.equal(bounds.y.max, 30);
});

test('an elevation shorter than the plan narrows the yard', () => {
  const views = [plan(), elevation('south', { extentFt: { width: 25, height: 30 } })];
  const bounds = resolveYardBounds(views);
  // South runs along x, so only x narrows.
  assert.deepEqual(bounds.x, { min: 0, max: 25 });
  assert.deepEqual(bounds.y, { min: 0, max: 30 });
});

test('each compass direction is bounded by its first elevation only', () => {
  // A second south elevation is a detail callout; a plant outside it is still
  // visible in the full south view, so it must not shrink the yard.
  const views = [
    plan(),
    elevation('south'),
    elevation('south', { id: 'south-detail', originFt: { x: 10, y: 0 }, extentFt: { width: 8, height: 6 } }),
  ];
  assert.deepEqual(resolveYardBounds(views).x, { min: 0, max: 40 });
});

test('a detail plan view does not shrink the yard either', () => {
  const views = [
    plan(),
    plan({ id: 'shade-bed', originFt: { x: 4, y: 9 }, extentFt: { width: 8, height: 6 } }),
  ];
  assert.deepEqual(resolveYardBounds(views).x, { min: 0, max: 40 });
});

test('views that do not overlap fall back to the plan rather than an inverted range', () => {
  const views = [plan(), elevation('south', { originFt: { x: 100, y: 0 } })];
  const bounds = resolveYardBounds(views);
  assert.deepEqual(bounds.x, { min: 0, max: 40 });
  assert.ok(bounds.x.min < bounds.x.max);
});

test('a project with no plan view has no shared yard to clamp to', () => {
  assert.equal(resolveYardBounds([elevation('south')]), null);
  assert.equal(resolveYardBounds(null), null);
});

test('the plan view may itself start away from the yard origin', () => {
  const views = [plan({ originFt: { x: 2, y: 2 }, extentFt: { width: 12, height: 25 } })];
  assert.deepEqual(resolveYardBounds(views), {
    x: { min: 2, max: 14 },
    y: { min: 2, max: 27 },
  });
});

test('a view that overlaps the plan nowhere is reported, not silently dropped', () => {
  // example-frontyard's shape: its west elevation runs along y 0..14.35 while
  // the plan starts at y 14.83, so the two miss each other by half a foot. The
  // bounds fall back to the plan — a drag needs some bound — but that leaves a
  // view able to draw none of the shared yard, with nothing saying so.
  const views = [
    { id: 'plan', type: 'plan', originFt: { x: 0, y: 14.83 }, extentFt: { width: 30, height: 30 } },
    {
      id: 'west',
      type: 'elevation',
      viewFrom: 'east',
      originFt: { x: 0, y: 0 },
      extentFt: { width: 14.35, height: 10 },
    },
  ];
  const conflicts = resolveYardConflicts(views);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].id, 'west');
  assert.equal(conflicts[0].axis, 'y');
  assert.deepEqual(conflicts[0].viewCovers, { min: 0, max: 14.35 });

  // The bounds themselves still answer, so a drag is still clamped to something.
  assert.deepEqual(resolveYardBounds(views).y, { min: 14.83, max: 44.83 });
});

test('views that do overlap raise nothing, however narrowly', () => {
  const overlapping = [
    { id: 'plan', type: 'plan', originFt: { x: 0, y: 0 }, extentFt: { width: 30, height: 30 } },
    {
      id: 'west',
      type: 'elevation',
      viewFrom: 'east',
      originFt: { x: 29.9 },
      extentFt: { width: 5, height: 10 },
    },
  ];
  assert.deepEqual(resolveYardConflicts(overlapping), []);
  // Touching end to end is not overlapping: there is no yard in both.
  const touching = [
    overlapping[0],
    { ...overlapping[1], originFt: { x: 30 }, extentFt: { width: 5, height: 10 } },
  ];
  assert.equal(resolveYardConflicts(touching).length, 1);
  // And a project with no plan has no shared yard to disagree with.
  assert.deepEqual(resolveYardConflicts([overlapping[1]]), []);
});
