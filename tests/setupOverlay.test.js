import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDocument } from './helpers/fakeDom.js';
import {
  buildOverlayGeometry,
  chooseGridStepFt,
  clearSetupOverlay,
  pickHandle,
  renderSetupOverlay,
  resolveHandleDrag,
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
