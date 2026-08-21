import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFeatures } from '../src/data/featureConfig.js';
import {
  buildFeatureHandles,
  createFeatureShape,
  grabOffsetFor,
  pickFeatureAt,
  pickFeatureHandle,
  reorderFeatures,
  resolveFeatureDrag,
} from '../src/render/featureOverlay.js';
import { createViewTransform } from '../src/render/viewTransform.js';

// 40 x 30 ft of yard at 20 px/ft.
const PLAN = createViewTransform({
  id: 'plan',
  type: 'plan',
  viewBox: { width: 800, height: 600 },
  originFt: { x: 0, y: 0 },
  extentFt: { width: 40, height: 30 },
});

/** A detail callout: 10 x 7.5 ft of the same yard, starting at (20, 15). */
const DETAIL = createViewTransform({
  id: 'detail',
  type: 'plan',
  viewBox: { width: 200, height: 150 },
  originFt: { x: 20, y: 15 },
  extentFt: { width: 10, height: 7.5 },
});

function features(raw) {
  return normalizeFeatures({ features: raw }, 'backyard').features;
}

const BED = {
  id: 'bed',
  type: 'surface',
  footprintFt: [
    { x: 4, y: 4 },
    { x: 12, y: 4 },
    { x: 12, y: 10 },
    { x: 4, y: 10 },
  ],
};

const FENCE = {
  id: 'fence',
  type: 'wall',
  pathFt: [
    { x: 0, y: 20 },
    { x: 30, y: 20 },
  ],
  heightFt: 6,
};

test('a vertex handle sits on its vertex, in viewBox pixels', () => {
  const [bed] = features([BED]);
  const handles = buildFeatureHandles(bed, PLAN);
  assert.equal(handles.length, 4);
  // (4, 4) ft at 20 px/ft, with yard y growing north and viewBox y growing down.
  assert.deepEqual(handles[0], { id: 'vertex:0', index: 0, x: 80, y: 520 });
  assert.equal(buildFeatureHandles(null, PLAN).length, 0);
});

test('the nearest handle wins, not the first one within reach', () => {
  const [bed] = features([BED]);
  const handles = buildFeatureHandles(bed, PLAN);
  // A hit radius generous enough for touch covers more than one corner of a
  // small shape; picking the first would make one corner unreachable.
  const picked = pickFeatureHandle(handles, { x: 235, y: 525 }, 200);
  assert.equal(picked.id, 'vertex:1');
  assert.equal(pickFeatureHandle(handles, { x: 400, y: 100 }, 20), null);
});

test('a click picks the topmost shape under it, and a wall by its path', () => {
  const list = features([BED, FENCE]);
  // Inside the bed: (8, 7) ft.
  assert.equal(pickFeatureAt(list, PLAN, { x: 160, y: 460 }).id, 'bed');
  // A wall has no interior, so it is picked by distance to the line itself.
  assert.equal(pickFeatureAt(list, PLAN, { x: 300, y: 200 }).id, 'fence');
  assert.equal(pickFeatureAt(list, PLAN, { x: 700, y: 100 }), null);

  // Draw order is z-order, so the last shape in the list is the one on top.
  const overlapping = features([BED, { ...BED, id: 'patio', type: 'box', heightFt: 2 }]);
  assert.equal(pickFeatureAt(overlapping, PLAN, { x: 160, y: 460 }).id, 'patio');
});

test('dragging a vertex moves that vertex and nothing else', () => {
  const [bed] = features([BED]);
  const moved = resolveFeatureDrag(bed, 'vertex:2', { x: 15, y: 14 });
  assert.deepEqual(moved.footprintFt[2], { x: 15, y: 14 });
  assert.deepEqual(moved.footprintFt[0], BED.footprintFt[0]);
  // The feature it was handed is untouched: the app has to be able to reject
  // the candidate and keep showing the last good state.
  assert.deepEqual(bed.footprintFt, BED.footprintFt);
  assert.equal(resolveFeatureDrag(bed, 'vertex:9', { x: 0, y: 0 }), null);
});

test('moving a shape keeps it under the pointer where it was grabbed', () => {
  const [bed] = features([BED]);
  // Grabbed at (10, 8) — six feet right and four feet up from the first vertex.
  const offset = grabOffsetFor(bed, { x: 10, y: 8 });
  assert.deepEqual(offset, { x: 6, y: 4 });

  const moved = resolveFeatureDrag(bed, 'move', { x: 20, y: 18 }, offset);
  // The shape translates by the pointer's travel, not by snapping a corner to it.
  assert.deepEqual(moved.footprintFt[0], { x: 14, y: 14 });
  assert.deepEqual(moved.footprintFt[2], { x: 22, y: 20 });
  const width = moved.footprintFt[1].x - moved.footprintFt[0].x;
  assert.equal(width, 8);
});

