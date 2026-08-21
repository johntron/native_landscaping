import { resolveElevationOrientation } from './elevationOrientation.js';

/**
 * The patch of yard a plant is allowed to occupy.
 *
 * Each view covers its own rectangle of yard, and those rectangles do not have
 * to agree: an elevation's near-edge inset is drawing margin, not plantable
 * ground, so its origin can sit before the yard's zero. Clamping a drag to the
 * view being dragged in therefore let a plant leave every OTHER view — dragged
 * along an elevation it could reach a coordinate the plan view cannot draw, and
 * it simply vanished from the plan.
 *
 * So the bound is shared, not per-view: the yard is what the primary plan view
 * covers, narrowed to what the primary elevations can actually draw. A plant
 * inside it appears in every view; there is nowhere to drag it that hides it.
 *
 * "Primary" means the first plan view and the first elevation for each compass
 * direction. Later views of the same kind are detail crops — a zoomed callout
 * shows part of the yard by definition, and a plant outside it is not lost, it
 * is just not in that detail.
 */

/**
 * @param {Array<object>} views normalized project views
 * @returns {{ x: { min: number, max: number }, y: { min: number, max: number } }|null}
 *   null when the project has no plan view to anchor the yard to, in which case
 *   callers should fall back to per-view clamping.
 */
/**
 * The views whose own rectangle does not overlap the plan's at all.
 *
 * resolveYardBounds silently falls back to the plan when a view leaves an
 * inverted range, which is the right thing for clamping — there is no sane
 * bound to hand a drag — but it means the project keeps a view that can draw
 * NONE of the shared yard, and nothing says so. A plant inside the bounds is
 * invisible there, and so is a newly added feature, however it is placed.
 *
 * Reported rather than repaired: the fix is a coordinate the author has to
 * choose, and guessing at it would rewrite a yard the app cannot measure.
 *
 * @param {Array<object>} views normalized project views
 * @returns {Array<{ id: string, axis: 'x'|'y', viewCovers: {min:number,max:number},
 *                   planCovers: {min:number,max:number} }>}
 */
export function resolveYardConflicts(views) {
  const list = Array.isArray(views) ? views : [];
  const plan = list.find((view) => view?.type === 'plan');
  if (!plan) return [];
  const planCovers = {
    x: { min: plan.originFt.x, max: plan.originFt.x + plan.extentFt.width },
    y: { min: plan.originFt.y, max: plan.originFt.y + plan.extentFt.height },
  };

  const seenDirections = new Set();
  const conflicts = [];
  list.forEach((view) => {
    if (view?.type !== 'elevation') return;
    if (seenDirections.has(view.viewFrom)) return;
    seenDirections.add(view.viewFrom);
    let axis;
    try {
      axis = resolveElevationOrientation(view.viewFrom).axisKey;
    } catch {
      return;
    }
    const viewCovers = {
      min: view.originFt.x,
      max: view.originFt.x + view.extentFt.width,
    };
    const overlaps =
      Math.max(viewCovers.min, planCovers[axis].min) <
      Math.min(viewCovers.max, planCovers[axis].max);
    if (!overlaps) {
      conflicts.push({ id: view.id, axis, viewCovers, planCovers: planCovers[axis] });
    }
  });
  return conflicts;
}

export function resolveYardBounds(views) {
  const list = Array.isArray(views) ? views : [];
  const plan = list.find((view) => view?.type === 'plan');
  if (!plan) return null;

  const planBounds = {
    x: { min: plan.originFt.x, max: plan.originFt.x + plan.extentFt.width },
    y: { min: plan.originFt.y, max: plan.originFt.y + plan.extentFt.height },
  };
  const bounds = { x: { ...planBounds.x }, y: { ...planBounds.y } };

  const seenDirections = new Set();
  list.forEach((view) => {
    if (view?.type !== 'elevation') return;
    if (seenDirections.has(view.viewFrom)) return;
    seenDirections.add(view.viewFrom);

    let orientation;
    try {
      orientation = resolveElevationOrientation(view.viewFrom);
    } catch {
      return;
    }
    const { axisKey } = orientation;
    // originFt.x is the near edge of the horizontal axis; extentFt.width is how
    // far along that axis the drawing reaches.
    const near = view.originFt.x;
    const far = near + view.extentFt.width;
    bounds[axisKey].min = Math.max(bounds[axisKey].min, near);
    bounds[axisKey].max = Math.min(bounds[axisKey].max, far);

    // And the DEPTH axis, once a view says where its camera stands. A feature
    // behind the camera is culled from that elevation; a plant must never be
    // there in the first place, because a plant that vanishes from a view is
    // precisely what this whole module exists to prevent. So the yard stops at
    // the observer instead. farIsHigh puts the camera at the low end of the
    // depth axis, and its opposite at the high end.
    const { depthKey, farIsHigh } = orientation;
    const viewerAtFt = viewerDepthOf(view);
    if (viewerAtFt === null) return;
    if (farIsHigh) bounds[depthKey].min = Math.max(bounds[depthKey].min, viewerAtFt);
    else bounds[depthKey].max = Math.min(bounds[depthKey].max, viewerAtFt);
  });

  // Views that do not overlap at all leave an inverted range, and clamping to
  // one gives whichever endpoint the comparison happens to hit. Fall back to
  // the plan, which is the view a plant most obviously has to stay inside.
  ['x', 'y'].forEach((axis) => {
    if (bounds[axis].min >= bounds[axis].max) bounds[axis] = { ...planBounds[axis] };
  });

  return bounds;
}

