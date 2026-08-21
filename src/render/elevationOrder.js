import { compareElevationDepth } from './elevationOrientation.js';
import { projectFeatureToElevation } from './featureProjection.js';

/**
 * The draw order for one elevation, with features and plants in a single list.
 *
 * Sorting them together is the whole payoff of drawing yard features: a fence
 * standing between the viewer and a shrub actually hides it, which a background
 * photo could never do without per-pixel depth.
 *
 * Each entry sorts on one depth scalar, and an extended footprint is drawn whole
 * at its NEAREST edge. For a box that is exactly right — nothing is planted
 * inside a house — and for a wall running away from the viewer it is the one
 * case it gets wrong, which is also the case where the wall is edge-on and
 * therefore a hairline. Splitting a footprint at each plant is not worth that.
 */

/** Lower bands are drawn first. Flat surfaces are ground, so they go underneath. */
const SURFACE_BAND = 0;
const DEFAULT_BAND = 1;

/**
 * @param {object} params
 * @param {Array<{ plant: any, state: any }>} params.plantStates
 * @param {Array<object>} [params.features] normalized features, in authoring order
 * @param {ReturnType<typeof import('./viewTransform.js').createViewTransform>} params.transform
 * @returns {Array<{ kind: 'plant'|'feature' } & object>} back to front
 */
export function orderElevationItems({ plantStates, features = [], transform }) {
  const { axisKey, depthKey, farIsHigh } = transform.orientation;

  const entries = [
    // Features first so that a tie leaves the authored z-order intact — Array
    // sort is stable, and authoring order is what a plan's z-order means.
    ...features.map((feature) => ({
      kind: 'feature',
      feature,
      projected: projectFeatureToElevation(feature, transform),
    })),
    ...plantStates.map((plantState) => ({ kind: 'plant', ...plantState })),
  ];

  return entries.sort((a, b) => {
    const priorityDiff = stackingPriority(a, axisKey) - stackingPriority(b, axisKey);
    if (priorityDiff !== 0) return priorityDiff; // lower priority drawn first

    // Draw back to front along the depth axis so nearer items overlap farther ones.
    const nearDiff = compareElevationDepth(depthOf(a, depthKey), depthOf(b, depthKey), farIsHigh);
    if (nearDiff !== 0) return nearDiff;

    // Beyond depth there is nothing meaningful to compare a fence with a shrub
    // on, so a mixed tie keeps the order it arrived in.
    if (a.kind !== 'plant' || b.kind !== 'plant') return 0;

    const heightA = a?.plant?.height ?? 0;
    const heightB = b?.plant?.height ?? 0;
    if (heightA !== heightB) return heightA - heightB;

    const depthTie = compareElevationDepth(depthOf(a, depthKey), depthOf(b, depthKey), farIsHigh);
    if (depthTie !== 0) return depthTie;

    const widthA = a?.plant?.width ?? 0;
    const widthB = b?.plant?.width ?? 0;
    if (widthA !== widthB) return widthA - widthB;

    return String(a?.plant?.id ?? '').localeCompare(String(b?.plant?.id ?? ''));
  });
}

/**
 * One accessor for both kinds. A parallel expression per kind is how features
 * end up silently sorting at depth zero — pinned to the very back or the very
 * front, which looks almost right.
 */
function depthOf(entry, depthKey) {
  if (entry?.kind === 'feature') return entry.projected.depthFt.near;
  return entry?.plant?.[depthKey] ?? 0;
}

function stackingPriority(entry, axisKey) {
  if (entry?.kind === 'feature') {
    return entry.feature.type === 'surface' ? SURFACE_BAND : DEFAULT_BAND;
  }
  const plant = entry?.plant;
  if (!plant) return DEFAULT_BAND;
  // On east/west elevations (y axis horizontal), force Callirhoe involucrata to render last so it stays in front.
  if (axisKey === 'y') {
    const botanical = (plant.botanicalName || plant.botanical_name || '').toLowerCase();
    if (botanical === 'callirhoe involucrata') {
      return 2;
    }
  }
  return DEFAULT_BAND;
}
