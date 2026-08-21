import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFeatures } from '../src/data/featureConfig.js';
import {
  projectFeature,
  projectFeatureToElevation,
  projectFeatureToPlan,
} from '../src/render/featureProjection.js';
import { createViewTransform } from '../src/render/viewTransform.js';
import { VIEW_FROM_DIRECTIONS } from '../src/render/elevationOrientation.js';

// A 40 x 30 ft yard at 20 px/ft. Elevations along the x axis are 40 ft wide,
// those along y are 30 ft wide; both stand 20 ft tall.
const PLAN = {
  id: 'plan',
  type: 'plan',
  viewBox: { width: 800, height: 600 },
  originFt: { x: 0, y: 0 },
  extentFt: { width: 40, height: 30 },
};

function elevation(viewFrom, overrides = {}) {
  const alongX = viewFrom === 'south' || viewFrom === 'north';
  return createViewTransform({
    id: viewFrom,
    type: 'elevation',
    viewFrom,
    viewBox: { width: alongX ? 800 : 600, height: 400 },
    originFt: { x: 0, y: 0 },
    extentFt: { width: alongX ? 40 : 30, height: 20 },
    ...overrides,
  });
}

/** One 16 x 8 ft house, 10 ft tall, sitting square in the middle of the yard. */
const HOUSE = feature({
  id: 'house',
  type: 'box',
  footprintFt: [
    { x: 8, y: 12 },
    { x: 24, y: 12 },
    { x: 24, y: 20 },
    { x: 8, y: 20 },
  ],
  heightFt: 10,
});

const FENCE = feature({
  id: 'fence',
  type: 'wall',
  pathFt: [
    { x: 4, y: 26 },
    { x: 36, y: 26 },
  ],
  heightFt: 6,
  style: { strokeWidthFt: 0.25 },
});

const DRIVEWAY = feature({
  id: 'driveway',
  type: 'surface',
  footprintFt: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 24 },
    { x: 0, y: 24 },
  ],
});

/** Normalize the fixture so the projection sees exactly what the loader produces. */
function feature(raw) {
  return normalizeFeatures({ features: [raw] }, 'backyard').features[0];
}

test('a plan gets the footprint itself, vertex by vertex', () => {
  const projected = projectFeatureToPlan(HOUSE, createViewTransform(PLAN));
  assert.equal(projected.id, 'house');
  assert.equal(projected.closed, true);
  // Yard y grows north and viewBox y grows down, so the low-y edge is the tall one.
  assert.deepEqual(projected.points, [
    { x: 160, y: 360 },
    { x: 480, y: 360 },
    { x: 480, y: 200 },
    { x: 160, y: 200 },
  ]);
  // Stroke is authored in feet so a rescaled view keeps the feature's weight.
  assert.equal(projected.strokeWidthPx, 0.15 * 20);
});

test('a wall stays an open path in plan; nothing else does', () => {
  assert.equal(projectFeatureToPlan(FENCE, createViewTransform(PLAN)).closed, false);
  assert.equal(projectFeatureToPlan(DRIVEWAY, createViewTransform(PLAN)).closed, true);
  assert.deepEqual(projectFeatureToPlan(FENCE, createViewTransform(PLAN)).points, [
    { x: 80, y: 80 },
    { x: 720, y: 80 },
  ]);
});

test('an elevation flattens the footprint onto its horizontal axis', () => {
  const south = projectFeatureToElevation(HOUSE, elevation('south'));
  // x 8..24 ft at 20 px/ft, extruded from the ground line to 10 ft.
  assert.deepEqual(
    { x: south.x, y: south.y, width: south.width, height: south.height },
    { x: 160, y: 200, width: 320, height: 200 }
  );
  // Looking north, the far edge is the high-y side.
  assert.deepEqual(south.depthFt, { min: 12, max: 20, far: 20, near: 12 });

  // Standing east, the y axis runs across the drawing instead.
  const east = projectFeatureToElevation(HOUSE, elevation('east'));
  assert.deepEqual(
    { x: east.x, y: east.y, width: east.width, height: east.height },
    { x: 240, y: 200, width: 160, height: 200 }
  );
  assert.deepEqual(east.depthFt, { min: 8, max: 24, far: 8, near: 24 });
});

test('the mirrored directions land where the compass says, not merely opposite', () => {
  // Pinned independently of south/east so a mistake shared by both sides of a
  // pair cannot hide inside the mirror assertion below.
  const north = projectFeatureToElevation(HOUSE, elevation('north'));
  assert.equal(north.x, 320); // x 8..24 ft measured in from the right edge
  assert.equal(north.width, 320);

  const west = projectFeatureToElevation(HOUSE, elevation('west'));
  assert.equal(west.x, 200); // y 12..20 ft measured in from the right edge
  assert.equal(west.width, 160);
});

