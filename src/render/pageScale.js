/**
 * One screen scale for the whole page.
 *
 * Every panel used to size itself to fit its own grid cell, so a foot was a
 * different number of screen pixels in each one. Three things followed, and all
 * three read as bugs: the panels had unrelated widths and heights, the
 * elevations' ground lines sat at unrelated heights down the page, and the
 * toolbar's scale reference — drawn at the first view's scale — was wrong for
 * every other panel.
 *
 * The fix is to stop fitting panels to cells and start sizing them from what
 * they cover: `extentFt × pxPerFt`, with one `pxPerFt` for the page. A view
 * covering twice as much yard is then twice as wide, which is the truth, and a
 * ruler held to the screen means the same thing everywhere.
 *
 * The scale is chosen to fit, so nothing has to be scrolled sideways to be
 * seen: the widest view fills the available width, or the tallest fills the
 * height budget, whichever binds first.
 */

/** How much of the viewport height the tallest view may occupy. */
const HEIGHT_BUDGET = 0.7;

/** Below this a drawing is unreadable, so let the page scroll instead. */
const MIN_PX_PER_FT = 4;

/**
 * @param {{ views: Array<{ extentFt: { width: number, height: number } }>,
 *           availableWidthPx: number, availableHeightPx: number,
 *           zoom?: number }} params
 * @returns {number} screen pixels per yard foot, for every panel alike
 */
export function resolvePageScale({ views, availableWidthPx, availableHeightPx, zoom = 1 }) {
  const list = (Array.isArray(views) ? views : []).filter((view) => view?.extentFt?.width > 0);
  if (!list.length) return MIN_PX_PER_FT;

  const widestFt = Math.max(...list.map((view) => view.extentFt.width));
  const tallestFt = Math.max(...list.map((view) => view.extentFt.height));

  const fits = [];
  if (availableWidthPx > 0) fits.push(availableWidthPx / widestFt);
  if (availableHeightPx > 0) fits.push((availableHeightPx * HEIGHT_BUDGET) / tallestFt);
  // Nothing measured yet — the first layout pass, before the container has a
  // width. A guess here would be visible for one frame; the caller re-runs.
  if (!fits.length) return MIN_PX_PER_FT;

  const factor = Number(zoom) > 0 ? Number(zoom) : 1;
  return Math.max(Math.min(...fits) * factor, MIN_PX_PER_FT);
}
