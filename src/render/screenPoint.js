/**
 * The one client-pixel <-> viewBox-unit authority (this file's counterpart to
 * viewTransform.js, which is the feet <-> pixel one).
 *
 * A pointer/touch event reports a position in CSS pixels on the SCREEN.
 * Turning that into a point in the SVG's own drawing coordinates (its viewBox)
 * used to be done per controller as `viewBox.width / rect.width` and
 * `viewBox.height / rect.height` from `getBoundingClientRect()`. That is only
 * correct when the element's box has exactly the viewBox's own aspect ratio.
 * Once it doesn't — a maximized panel on a phone, clamped to `100%` width or
 * `100dvh` height rather than both — `preserveAspectRatio="xMidYMid meet"`
 * (src/render/viewConfig.js) letterboxes the drawing inside the box, and the
 * rect-based math above ignores both the resulting offset and the fact that
 * only ONE axis's scale is still right. North/south drags came out short and
 * hit-testing aimed at the wrong plant (nl-o47.1).
 *
 * `getScreenCTM()` is the browser's own answer to "user space -> screen
 * pixels", already carrying the viewBox's scale AND origin, the
 * preserveAspectRatio letterbox offset, and any CSS transform on the element
 * or an ancestor (a later bead zooms the canvas that way) — the exact matrix
 * the browser itself hit-tests with. Its inverse is what a client point needs
 * to become a viewBox point, correct under all three at once.
 *
 * The matrix arithmetic is pulled out as pure functions, over a plain
 * `{a,b,c,d,e,f}` (DOMMatrix's own field names for a 2D affine transform), so
 * it is unit-testable in Node with no DOM. `clientPointToViewBox` is the only
 * part that touches `svg`, and it stays thin: read the CTM, invert it, hand
 * the plain numbers to the pure functions below.
 */

/**
 * Apply a 2D affine matrix to a point: `x' = a*x + c*y + e`, `y' = b*x + d*y + f`.
 * @param {{a: number, b: number, c: number, d: number, e: number, f: number}} matrix
 * @param {{x: number, y: number}} point
 * @returns {{x: number, y: number}}
 */
export function applyMatrix(matrix, point) {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f,
  };
}

/**
 * A uniform scale factor read off a matrix: the length of its transformed x
 * unit vector. Under `meet` with no rotation the matrix is a plain scale
 * (`a === d`, `b === c === 0`), so this is just `|a|` — but it stays right if
 * a future CSS transform ever adds rotation, where `a` alone would not be.
 * This is what MIN_HITBOX_RADIUS_PX and similar screen-pixel radii convert
 * through to become viewBox-unit radii.
 * @param {{a: number, b: number, c: number, d: number, e: number, f: number}} matrix
 * @returns {number}
 */
export function matrixScale(matrix) {
  return Math.hypot(matrix.a, matrix.b);
}

/**
 * A client point (event.clientX/clientY, in CSS screen pixels) mapped into
 * `svg`'s own viewBox coordinates, plus the screen-px -> viewBox-unit scale at
 * that point.
 * @param {SVGSVGElement} svg
 * @param {number} clientX
 * @param {number} clientY
 * @returns {{point: {x: number, y: number}, scaleFactor: number}|null} null
 *   before the SVG has a layout box (e.g. it is not yet connected/visible).
 */
export function clientPointToViewBox(svg, clientX, clientY) {
  const screenCtm = svg?.getScreenCTM?.();
  if (!screenCtm) return null;
  const inverse = screenCtm.inverse();
  const matrix = {
    a: inverse.a,
    b: inverse.b,
    c: inverse.c,
    d: inverse.d,
    e: inverse.e,
    f: inverse.f,
  };
  // A non-invertible CTM (e.g. a panel collapsed to zero size) makes
  // DOMMatrix.inverse() return every component as NaN rather than throwing.
  // Left unchecked that NaN flows into a plant's x/y through clamp() (which
  // passes NaN through unchanged) and corrupts it silently on the next save.
  if (!Object.values(matrix).every(Number.isFinite)) return null;
  return {
    point: applyMatrix(matrix, { x: clientX, y: clientY }),
    scaleFactor: matrixScale(matrix),
  };
}
