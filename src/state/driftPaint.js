/**
 * Pure pieces for "paint a drift along a stroke" (nl-o47.6.6, nl-o47.6's
 * making method 4): resampling a traced polyline at a spacing, and dropping
 * resampled points that fall outside the declared yard. No DOM, no state
 * mutation, no fetch — src/state/driftEdits.js's paintDrift is the actual
 * edit that combines these with the species catalog and the plants list.
 */

/**
 * A stroke longer than this many plants' worth is cut off. OUR JUDGEMENT, not
 * a technical limit, and a DIFFERENT number from src/state/driftEdits.js's
 * own MAX_DRIFT_COUNT: that cap exists because the Add plant sheet is a
 * search-and-tap picker, not a bulk-planting tool, and its own doc comment
 * points at painting as the "plant in a few batches" alternative for anyone
 * who wants more than it allows — so painting has to comfortably exceed it.
 * This cap instead guards against one enormous stroke (a trace run the full
 * length of a long fence line) building an unreasonably large single history
 * entry or an unreadable mass of plants in one undo step. A bed longer than
 * this is painted in two strokes, each its own drift; the stroke simply stops
 * contributing plants past the cap rather than refusing the whole gesture.
 */
export const MAX_PAINT_COUNT = 300;

/**
 * Resample a traced polyline (plain {x,y} points in yard feet, in drawing
 * order — typically raw pointer samples) into plant positions `spacingFt`
 * apart, starting at the stroke's own first point.
 *
 * A degenerate stroke (every point coincides, or there is at most one point)
 * resamples to nothing: the caller is expected to have already decided
 * whether the gesture moved enough to count as a stroke at all (a screen-
 * space tap-movement threshold, not this function's business — a few feet on
 * one zoom level is a few pixels on another); this is purely the spacing
 * math, and it would be wrong to read "no net displacement in FEET" as "no
 * movement," since a tight zig-zag can cover real distance while starting and
 * ending at the same point. A stroke shorter than one spacing still yields
 * its single starting point.
 * @param {Array<{x:number,y:number}>} points
 * @param {number} spacingFt
 * @param {{ maxCount?: number }} [options]
 * @returns {{ positions: Array<{x:number,y:number}>, capped: boolean }}
 *   `capped` is true when the stroke had room for more than `maxCount`
 *   plants and the rest of it (past the cap) was left unplanted.
 */
export function resampleStroke(points, spacingFt, { maxCount = MAX_PAINT_COUNT } = {}) {
  const pts = (Array.isArray(points) ? points : [])
    .map((p) => ({ x: Number(p?.x), y: Number(p?.y) }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length < 2) return { positions: [], capped: false };

  const cumulative = [0];
  for (let i = 1; i < pts.length; i += 1) {
    cumulative.push(cumulative[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  const total = cumulative[cumulative.length - 1];
  if (!(total > 0)) return { positions: [], capped: false }; // every point coincides: nothing traced

  const spacing = Number(spacingFt) > 0 ? Number(spacingFt) : total;
  const cap = Number(maxCount) > 0 ? Math.trunc(maxCount) : 1;
  const positions = [];
  let segment = 0;
  const EPSILON = 1e-9;
  for (let target = 0; target <= total + EPSILON; target += spacing) {
    if (positions.length >= cap) return { positions, capped: true };
    while (segment < cumulative.length - 2 && cumulative[segment + 1] < target) segment += 1;
    const segStart = cumulative[segment];
    const segEnd = cumulative[segment + 1] ?? segStart;
    const t = segEnd > segStart ? (target - segStart) / (segEnd - segStart) : 0;
    const a = pts[segment];
    const b = pts[segment + 1] ?? a;
    positions.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return { positions, capped: false };
}

/**
 * Drop every position that falls outside the declared yard, rather than
 * clamping the stroke as a group (src/state/driftGeometry.js's clampGroup,
 * what every other drift-making path uses): a hand-traced stroke can wander
 * past the fence at either end, and sliding the whole stroke to fit — or
 * piling the overflow at the boundary, which is what a group clamp would do
 * when the stroke is longer than the yard on some axis — would bunch plants
 * somewhere the hand never pointed. Cutting the stroke off at the yard edge
 * instead is the plain reading of "painted along a bed" when the bed's own
 * edge is the yard's edge. `bounds` absent (no declared yard) drops nothing.
 * @param {Array<{x:number,y:number}>} positions
 * @param {{x:{min,max},y:{min,max}}|null} bounds
 * @returns {Array<{x:number,y:number}>}
 */
export function dropPositionsOutsideYard(positions, bounds) {
  const list = Array.isArray(positions) ? positions : [];
  if (!bounds) return list;
  return list.filter(
    (p) => p.x >= bounds.x.min && p.x <= bounds.x.max && p.y >= bounds.y.min && p.y <= bounds.y.max
  );
}
