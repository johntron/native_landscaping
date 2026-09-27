import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewTransform } from '../src/render/viewTransform.js';
import { visiblePlanCenterFt } from '../src/render/visiblePlanCenter.js';

// A 20ft x 10ft plan drawn 200x100 CSS px on screen, at (0, 0): 10 px/ft, no
// letterboxing (the module's documented assumption outside of a maximized
// phone view).
const transform = createViewTransform({
  id: 'plan',
  type: 'plan',
  viewBox: { width: 200, height: 100 },
  extentFt: { width: 20, height: 10 },
  originFt: { x: 0, y: 0 },
});
const svgRect = { left: 0, top: 0, width: 200, height: 100 };

test('the whole SVG visible: the centre is the plan middle', () => {
  const viewportRect = { left: 0, top: 0, width: 800, height: 600 };
  assert.deepEqual(visiblePlanCenterFt(svgRect, viewportRect, transform), { x: 10, y: 5 });
});

test('only the top of the SVG is on screen: the centre is in the north half', () => {
  // Yard y increases north, and pixel y increases downward, so a viewport
  // that only shows the TOP of the drawing (small pixel y) must report a
  // HIGH y in feet — this is the assertion that would catch a missed y-flip.
  const viewportRect = { left: 0, top: 0, width: 800, height: 40 };
  const center = visiblePlanCenterFt(svgRect, viewportRect, transform);
  assert.ok(center.y > 5, `expected the north half (y > 5), got ${center.y}`);
  assert.equal(center.x, 10);
});

test('only the bottom of the SVG is on screen: the centre is in the south half', () => {
  const viewportRect = { left: 0, top: 60, width: 800, height: 600 };
  const center = visiblePlanCenterFt(svgRect, viewportRect, transform);
  assert.ok(center.y < 5, `expected the south half (y < 5), got ${center.y}`);
});

test('only the left of the SVG is on screen: the centre is west', () => {
  const viewportRect = { left: 0, top: 0, width: 60, height: 600 };
  const center = visiblePlanCenterFt(svgRect, viewportRect, transform);
  assert.ok(center.x < 10, `expected the west half (x < 10), got ${center.x}`);
});

test('a visual viewport offset by a pinch zoom is honoured', () => {
  // window.visualViewport.offsetLeft/offsetTop are in the same CSS-px frame
  // as getBoundingClientRect(), so this is only a rectangle intersection, not
  // a coordinate-space conversion.
  const viewportRect = { left: 50, top: 0, width: 60, height: 600 };
  const center = visiblePlanCenterFt(svgRect, viewportRect, transform);
  // Visible slice of the SVG is x in [50, 110] of 200 -> feet [5, 11], centre 8.
  assert.equal(center.x, 8);
});

test('no overlap between the SVG and the viewport: null', () => {
  assert.equal(visiblePlanCenterFt(svgRect, { left: 500, top: 0, width: 100, height: 100 }, transform), null);
  assert.equal(visiblePlanCenterFt(svgRect, { left: 0, top: 500, width: 100, height: 100 }, transform), null);
});

test('a zero-size SVG or viewport rect: null', () => {
  assert.equal(visiblePlanCenterFt({ left: 0, top: 0, width: 0, height: 100 }, { left: 0, top: 0, width: 800, height: 600 }, transform), null);
  assert.equal(visiblePlanCenterFt(svgRect, { left: 0, top: 0, width: 0, height: 600 }, transform), null);
  assert.equal(visiblePlanCenterFt(svgRect, null, transform), null);
  assert.equal(visiblePlanCenterFt(null, { left: 0, top: 0, width: 800, height: 600 }, transform), null);
});

test('an SVG offset on the page maps through its own rect, not the origin', () => {
  const offsetRect = { left: 300, top: 150, width: 200, height: 100 };
  const viewportRect = { left: 0, top: 0, width: 1200, height: 800 };
  assert.deepEqual(visiblePlanCenterFt(offsetRect, viewportRect, transform), { x: 10, y: 5 });
});