test('a wall drags by its path, since that is what it is authored with', () => {
  const [fence] = features([FENCE]);
  const moved = resolveFeatureDrag(fence, 'vertex:1', { x: 30, y: 26 });
  assert.deepEqual(moved.pathFt, [{ x: 0, y: 20 }, { x: 30, y: 26 }]);
  assert.equal('footprintFt' in moved, false);
});

test('a drag in a detail crop still writes yard coordinates', () => {
  const [bed] = features([{ ...BED, footprintFt: [
    { x: 21, y: 16 },
    { x: 24, y: 16 },
    { x: 24, y: 19 },
    { x: 21, y: 19 },
  ] }]);
  // The crop starts at (20, 15) ft, so its own origin is not the yard's.
  const handles = buildFeatureHandles(bed, DETAIL);
  assert.deepEqual(handles[0], { id: 'vertex:0', index: 0, x: 20, y: 130 });
  // And a point in the crop's pixels maps back to a yard coordinate.
  assert.deepEqual(DETAIL.viewBoxToPlan({ x: 20, y: 130 }), { x: 21, y: 16 });
});

test('a new shape arrives usable: real size, real height, unique id', () => {
  const surface = createFeatureShape('surface', { x: 20, y: 15 });
  assert.equal(surface.footprintFt.length, 4);
  assert.equal(surface.heightFt, undefined);

  // A wall and a box are given a height here on purpose: normalizeFeatures
  // refuses one without a positive heightFt, and the first frame of a new fence
  // must not be the thing that trips that guard.
  const wall = createFeatureShape('wall', { x: 20, y: 15 });
  assert.ok(wall.heightFt > 0);
  assert.equal(wall.pathFt.length, 2);
  const box = createFeatureShape('box', { x: 20, y: 15 });
  assert.ok(box.heightFt > 0);

  // Every one of them survives the normalizer that guards the live model.
  const normalized = features([surface, wall, box]);
  assert.deepEqual(normalized.map((f) => f.id), ['surface', 'wall', 'box']);

  // Ids do not collide with what is already drawn.
  assert.equal(createFeatureShape('box', { x: 0, y: 0 }, ['box', 'box-2']).id, 'box-3');
});

test('a new shape fits inside the yard EVERY view can draw', () => {
  // The trap: a project whose elevations show a narrow slice has a shared yard
  // far smaller than its plan. A shape sized and placed by the plan then lands
  // wholly off-canvas in every elevation — which is what "I do not see it in
  // the other views" looks like from the outside.
  const bounds = { x: { min: 5, max: 12 }, y: { min: 20, max: 30 } };
  const centre = { x: 8.5, y: 25 };

  const wall = createFeatureShape('wall', centre, [], bounds);
  const wallSpan = wall.pathFt[1].x - wall.pathFt[0].x;
  assert.ok(wallSpan < bounds.x.max - bounds.x.min, 'the wall fits across the yard');
  wall.pathFt.forEach((point) => {
    assert.ok(point.x >= bounds.x.min && point.x <= bounds.x.max, `x ${point.x} inside`);
    assert.ok(point.y >= bounds.y.min && point.y <= bounds.y.max, `y ${point.y} inside`);
  });

  const box = createFeatureShape('box', centre, [], bounds);
  box.footprintFt.forEach((point) => {
    assert.ok(point.x >= bounds.x.min && point.x <= bounds.x.max, `x ${point.x} inside`);
    assert.ok(point.y >= bounds.y.min && point.y <= bounds.y.max, `y ${point.y} inside`);
  });

  // A yard barely wider than nothing still gets a shape with real extent, since
  // a zero-width footprint is not something the normalizer will accept.
  const sliver = createFeatureShape('box', { x: 0, y: 0 }, [], {
    x: { min: -0.1, max: 0.1 },
    y: { min: -0.1, max: 0.1 },
  });
  assert.ok(sliver.footprintFt[1].x - sliver.footprintFt[0].x > 0);
  assert.doesNotThrow(() => features([sliver]));

  // With no bounds at all the defaults stand, which is what a project with no
  // elevations to narrow the yard should get.
  assert.equal(createFeatureShape('wall', centre).pathFt[1].x - centre.x, 6);
});

test('reordering moves a feature through the z-order', () => {
  const list = features([BED, FENCE]);
  assert.deepEqual(reorderFeatures(list, 'fence', -1).map((f) => f.id), ['fence', 'bed']);
  // The ends hold: there is nothing above the top or below the bottom.
  assert.deepEqual(reorderFeatures(list, 'bed', -1).map((f) => f.id), ['bed', 'fence']);
  assert.deepEqual(reorderFeatures(list, 'missing', 1).map((f) => f.id), ['bed', 'fence']);
});
