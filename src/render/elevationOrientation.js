/**
 * Compass geometry for the elevation views.
 *
 * The yard coordinate system has its origin at the SW corner, with x increasing
 * east and y increasing north. An elevation is defined by the compass side the
 * viewer stands on, which determines three things:
 *
 *  - `axisKey`   – which yard axis runs horizontally across the drawing.
 *  - `mirrored`  – whether that axis increases to the left instead of the right.
 *  - `farIsHigh` – whether a larger depth value is farther from the viewer, which
 *                  fixes the back-to-front draw order.
 *
 * Standing to the south and looking north, east (+x) falls on the right and the
 * plants with the smallest y are nearest, so nothing is mirrored and larger y is
 * farther. Walking around to the north flips both: east now falls on the left and
 * the largest y is nearest. The east/west pair works the same way about the y axis.
 */

export const VIEW_FROM_DIRECTIONS = ['south', 'north', 'east', 'west'];

const ORIENTATIONS = {
  // Looking north: x runs left-to-right, the far edge is the high-y (north) side.
  south: { axisKey: 'x', depthKey: 'y', mirrored: false, farIsHigh: true },
  // Looking south: x runs right-to-left, the far edge is the low-y (south) side.
  north: { axisKey: 'x', depthKey: 'y', mirrored: true, farIsHigh: false },
  // Looking west: y runs left-to-right, the far edge is the low-x (west) side.
  east: { axisKey: 'y', depthKey: 'x', mirrored: false, farIsHigh: false },
  // Looking east: y runs right-to-left, the far edge is the high-x (east) side.
  west: { axisKey: 'y', depthKey: 'x', mirrored: true, farIsHigh: true },
};

/**
 * @param {string} viewFrom one of VIEW_FROM_DIRECTIONS
 * @returns {{ viewFrom: string, axisKey: 'x'|'y', depthKey: 'x'|'y', mirrored: boolean, farIsHigh: boolean }}
 */
export function resolveElevationOrientation(viewFrom) {
  const key = String(viewFrom || '').toLowerCase();
  const orientation = ORIENTATIONS[key];
  if (!orientation) {
    throw new Error(
      `Unknown elevation viewFrom "${viewFrom}" (expected one of ${VIEW_FROM_DIRECTIONS.join(', ')})`
    );
  }
  return { viewFrom: key, ...orientation };
}

export function isValidViewFrom(viewFrom) {
  return Object.prototype.hasOwnProperty.call(ORIENTATIONS, String(viewFrom || '').toLowerCase());
}

/**
 * Map a plant's position along the horizontal axis to a viewBox x coordinate.
 * Mirrored views reflect about the viewBox centre so the left offset keeps
 * meaning "inset from the near edge of the drawing".
 *
 * @param {number} axisFeet position along the horizontal yard axis, in feet
 * @param {(feet: number) => number} toPixels
 * @param {{ mirrored: boolean, leftOffsetPx: number, viewBoxWidth: number }} params
 * @returns {number}
 */
export function elevationAxisToViewBoxX(axisFeet, toPixels, { mirrored, leftOffsetPx = 0, viewBoxWidth }) {
  const unmirrored = toPixels(axisFeet) + leftOffsetPx;
  return mirrored ? viewBoxWidth - unmirrored : unmirrored;
}

/**
 * Comparator fragment for back-to-front draw order along the depth axis.
 * Returns a negative number when `a` should be drawn first (farther away).
 *
 * @param {number} depthA
 * @param {number} depthB
 * @param {boolean} farIsHigh
 */
export function compareElevationDepth(depthA, depthB, farIsHigh) {
  if (depthA === depthB) return 0;
  return farIsHigh ? depthB - depthA : depthA - depthB;
}
