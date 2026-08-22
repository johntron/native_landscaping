import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDocument } from './helpers/fakeDom.js';
import {
  buildOverlayGeometry,
  chooseGridStepFt,
  clearSetupOverlay,
  pickCamera,
  renderSetupOverlay,
  resolveCameraDrag,
} from '../src/render/setupOverlay.js';
import { VIEW_FROM_DIRECTIONS } from '../src/render/elevationOrientation.js';
import { createViewTransform } from '../src/render/viewTransform.js';

/** A 32 x 22 ft yard with 4 ft of margin, at 20 px/ft — the shape a view is derived into. */
const YARD = { width: 32, depth: 22 };

const PLAN = {
  id: 'plan',
  type: 'plan',
  viewBox: { width: 800, height: 600 },
  originFt: { x: -4, y: -4 },
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

test('a plan draws the yard it covers, and the corner coordinates start from', () => {
  const geometry = buildOverlayGeometry(PLAN, { yardFt: YARD });
  const yard = geometry.guides.find((guide) => guide.id === 'yard');
  // The yard sits inside the panel by the padding the view was derived with:
  // PLAN starts 4 ft before the yard's zero, at 20 px/ft.
  assert.deepEqual([yard.x1, yard.y2], [80, 520]);
  assert.equal(yard.x2 - yard.x1, YARD.width * 20);

  const origin = geometry.guides.find((guide) => guide.id === 'origin');
  assert.equal(origin.orientation, 'point');
  assert.deepEqual([origin.x1, origin.y1], [80, 520]);
});

test('an elevation draws its ground line and the span of yard across it', () => {
  const geometry = buildOverlayGeometry(elevation('east'), { yardFt: YARD });
  const ids = geometry.guides.map((guide) => guide.id).sort();
  assert.deepEqual(ids, ['ground', 'origin', 'yard']);
  // Ground is height zero: 2.5 ft above the bottom at 20 px/ft.
  assert.equal(geometry.guides.find((guide) => guide.id === 'ground').y1, 550);
  // A view from the east looks along y, so it spans the yard's DEPTH.
  const yard = geometry.guides.find((guide) => guide.id === 'yard');
  assert.equal(yard.x2 - yard.x1, YARD.depth * 20);
});

test('renderSetupOverlay draws one removable group of guides', () => {
  const doc = resetDocument();
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  renderSetupOverlay(svg, elevation('west'), { yardFt: YARD });

  assert.equal(svg.querySelectorAll('g[data-setup-overlay]').length, 1);
  // The ground line, plus the yard's span and its origin marker.
  assert.equal(svg.querySelectorAll('line[data-setup-guide]').length, 1);
  assert.equal(svg.querySelectorAll('rect[data-setup-guide]').length, 1);
  assert.equal(svg.querySelectorAll('circle[data-setup-guide]').length, 1);
  assert.ok(svg.querySelectorAll('line[data-setup-grid]').length > 0);
  const readout = svg.querySelectorAll('text[data-setup-readout]')[0];
  assert.match(readout.textContent, /ft/);
  // Anchored top-right, clear of the panel's own scale badge.
  assert.equal(readout.getAttribute('text-anchor'), 'end');
  assert.equal(Number(readout.getAttribute('x')), 792);

  // Rendering twice must not stack two overlays, and clearing removes it.
  renderSetupOverlay(svg, elevation('west'), { yardFt: YARD });
  assert.equal(svg.querySelectorAll('g[data-setup-overlay]').length, 1);
  clearSetupOverlay(svg);
  assert.equal(svg.querySelectorAll('g[data-setup-overlay]').length, 0);
});

test('a plan overlay outlines the yard and names its corner', () => {
  const doc = resetDocument();
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  renderSetupOverlay(svg, { ...PLAN, background: 'img/x.webp' }, { yardFt: YARD });
  assert.equal(svg.querySelectorAll('rect[data-setup-guide]').length, 1);
  assert.equal(svg.querySelectorAll('circle[data-setup-guide="origin"]').length, 1);
});

test('a camera is one object: a line, an arrow off it, and a grip to drag it', () => {
  const doc = resetDocument();
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const north = elevation('north', { id: 'north', viewerAtFt: 20 });
  renderSetupOverlay(svg, PLAN, { yardFt: YARD, views: [north] });

  assert.equal(svg.querySelectorAll('line[data-setup-camera="north"]').length, 1);
  // The arrow grows off the line rather than sitting somewhere near it: the
  // direction and the position were two marks for a while, which is the same
  // fact drawn twice in two places that could disagree.
  const shaft = svg.querySelectorAll('line[data-setup-camera-arrow="north"]')[0];
  const line = svg.querySelectorAll('line[data-setup-camera="north"]')[0];
  assert.equal(shaft.getAttribute('y1'), line.getAttribute('y1'));
  assert.equal(svg.querySelectorAll('polygon[data-setup-camera-head="north"]').length, 1);
  assert.equal(svg.querySelectorAll('circle[data-setup-camera-grip="north"]').length, 1);

  // A view that is only reference draws the camera but offers no grip.
  const other = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  renderSetupOverlay(other, PLAN, { yardFt: YARD, views: [north], interactive: false });
  assert.equal(other.querySelectorAll('line[data-setup-camera="north"]').length, 1);
  assert.equal(other.querySelectorAll('circle[data-setup-camera-grip="north"]').length, 0);
});

test('a camera is grabbable anywhere along its line, and drags along its own axis', () => {
  const north = elevation('north', { id: 'north', viewerAtFt: 20 });
  const east = elevation('east', { id: 'east', viewerAtFt: 10 });
  const geometry = buildOverlayGeometry(PLAN, { yardFt: YARD, views: [north, east] });

  // North's line runs across the drawing at y = 120; far along it horizontally
  // is still on it.
  assert.equal(pickCamera(geometry, { x: 700, y: 122 }, 28)?.id, 'north');
  assert.equal(pickCamera(geometry, { x: 700, y: 400 }, 28), null);
  // East's runs down it, so only the horizontal distance counts.
  assert.equal(pickCamera(geometry, { x: 282, y: 500 }, 28)?.id, 'east');

  // Dragging reports feet on the camera's own depth axis, for its OWN view —
  // not for the plan the gesture happened in.
  const dragged = resolveCameraDrag(PLAN, 'north', { x: 400, y: 200 }, [north, east]);
  assert.equal(dragged.id, 'north');
  // 200 px is 400 px above the bottom of a 600 px drawing starting at -4 ft,
  // which at 20 px/ft is y = 16 ft.
  assert.equal(dragged.viewerAtFt, 16);

  // East runs on x, so the same point solves a different number.
  assert.equal(resolveCameraDrag(PLAN, 'east', { x: 400, y: 200 }, [north, east]).viewerAtFt, 16);
});

test('a camera cannot be dragged from an elevation, or for a view that is gone', () => {
  const north = elevation('north', { id: 'north', viewerAtFt: 20 });
  assert.equal(resolveCameraDrag(elevation('south'), 'north', { x: 1, y: 1 }, [north]), null);
  assert.equal(resolveCameraDrag(PLAN, 'ghost', { x: 1, y: 1 }, [north]), null);
});

test('a plan draws each elevation camera as a line, with the culled yard behind it', () => {
  // 40 x 30 ft at 20 px/ft, starting 4 ft before the yard's zero. Yard y grows
  // UP the drawing, so y = 20 ft is 480 px above the bottom: viewBox y = 120.
  const cameras = buildOverlayGeometry(PLAN, {
    yardFt: YARD,
    views: [
      elevation('north', { id: 'north', viewerAtFt: 20 }),
      elevation('south', { id: 'south', viewerAtFt: 20 }),
    ],
  }).cameras;

  const north = cameras.find((camera) => camera.id === 'north');
  assert.equal(north.orientation, 'horizontal');
  assert.deepEqual(north.line, { x1: 0, y1: 120, x2: 800, y2: 120 });
  // North stands at the HIGH end of y and looks south, so everything above the
  // line — the top of the drawing — is behind it.
  assert.deepEqual(north.culled, { x: 0, y: 0, width: 800, height: 120 });

  // South stands at the low end and culls the other side of the same number.
  const south = cameras.find((camera) => camera.id === 'south');
  assert.deepEqual(south.line, { x1: 0, y1: 120, x2: 800, y2: 120 });
  assert.deepEqual(south.culled, { x: 0, y: 120, width: 800, height: 480 });

  // Each label sits on the side its elevation can still see, never inside the
  // band, where it would read as a caption for the hidden yard.
  assert.ok(north.labelAt.y > north.line.y1);
  assert.ok(south.labelAt.y < south.line.y1);
});

test('east and west run down the drawing and mirror about their number', () => {
  const cameras = buildOverlayGeometry(PLAN, {
    yardFt: YARD,
    views: [
      elevation('east', { id: 'east', viewerAtFt: 10 }),
      elevation('west', { id: 'west', viewerAtFt: 10 }),
    ],
  }).cameras;
  const east = cameras.find((camera) => camera.id === 'east');
  const west = cameras.find((camera) => camera.id === 'west');
  assert.equal(east.orientation, 'vertical');
  assert.deepEqual(east.line, { x1: 280, y1: 0, x2: 280, y2: 600 });
  // East stands at high x; west at low x. Same line, opposite bands.
  assert.deepEqual(east.culled, { x: 280, y: 0, width: 520, height: 600 });
  assert.deepEqual(west.culled, { x: 0, y: 0, width: 280, height: 600 });
  assert.equal(east.labelAt.anchor, 'end');
  assert.equal(west.labelAt.anchor, 'start');
});

test('a camera outside the plan clamps its band to the drawing', () => {
  const [beyond] = buildOverlayGeometry(PLAN, {
    yardFt: YARD,
    views: [elevation('north', { id: 'north', viewerAtFt: 90 })],
  }).cameras;
  // Standing 60 ft past the far edge hides nothing inside the plan, and the
  // band must say that rather than running off into negative pixels.
  assert.deepEqual(beyond.culled, { x: 0, y: 0, width: 800, height: 0 });
});

test('an elevation that names no camera still gets one, but it culls nothing', () => {
  // Something has to be there to pick up, or half the views have no control at
  // all. But absent means cull nothing, and writing the default into the view
  // would silently cull features — see normalizeViewerAt.
  const [ghost] = buildOverlayGeometry(PLAN, {
    yardFt: YARD,
    paddingFt: 4,
    views: [elevation('north')],
  }).cameras;
  assert.equal(ghost.declared, false);
  // North stands past the yard's far side, half a margin out.
  assert.equal(ghost.atFt, YARD.depth + 2);
  assert.deepEqual(buildOverlayGeometry(PLAN, [PLAN]).cameras, []);
  assert.deepEqual(buildOverlayGeometry(PLAN).cameras, []);
  // An elevation has no place to draw one: its depth axis runs into the page,
  // so every point of the picture is at every depth.
  assert.deepEqual(
    buildOverlayGeometry(elevation('north'), [elevation('south', { viewerAtFt: 5 })]).cameras,
    []
  );
});
