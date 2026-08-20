import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDocument } from './helpers/fakeDom.js';
import {
  MIN_RULER_PIXELS,
  buildOverlayGeometry,
  chooseGridStepFt,
  clearSetupOverlay,
  measureRuler,
  pickHandle,
  renderSetupOverlay,
  resolveHandleDrag,
  resolveRulerCalibration,
} from '../src/render/setupOverlay.js';
import { VIEW_FROM_DIRECTIONS } from '../src/render/elevationOrientation.js';

const PLAN = {
  id: 'plan',
  type: 'plan',
  viewBox: { width: 800, height: 600 },
  originFt: { x: 0, y: 0 },
  extentFt: { width: 40, height: 30 }, // 20 px/ft
};

function elevation(viewFrom, overrides = {}) {
  return {
    id: viewFrom,
    type: 'elevation',
    viewFrom,
    viewBox: { width: 800, height: 600 },
    originFt: { x: -3, y: -2.5 },
    extentFt: { width: 40, height: 30 },
    ...overrides,
  };
}

test('grid spacing grows coarser as the view zooms out', () => {
  // A step is picked so lines stay at least ~45px apart.
  assert.equal(chooseGridStepFt(100), 0.5);
  assert.equal(chooseGridStepFt(20), 5);
  assert.equal(chooseGridStepFt(2), 50);
});

test('grid lines land on whole yard feet, not on the view corner', () => {
  const geometry = buildOverlayGeometry({ ...PLAN, originFt: { x: 3, y: 1 } });
  const verticals = geometry.gridLines.filter((line) => line.orientation === 'vertical');
  // With a 5 ft step and an origin at 3 ft, the first line is the 5 ft mark.
  assert.equal(verticals[0].feet, 5);
  assert.ok(verticals.every((line) => line.feet % geometry.stepFt === 0));
  // 5 ft is 2 ft past the left edge, at 20 px/ft.
  assert.equal(verticals[0].x1, 40);
});

test('a plan view carries eight handles on the edges it can be resized from', () => {
  const geometry = buildOverlayGeometry(PLAN);
  assert.deepEqual(
    geometry.handles.map((handle) => handle.id).sort(),
    ['max-max', 'max-mid', 'max-min', 'mid-max', 'mid-min', 'min-max', 'min-mid', 'min-min']
  );
  // Yard y grows up, so the y-minimum handle sits at the bottom of the drawing.
  const bottomLeft = geometry.handles.find((handle) => handle.id === 'min-min');
  assert.deepEqual([bottomLeft.x, bottomLeft.y], [0, 600]);
  const topRight = geometry.handles.find((handle) => handle.id === 'max-max');
  assert.deepEqual([topRight.x, topRight.y], [800, 0]);
});

test('a resize carries the drawing with it, so the view stays uniformly scaled', () => {
  // 45 ft of yard at the view's unchanged 20 px/ft is a 900 px drawing. Leaving
  // viewBox at 800 would be 20 px/ft across and 20 px/ft down over 45x30 ft —
  // the non-uniform view createViewTransform refuses to build.
  const wider = resolveHandleDrag(PLAN, 'max-mid', { x: 900, y: 300 });
  assert.deepEqual(wider.viewBox, { width: 900, height: 600 });
  assert.doesNotThrow(() => buildOverlayGeometry({ ...PLAN, ...wider }));
  assert.equal(buildOverlayGeometry({ ...PLAN, ...wider }).transform.pxPerFt, 20);
});

test('dragging an edge handle moves that edge and leaves the opposite one alone', () => {
  // Right edge out to 900px: 45 ft of yard at 20 px/ft.
  const wider = resolveHandleDrag(PLAN, 'max-mid', { x: 900, y: 300 });
  assert.deepEqual(wider.originFt, { x: 0, y: 0 });
  assert.equal(wider.extentFt.width, 45);
  assert.equal(wider.extentFt.height, 30);

  // Left edge in to 200px: the right edge stays at 40 ft.
  const narrower = resolveHandleDrag(PLAN, 'min-mid', { x: 200, y: 300 });
  assert.equal(narrower.originFt.x, 10);
  assert.equal(narrower.extentFt.width, 30);
  assert.equal(narrower.originFt.x + narrower.extentFt.width, 40);
});

