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

    let axisKey;
    try {
      axisKey = resolveElevationOrientation(view.viewFrom).axisKey;
    } catch {
      return;
    }
    // originFt.x is the near edge of the horizontal axis; extentFt.width is how
    // far along that axis the drawing reaches.
    const near = view.originFt.x;
    const far = near + view.extentFt.width;
    bounds[axisKey].min = Math.max(bounds[axisKey].min, near);
    bounds[axisKey].max = Math.min(bounds[axisKey].max, far);
  });

  // Views that do not overlap at all leave an inverted range, and clamping to
  // one gives whichever endpoint the comparison happens to hit. Fall back to
  // the plan, which is the view a plant most obviously has to stay inside.
  ['x', 'y'].forEach((axis) => {
    if (bounds[axis].min >= bounds[axis].max) bounds[axis] = { ...planBounds[axis] };
  });

  return bounds;
}
