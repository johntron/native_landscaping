import { createViewTransform } from './viewTransform.js';

/**
 * Where a view's background photo sits behind the drawing.
 *
 * A view's rectangle is derived from the declared yard, so it is the same in
 * every project that shares a yard and it cannot be bent to suit a photograph.
 * The photograph therefore has to be placed: `photoFt` says which rectangle of
 * yard the image covers, in the view's own coordinates — axis feet across, and
 * yard feet (plan) or height feet (elevation) up. Drag the photo to set its
 * origin, measure a known length to set its extent, and the drawing stays put
 * while the picture moves under it.
 *
 * This is the same arithmetic the old detail-callout crop did, pointed the
 * other way. It used to answer "which patch of this photo does that view
 * cover?", always a sub-rectangle; it now answers "where does this photo land
 * in this panel?", which is just as often bigger than the panel or smaller than
 * it. Both the on-screen panel (CSS background-size / -position) and the PNG
 * export (canvas destination rect) need that rectangle, so it is computed once
 * here and expressed two ways.
 *
 * The rectangle is derived by mapping the photo's corners through the view's
 * transform. Doing the subtraction in feet by hand would be right for a plan
 * and wrong for a mirrored elevation (north/west put the low axis value on the
 * right) and wrong on the vertical axis everywhere (yard y grows north, image y
 * grows down). One mapping gets all three for free.
 */

/**
 * @typedef {{ x: number, y: number, width: number, height: number }} PlacementRect
 * viewBox pixels; may start before the panel or extend past it.
 */

/**
 * Resolve which image a view draws and where it lands.
 *
 * @param {object} view a normalized view
 * @returns {{ path: string|null, rect: PlacementRect|null }} `path` is relative
 *   to the project directory; `rect` is null when the photo simply fills the
 *   panel, which is what an uncalibrated photo does.
 */
export function resolvePhotoPlacement(view) {
  const path = view?.background || null;
  if (!path) return { path: null, rect: null };
  const photo = view.photoFt;
  if (!photo) return { path, rect: null };

  let transform;
  try {
    transform = createViewTransform(view);
  } catch {
    return { path, rect: null };
  }

  const near = mapCorner(transform, photo.originFt.x, photo.originFt.y);
  const far = mapCorner(
    transform,
    photo.originFt.x + photo.extentFt.width,
    photo.originFt.y + photo.extentFt.height
  );

  // Mirroring and the y flip can put either corner first, so normalize.
  const width = Math.abs(far.x - near.x);
  const height = Math.abs(far.y - near.y);
  if (!(width > 0) || !(height > 0)) return { path, rect: null };
  return {
    path,
    rect: { x: Math.min(near.x, far.x), y: Math.min(near.y, far.y), width, height },
  };
}

/** Map a yard corner into the view's drawing pixels. */
function mapCorner(transform, x, y) {
  if (transform.type === 'plan') return transform.planToViewBox({ x, y });
  return { x: transform.axisToX(x), y: transform.heightToY(y) };
}

/**
 * Express a placement as the CSS a panel needs.
 *
 * `background-position: X%` aligns the IMAGE's X% point with the CONTAINER's
 * X% point, so the denominator is the leftover travel — panel minus image —
 * rather than the panel. That travel is now routinely NEGATIVE: a photo that
 * covers more yard than the panel shows is wider than it, and the percentage
 * that lands it correctly is outside 0–100. CSS allows that; the earlier
 * version, which only ever cropped into an image, clamped such a case to zero
 * and would slide every under-sized photo to the panel's left edge.
 *
 * Only a photo exactly the panel's size is degenerate — every position is then
 * the same position — and that reports 0%.
 *
 * @param {PlacementRect|null} rect
 * @param {{ width: number, height: number }} viewBox
 * @returns {{ backgroundSize: string, backgroundPosition: string }|null}
 */
export function placementToCssBackground(rect, viewBox) {
  if (!rect || !viewBox) return null;
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  if (!(viewBox.width > 0) || !(viewBox.height > 0)) return null;
  return {
    backgroundSize: `${percent(rect.width / viewBox.width)} ${percent(rect.height / viewBox.height)}`,
    backgroundPosition: `${percent(pan(rect.x, viewBox.width, rect.width))} ${percent(
      pan(rect.y, viewBox.height, rect.height)
    )}`,
  };
}

/** Below this the leftover travel is treated as zero — no room to pan. */
const EPSILON = 1e-9;

function pan(offset, panelSize, imageSize) {
  const travel = panelSize - imageSize;
  return Math.abs(travel) > EPSILON ? offset / travel : 0;
}

function percent(fraction) {
  return `${round(fraction * 100)}%`;
}

/** Trim float noise so the inline style stays readable and stable. */
function round(value) {
  return Math.round(value * 1e6) / 1e6;
}
