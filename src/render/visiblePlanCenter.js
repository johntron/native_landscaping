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
 * The caller supplies the client-px -> yard-feet mapping. src/app.js maps
 * through src/render/screenPoint.js (the SVG's screen CTM), the same path a
 * drag takes, so the result stays right under letterboxing or a CSS zoom
 * transform; this module only finds which client point to map.
 */

/**
 * @param {{ left: number, top: number, width: number, height: number }} svgRect
 *   the plan SVG's own `getBoundingClientRect()`, in CSS px
 * @param {{ left: number, top: number, width: number, height: number }} viewportRect
 *   the visible viewport, in the same CSS-px coordinate space as `svgRect` —
 *   `window.visualViewport`'s `offsetLeft`/`offsetTop`/`width`/`height` when
 *   present (its offsets are already relative to the layout viewport, the
 *   same frame `getBoundingClientRect()` uses), else the layout viewport
 * @param {(clientPoint: { x: number, y: number }) => ({ x: number, y: number }|null)} clientToFeet
 *   maps a client point over the plan SVG to yard feet
 * @returns {{ x: number, y: number }|null} yard feet, or null when no part of
 *   the plan SVG's rect intersects the viewport (nothing on screen to centre on)
 */
export function visiblePlanCenterFt(svgRect, viewportRect, clientToFeet) {
  if (!(svgRect?.width > 0) || !(svgRect?.height > 0)) return null;
  if (!(viewportRect?.width > 0) || !(viewportRect?.height > 0)) return null;

  const left = Math.max(svgRect.left, viewportRect.left);
  const top = Math.max(svgRect.top, viewportRect.top);
  const right = Math.min(svgRect.left + svgRect.width, viewportRect.left + viewportRect.width);
  const bottom = Math.min(svgRect.top + svgRect.height, viewportRect.top + viewportRect.height);
  if (right <= left || bottom <= top) return null;

  return clientToFeet({ x: (left + right) / 2, y: (top + bottom) / 2 });
}
