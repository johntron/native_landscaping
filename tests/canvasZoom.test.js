import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FIT_STATE,
  MAX_ZOOM,
  MIN_ZOOM,
  clampScale,
  clampTranslateAxis,
  clampZoomState,
  isAtFit,
  panBy,
  pinchUpdate,
  zoomAbout,
} from '../src/render/canvasZoom.js';

// A 300x400 container whose content already fits it exactly at scale 1 (the
// normal case: styles.css sizes `.view` to its clip box before any zoom).
const BOUNDS = { containerWidth: 300, containerHeight: 400, contentWidth: 300, contentHeight: 400 };

test('clampScale floors at MIN_ZOOM and ceils at MAX_ZOOM', () => {
  assert.equal(clampScale(0.2), MIN_ZOOM);
  assert.equal(clampScale(MIN_ZOOM), MIN_ZOOM);
  assert.equal(clampScale(3), 3);
  assert.equal(clampScale(50), MAX_ZOOM);
});

test('clampScale treats a non-finite scale as MIN_ZOOM rather than propagating NaN', () => {
  assert.equal(clampScale(NaN), MIN_ZOOM);
  assert.equal(clampScale(Infinity), MIN_ZOOM);
});

test('clampTranslateAxis: at scale 1 (content == container), only 0 is legal', () => {
  assert.equal(clampTranslateAxis(40, 1, 300, 300), 0);
  assert.equal(clampTranslateAxis(-40, 1, 300, 300), 0);
  assert.equal(clampTranslateAxis(0, 1, 300, 300), 0);
});

test('clampTranslateAxis: at scale 2, the range is [container - content*scale, 0]', () => {
  // container 300, content 300, scale 2 -> scaled content 600 -> range [-300, 0]
  assert.equal(clampTranslateAxis(0, 2, 300, 300), 0);
  assert.equal(clampTranslateAxis(-300, 2, 300, 300), -300);
  assert.equal(clampTranslateAxis(-500, 2, 300, 300), -300, 'past the left edge clamps back to it');
  assert.equal(clampTranslateAxis(50, 2, 300, 300), 0, 'past the right edge clamps back to it');
  assert.equal(clampTranslateAxis(-150, 2, 300, 300), -150, 'inside the range is left alone');
});

test('clampTranslateAxis centers rather than inverting its range if content is ever smaller than its box', () => {
  // content 200 in a 300-wide container at scale 1: 100px of slack, centered.
  assert.equal(clampTranslateAxis(0, 1, 300, 200), 50);
  assert.equal(clampTranslateAxis(999, 1, 300, 200), 50, 'a requested translate cannot escape the centering');
});

test('clampZoomState clamps scale and both axes together', () => {
  const state = clampZoomState({ scale: 50, tx: -9999, ty: 9999 }, BOUNDS);
  assert.equal(state.scale, MAX_ZOOM);
  // scaled content is 300*6 x 400*6 = 1800x2400; range is [300-1800,0]=[-1500,0] and [400-2400,0]=[-2000,0]
  assert.equal(state.tx, -1500);
  assert.equal(state.ty, 0);
});

test('panBy adds a screen delta at the current scale and clamps', () => {
  const zoomedIn = clampZoomState({ scale: 2, tx: 0, ty: 0 }, BOUNDS);
  const panned = panBy(zoomedIn, -20, -15, BOUNDS);
  assert.equal(panned.tx, -20);
  assert.equal(panned.ty, -15);
  assert.equal(panned.scale, 2, 'panning never changes scale');

  const overPanned = panBy(zoomedIn, -9999, 0, BOUNDS);
  // scale 2, container 300, content 300 -> min tx is 300 - 600 = -300
  assert.equal(overPanned.tx, -300);
});

// These use BOUNDS (container == content at scale 1) rather than a container
// much larger than the content: with room to spare, clampTranslateAxis's own
// centering branch (tested separately above) would swallow the pan/zoom
// result these tests are checking, for a reason that has nothing to do with
// them.
test('zoomAbout keeps the content point under the anchor fixed on screen', () => {
  // At FIT_STATE (scale 1, tx 0, ty 0), the anchor (120, 80) sits over the
  // content-space point (120, 80) too. Zooming to 3x about that same anchor
  // must still show that content point at (120, 80) on screen.
  const next = zoomAbout(FIT_STATE, { x: 120, y: 80 }, 3, BOUNDS);
  assert.equal(next.scale, 3);
  // screen = tx + scale*local -> 120 = tx + 3*120 -> tx = 120 - 360 = -240
  assert.equal(next.tx, -240);
  assert.equal(next.ty, 80 - 3 * 80);
});

test('zoomAbout is reversible: zooming back to 1 at the same anchor returns to FIT_STATE', () => {
  const zoomed = zoomAbout(FIT_STATE, { x: 50, y: 60 }, 4, BOUNDS);
  const back = zoomAbout(zoomed, { x: 50, y: 60 }, 1, BOUNDS);
  // At scale 1 the translate clamp forces (0,0) regardless of the math above
  // (content == container at MIN_ZOOM), which is exactly FIT_STATE.
  assert.deepEqual(back, FIT_STATE);
});

test('pinchUpdate: distance ratio alone (midpoint steady) scales about that midpoint', () => {
  const mid = { x: 150, y: 200 };
  const next = pinchUpdate(FIT_STATE, mid, 100, mid, 250, BOUNDS);
  assert.equal(next.scale, 2.5);
  // The midpoint itself (a content point at FIT_STATE, since scale/translate
  // start at 1/0/0) stays exactly where it was on screen.
  assert.equal(next.tx, 150 - 2.5 * 150);
  assert.equal(next.ty, 200 - 2.5 * 200);
});

test('pinchUpdate: midpoint movement alone (distance steady) is a plain pan, no zoom', () => {
  const start = { scale: 2, tx: -50, ty: -30 }; // already a legal clamped state at scale 2 under BOUNDS
  const startMid = { x: 200, y: 200 };
  const movedMid = { x: 230, y: 180 };
  const next = pinchUpdate(start, startMid, 120, movedMid, 120, BOUNDS);
  assert.equal(next.scale, 2, 'scale is unchanged when the finger separation does not change');
  assert.equal(next.tx, start.tx + 30);
  assert.equal(next.ty, start.ty - 20);
});

test('pinchUpdate clamps the resulting scale and pan to the same bounds as everything else', () => {
  const next = pinchUpdate(FIT_STATE, { x: 0, y: 0 }, 10, { x: 0, y: 0 }, 10000, BOUNDS);
  assert.equal(next.scale, MAX_ZOOM);
});

test('pinchUpdate treats a zero (or negative) starting distance as no zoom change, not a divide-by-zero', () => {
  const bounds = { containerWidth: 1000, containerHeight: 1000, contentWidth: 300, contentHeight: 400 };
  const next = pinchUpdate(FIT_STATE, { x: 10, y: 10 }, 0, { x: 10, y: 10 }, 50, bounds);
  assert.equal(next.scale, MIN_ZOOM);
  assert.ok(Number.isFinite(next.tx) && Number.isFinite(next.ty));
});

test('isAtFit', () => {
  assert.equal(isAtFit(FIT_STATE), true);
  assert.equal(isAtFit({ scale: 1.01, tx: 0, ty: 0 }, 0.001), false);
  assert.equal(isAtFit({ scale: 2, tx: 0, ty: 0 }), false);
});
