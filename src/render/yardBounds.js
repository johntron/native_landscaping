/**
 * The patch of yard a plant is allowed to occupy.
 *
 * The yard is declared once, in feet, and every view is derived from it, so
 * this is the whole yard rectangle: a plant inside it appears in every view,
 * because no view can be framed to miss it, and nothing here narrows that
 * further.
 *
 * An elevation's camera (`viewerAtFt`) is NOT consulted, on purpose — an
 * earlier version stopped the yard at the nearest camera so a plant could
 * never end up "behind" one. That solved a problem plants do not have:
 * `elevationOrder.js` never culls a plant (only features are culled there;
 * see its `isBehindViewer`), so a plant beyond a camera was always still
 * drawn — the narrowing bought nothing but a smaller buildable area, and two
 * cameras on opposite sides of a yard (as on the Walkway project) could
 * squeeze it to a sliver. A plant beyond a camera may sort oddly relative to
 * that one elevation's depth order; it never disappears.
 */

/**
 * @param {{ yardFt: { width: number, depth: number } }} project
 * @returns {{ x: { min: number, max: number }, y: { min: number, max: number } }|null}
 *   null when there is no yard to anchor plants to.
 */
export function resolveYardBounds(project) {
  const yardFt = project?.yardFt;
  if (!(yardFt?.width > 0) || !(yardFt?.depth > 0)) return null;

  return {
    x: { min: 0, max: yardFt.width },
    y: { min: 0, max: yardFt.depth },
  };
}
