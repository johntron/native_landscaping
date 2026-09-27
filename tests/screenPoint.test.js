import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMatrix, clientPointToViewBox, matrixScale } from '../src/render/screenPoint.js';

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

test('applyMatrix is the identity when the matrix is', () => {
  assert.deepEqual(applyMatrix(IDENTITY, { x: 12, y: -4 }), { x: 12, y: -4 });
});

test('applyMatrix scales and translates: a screen point becomes a viewBox point', () => {
  // A 20px/ft view offset 5px in x and 3px in y, the shape getScreenCTM().inverse()
  // takes for a plain (unletterboxed) plan: viewBoxPoint = screenPoint / 20 - offset.
  const matrix = { a: 0.05, b: 0, c: 0, d: 0.05, e: -0.25, f: -0.15 };
  const point = applyMatrix(matrix, { x: 100, y: 100 });
  assert.equal(point.x, 4.75);
  assert.equal(point.y, 4.85);
});

test('applyMatrix handles a mirrored axis (negative scale), as an elevation viewFrom north/west uses', () => {
  const matrix = { a: -0.1, b: 0, c: 0, d: 0.1, e: 80, f: 0 };
  assert.deepEqual(applyMatrix(matrix, { x: 100, y: 50 }), { x: 70, y: 5 });
});

test('applyMatrix combines both axes under a skew/rotation term (b, c nonzero)', () => {
  // Not a shape this app currently produces, but the affine form must hold in
  // general so a future CSS transform (e.g. rotation) is not a special case.
  const matrix = { a: 2, b: 1, c: 0, d: 2, e: 0, f: 0 };
  assert.deepEqual(applyMatrix(matrix, { x: 3, y: 5 }), { x: 6, y: 13 });
});

test('matrixScale reads a uniform scale straight off a plain scale matrix', () => {
  assert.equal(matrixScale({ a: 0.05, b: 0, c: 0, d: 0.05, e: 0, f: 0 }), 0.05);
});

test('matrixScale is the same on either axis under `meet` (no rotation), by construction', () => {
  // Letterboxing changes e/f (the offset) and can leave a===d unequal to the
  // OTHER axis's own naive rect-based scale, but never introduces b or c, so
  // matrixScale still reads one honest number off a and b alone.
  const matrix = { a: 0.025, b: 0, c: 0, d: 0.025, e: 40, f: 0 };
  assert.equal(matrixScale(matrix), 0.025);
});

test('matrixScale is the length of the transformed x unit vector, so rotation does not throw it off', () => {
  // A 3-4-5 triangle: hypot(3, 4) = 5.
  assert.equal(matrixScale({ a: 3, b: 4, c: -4, d: 3, e: 0, f: 0 }), 5);
});

/** A DOMMatrix stand-in: just the fields clientPointToViewBox reads. */
function fakeCtm(matrix) {
  return { ...matrix, inverse: () => fakeCtm(invert(matrix)) };
}

/** Invert a 2D affine matrix, for building test fixtures only (screenPoint.js
 * itself never inverts one — it hands that to the browser's own CTM). */
function invert({ a, b, c, d, e, f }) {
  const det = a * d - b * c;
  return {
    a: d / det,
    b: -b / det,
    c: -c / det,
    d: a / det,
    e: (c * f - d * e) / det,
    f: (b * e - a * f) / det,
  };
}

test('clientPointToViewBox maps a screen point through the SVG element\'s own screenCTM', () => {
  // 20 px/ft, viewBox origin at the panel's top-left: forward matrix is a
  // plain scale, so its inverse (what getScreenCTM().inverse() would return)
  // divides back down.
  const svg = { getScreenCTM: () => fakeCtm({ a: 20, b: 0, c: 0, d: 20, e: 0, f: 0 }) };
  const mapped = clientPointToViewBox(svg, 100, 40);
  assert.deepEqual(mapped.point, { x: 5, y: 2 });
  assert.equal(mapped.scaleFactor, 0.05);
});

test('clientPointToViewBox accounts for a letterbox offset a bare rect-based scale cannot see', () => {
  // A viewBox 800x600 (4:3) letterboxed into a screen box 400 wide but 400
  // tall (1:1): `meet` centers it, so the drawing is 400x300 with 50px bars
  // above and below. Forward (viewBox -> screen): scale 0.5, y offset +50.
  const forward = { a: 0.5, b: 0, c: 0, d: 0.5, e: 0, f: 50 };
  const svg = { getScreenCTM: () => fakeCtm(forward) };
  // A screen point in the top letterbox bar (y=10, above the drawing) maps to
  // a NEGATIVE viewBox y — outside the 0..600 box, as it should: a naive
  // `viewBox.height / rect.height` (600/400 = 1.5) with no offset would have
  // placed it at y=15, inside the drawing, off by a full letterbox bar.
  const mapped = clientPointToViewBox(svg, 200, 10);
  assert.equal(mapped.point.x, 400);
  assert.equal(mapped.point.y, -80);
  assert.equal(mapped.scaleFactor, 2);
});

test('clientPointToViewBox returns null when the SVG has no screenCTM yet (unlaid-out/disconnected)', () => {
  assert.equal(clientPointToViewBox({ getScreenCTM: () => null }, 1, 1), null);
  assert.equal(clientPointToViewBox({}, 1, 1), null);
});

test('clientPointToViewBox returns null for a degenerate (non-invertible) CTM rather than propagating NaN', () => {
  // A singular forward matrix (e.g. a panel collapsed to zero size): per the
  // DOMMatrix spec, .inverse() on one of these yields every component as NaN
  // rather than throwing, and NaN would otherwise flow silently into a
  // plant's x/y (clamp() passes NaN through unchanged).
  const svg = { getScreenCTM: () => fakeCtm({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 }) };
  assert.equal(clientPointToViewBox(svg, 10, 10), null);
});
