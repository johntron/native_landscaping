import { createSvgElement } from './svgUtils.js';
import { pointInPolygon, distanceToPath } from './geometry.js';
import { geometryKeyFor } from '../data/featureConfig.js';
import { projectFeatureToPlan } from './featureProjection.js';

/**
 * The handles that edit a yard feature, and the arithmetic behind them.
 *
 * Split from the controller the same way setupOverlay is split from
 * setupController: `buildFeatureHandles` and `resolveFeatureDrag` are plain
 * numbers and can be tested without a DOM, `renderFeatureOverlay` turns them
 * into elements.
 *
 * Features are edited in the PLAN only. A footprint lives in plan space and a
 * height is a number in a form field, not a drag — so every elevation stays
 * derived and read-only, which is most of what keeps this editor small.
 */

const OVERLAY_GROUP_ATTR = 'data-feature-overlay';
const VERTEX_RADIUS_PX = 6;
const SELECTION_COLOR = '#1b74d8';

/** Defaults for a newly drawn shape, in feet — an upper bound, not a promise. */
const NEW_SHAPE = {
  sizeFt: 8,
  wallLengthFt: 12,
  wallHeightFt: 6,
  boxHeightFt: 8,
  trellisLengthFt: 4,
  trellisHeightFt: 7,
};

/** How much of the shared yard a new shape may span, so it always fits inside it. */
const NEW_SHAPE_YARD_FRACTION = 0.4;
const MIN_NEW_SHAPE_FT = 0.5;

/**
 * Handles for the selected feature: one per vertex, plus the shape itself for
 * moving it whole. Coordinates come back in viewBox pixels, which is what the
 * pointer speaks.
 *
 * @param {object} feature a normalized feature, or null
 * @param {ReturnType<typeof import('./viewTransform.js').createViewTransform>} transform
 * @returns {Array<{ id: string, index: number, x: number, y: number }>}
 */
export function buildFeatureHandles(feature, transform) {
  if (!feature) return [];
  return featurePoints(feature).map((point, index) => {
    const pixel = transform.planToViewBox(point);
    return { id: `vertex:${index}`, index, x: pixel.x, y: pixel.y };
  });
}

/**
 * Nearest handle within the radius. Nearest rather than first: vertices of a
 * small shape overlap at a touch-sized hit radius, and picking the first would
 * make one corner of a bed unreachable.
 */
export function pickFeatureHandle(handles, point, radius) {
  let best = null;
  let bestDistance = radius;
  handles.forEach((handle) => {
    const distance = Math.hypot(handle.x - point.x, handle.y - point.y);
    if (distance <= bestDistance) {
      best = handle;
      bestDistance = distance;
    }
  });
  return best;
}

/**
 * Which feature is under the pointer, topmost first — the reverse of draw
 * order, so clicking overlapping shapes selects the one you can see.
 *
 * An open-path feature (wall, trellis) has no interior to be inside of, so it
 * is picked by distance to its path instead.
 */
export function pickFeatureAt(features, transform, point, radius = 0) {
  for (let i = features.length - 1; i >= 0; i -= 1) {
    const feature = features[i];
    const pixels = projectFeatureToPlan(feature, transform).points;
    if (geometryKeyFor(feature.type) === 'pathFt') {
      if (distanceToPath(point, pixels) <= Math.max(radius, VERTEX_RADIUS_PX)) return feature;
    } else if (pointInPolygon(point, pixels)) {
      return feature;
    }
  }
  return null;
}

/**
 * Move a whole feature, or one of its vertices, to a plan point in FEET.
 *
 * Returns a new feature; nothing here mutates the one it was handed, because
 * the app has to be able to reject the result and keep showing the last good
 * state.
 *
 * @param {object} feature
 * @param {string} handleId `vertex:<n>`, or 'move' for the whole shape
 * @param {{ x: number, y: number }} pointFt where the pointer is, in yard feet
 * @param {{ x: number, y: number }} [grabOffsetFt] pointer minus shape at grab time
 */
