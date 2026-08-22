import test from 'node:test';
import assert from 'node:assert/strict';
import {
  placementToCssBackground,
  resolvePhotoPlacement,
} from '../src/render/photoPlacement.js';

/** A panel covering 40 x 30 ft of yard at 20 px/ft. */
const PLAN = {
  id: 'plan',
  type: 'plan',
  viewBox: { width: 800, height: 600 },
  originFt: { x: 0, y: 0 },
  extentFt: { width: 40, height: 30 },
  background: 'img/plan.webp',
};

/** A photo covering 8 x 6 ft of that yard, its SW corner at (4, 9). */
const SMALL_PHOTO = { originFt: { x: 4, y: 9 }, extentFt: { width: 8, height: 6 } };

const close = (actual, expected, what) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual} !== ${expected}`);

test('a placed photo lands on the drawing pixels its rectangle covers', () => {
  const { path, rect } = resolvePhotoPlacement({ ...PLAN, photoFt: SMALL_PHOTO });
  assert.equal(path, 'img/plan.webp');
  close(rect.x, 80, 'x');
  close(rect.width, 160, 'width');
  // Plan y grows north but drawing y grows down, so the photo's TOP edge is its
  // NORTH edge: 30 - (9 + 6) = 15 ft down from the panel's top.
  close(rect.y, 300, 'y');
  close(rect.height, 120, 'height');
});

test('CSS position divides by the leftover travel, not the panel', () => {
  const { rect } = resolvePhotoPlacement({ ...PLAN, photoFt: SMALL_PHOTO });
  const css = placementToCssBackground(rect, PLAN.viewBox);
  assert.equal(css.backgroundSize, '20% 20%');
  // 80 / (800 - 160) = 12.5%; 300 / (600 - 120) = 62.5%.
  assert.equal(css.backgroundPosition, '12.5% 62.5%');
});

/**
 * The case the old crop-only version could not express. A photo covering more
 * yard than the panel shows is LARGER than the panel, so the travel is
 * negative and the percentage that lands it correctly is outside 0–100 —
 * legal in CSS, and the only way to say "centred, overflowing both sides".
 */
test('a photo bigger than its panel positions outside 0–100%', () => {
  const { rect } = resolvePhotoPlacement({
    ...PLAN,
    photoFt: { originFt: { x: -20, y: -15 }, extentFt: { width: 80, height: 60 } },
  });
  close(rect.x, -400, 'x');
  close(rect.width, 1600, 'width');
  const css = placementToCssBackground(rect, PLAN.viewBox);
  assert.equal(css.backgroundSize, '200% 200%');
  // -400 / (800 - 1600) = 50% — dead centre, hanging off both edges.
  assert.equal(css.backgroundPosition, '50% 50%');
});

test('a photo the size of its panel has no travel to divide by', () => {
  const { rect } = resolvePhotoPlacement({
    ...PLAN,
    photoFt: { originFt: { x: 0, y: 0 }, extentFt: { width: 40, height: 30 } },
  });
  const css = placementToCssBackground(rect, PLAN.viewBox);
  assert.equal(css.backgroundSize, '100% 100%');
  assert.equal(css.backgroundPosition, '0% 0%');
});

test('a full-width photo pans vertically only', () => {
  const { rect } = resolvePhotoPlacement({
    ...PLAN,
    photoFt: { originFt: { x: 0, y: 9 }, extentFt: { width: 40, height: 6 } },
  });
  const css = placementToCssBackground(rect, PLAN.viewBox);
  assert.equal(css.backgroundSize, '100% 20%');
  // No horizontal travel — 0% is the right answer, not merely the safe one.
  assert.equal(css.backgroundPosition, '0% 62.5%');
});

test('a mirrored elevation places its photo from the other side', () => {
  const north = {
    id: 'north',
    type: 'elevation',
    viewFrom: 'north',
    viewBox: { width: 800, height: 600 },
    originFt: { x: 0, y: 0 },
    extentFt: { width: 40, height: 30 },
    background: 'img/north.webp',
    photoFt: SMALL_PHOTO,
  };
  const { rect } = resolvePhotoPlacement(north);
  // Looking south the axis runs right-to-left, so 4..12 ft sits at 560..720 px
  // of an 800 px drawing, not at 80..240 as a subtraction in feet would say.
  close(rect.x, 560, 'x');
  close(rect.width, 160, 'width');
});

test('an unmirrored elevation places from the low end of the axis', () => {
  const south = {
    id: 'south',
    type: 'elevation',
    viewFrom: 'south',
    viewBox: { width: 800, height: 600 },
    originFt: { x: 0, y: 0 },
    extentFt: { width: 40, height: 30 },
    background: 'img/south.webp',
    photoFt: SMALL_PHOTO,
  };
  const { rect } = resolvePhotoPlacement(south);
  close(rect.x, 80, 'x');
  close(rect.width, 160, 'width');
});

test('an uncalibrated photo simply fills its panel', () => {
  const resolved = resolvePhotoPlacement(PLAN);
  assert.equal(resolved.path, 'img/plan.webp');
  assert.equal(resolved.rect, null);
});

test('a view with no image draws nothing', () => {
  const resolved = resolvePhotoPlacement({ ...PLAN, background: null, photoFt: SMALL_PHOTO });
  assert.equal(resolved.path, null);
  assert.equal(resolved.rect, null);
});

test('a degenerate placement falls back to filling the panel', () => {
  const resolved = resolvePhotoPlacement({
    ...PLAN,
    photoFt: { originFt: { x: 4, y: 9 }, extentFt: { width: 0, height: 6 } },
  });
  assert.equal(resolved.rect, null);
});

test('placementToCssBackground tolerates a missing or degenerate rect', () => {
  assert.equal(placementToCssBackground(null, PLAN.viewBox), null);
  assert.equal(placementToCssBackground({ x: 0, y: 0, width: 0, height: 1 }, PLAN.viewBox), null);
  assert.equal(placementToCssBackground({ x: 0, y: 0, width: 1, height: 1 }, null), null);
});
