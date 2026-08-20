import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewTransform } from '../src/render/viewTransform.js';
import {
  elevationAxisToViewBoxX,
  resolveElevationOrientation,
  VIEW_FROM_DIRECTIONS,
} from '../src/render/elevationOrientation.js';
import { INCHES_PER_FOOT } from '../src/constants.js';

// The values projects/backyard/project.json ships today, before any migration.
const LEGACY = {
  pixelsPerInch: 2.25,
  viewBox: { width: 800, height: 600 },
  bottomOffsetPx: 100,
  leftOffsetPx: 80,
  viewFrom: 'east',
};
const LEGACY_PX_PER_FT = LEGACY.pixelsPerInch * INCHES_PER_FOOT; // 27
const legacyToPixels = (feet) => feet * INCHES_PER_FOOT * LEGACY.pixelsPerInch;

/** The migration bead 2 will perform, written out here so the parity test can run today. */
function migrateLegacy({ viewBox, pixelsPerInch, viewFrom, bottomOffsetPx = 0, leftOffsetPx = 0 }) {
  const pxPerFt = pixelsPerInch * INCHES_PER_FOOT;
  const shared = {
    viewBox,
    extentFt: { width: viewBox.width / pxPerFt, height: viewBox.height / pxPerFt },
  };
  if (!viewFrom) {
    return { id: 'plan', type: 'plan', ...shared, originFt: { x: 0, y: 0 } };
  }
  return {
    id: viewFrom,
    type: 'elevation',
    viewFrom,
    ...shared,
    originFt: { x: -leftOffsetPx / pxPerFt, y: -bottomOffsetPx / pxPerFt },
  };
}

const SAMPLE_PLANTS = [
  { x: 0, y: 0 },
  { x: 5, y: 3 },
  { x: 12.5, y: 18.25 },
  { x: 29, y: 21.9 },
];

test('derives pxPerFt from viewBox over extentFt', () => {
  const transform = createViewTransform(migrateLegacy({ ...LEGACY, viewFrom: '' }));
  assert.equal(transform.pxPerFt, LEGACY_PX_PER_FT);
  assert.equal(transform.toPx(2), 54);
  assert.equal(transform.toFeet(54), 2);
});

test('plan parity: migrated backyard values reproduce the current topView formulas', () => {
  const transform = createViewTransform(migrateLegacy({ ...LEGACY, viewFrom: '' }));
  SAMPLE_PLANTS.forEach((plant) => {
    // src/render/topView.js: cx = toPixels(x), cy = viewBox.height - toPixels(y)
    const expected = {
      x: legacyToPixels(plant.x),
      y: LEGACY.viewBox.height - legacyToPixels(plant.y),
    };
    const actual = transform.planToViewBox(plant);
    assert.ok(Math.abs(actual.x - expected.x) < 1e-9, `x for ${JSON.stringify(plant)}`);
    assert.ok(Math.abs(actual.y - expected.y) < 1e-9, `y for ${JSON.stringify(plant)}`);
  });
});

test('plan pixels are the ones a reader can check by hand', () => {
  const transform = createViewTransform(migrateLegacy({ ...LEGACY, viewFrom: '' }));
  const point = transform.planToViewBox({ x: 5, y: 3 });
  assert.equal(point.x, 135); // 5 ft x 27 px/ft
  assert.equal(point.y, 519); // 600 - 3 ft x 27 px/ft
});

test('elevation parity: the east elevation reproduces the current formulas', () => {
  const view = migrateLegacy(LEGACY);
  const transform = createViewTransform(view);
  const { mirrored } = resolveElevationOrientation(LEGACY.viewFrom);

  SAMPLE_PLANTS.forEach((plant) => {
    // src/render/elevationViews.js drives the east elevation off the y axis.
    const expected = elevationAxisToViewBoxX(plant.y, legacyToPixels, {
      mirrored,
      leftOffsetPx: LEGACY.leftOffsetPx,
      viewBoxWidth: LEGACY.viewBox.width,
    });
    assert.ok(Math.abs(transform.axisToX(plant.y) - expected) < 1e-9, `axis ${plant.y}`);
  });

  // groundY = viewBox.height - bottomOffsetPx
  assert.ok(Math.abs(transform.groundY - (LEGACY.viewBox.height - LEGACY.bottomOffsetPx)) < 1e-9);
  assert.equal(Math.round(transform.groundY), 500);
  assert.equal(Math.round(transform.axisToX(5)), 215); // 5 ft x 27 px/ft + 80 px inset
});

