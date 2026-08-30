import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveYardBounds } from '../src/render/yardBounds.js';

const YARD = { width: 40, depth: 30 };

const elevation = (viewFrom, overrides = {}) => ({
  id: viewFrom,
  type: 'elevation',
  viewFrom,
  ...overrides,
});

const project = (views = []) => ({ yardFt: YARD, views });

test('the yard is the declared yard', () => {
  assert.deepEqual(resolveYardBounds(project()), {
    x: { min: 0, max: 40 },
    y: { min: 0, max: 30 },
  });
});

/**
 * The old model derived the yard from whatever the views happened to overlap,
 * so an elevation reframed on its own could shrink it — or wipe it out. There
 * is nothing left to shrink it with: every view covers the yard by
 * construction, and a view that misses it is not expressible.
 */
test('no arrangement of views can narrow the yard', () => {
  const views = [
    { id: 'plan', type: 'plan' },
    elevation('south'),
    elevation('east'),
    elevation('north'),
    elevation('west'),
  ];
  assert.deepEqual(resolveYardBounds(project(views)), resolveYardBounds(project()));
});

/**
 * A camera position used to stop the yard at the observer, on the axis it
 * stands on — removed because plants are never culled by a camera
 * (elevationOrder.js's isBehindViewer only ever culls features), so the
 * narrowing bought nothing but a smaller buildable area. Two cameras facing
 * each other, as on the Walkway project, could squeeze it to a sliver.
 */
test('a camera narrows nothing, on any axis, at any position', () => {
  const withCameras = project([
    elevation('south', { viewerAtFt: 4 }),
    elevation('north', { viewerAtFt: 0 }),
    elevation('east', { viewerAtFt: 30 }),
    elevation('west', { viewerAtFt: 30 }),
  ]);
  assert.deepEqual(resolveYardBounds(withCameras), resolveYardBounds(project()));
});

test('an unknown compass direction is skipped rather than throwing', () => {
  assert.deepEqual(
    resolveYardBounds(project([elevation('sideways', { viewerAtFt: 4 })])),
    resolveYardBounds(project())
  );
});

test('without a yard there is nothing to clamp to', () => {
  assert.equal(resolveYardBounds({ views: [] }), null);
  assert.equal(resolveYardBounds({ yardFt: { width: 0, depth: 10 }, views: [] }), null);
  assert.equal(resolveYardBounds(null), null);
});
