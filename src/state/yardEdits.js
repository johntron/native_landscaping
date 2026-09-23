/**
 * Pure edits to the yard model: scaling and shifting features.json's shapes,
 * and patching one view in project.json's list. No DOM, so tests import them
 * directly. Coordinates are yard feet, rounded to 2 decimals like everything
 * the design tool saves.
 */

export function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

/** Every authored point in the feature model, whatever primitive holds it. */
export function featurePoints(features) {
  return (Array.isArray(features) ? features : []).flatMap(
    (feature) => feature.footprintFt || feature.pathFt || []
  );
}

/**
 * Scale the feature model about the yard's corner.
 *
 * Features move with the plants or not at all: a bed scaled while the plants in
 * it stay put is worse than either alone. Heights scale too — a fence is not
 * the same fence at 60% of its footprint — and so does a stroke width in feet.
 */
export function scaleFeatures(features, factor) {
  if (!Array.isArray(features) || !features.length) return features;
  const point = (p) => ({ ...p, x: round2(p.x * factor), y: round2(p.y * factor) });
  return features.map((feature) => {
    const next = { ...feature };
    if (Array.isArray(feature.footprintFt)) next.footprintFt = feature.footprintFt.map(point);
    if (Array.isArray(feature.pathFt)) next.pathFt = feature.pathFt.map(point);
    if (Number.isFinite(feature.heightFt)) next.heightFt = round2(feature.heightFt * factor);
    if (Number.isFinite(feature.baseFt)) next.baseFt = round2(feature.baseFt * factor);
    if (Number.isFinite(feature.style?.strokeWidthFt)) {
      next.style = { ...feature.style, strokeWidthFt: round2(feature.style.strokeWidthFt * factor) };
    }
    return next;
  });
}

/**
 * Shift the whole feature — never just the points that fall outside — back
 * within the yard (nl-1ug). Clamping each point independently would deform a
 * bed or wall's shape; a translation keeps it, at the cost of not always
 * fully fitting a feature that is itself bigger than the yard on one axis
 * (best effort: the near edge wins, so it is still reported afterward).
 */
export function translateFeaturesInside(features, ids, yardFt) {
  if (!Array.isArray(features) || !features.length || !ids?.size) return features;
  const axisShift = (min, max, extent) => {
    if (min < 0) return -min;
    if (max > extent) return extent - max;
    return 0;
  };
  return features.map((feature) => {
    if (!ids.has(feature.id)) return feature;
    const points = featurePoints([feature]);
    if (!points.length) return feature;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const dx = axisShift(Math.min(...xs), Math.max(...xs), yardFt.width);
    const dy = axisShift(Math.min(...ys), Math.max(...ys), yardFt.depth);
    if (!dx && !dy) return feature;
    const shift = (p) => ({ ...p, x: round2(p.x + dx), y: round2(p.y + dy) });
    const next = { ...feature };
    if (Array.isArray(feature.footprintFt)) next.footprintFt = feature.footprintFt.map(shift);
    if (Array.isArray(feature.pathFt)) next.pathFt = feature.pathFt.map(shift);
    return next;
  });
}

/** Replace one view in a list with a shallow-merged copy. */
export function patchView(views, viewId, patch) {
  return views.map((view) => (view.id === viewId ? { ...view, ...patch } : view));
}
