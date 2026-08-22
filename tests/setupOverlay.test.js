import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDocument } from './helpers/fakeDom.js';
import {
  MIN_RULER_PIXELS,
  buildOverlayGeometry,
  chooseGridStepFt,
  clearSetupOverlay,
  measureRuler,
  renderSetupOverlay,
  resolvePhotoDrag,
  resolveRulerCalibration,
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

test('dragging the photo moves it by the drag, in every compass direction', () => {
  VIEW_FROM_DIRECTIONS.forEach((viewFrom) => {
    const view = elevation(viewFrom, { background: 'img/x.webp' });
    const mirrored = buildOverlayGeometry(view).transform.orientation.mirrored;
    // 100 px to the right of the drawing is 5 ft along the axis — or 5 ft
    // BACK along it, on a mirrored view, which is the whole reason this is
    // solved in feet rather than pixels.
    const dragged = resolvePhotoDrag(view, { x: 300, y: 300 }, { x: 400, y: 300 });
    const expected = view.originFt.x + (mirrored ? -5 : 5);
    assert.ok(
      Math.abs(dragged.photoFt.originFt.x - expected) < 1e-9,
      `${viewFrom}: ${dragged.photoFt.originFt.x} !== ${expected}`
    );
    // Dragging never rescales.
    assert.deepEqual(dragged.photoFt.extentFt, view.extentFt);
  });
});

test('dragging the photo up the drawing raises it in feet', () => {
  const view = elevation('south', { background: 'img/x.webp' });
  // 100 px up the drawing at 20 px/ft is 5 ft higher, because drawing y grows
  // down and yard height grows up.
  const dragged = resolvePhotoDrag(view, { x: 400, y: 400 }, { x: 400, y: 300 });
  assert.ok(Math.abs(dragged.photoFt.originFt.y - (view.originFt.y + 5)) < 1e-9);
});

test('an uncalibrated photo starts from the panel it fills', () => {
  const view = { ...PLAN, background: 'img/x.webp' };
  const dragged = resolvePhotoDrag(view, { x: 0, y: 0 }, { x: 200, y: 0 });
  // No photoFt yet, so the drag starts from the rectangle the photo is
  // currently drawn over — the panel — and moves it 10 ft east.
  assert.deepEqual(dragged.photoFt.extentFt, PLAN.extentFt);
  assert.ok(Math.abs(dragged.photoFt.originFt.x - (PLAN.originFt.x + 10)) < 1e-9);
});

test('there is nothing to drag on a view with no photo', () => {
  assert.equal(resolvePhotoDrag(PLAN, { x: 0, y: 0 }, { x: 10, y: 0 }), null);
});

test('renderSetupOverlay draws one removable group of guides', () => {
  const doc = resetDocument();
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  renderSetupOverlay(svg, elevation('west'), null, { yardFt: YARD });

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
  renderSetupOverlay(svg, elevation('west'), null, { yardFt: YARD });
  assert.equal(svg.querySelectorAll('g[data-setup-overlay]').length, 1);
  clearSetupOverlay(svg);
  assert.equal(svg.querySelectorAll('g[data-setup-overlay]').length, 0);
});

test('a plan overlay outlines the yard, and the photo it is being lined up with', () => {
  const doc = resetDocument();
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  renderSetupOverlay(svg, { ...PLAN, background: 'img/x.webp' }, null, { yardFt: YARD });
  assert.equal(svg.querySelectorAll('rect[data-setup-guide]').length, 1);
  assert.equal(svg.querySelectorAll('circle[data-setup-guide]').length, 1);
  // The photo's own edge, so a picture smaller than the panel does not read as
  // a panel that failed to load.
  assert.equal(svg.querySelectorAll('rect[data-setup-photo]').length, 1);

  // A neighbouring view is reference, not a target: no photo outline there.
  const other = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  renderSetupOverlay(other, { ...PLAN, background: 'img/x.webp' }, null, {
    yardFt: YARD,
    interactive: false,
  });
  assert.equal(other.querySelectorAll('rect[data-setup-photo]').length, 0);
});

test('the ruler reads a drag in the feet the view currently claims', () => {
  // 200 px at 20 px/ft, measured on the diagonal of a 120-160 triangle.
  const measured = measureRuler(PLAN, { x: 40, y: 30 }, { x: 200, y: 150 });
  assert.equal(measured.pixels, 200);
  assert.equal(measured.feet, 10);
  assert.equal(measured.pxPerFt, 20);
});

test('a photo measured too small is scaled up, and the drawing does not move', () => {
  const view = { ...PLAN, background: 'img/x.webp' };
  // The span the drag crossed reads as 10 ft; the user says it is really 20,
  // so the photo is half the size it should be.
  const patch = resolveRulerCalibration(view, { x: 0, y: 0 }, { x: 200, y: 0 }, 20);
  assert.equal(patch.photoFt.extentFt.width, 80);
  assert.equal(patch.photoFt.extentFt.height, 60);
  // The view is the yard, and the yard was never what was wrong.
  assert.equal('extentFt' in patch, false);
  assert.equal('viewBox' in patch, false);
});

test('the measured span stays under the pointer while the photo scales', () => {
  const view = { ...PLAN, background: 'img/x.webp' };
  // Midpoint of the drag is 200 px across, which is 6 ft east of the yard's
  // zero at 20 px/ft on a panel starting at -4 ft.
  const patch = resolveRulerCalibration(view, { x: 100, y: 300 }, { x: 300, y: 300 }, 20);
  const after = { ...view, photoFt: patch.photoFt };
  const held = 6;
  // Same view either way — what moved is the photo, so the held foot is still
  // drawn at the same pixel.
  assert.equal(
    createViewTransform(view).planToViewBox({ x: held, y: 0 }).x,
    createViewTransform(after).planToViewBox({ x: held, y: 0 }).x
  );
  // And that foot is still the same fraction along the photo, which is what
  // "the thing you measured did not move" means once the photo has rescaled.
  const fraction = (held - patch.photoFt.originFt.x) / patch.photoFt.extentFt.width;
  assert.ok(Math.abs(fraction - (held - PLAN.originFt.x) / PLAN.extentFt.width) < 1e-9);
});

test('calibration is uniform: the same span solves the same however it is drawn', () => {
  const view = { ...PLAN, background: 'img/x.webp' };
  const across = resolveRulerCalibration(view, { x: 10, y: 500 }, { x: 210, y: 500 }, 8);
  const diagonal = resolveRulerCalibration(view, { x: 0, y: 0 }, { x: 120, y: 160 }, 8);
  assert.deepEqual(diagonal.photoFt.extentFt, across.photoFt.extentFt);
});

test('calibrating a mirrored elevation scales its photo the same way', () => {
  const view = elevation('north', { background: 'img/x.webp' }); // north and west mirror
  const patch = resolveRulerCalibration(view, { x: 100, y: 100 }, { x: 300, y: 100 }, 5);
  // 200 px read as 10 ft and are really 5, so the photo covers half as much yard.
  assert.equal(patch.photoFt.extentFt.width, 20);
  // Held about the measurement's midpoint, which on a mirrored view is a
  // *decreasing* axis value to the right — solved in feet, so it comes out
  // right without a mirror case here.
  const midFt = createViewTransform(view).xToAxis(200);
  const fractionOf = (origin, extent) => (midFt - origin) / extent;
  assert.ok(
    Math.abs(
      fractionOf(patch.photoFt.originFt.x, patch.photoFt.extentFt.width) -
        fractionOf(view.originFt.x, view.extentFt.width)
    ) < 1e-9
  );
});

test('a misclick or a nonsense length solves to nothing at all', () => {
  const view = { ...PLAN, background: 'img/x.webp' };
  const tiny = { x: MIN_RULER_PIXELS - 1, y: 0 };
  assert.equal(resolveRulerCalibration(view, { x: 0, y: 0 }, tiny, 10), null);
  assert.equal(resolveRulerCalibration(view, { x: 0, y: 0 }, { x: 0, y: 0 }, 10), null);
  [0, -4, Number.NaN, 'twelve'].forEach((length) => {
    assert.equal(resolveRulerCalibration(view, { x: 0, y: 0 }, { x: 200, y: 0 }, length), null);
  });
  // Nothing to scale without a photo.
  assert.equal(resolveRulerCalibration(PLAN, { x: 0, y: 0 }, { x: 200, y: 0 }, 10), null);
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

test('a photo drag and a ruler solve return patches, never rebuilt views', () => {
  // app.js applies these with { ...view, ...patch }, so anything a view carries
  // that the solve does not name survives. nl-jqd was filed for the opposite —
  // a Setup edit rebuilding a view and dropping originFt on the way — so the
  // shape of the return value is the invariant, not an implementation detail.
  const view = {
    id: 'north',
    type: 'elevation',
    viewFrom: 'north',
    viewBox: { width: 800, height: 400 },
    originFt: { x: 0, y: -2 },
    extentFt: { width: 40, height: 20 },
    background: 'img/x.webp',
    viewerAtFt: 21,
  };
  const KEYS = ['photoFt'];
  assert.deepEqual(
    Object.keys(resolvePhotoDrag(view, { x: 0, y: 0 }, { x: 100, y: 300 })).sort(),
    [...KEYS].sort()
  );
  assert.deepEqual(
    Object.keys(resolveRulerCalibration(view, { x: 0, y: 0 }, { x: 200, y: 0 }, 5)).sort(),
    [...KEYS].sort()
  );
  // Which means the camera position is neither dropped nor rescaled: it is a
  // yard coordinate, not an offset anchored to the drawing.
  assert.equal(
    { ...view, ...resolvePhotoDrag(view, { x: 0, y: 0 }, { x: 100, y: 200 }) }.viewerAtFt,
    21
  );
  assert.equal(
    { ...view, ...resolveRulerCalibration(view, { x: 0, y: 0 }, { x: 200, y: 0 }, 5) }.viewerAtFt,
    21
  );
});

test('a plan draws each elevation camera as a line, with the culled yard behind it', () => {
  // 40 x 30 ft at 20 px/ft, starting 4 ft before the yard's zero. Yard y grows
  // UP the drawing, so y = 20 ft is 480 px above the bottom: viewBox y = 120.
  const cameras = buildOverlayGeometry(PLAN, {
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
    views: [elevation('north', { id: 'north', viewerAtFt: 90 })],
  }).cameras;
  // Standing 60 ft past the far edge hides nothing inside the plan, and the
  // band must say that rather than running off into negative pixels.
  assert.deepEqual(beyond.culled, { x: 0, y: 0, width: 800, height: 0 });
});

test('only an elevation that names a camera draws one', () => {
  assert.deepEqual(buildOverlayGeometry(PLAN, { views: [elevation('north')] }).cameras, []);
  assert.deepEqual(buildOverlayGeometry(PLAN, [PLAN]).cameras, []);
  assert.deepEqual(buildOverlayGeometry(PLAN).cameras, []);
  // An elevation has no place to draw one: its depth axis runs into the page,
  // so every point of the picture is at every depth.
  assert.deepEqual(
    buildOverlayGeometry(elevation('north'), [elevation('south', { viewerAtFt: 5 })]).cameras,
    []
  );
});