test('elevation parity holds for every direction, mirrored or not', () => {
  VIEW_FROM_DIRECTIONS.forEach((viewFrom) => {
    const legacy = { ...LEGACY, viewFrom, leftOffsetPx: 80, bottomOffsetPx: 100 };
    const transform = createViewTransform(migrateLegacy(legacy));
    const { mirrored } = resolveElevationOrientation(viewFrom);
    assert.equal(transform.orientation.viewFrom, viewFrom);

    [0, 4.5, 17, 29].forEach((axisFeet) => {
      const expected = elevationAxisToViewBoxX(axisFeet, legacyToPixels, {
        mirrored,
        leftOffsetPx: legacy.leftOffsetPx,
        viewBoxWidth: legacy.viewBox.width,
      });
      assert.ok(
        Math.abs(transform.axisToX(axisFeet) - expected) < 1e-9,
        `${viewFrom} at ${axisFeet} ft`
      );
    });
  });
});

test('axisToX and xToAxis invert each other, including the mirrored directions', () => {
  VIEW_FROM_DIRECTIONS.forEach((viewFrom) => {
    const transform = createViewTransform({
      id: `${viewFrom}-elevation`,
      type: 'elevation',
      viewFrom,
      viewBox: { width: 800, height: 600 },
      extentFt: { width: 40, height: 30 },
      originFt: { x: -3, y: -2.5 },
    });
    [-3, 0, 11.75, 37].forEach((axisFeet) => {
      const px = transform.axisToX(axisFeet);
      assert.ok(Math.abs(transform.xToAxis(px) - axisFeet) < 1e-9, `${viewFrom} at ${axisFeet} ft`);
    });
    // originFt.x is the axis value at the NEAR edge, which mirroring moves to the right.
    const nearEdgeX = transform.orientation.mirrored ? 800 : 0;
    assert.ok(Math.abs(transform.xToAxis(nearEdgeX) - -3) < 1e-9, `${viewFrom} near edge`);
    // Ground height 0 sits 2.5 ft x 20 px/ft above the bottom edge.
    assert.equal(transform.groundY, 550);
    assert.equal(transform.heightToY(6), 430);
    assert.equal(transform.yToHeight(430), 6);
  });
});

test('a detail crop is a plan view with a non-zero origin and a smaller extent', () => {
  const crop = createViewTransform({
    id: 'shade-bed',
    type: 'plan',
    viewBox: { width: 600, height: 450 },
    originFt: { x: 4, y: 9 },
    extentFt: { width: 8, height: 6 },
  });
  assert.equal(crop.pxPerFt, 75);
  // The origin lands on the bottom-left corner.
  assert.deepEqual(crop.planToViewBox({ x: 4, y: 9 }), { x: 0, y: 450 });
  // The far corner lands on the top-right corner.
  assert.deepEqual(crop.planToViewBox({ x: 12, y: 15 }), { x: 600, y: 0 });
  assert.deepEqual(crop.planToViewBox({ x: 6, y: 10 }), { x: 150, y: 375 });
  assert.deepEqual(crop.viewBoxToPlan({ x: 150, y: 375 }), { x: 6, y: 10 });
});

test('plan and elevation mappings refuse to serve the wrong view type', () => {
  const plan = createViewTransform({
    id: 'plan',
    type: 'plan',
    viewBox: { width: 800, height: 600 },
    originFt: { x: 0, y: 0 },
    extentFt: { width: 40, height: 30 },
  });
  assert.throws(() => plan.axisToX(1), /"plan" is a plan/);
  assert.throws(() => plan.xToAxis(1), /"plan" is a plan/);

  const elevation = createViewTransform({
    id: 'east',
    type: 'elevation',
    viewFrom: 'east',
    viewBox: { width: 800, height: 600 },
    originFt: { x: 0, y: 0 },
    extentFt: { width: 40, height: 30 },
  });
  assert.throws(() => elevation.planToViewBox({ x: 1, y: 1 }), /"east" is an elevation/);
  assert.throws(() => elevation.viewBoxToPlan({ x: 1, y: 1 }), /"east" is an elevation/);
});

