import { createViewTransform } from './viewTransform.js';

/**
 * Where a view's background photo comes from, and which patch of it to show.
 *
 * A detail view sets `backgroundFrom: '<other view id>'` instead of carrying its
 * own image: it reuses that view's photo, cropped to the rectangle of yard the
 * detail actually covers. Both the on-screen panel (CSS background-size /
 * -position) and the PNG export (canvas drawImage source rect) need the same
 * rectangle, so it is computed once here and expressed two ways.
 *
 * The crop is derived by mapping the detail's own corners through the SOURCE
 * view's transform. That is deliberate: doing the subtraction in feet would be
 * right for a plan view and wrong for a mirrored elevation (north/west put the
 * near edge on the right) and wrong on the vertical axis everywhere (yard y
 * grows north, image y grows down). One mapping gets all three for free.
 */

/** Below this the leftover travel is treated as zero — no room to pan. */
const EPSILON = 1e-9;

/**
 * @typedef {{ x: number, y: number, width: number, height: number }} CropRect
 * fractions of the source image, x/y measured from its TOP-LEFT corner.
 */

/**
 * Resolve which image a view draws and which part of it.
 *
 * @param {Array<object>} views every view in the project
 * @param {object} view the view being drawn
 * @returns {{ path: string|null, crop: CropRect|null }} `path` is relative to
 *   the project directory; `crop` is null when the whole image is used.
 */
export function resolveViewBackground(views, view) {
  if (!view) return { path: null, crop: null };
  const borrowFrom = view.backgroundFrom;
  if (!borrowFrom) {
    return { path: view.background || null, crop: null };
  }
  const source = (views || []).find((entry) => entry?.id === borrowFrom);
  // An unknown id is rejected by normalizeProjectConfig; a target with no image
  // of its own is legal (it may not have one yet) and simply draws nothing.
  if (!source?.background) return { path: null, crop: null };
  return { path: source.background, crop: computeBackgroundCrop(source, view) };
}

/**
 * The patch of `sourceView`'s drawing that `cropView` covers, as fractions of
 * the source image.
 *
 * @param {object} sourceView view that owns the photo
 * @param {object} cropView view borrowing it
 * @returns {CropRect|null} null when the two views cannot be compared
 */
export function computeBackgroundCrop(sourceView, cropView) {
  if (!sourceView || !cropView) return null;
  if (sourceView.type !== cropView.type) return null;
  if (sourceView.type === 'elevation' && sourceView.viewFrom !== cropView.viewFrom) return null;

  let source;
  try {
    source = createViewTransform(sourceView);
  } catch {
    return null;
  }

  const near = mapCorner(source, cropView.originFt.x, cropView.originFt.y);
  const far = mapCorner(
    source,
    cropView.originFt.x + cropView.extentFt.width,
    cropView.originFt.y + cropView.extentFt.height
  );

  // Mirroring and the y flip can put either corner first, so normalize.
  const left = Math.min(near.x, far.x);
  const top = Math.min(near.y, far.y);
  return {
    x: left / source.viewBox.width,
    y: top / source.viewBox.height,
    width: Math.abs(far.x - near.x) / source.viewBox.width,
    height: Math.abs(far.y - near.y) / source.viewBox.height,
  };
}

/** Map a yard corner into the source view's drawing pixels. */
function mapCorner(source, x, y) {
  if (source.type === 'plan') return source.planToViewBox({ x, y });
  return { x: source.axisToX(x), y: source.heightToY(y) };
}

/**
 * Express a crop as the CSS a panel needs.
 *
 * `background-position: X%` aligns the IMAGE's X% point with the CONTAINER's X%
 * point, so the denominator is the leftover travel (1 - crop width), not the
 * full width. When the crop is as wide as the source there is no travel at all
 * and any position is equivalent, so report 0%.
 *
 * @param {CropRect|null} crop
 * @returns {{ backgroundSize: string, backgroundPosition: string }|null}
 */
export function cropToCssBackground(crop) {
  if (!crop) return null;
  if (!(crop.width > 0) || !(crop.height > 0)) return null;
  return {
    backgroundSize: `${percent(1 / crop.width)} ${percent(1 / crop.height)}`,
    backgroundPosition: `${percent(pan(crop.x, crop.width))} ${percent(pan(crop.y, crop.height))}`,
  };
}

function pan(offset, size) {
  const travel = 1 - size;
  return travel > EPSILON ? offset / travel : 0;
}

function percent(fraction) {
  return `${round(fraction * 100)}%`;
}

/** Trim float noise so the inline style stays readable and stable. */
function round(value) {
  return Math.round(value * 1e6) / 1e6;
}
