import { geometryKeyFor } from '../data/featureConfig.js';

/**
 * Project one yard feature into one view.
 *
 * Features are authored once, in yard feet, and every view is a projection of
 * that single model — never a drawing per view. A plan gets the footprint
 * itself; an elevation gets a deliberately crude silhouette: the footprint
 * flattened onto the view's horizontal axis, extruded from its base to its
 * height.
 *
 * Every mapping here goes through the transform. North and west elevations are
 * mirrored, image y grows down while yard y grows north, and an elevation's
 * origin is measured from its *near* edge — doing any of that subtraction in
 * feet by hand is how the mirrored views end up quietly backwards.
 */

/**
 * @param {object} feature a normalized feature (see src/data/featureConfig.js)
 * @param {ReturnType<typeof import('./viewTransform.js').createViewTransform>} transform
 */
export function projectFeature(feature, transform) {
  return transform.type === 'plan'
    ? projectFeatureToPlan(feature, transform)
    : projectFeatureToElevation(feature, transform);
}

/**
 * Plan: the footprint, vertex by vertex. A surface and a box project
 * identically here — height is what separates them, and a plan has no height.
 *
 * @returns {{ id: string, type: string, closed: boolean,
 *   points: Array<{ x: number, y: number }>, strokeWidthPx: number }}
 */
export function projectFeatureToPlan(feature, transform) {
  const points = featurePoints(feature).map((point) => transform.planToViewBox(point));
  return {
    id: feature.id,
    type: feature.type,
    // A wall or trellis is an open path — closing it would fill in the yard
    // behind a fence, or paint a lattice as a solid panel.
    closed: geometryKeyFor(feature.type) === 'footprintFt',
    points,
    strokeWidthPx: transform.toPx(feature.style.strokeWidthFt),
  };
}

/**
 * Elevation: a silhouette rectangle spanning the feature's extent along the
 * view's horizontal axis, from its base to base + height.
 *
 * Two silhouettes come out degenerate, both legitimately: a surface has zero
 * height by definition, and a wall seen end-on — a fence running away from the
 * viewer — has zero width. Neither is an error, and the thickness that makes
 * them visible is a rendering decision rather than a projection one: the
 * renderer draws them at `strokeWidthPx`.
 *
 * `depthFt` is what an elevation sorts on: features and plants interleave
 * far-to-near, which is what lets a fence actually hide the plant behind it.
 *
 * @returns {{ id: string, type: string, x: number, y: number,
 *   width: number, height: number,
 *   depthFt: { min: number, max: number, near: number, far: number },
 *   strokeWidthPx: number }}
 */
export function projectFeatureToElevation(feature, transform) {
  if (transform?.type !== 'elevation') {
    throw new Error(`View "${transform?.id}" is a plan; project its features into the plan instead`);
  }
  const { axisKey, depthKey, farIsHigh } = transform.orientation;
  const points = featurePoints(feature);

  // Map both ends through axisToX before taking the span: on a mirrored view the
  // larger axis value produces the SMALLER x, so a min/max taken in feet would
  // put the rectangle's left edge on its right.
  const axisXs = points.map((point) => transform.axisToX(point[axisKey]));
  const left = Math.min(...axisXs);
  const right = Math.max(...axisXs);

  const depths = points.map((point) => point[depthKey]);
  const minDepth = Math.min(...depths);
  const maxDepth = Math.max(...depths);

  const baseY = transform.heightToY(feature.baseFt);
  const topY = transform.heightToY(feature.baseFt + feature.heightFt);

  return {
    id: feature.id,
    type: feature.type,
    x: left,
    y: topY,
    width: right - left,
    height: baseY - topY,
    depthFt: {
      min: minDepth,
      max: maxDepth,
      far: farIsHigh ? maxDepth : minDepth,
      near: farIsHigh ? minDepth : maxDepth,
    },
    strokeWidthPx: transform.toPx(feature.style.strokeWidthFt),
  };
}

/** The authored geometry of a feature, whichever key its primitive uses. */
function featurePoints(feature) {
  const points = feature?.[geometryKeyFor(feature?.type)];
  if (!Array.isArray(points) || !points.length) {
    throw new Error(`Feature "${feature?.id}" has no ${geometryKeyFor(feature?.type)} to project`);
  }
  return points;
}
