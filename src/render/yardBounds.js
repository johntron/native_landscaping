import { resolveElevationOrientation } from './elevationOrientation.js';

/**
 * The patch of yard a plant is allowed to occupy.
 *
 * The yard is declared once, in feet, and every view is derived from it, so
 * this is mostly bookkeeping now: the bound is the yard, and a plant inside it
 * appears in every view because no view can be framed to miss it. That was the
 * hard part of the old model, where each view carried its own rectangle: the
 * rectangles did not have to agree, the yard was whatever they all overlapped,
 * and reframing one view silently shrank where plants could live in all the
 * others — sometimes to nothing.
 *
 * One narrowing survives, and it is not geometry but a camera. An elevation may
 * say where its observer stands (`viewerAtFt`); a feature behind that observer
 * is culled from the drawing, and a plant behind it would simply disappear.
 * Since a plant that vanishes from a view is exactly what this module exists to
 * prevent, the yard stops at the observer instead.
 */

/**
 * @param {{ yardFt: { width: number, depth: number }, views: Array<object> }} project
 * @returns {{ x: { min: number, max: number }, y: { min: number, max: number } }|null}
 *   null when there is no yard to anchor plants to.
 */
export function resolveYardBounds(project) {
  const yardFt = project?.yardFt;
  if (!(yardFt?.width > 0) || !(yardFt?.depth > 0)) return null;

  const yard = {
    x: { min: 0, max: yardFt.width },
    y: { min: 0, max: yardFt.depth },
  };
  const bounds = { x: { ...yard.x }, y: { ...yard.y } };

  const views = Array.isArray(project.views) ? project.views : [];
  views.forEach((view) => {
    if (view?.type !== 'elevation') return;
    const viewerAtFt = Number.isFinite(view.viewerAtFt) ? view.viewerAtFt : null;
    if (viewerAtFt === null) return;

    let orientation;
    try {
      orientation = resolveElevationOrientation(view.viewFrom);
    } catch {
      return;
    }
    // farIsHigh puts the camera at the low end of the depth axis, and its
    // opposite at the high end.
    const { depthKey, farIsHigh } = orientation;
    if (farIsHigh) bounds[depthKey].min = Math.max(bounds[depthKey].min, viewerAtFt);
    else bounds[depthKey].max = Math.min(bounds[depthKey].max, viewerAtFt);
  });

  // Cameras standing outside the yard, or on both sides of it, leave an
  // inverted range; clamping to one gives whichever endpoint the comparison
  // happens to hit. Fall back to the whole yard, which is the bound a drag
  // most obviously has to respect.
  ['x', 'y'].forEach((axis) => {
    if (bounds[axis].min >= bounds[axis].max) bounds[axis] = { ...yard[axis] };
  });

  return bounds;
}