test('an edge cannot be dragged through its opposite', () => {
  const collapsed = resolveHandleDrag(PLAN, 'min-mid', { x: 100000, y: 300 });
  assert.ok(collapsed.extentFt.width >= 0.5, 'keeps a usable extent');
  assert.ok(collapsed.originFt.x < collapsed.originFt.x + collapsed.extentFt.width);
});

test('an elevation shows a ground line and a near-edge line', () => {
  const geometry = buildOverlayGeometry(elevation('east'));
  const ids = geometry.guides.map((guide) => guide.id).sort();
  assert.deepEqual(ids, ['ground', 'near-edge']);
  // Ground is height zero: 2.5 ft above the bottom at 20 px/ft.
  const ground = geometry.guides.find((guide) => guide.id === 'ground');
  assert.equal(ground.y1, 550);
  assert.match(geometry.readout.text, /ground -2\.5 ft/);
});

test('the near edge follows the mirror, and dragging it reads the same in every direction', () => {
  VIEW_FROM_DIRECTIONS.forEach((viewFrom) => {
    const view = elevation(viewFrom);
    const geometry = buildOverlayGeometry(view);
    const near = geometry.guides.find((guide) => guide.id === 'near-edge');
    const mirrored = geometry.transform.orientation.mirrored;
    // originFt.x is the NEAR edge, which mirroring puts on the right.
    assert.equal(near.x1, mirrored ? 800 : 0, `${viewFrom} near edge`);

    // Dragging 100px inward is 5 ft inward whichever side that is.
    const inward = mirrored ? 700 : 100;
    const dragged = resolveHandleDrag(view, 'near-edge', { x: inward, y: 300 });
    assert.ok(Math.abs(dragged.originFt.x - 2) < 1e-9, `${viewFrom} dragged inward`);
  });
});

test('dragging the ground line moves height zero to the pointer', () => {
  const view = elevation('south');
  const dragged = resolveHandleDrag(view, 'ground', { x: 400, y: 500 });
  // Ground at 500px is 100px above the bottom, so height zero sits at -5 ft.
  assert.equal(dragged.originFt.y, -5);
  // Moving the ground does not resize the view.
  assert.deepEqual(dragged.viewBox, view.viewBox);
  // Re-deriving from the patched view puts the line where the pointer was.
  const after = buildOverlayGeometry({ ...view, ...dragged });
  assert.equal(after.guides.find((guide) => guide.id === 'ground').y1, 500);
});

test('a line guide is grabbable anywhere along it, a corner only near itself', () => {
  const geometry = buildOverlayGeometry(elevation('south'));
  // Far along the ground line horizontally, but on it vertically.
  assert.equal(pickHandle(geometry, { x: 40, y: 550 }, 28)?.id, 'ground');
  // Well below it: no grab.
  assert.equal(pickHandle(geometry, { x: 40, y: 300 }, 28), null);

  const plan = buildOverlayGeometry(PLAN);
  assert.equal(pickHandle(plan, { x: 5, y: 595 }, 28)?.id, 'min-min');
  assert.equal(pickHandle(plan, { x: 400, y: 300 }, 28), null);
});

test('renderSetupOverlay draws one removable group of guides', () => {
  const doc = resetDocument();
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  renderSetupOverlay(svg, elevation('west'));

  assert.equal(svg.querySelectorAll('g[data-setup-overlay]').length, 1);
  assert.equal(svg.querySelectorAll('line[data-setup-guide]').length, 2);
  assert.equal(svg.querySelectorAll('circle[data-setup-handle]').length, 2);
  assert.ok(svg.querySelectorAll('line[data-setup-grid]').length > 0);
  const readout = svg.querySelectorAll('text[data-setup-readout]')[0];
  assert.match(readout.textContent, /ft/);
  // Anchored top-right, clear of the panel's own scale badge.
  assert.equal(readout.getAttribute('text-anchor'), 'end');
  assert.equal(Number(readout.getAttribute('x')), 792);

  // Rendering twice must not stack two overlays, and clearing removes it.
  renderSetupOverlay(svg, elevation('west'));
  assert.equal(svg.querySelectorAll('g[data-setup-overlay]').length, 1);
  clearSetupOverlay(svg);
  assert.equal(svg.querySelectorAll('g[data-setup-overlay]').length, 0);
});