test('the mirrored directions reflect the silhouette and swap near for far', () => {
  const pairs = [
    ['south', 'north'],
    ['east', 'west'],
  ];
  pairs.forEach(([direct, mirrored]) => {
    const a = projectFeatureToElevation(HOUSE, elevation(direct));
    const b = projectFeatureToElevation(HOUSE, elevation(mirrored));
    const viewBoxWidth = elevation(direct).viewBox.width;

    // Same yard, same silhouette — walked around to the other side.
    assert.equal(b.width, a.width, `${mirrored} width`);
    assert.equal(b.height, a.height, `${mirrored} height`);
    assert.equal(b.y, a.y, `${mirrored} top`);
    assert.equal(b.x, viewBoxWidth - (a.x + a.width), `${mirrored} left edge`);

    // Depth extent is unchanged; which end of it is nearest is not.
    assert.deepEqual({ min: b.depthFt.min, max: b.depthFt.max }, { min: a.depthFt.min, max: a.depthFt.max });
    assert.equal(b.depthFt.near, a.depthFt.far, `${mirrored} near`);
    assert.equal(b.depthFt.far, a.depthFt.near, `${mirrored} far`);
  });
});

test('every direction puts the silhouette inside the drawing, the right way round', () => {
  VIEW_FROM_DIRECTIONS.forEach((viewFrom) => {
    const transform = elevation(viewFrom);
    const projected = projectFeatureToElevation(HOUSE, transform);
    assert.ok(projected.width > 0, `${viewFrom} has a positive width`);
    assert.ok(projected.x >= 0, `${viewFrom} starts inside the viewBox`);
    assert.ok(
      projected.x + projected.width <= transform.viewBox.width,
      `${viewFrom} ends inside the viewBox`
    );
    // A feature stands on the same ground line the plants do.
    assert.equal(projected.y + projected.height, transform.groundY, `${viewFrom} ground line`);
  });
});

test('baseFt lifts a feature off the ground without changing its height', () => {
  const planter = feature({
    id: 'planter',
    type: 'box',
    footprintFt: [
      { x: 8, y: 12 },
      { x: 24, y: 12 },
      { x: 24, y: 20 },
      { x: 8, y: 20 },
    ],
    baseFt: 2,
    heightFt: 3,
  });
  const projected = projectFeatureToElevation(planter, elevation('south'));
  assert.equal(projected.height, 3 * 20);
  assert.equal(projected.y, 400 - 5 * 20); // its top is 5 ft above the ground
  assert.equal(projected.y + projected.height, 400 - 2 * 20);
});

test('a surface is flat against the ground line, not a rectangle with a height', () => {
  const projected = projectFeatureToElevation(DRIVEWAY, elevation('south'));
  assert.equal(projected.height, 0);
  assert.equal(projected.y, elevation('south').groundY);
  // It still has a real depth extent, which is what an elevation sorts on.
  assert.deepEqual(projected.depthFt, { min: 0, max: 24, far: 24, near: 0 });
});

test('a wall seen end-on is a zero-width silhouette, not a missing one', () => {
  // The fence runs east-west, so from the east it is edge-on: no width at all.
  const east = projectFeatureToElevation(FENCE, elevation('east'));
  assert.equal(east.width, 0);
  assert.equal(east.x, 26 * 20);
  assert.equal(east.height, 6 * 20);
  // It still spans the whole yard in depth, and is drawn at its stroke weight.
  assert.deepEqual(east.depthFt, { min: 4, max: 36, far: 4, near: 36 });
  assert.equal(east.strokeWidthPx, 0.25 * 20);

  // Turned ninety degrees, the same fence is the full width of the drawing.
  assert.equal(projectFeatureToElevation(FENCE, elevation('south')).width, 32 * 20);
});

test('an offset origin moves the feature with the view, not against it', () => {
  // The view starts 5 ft before the yard's zero and its ground line sits 2 ft up.
  const offset = elevation('south', { originFt: { x: -5, y: -2 } });
  const projected = projectFeatureToElevation(HOUSE, offset);
  assert.equal(projected.x, 160 + 5 * 20);
  assert.equal(projected.y + projected.height, offset.groundY);

  // Mirrored, the same inset is measured from the other edge.
  const mirrored = elevation('north', { originFt: { x: -5, y: -2 } });
  const north = projectFeatureToElevation(HOUSE, mirrored);
  assert.equal(north.x + north.width, 800 - 160 - 5 * 20);
});

test('projectFeature dispatches on the view it is given', () => {
  assert.deepEqual(
    projectFeature(HOUSE, createViewTransform(PLAN)),
    projectFeatureToPlan(HOUSE, createViewTransform(PLAN))
  );
  assert.deepEqual(
    projectFeature(HOUSE, elevation('west')),
    projectFeatureToElevation(HOUSE, elevation('west'))
  );
});

test('a feature with no geometry to project says so', () => {
  assert.throws(
    () => projectFeatureToElevation(HOUSE, createViewTransform(PLAN)),
    /is a plan; project its features into the plan/
  );
  assert.throws(
    () => projectFeatureToPlan({ id: 'ghost', type: 'box' }, createViewTransform(PLAN)),
    /no footprintFt to project/
  );
  assert.throws(
    () => projectFeatureToPlan({ id: 'ghost', type: 'wall', pathFt: [] }, createViewTransform(PLAN)),
    /no pathFt to project/
  );
});
