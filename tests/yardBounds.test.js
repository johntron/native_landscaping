import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeYardBounds,
  resolveYardBounds,
  resolveYardConflicts,
} from '../src/render/yardBounds.js';

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

test('the shared yard names the view holding each edge it does not share with the plan', () => {
  // The gesture this guards: reframing the plan and leaving the elevations in
  // the old coordinate frame. Nothing on the canvas shows the yard shrinking,
  // so Setup mode reads this out on every edit.
  const views = [
    plan(),
    elevation('south', { originFt: { x: 3, y: 0 }, extentFt: { width: 25, height: 30 } }),
    elevation('east', { extentFt: { width: 18, height: 30 } }),
  ];
  const summary = describeYardBounds(views);
  assert.deepEqual(summary.plan, { x: { min: 0, max: 40 }, y: { min: 0, max: 30 } });
  assert.deepEqual(summary.bounds, { x: { min: 3, max: 28 }, y: { min: 0, max: 18 } });
  assert.deepEqual(summary.limits, {
    // South runs along x and holds both of its edges; east runs along y and
    // only caps the far one, since its near edge is the plan's own.
    x: { min: 'south', max: 'south' },
    y: { min: null, max: 'east' },
  });
  assert.deepEqual(summary.conflicts, []);
});

test('a yard the elevations do not narrow at all names nobody', () => {
  const summary = describeYardBounds([plan(), elevation('south'), elevation('east')]);
  assert.deepEqual(summary.bounds, summary.plan);
  assert.deepEqual(summary.limits, {
    x: { min: null, max: null },
    y: { min: null, max: null },
  });
});

test('a conflicting axis blames no view for the bound it fell back to', () => {
  // example-frontyard's shape before the fix: west ran along y 0..14.35 while
  // the plan started at 14.83. The bounds fall back to the plan, so the y edges
  // are the plan's own — reporting west as their author would be a lie about a
  // view that in fact draws none of the yard.
  const views = [
    plan({ originFt: { x: 0, y: 14.83 }, extentFt: { width: 30, height: 30 } }),
    elevation('east', { originFt: { x: 0, y: 0 }, extentFt: { width: 14.35, height: 10 } }),
  ];
  const summary = describeYardBounds(views);
  assert.equal(summary.conflicts.length, 1);
  assert.equal(summary.conflicts[0].id, 'east');
  assert.deepEqual(summary.bounds.y, { min: 14.83, max: 44.83 });
  assert.deepEqual(summary.limits.y, { min: null, max: null });
});

test('a project with no plan view describes no yard', () => {
  assert.equal(describeYardBounds([elevation('south')]), null);
  assert.equal(describeYardBounds(null), null);
});

test("example-frontyard's own numbers name the views that cap its yard", () => {
  // Inlined, never read from projects/: every shipped project is editable in
  // the running app, so a Setup save would break a test that read one. These
  // are the numbers the yard was repaired to — the plan reframed to the origin
  // its elevations and its traced features were always authored against.
  const views = [
    plan({ originFt: { x: 0, y: 0 }, extentFt: { width: 29.89246441279738, height: 30.30767881773445 } }),
    elevation('north', { originFt: { x: 0, y: -7.1365343829237 }, extentFt: { width: 10.627009489616261, height: 15.940514234424391 } }),
    elevation('east', { id: 'west', originFt: { x: 0, y: -3.196864496043244 }, extentFt: { width: 14.348976216425921, height: 10.331262875826663 } }),
    elevation('south', { id: 'view', originFt: { x: 0, y: 0 }, extentFt: { width: 9.37205123677835, height: 7.029038427583763 } }),
  ];
  const summary = describeYardBounds(views);
  assert.deepEqual(summary.conflicts, []);
  // South is the shorter of the two x-axis views, so it — not north — caps x.
  assert.deepEqual(summary.limits.x, { min: null, max: 'view' });
  assert.deepEqual(summary.limits.y, { min: null, max: 'west' });
  assert.equal(summary.bounds.x.max, 9.37205123677835);
  assert.equal(summary.bounds.y.max, 14.348976216425921);
});

test("an elevation's camera position closes the depth axis behind it", () => {
  // A plant is never culled from a view — that is the whole premise — so the
  // yard stops at the observer instead. South stands at low y and looks north,
  // so it cuts the FAR side of nothing and the near side at 4.
  assert.deepEqual(resolveYardBounds([plan(), elevation('south', { viewerAtFt: 4 })]).y, {
    min: 4,
    max: 30,
  });
  // North stands at high y looking south, so the same number cuts the other end.
  assert.deepEqual(resolveYardBounds([plan(), elevation('north', { viewerAtFt: 4 })]).y, {
    min: 0,
    max: 4,
  });
  // east/west run on the depth axis x, and mirror the same way.
  assert.deepEqual(resolveYardBounds([plan(), elevation('east', { viewerAtFt: 30 })]).x, {
    min: 0,
    max: 30,
  });
  assert.deepEqual(resolveYardBounds([plan(), elevation('west', { viewerAtFt: 30 })]).x, {
    min: 30,
    max: 40,
  });
});

test('an elevation that names no camera leaves the depth axis alone', () => {
  // Every project predating the field. The axis narrowing still applies.
  const views = [plan(), elevation('south', { extentFt: { width: 25, height: 30 } })];
  assert.deepEqual(resolveYardBounds(views), {
    x: { min: 0, max: 25 },
    y: { min: 0, max: 30 },
  });
});

test('the shared yard names the view whose camera caps a depth edge', () => {
  const views = [plan(), elevation('north', { viewerAtFt: 22 })];
  const summary = describeYardBounds(views);
  assert.deepEqual(summary.bounds.y, { min: 0, max: 22 });
  assert.deepEqual(summary.limits.y, { min: null, max: 'north' });
  // Its own axis is the full plan width, so it caps nothing there.
  assert.deepEqual(summary.limits.x, { min: null, max: null });
});
