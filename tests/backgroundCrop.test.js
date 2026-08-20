import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBackgroundCrop,
  cropToCssBackground,
  resolveViewBackground,
} from '../src/render/backgroundCrop.js';

/** 40 x 30 ft of yard at 20 px/ft. */
const PLAN = {
  id: 'plan',
  type: 'plan',
  viewBox: { width: 800, height: 600 },
  originFt: { x: 0, y: 0 },
  extentFt: { width: 40, height: 30 },
  background: 'img/plan.webp',
};

/** The bead's worked example: a 8 x 6 ft detail whose SW corner is at (4, 9). */
const SHADE_BED = {
  id: 'shade-bed',
  type: 'plan',
  viewBox: { width: 160, height: 120 },
  originFt: { x: 4, y: 9 },
  extentFt: { width: 8, height: 6 },
  backgroundFrom: 'plan',
};

const close = (actual, expected, what) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual} !== ${expected}`);

test('a plan crop is the fraction of the photo its rectangle covers', () => {
  const crop = computeBackgroundCrop(PLAN, SHADE_BED);
  close(crop.x, 4 / 40, 'x');
  close(crop.width, 8 / 40, 'width');
  // Plan y grows north but image y grows down, so the crop's TOP is measured
  // from the plan's north edge: 30 - (9 + 6) = 15 ft down from it.
  close(crop.y, 15 / 30, 'y');
  close(crop.height, 6 / 30, 'height');
});

test('CSS position divides by the leftover travel, not the full extent', () => {
  const css = cropToCssBackground(computeBackgroundCrop(PLAN, SHADE_BED));
  assert.equal(css.backgroundSize, '500% 500%');
  // (4 - 0) / (40 - 8) = 12.5%; 100 - (9 - 0) / (30 - 6) = 62.5%.
  assert.equal(css.backgroundPosition, '12.5% 62.5%');
});

test('a crop the size of its source has no travel to divide by', () => {
  const whole = { ...SHADE_BED, originFt: { x: 0, y: 0 }, extentFt: { width: 40, height: 30 } };
  const css = cropToCssBackground(computeBackgroundCrop(PLAN, whole));
  assert.equal(css.backgroundSize, '100% 100%');
  assert.equal(css.backgroundPosition, '0% 0%');
});

test('a full-width band pans vertically only', () => {
  const band = {
    ...SHADE_BED,
    viewBox: { width: 800, height: 120 },
    originFt: { x: 0, y: 9 },
    extentFt: { width: 40, height: 6 },
  };
  const css = cropToCssBackground(computeBackgroundCrop(PLAN, band));
  assert.equal(css.backgroundSize, '100% 500%');
  // No horizontal travel — 0% is the right answer, not merely the safe one.
  assert.equal(css.backgroundPosition, '0% 62.5%');
});

test('a mirrored elevation crops from the other side of the photo', () => {
  const north = {
    id: 'north',
    type: 'elevation',
    viewFrom: 'north',
    viewBox: { width: 800, height: 600 },
    originFt: { x: 0, y: 0 },
    extentFt: { width: 40, height: 30 },
    background: 'img/north.webp',
  };
  const detail = {
    id: 'north-detail',
    type: 'elevation',
    viewFrom: 'north',
    viewBox: { width: 160, height: 120 },
    originFt: { x: 4, y: 9 },
    extentFt: { width: 8, height: 6 },
    backgroundFrom: 'north',
  };
  const crop = computeBackgroundCrop(north, detail);
  // Looking south, the axis runs right-to-left: 4..12 ft sits at 560..720 px of
  // an 800 px drawing, not at 80..240 as a subtraction in feet would suggest.
  close(crop.x, 0.7, 'x');
  close(crop.width, 0.2, 'width');
});

test('an unmirrored elevation crops from the near side', () => {
  const south = {
    id: 'south',
    type: 'elevation',
    viewFrom: 'south',
    viewBox: { width: 800, height: 600 },
    originFt: { x: 0, y: 0 },
    extentFt: { width: 40, height: 30 },
    background: 'img/south.webp',
  };
  const detail = {
    ...south,
    id: 'south-detail',
    viewBox: { width: 160, height: 120 },
    originFt: { x: 4, y: 9 },
    extentFt: { width: 8, height: 6 },
  };
  const crop = computeBackgroundCrop(south, detail);
  close(crop.x, 0.1, 'x');
  close(crop.width, 0.2, 'width');
});

test('views that look at the yard differently cannot be cropped into each other', () => {
  const elevation = {
    id: 'south',
    type: 'elevation',
    viewFrom: 'south',
    viewBox: { width: 800, height: 600 },
    originFt: { x: 0, y: 0 },
    extentFt: { width: 40, height: 30 },
    background: 'img/south.webp',
  };
  assert.equal(computeBackgroundCrop(elevation, SHADE_BED), null);
  assert.equal(computeBackgroundCrop({ ...elevation, viewFrom: 'north' }, elevation), null);
});

test('resolveViewBackground returns a view’s own image uncropped', () => {
  const resolved = resolveViewBackground([PLAN, SHADE_BED], PLAN);
  assert.equal(resolved.path, 'img/plan.webp');
  assert.equal(resolved.crop, null);
});

test('resolveViewBackground borrows the source image and crops it', () => {
  const resolved = resolveViewBackground([PLAN, SHADE_BED], SHADE_BED);
  assert.equal(resolved.path, 'img/plan.webp');
  close(resolved.crop.width, 0.2, 'width');
});

test('borrowing from a view with no image of its own draws nothing', () => {
  const bare = { ...PLAN, background: null };
  const resolved = resolveViewBackground([bare, SHADE_BED], SHADE_BED);
  assert.equal(resolved.path, null);
  assert.equal(resolved.crop, null);
});

test('cropToCssBackground tolerates a missing or degenerate crop', () => {
  assert.equal(cropToCssBackground(null), null);
  assert.equal(cropToCssBackground({ x: 0, y: 0, width: 0, height: 1 }), null);
});