/**
 * The shared yard, said out loud: what it is, what the plan covers, and which
 * view is responsible for each edge that differs.
 *
 * `resolveYardBounds` answers a drag, so it returns a rectangle and nothing
 * else. An *author* needs the other half — a plan reframed by a corner-handle
 * drag leaves every elevation's `originFt.x` describing the old frame, and the
 * yard silently shrinks to whatever corner still overlaps, or to nothing at
 * all. That is how example-frontyard ended up with a west elevation that could
 * draw none of its own yard. Setup mode shows this while the geometry is being
 * edited, so the shrink is visible in the gesture that causes it rather than in
 * a notice the next morning.
 *
 * @param {Array<object>} views normalized project views
 * @returns {{ plan: {x: {min:number,max:number}, y: {min:number,max:number}},
 *             bounds: {x: {min:number,max:number}, y: {min:number,max:number}},
 *             limits: {x: {min: string|null, max: string|null},
 *                      y: {min: string|null, max: string|null}},
 *             conflicts: Array<object> }|null}
 *   null when there is no plan view, matching resolveYardBounds.
 */
export function describeYardBounds(views) {
  const list = Array.isArray(views) ? views : [];
  const plan = list.find((view) => view?.type === 'plan');
  if (!plan) return null;

  const planCovers = {
    x: { min: plan.originFt.x, max: plan.originFt.x + plan.extentFt.width },
    y: { min: plan.originFt.y, max: plan.originFt.y + plan.extentFt.height },
  };
  const bounds = resolveYardBounds(list);
  const conflicts = resolveYardConflicts(list);
  const limits = { x: { min: null, max: null }, y: { min: null, max: null } };
  // A conflicting axis fell back to the plan, so no elevation set its edges —
  // naming one there would blame a view for a bound it does not hold.
  const conflicted = new Set(conflicts.map((conflict) => conflict.axis));

  const seenDirections = new Set();
  list.forEach((view) => {
    if (view?.type !== 'elevation') return;
    if (seenDirections.has(view.viewFrom)) return;
    seenDirections.add(view.viewFrom);
    let axis;
    try {
      axis = resolveElevationOrientation(view.viewFrom).axisKey;
    } catch {
      return;
    }
    if (!conflicted.has(axis)) {
      if (view.originFt.x === bounds[axis].min && bounds[axis].min > planCovers[axis].min) {
        limits[axis].min = view.id;
      }
      const far = view.originFt.x + view.extentFt.width;
      if (far === bounds[axis].max && bounds[axis].max < planCovers[axis].max) {
        limits[axis].max = view.id;
      }
    }

    // A view caps its depth axis too, wherever it says its camera stands.
    const viewerAtFt = viewerDepthOf(view);
    if (viewerAtFt === null) return;
    const { depthKey, farIsHigh } = resolveElevationOrientation(view.viewFrom);
    if (conflicted.has(depthKey)) return;
    const edge = farIsHigh ? 'min' : 'max';
    const narrows =
      edge === 'min'
        ? bounds[depthKey].min > planCovers[depthKey].min
        : bounds[depthKey].max < planCovers[depthKey].max;
    if (viewerAtFt === bounds[depthKey][edge] && narrows) limits[depthKey][edge] = view.id;
  });

  return { plan: planCovers, bounds, limits, conflicts };
}

/** An elevation's authored camera depth, or null when it declares none. */
function viewerDepthOf(view) {
  return Number.isFinite(view?.viewerAtFt) ? view.viewerAtFt : null;
}