test('a plan overlay outlines the rect it covers', () => {
  const doc = resetDocument();
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  renderSetupOverlay(svg, PLAN);
  assert.equal(svg.querySelectorAll('rect[data-setup-guide]').length, 1);
  assert.equal(svg.querySelectorAll('circle[data-setup-handle]').length, 8);
});

test('the ruler reads a drag in the feet the view currently claims', () => {
  // 200 px at 20 px/ft, measured on the diagonal of a 120-160 triangle.
  const measured = measureRuler(PLAN, { x: 40, y: 30 }, { x: 200, y: 150 });
  assert.equal(measured.pixels, 200);
  assert.equal(measured.feet, 10);
  assert.equal(measured.pxPerFt, 20);
});

test('calibrating to a longer real length stretches the yard the photo covers', () => {
  // The span the drag crossed reads as 10 ft; the user says it is really 20.
  const patch = resolveRulerCalibration(PLAN, { x: 0, y: 0 }, { x: 200, y: 0 }, 20);
  assert.equal(patch.extentFt.width, 80);
  assert.equal(patch.extentFt.height, 60);
  // Resolution is held, so the drawing grows with the extent — the photo fills
  // whatever box it is given, so this is a visual no-op.
  assert.equal(patch.viewBox.width / patch.extentFt.width, 20);
  // A plan's origin IS its bottom-left corner, so it sits on the same pixel at
  // any scale and must not move.
  assert.deepEqual(patch.originFt, { x: 0, y: 0 });
});

test('calibration is uniform: the same span solves the same however it is drawn', () => {
  const across = resolveRulerCalibration(PLAN, { x: 10, y: 500 }, { x: 210, y: 500 }, 8);
  const diagonal = resolveRulerCalibration(PLAN, { x: 0, y: 0 }, { x: 120, y: 160 }, 8);
  assert.deepEqual(diagonal.extentFt, across.extentFt);
});

test('calibrating a mirrored elevation keeps its near edge and ground on the photo', () => {
  const view = elevation('north'); // north and west are the mirrored directions
  const before = buildOverlayGeometry(view);
  const patch = resolveRulerCalibration(view, { x: 100, y: 100 }, { x: 300, y: 100 }, 5);
  // 200 px read as 10 ft and are really 5, so the view covers half as much yard.
  assert.equal(patch.extentFt.width, 20);
  const after = buildOverlayGeometry({ ...view, ...patch });

  // The near edge is the right-hand side on a mirrored elevation. Both it and
  // the ground line have to stay on the same fraction of the photo, or
  // calibrating would slide the guides off the features they were placed on.
  assert.equal(before.transform.axisToX(before.transform.originFt.x) / before.transform.viewBox.width, 1);
  assert.equal(after.transform.axisToX(after.transform.originFt.x) / after.transform.viewBox.width, 1);
  assert.equal(
    round(before.transform.groundY / before.transform.viewBox.height),
    round(after.transform.groundY / after.transform.viewBox.height)
  );
  // The ground still means height zero; it is the feet that rescaled.
  assert.equal(after.transform.originFt.y, -1.25);
});

test('a misclick or a nonsense length solves to nothing at all', () => {
  const tiny = { x: MIN_RULER_PIXELS - 1, y: 0 };
  assert.equal(resolveRulerCalibration(PLAN, { x: 0, y: 0 }, tiny, 10), null);
  assert.equal(resolveRulerCalibration(PLAN, { x: 0, y: 0 }, { x: 0, y: 0 }, 10), null);
  [0, -4, Number.NaN, 'twelve'].forEach((length) => {
    assert.equal(resolveRulerCalibration(PLAN, { x: 0, y: 0 }, { x: 200, y: 0 }, length), null);
  });
});

test('renderSetupOverlay draws the measuring segment only when there is one', () => {
  const doc = resetDocument();
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  renderSetupOverlay(svg, PLAN);
  assert.equal(svg.querySelectorAll('line[data-setup-ruler]').length, 0);

  renderSetupOverlay(svg, PLAN, { from: { x: 0, y: 0 }, to: { x: 200, y: 0 } });
  assert.equal(svg.querySelectorAll('line[data-setup-ruler]').length, 1);
  assert.equal(svg.querySelectorAll('circle[data-setup-ruler-end]').length, 2);
  assert.match(svg.querySelectorAll('text[data-setup-ruler-readout]')[0].textContent, /10 ft/);
});

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}