export function resolveFeatureDrag(feature, handleId, pointFt, grabOffsetFt = { x: 0, y: 0 }) {
  if (!feature) return null;
  const key = geometryKeyFor(feature.type);
  const points = featurePoints(feature);

  if (handleId === 'move') {
    // The offset keeps the shape under the pointer where it was grabbed; without
    // it every move snaps the first vertex to the cursor.
    const dx = pointFt.x - grabOffsetFt.x - points[0].x;
    const dy = pointFt.y - grabOffsetFt.y - points[0].y;
    return { ...feature, [key]: points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
  }

  const index = vertexIndex(handleId);
  if (index === null || index >= points.length) return null;
  const moved = points.map((point, i) => (i === index ? { x: pointFt.x, y: pointFt.y } : point));
  return { ...feature, [key]: moved };
}

/** The pointer's offset from the shape's first vertex, so a move does not jump. */
export function grabOffsetFor(feature, pointFt) {
  const first = featurePoints(feature)[0];
  return { x: pointFt.x - first.x, y: pointFt.y - first.y };
}

/**
 * A new shape, centred on a yard point. Drawing is two clicks and a drag rather
 * than a rubber band: the shape appears at a sensible size and is then reshaped
 * with the same handles everything else uses.
 *
 * The size is capped to a fraction of `boundsFt` — the yard EVERY view can draw,
 * not the yard the plan covers. Those are not the same rectangle: a project
 * whose elevations show a narrow slice has a shared yard far smaller than its
 * plan, and a shape sized to the plan lands wholly off-canvas in every
 * elevation. That is the same trap resolveYardBounds exists to keep plants out
 * of.
 *
 * A wall and a box are given a real height here, deliberately. normalizeFeatures
 * refuses one without a positive heightFt, and a half-drawn shape must not be
 * the thing that trips that guard — "reject loudly" is for malformed files, not
 * for the first frame of a new fence.
 *
 * @param {'surface'|'wall'|'box'|'trellis'} type
 * @param {{ x: number, y: number }} centerFt
 * @param {Array<string>} [existingIds]
 * @param {{ x: {min:number,max:number}, y: {min:number,max:number} }} [boundsFt]
 */
export function createFeatureShape(type, centerFt, existingIds = [], boundsFt = null) {
  const id = uniqueId(type, existingIds);
  const spanX = boundsFt ? boundsFt.x.max - boundsFt.x.min : Infinity;
  const spanY = boundsFt ? boundsFt.y.max - boundsFt.y.min : Infinity;
  const fit = (want, ...spans) =>
    Math.max(MIN_NEW_SHAPE_FT, Math.min(want, ...spans.map((span) => span * NEW_SHAPE_YARD_FRACTION)));

  const half = fit(NEW_SHAPE.sizeFt, spanX, spanY) / 2;
  if (type === 'wall' || type === 'trellis') {
    const lengthFt = type === 'trellis' ? NEW_SHAPE.trellisLengthFt : NEW_SHAPE.wallLengthFt;
    const heightFt = type === 'trellis' ? NEW_SHAPE.trellisHeightFt : NEW_SHAPE.wallHeightFt;
    const halfLength = fit(lengthFt, spanX) / 2;
    return {
      id,
      type,
      pathFt: [
        { x: centerFt.x - halfLength, y: centerFt.y },
        { x: centerFt.x + halfLength, y: centerFt.y },
      ],
      heightFt,
    };
  }
  const footprintFt = [
    { x: centerFt.x - half, y: centerFt.y - half },
    { x: centerFt.x + half, y: centerFt.y - half },
    { x: centerFt.x + half, y: centerFt.y + half },
    { x: centerFt.x - half, y: centerFt.y + half },
  ];
  return type === 'box'
    ? { id, type: 'box', footprintFt, heightFt: NEW_SHAPE.boxHeightFt }
    : { id, type: 'surface', footprintFt };
}

/** `bed`, then `bed-2`, `bed-3` — the slug shape normalizeFeatures insists on. */
function uniqueId(type, existingIds) {
  const taken = new Set(existingIds);
  if (!taken.has(type)) return type;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${type}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${type}-${taken.size + 1}`;
}

/** Move a feature within the list. Array order is the plan's z-order. */
export function reorderFeatures(features, id, delta) {
  const index = features.findIndex((feature) => feature.id === id);
  const next = index + delta;
  if (index < 0 || next < 0 || next >= features.length) return features;
  const moved = [...features];
  [moved[index], moved[next]] = [moved[next], moved[index]];
  return moved;
}

/**
 * Draw the selection outline and its vertex handles over the plan.
 *
 * Rendering clears the SVG, so this runs after every render rather than once —
 * the same contract renderSetupOverlay has.
 */
export function renderFeatureOverlay(svg, features, selectedId, transform) {
  clearFeatureOverlay(svg);
  const feature = features.find((entry) => entry.id === selectedId);
  if (!feature) return null;

  const group = createSvgElement('g', { [OVERLAY_GROUP_ATTR]: 'true', 'pointer-events': 'none' });
  const projected = projectFeatureToPlan(feature, transform);
  const points = projected.points.map((point) => `${point.x},${point.y}`).join(' ');
  group.appendChild(
    createSvgElement(projected.closed ? 'polygon' : 'polyline', {
      points,
      fill: 'none',
      stroke: SELECTION_COLOR,
      'stroke-width': 2,
      'stroke-dasharray': '6 4',
    })
  );

  buildFeatureHandles(feature, transform).forEach((handle) => {
    group.appendChild(
      createSvgElement('circle', {
        cx: handle.x,
        cy: handle.y,
        r: VERTEX_RADIUS_PX,
        fill: '#fff',
        stroke: SELECTION_COLOR,
        'stroke-width': 2,
        'data-feature-handle': handle.id,
      })
    );
  });

  svg.appendChild(group);
  return group;
}

export function clearFeatureOverlay(svg) {
  if (!svg) return;
  Array.from(svg.querySelectorAll(`[${OVERLAY_GROUP_ATTR}]`)).forEach((node) =>
    node.parentNode?.removeChild(node)
  );
}

function featurePoints(feature) {
  return feature[geometryKeyFor(feature.type)] || [];
}

function vertexIndex(handleId) {
  const match = /^vertex:(\d+)$/.exec(String(handleId || ''));
  return match ? Number(match[1]) : null;
}