test('a non-uniformly scaled view is rejected, but rounded feet are tolerated', () => {
  assert.throws(
    () =>
      createViewTransform({
        id: 'stretched',
        type: 'plan',
        viewBox: { width: 800, height: 600 },
        originFt: { x: 0, y: 0 },
        extentFt: { width: 40, height: 20 },
      }),
    /non-uniformly scaled/
  );

  // The extents a setup panel would write out, rounded to two decimals.
  const rounded = createViewTransform({
    id: 'rounded',
    type: 'plan',
    viewBox: { width: 800, height: 600 },
    originFt: { x: 0, y: 0 },
    extentFt: { width: 29.63, height: 22.22 },
  });
  assert.ok(Math.abs(rounded.pxPerFt - 27) < 0.01);
});

test('malformed views fail loudly', () => {
  assert.throws(() => createViewTransform(null), /requires a view object/);
  assert.throws(
    () => createViewTransform({ id: 'mystery', viewBox: {}, extentFt: {} }),
    /unknown type/
  );
  assert.throws(
    () =>
      createViewTransform({
        id: 'flat',
        type: 'plan',
        viewBox: { width: 800, height: 0 },
        extentFt: { width: 40, height: 30 },
      }),
    /viewBox must have positive width and height/
  );
  assert.throws(
    () =>
      createViewTransform({
        id: 'nowhere',
        type: 'elevation',
        viewFrom: 'up',
        viewBox: { width: 800, height: 600 },
        extentFt: { width: 40, height: 30 },
      }),
    /Unknown elevation viewFrom/
  );
});

// The inverse direction is what the drag controllers use, so pin it to the
// legacy pointer math rather than trusting a round trip through axisToX.

/** src/interaction/dragController.js: buildPointerContext.positionFeet */
function legacyPositionFeet(viewBoxX, viewBoxY) {
  return {
    x: viewBoxX / (INCHES_PER_FOOT * LEGACY.pixelsPerInch),
    y: (LEGACY.viewBox.height - viewBoxY) / (INCHES_PER_FOOT * LEGACY.pixelsPerInch),
  };
}

/** src/interaction/dragController.js: pointerAxisFeet */
function legacyPointerAxisFeet(viewBoxX, mirrored) {
  const offsetFeet = LEGACY.leftOffsetPx / (INCHES_PER_FOOT * LEGACY.pixelsPerInch);
  const widthFt = LEGACY.viewBox.width / (INCHES_PER_FOOT * LEGACY.pixelsPerInch);
  const posX = legacyPositionFeet(viewBoxX, 0).x;
  return (mirrored ? widthFt - posX : posX) - offsetFeet;
}

const SAMPLE_VIEWBOX_X = [0, 215, 400, 800];

test('viewBoxToPlan parity: it reproduces the drag controller pointer mapping', () => {
  const transform = createViewTransform(migrateLegacy({ ...LEGACY, viewFrom: '' }));
  SAMPLE_VIEWBOX_X.forEach((viewBoxX) => {
    [0, 137, 519, 600].forEach((viewBoxY) => {
      const expected = legacyPositionFeet(viewBoxX, viewBoxY);
      const actual = transform.viewBoxToPlan({ x: viewBoxX, y: viewBoxY });
      assert.ok(Math.abs(actual.x - expected.x) < 1e-9, `x at ${viewBoxX}`);
      assert.ok(Math.abs(actual.y - expected.y) < 1e-9, `y at ${viewBoxY}`);
    });
  });
});

test('xToAxis parity: it reproduces pointerAxisFeet for every direction', () => {
  VIEW_FROM_DIRECTIONS.forEach((viewFrom) => {
    const transform = createViewTransform(migrateLegacy({ ...LEGACY, viewFrom }));
    const { mirrored } = resolveElevationOrientation(viewFrom);
    SAMPLE_VIEWBOX_X.forEach((viewBoxX) => {
      const expected = legacyPointerAxisFeet(viewBoxX, mirrored);
      assert.ok(
        Math.abs(transform.xToAxis(viewBoxX) - expected) < 1e-9,
        `${viewFrom} at ${viewBoxX}px`
      );
    });
  });
});
