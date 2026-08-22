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

test('a camera stops the yard at the observer, on the axis it stands on', () => {
  // South and east stand at the LOW end of their depth axis, so the yard
  // starts at them; north and west stand at the high end and it ends there.
  assert.deepEqual(resolveYardBounds(project([elevation('south', { viewerAtFt: 4 })])).y, {
    min: 4,
    max: 30,
  });
  assert.deepEqual(resolveYardBounds(project([elevation('north', { viewerAtFt: 4 })])).y, {
    min: 0,
    max: 4,
  });
  assert.deepEqual(resolveYardBounds(project([elevation('east', { viewerAtFt: 30 })])).x, {
    min: 0,
    max: 30,
  });
  assert.deepEqual(resolveYardBounds(project([elevation('west', { viewerAtFt: 30 })])).x, {
    min: 30,
    max: 40,
  });
});

test('zero is a real camera position, not an absent one', () => {
  // A truthiness test would drop it, and the yard would keep a strip of ground
  // the elevation cannot draw.
  // North caps y at its camera, which is zero — an empty range, so the fallback
  // hands back the whole yard rather than an inverted one.
  const bounds = resolveYardBounds(project([elevation('north', { viewerAtFt: 0 })]));
  assert.deepEqual(bounds.y, { min: 0, max: 30 });
  // But a camera one foot in does cap it, which a truthiness test would also
  // have done — the distinguishing case is that zero was *considered*.
  assert.deepEqual(resolveYardBounds(project([elevation('north', { viewerAtFt: 1 })])).y, {
    min: 0,
    max: 1,
  });
});

test('an elevation with no camera narrows nothing', () => {
  assert.deepEqual(resolveYardBounds(project([elevation('south')])), resolveYardBounds(project()));
});

test('cameras that leave no yard at all fall back to the whole yard', () => {
  // One camera at each end of y, facing each other: the intersection is empty,
  // and clamping a drag to an inverted range gives whichever endpoint the
  // comparison happens to hit. A drag needs some bound, so it gets the yard.
  const facing = project([
    elevation('south', { viewerAtFt: 20 }),
    elevation('north', { viewerAtFt: 5 }),
  ]);
  assert.deepEqual(resolveYardBounds(facing).y, { min: 0, max: 30 });
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
