/**
 * The centre, in yard feet, of the part of the plan view that is actually on
 * screen right now — used to place a newly added plant somewhere the person
 * can see and immediately drag, instead of the plan's true middle, which is
 * routinely scrolled off a phone screen (nl-o47.3).
 *
 * Pure: every input is screen-rect math the caller has already done.
 * src/app.js owns every DOM and `window` read (per AGENTS.md); this module
 * never touches either, so it is unit tested directly on plain rect objects.
 *
 * ASSUMPTION: outside of a maximized view on a narrow phone (a separate bug,
 * nl-o47.1), the plan SVG's CSS box is drawn at the same aspect ratio as its
 * own viewBox — src/render/pageScale.js sizes every panel at
 * `extentFt * pxPerFt` on both axes — so there is no SVG letterboxing to
 * correct for, and a screen pixel maps to a viewBox pixel by one ratio per
 * axis (`viewBox.width / svgRect.width`, and the same on the other axis).
 * If that assumption is ever violated the centre point drifts by however much
 * the box is letterboxed; the caller still clamps the result to the declared
 * yard (src/render/yardBounds.js), so the failure mode is a placement a
 * little off-centre, never a plant placed outside the yard.
 */

/**
 * @param {{ left: number, top: number, width: number, height: number }} svgRect
 *   the plan SVG's own `getBoundingClientRect()`, in CSS px
 * @param {{ left: number, top: number, width: number, height: number }} viewportRect
 *   the visible viewport, in the same CSS-px coordinate space as `svgRect` —
 *   `window.visualViewport`'s `offsetLeft`/`offsetTop`/`width`/`height` when
 *   present (its offsets are already relative to the layout viewport, the
 *   same frame `getBoundingClientRect()` uses), else the layout viewport
 * @param {{ viewBox: { width: number, height: number }, viewBoxToPlan: (point: { x: number, y: number }) => { x: number, y: number } }} transform
 *   the plan view's own `createViewTransform(view)`
 * @returns {{ x: number, y: number }|null} yard feet, or null when no part of
 *   the plan SVG's rect intersects the viewport (nothing on screen to centre on)
 */
export function visiblePlanCenterFt(svgRect, viewportRect, transform) {
  if (!(svgRect?.width > 0) || !(svgRect?.height > 0)) return null;
  if (!(viewportRect?.width > 0) || !(viewportRect?.height > 0)) return null;

  const left = Math.max(svgRect.left, viewportRect.left);
  const top = Math.max(svgRect.top, viewportRect.top);
  const right = Math.min(svgRect.left + svgRect.width, viewportRect.left + viewportRect.width);
  const bottom = Math.min(svgRect.top + svgRect.height, viewportRect.top + viewportRect.height);
  if (right <= left || bottom <= top) return null;

  const scaleX = transform.viewBox.width / svgRect.width;
  const scaleY = transform.viewBox.height / svgRect.height;
  const viewBoxPoint = {
    x: ((left + right) / 2 - svgRect.left) * scaleX,
    y: ((top + bottom) / 2 - svgRect.top) * scaleY,
  };
  return transform.viewBoxToPlan(viewBoxPoint);
}
