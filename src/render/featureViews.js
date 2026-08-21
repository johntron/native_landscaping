import { createSvgElement } from './svgUtils.js';
import { projectFeatureToElevation, projectFeatureToPlan } from './featureProjection.js';

/**
 * Draw one projected yard feature.
 *
 * Silhouettes are deliberately crude — a filled footprint in plan, a rectangle
 * in elevation. That is the point: this is the in-app version of a traced
 * outline, not an illustration.
 */

/** A hairline feature still has to be visible at any zoom. */
const MIN_STROKE_PX = 1;

/**
 * @param {object} feature a normalized feature (see src/data/featureConfig.js)
 * @param {ReturnType<typeof import('./viewTransform.js').createViewTransform>} transform
 * @returns {SVGGElement}
 */
export function buildFeatureGroup(feature, transform) {
  const group = createSvgElement('g', {
    'data-feature-id': feature.id,
    'data-feature-type': feature.type,
  });
  const shape =
    transform.type === 'plan'
      ? buildPlanShape(feature, projectFeatureToPlan(feature, transform))
      : buildElevationShape(feature, projectFeatureToElevation(feature, transform));
  group.appendChild(shape);
  return group;
}

function buildPlanShape(feature, projected) {
  const points = projected.points.map((point) => `${round(point.x)},${round(point.y)}`).join(' ');
  // A wall is an open path: filling it would paint in the yard behind the fence.
  return createSvgElement(projected.closed ? 'polygon' : 'polyline', {
    points,
    fill: projected.closed ? feature.style.fill : 'none',
    stroke: feature.style.stroke,
    'stroke-width': strokeWidth(projected),
    'stroke-linejoin': 'round',
  });
}

/**
 * Two silhouettes come out flat, both legitimately: a surface has no height, and
 * a wall seen end-on has no width. SVG draws neither a zero-width nor a
 * zero-height rect at all, so those become a line at the feature's stroke weight
 * — a surface reads as the thin band of ground it is, an end-on fence as the
 * hairline it is.
 */
function buildElevationShape(feature, projected) {
  if (projected.width === 0 || projected.height === 0) {
    return createSvgElement('line', {
      x1: round(projected.x),
      y1: round(projected.y),
      x2: round(projected.x + projected.width),
      y2: round(projected.y + projected.height),
      stroke: feature.style.stroke,
      'stroke-width': strokeWidth(projected),
      'stroke-linecap': 'round',
    });
  }
  return createSvgElement('rect', {
    x: round(projected.x),
    y: round(projected.y),
    width: round(projected.width),
    height: round(projected.height),
    fill: feature.style.fill,
    stroke: feature.style.stroke,
    'stroke-width': strokeWidth(projected),
  });
}

function strokeWidth(projected) {
  return Math.max(projected.strokeWidthPx, MIN_STROKE_PX);
}

function round(value) {
  return Math.round(value * 100) / 100;
}
