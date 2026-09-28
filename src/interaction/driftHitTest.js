/**
 * Pure decisions behind a drift-aware tap/click in Edit mode (nl-o47.6.2), on
 * top of nl-o47.2's tapSelection.js. No DOM: src/interaction/dragController.js
 * is the only caller, feeding it plain candidate ids and yard-feet points, and
 * turning the returned action into a src/ui/plantSelection.js call.
 *
 * Two separate resolutions, because they answer different questions:
 *  - resolveDriftAction: given a plant a tap/press actually LANDED on (or
 *    none), what should the selection become? A hit on a member while a
 *    drift is already isolated always drills into it (dragController.js
 *    decides, for MOUSE only, whether to apply that immediately or defer it
 *    to a plain click's release — see its own comment, since a single press
 *    both selects and starts a drag there).
 *  - containingDriftIdsByDistance / resolveGapTapAction: a tap that hit no
 *    plant at all, but may still have landed BETWEEN a drift's members,
 *    inside its outline (src/state/driftGeometry.js isPointInDriftOutline) —
 *    the "far bigger target than one small plant" the design calls for.
 *    Ordered nearest-centroid-first so overlapping drifts (an interwoven
 *    planting) resolve deterministically and can be cycled through by
 *    repeat taps the same way tapSelection.js cycles overlapping plants.
 */
import { allDrifts, driftCentroid, driftMembers, driftOutline, isPointInDriftOutline } from '../state/driftGeometry.js';

/**
 * @param {{
 *   selectedId: string|null,
 *   driftContext: { selectedDriftId: string, driftDrilledIn: boolean },
 *   plants: Array<{id: any, driftId?: string}>,
 * }} args
 * @returns {
 *   | { type: 'clear' }
 *   | { type: 'selectPlant', plantId: string }
 *   | { type: 'selectDrift', driftId: string }
 *   | { type: 'drillInto', plantId: string, driftId: string }
 * }
 */
export function resolveDriftAction({ selectedId, driftContext, plants }) {
  if (!selectedId) return { type: 'clear' };
  const id = String(selectedId);
  if (driftContext?.selectedDriftId) {
    return { type: 'drillInto', plantId: id, driftId: driftContext.selectedDriftId };
  }
  const plant = (plants || []).find((p) => String(p.id) === id);
  return plant?.driftId ? { type: 'selectDrift', driftId: plant.driftId } : { type: 'selectPlant', plantId: id };
}

/**
 * Every drift whose outline contains `point`, nearest centroid first — "when
 * several drift outlines contain the point, prefer ... the nearest centroid"
 * (nl-o47.6's design). Only meaningful in the plan view; elevations have no
 * outline (a point there has no y-depth to test against a hull), so callers
 * pass `point: null` and get [] back.
 * @param {Array<object>} plants
 * @param {{x:number,y:number}|null} point  yard feet
 * @returns {string[]} driftIds
 */
export function containingDriftIdsByDistance(plants, point) {
  if (!point) return [];
  return allDrifts(plants)
    .map((drift) => {
      const outline = driftOutline(drift.members);
      if (!isPointInDriftOutline(point, outline)) return null;
      const centroid = driftCentroid(drift.members);
      return { driftId: drift.driftId, dist: Math.hypot(point.x - centroid.x, point.y - centroid.y) };
    })
    .filter(Boolean)
    .sort((a, b) => a.dist - b.dist)
    .map((entry) => entry.driftId);
}

/**
 * What a "gap tap" (no plant hit, but possibly inside one or more outlines)
 * should do, once the caller has already cycled `containingDriftIdsByDistance`
 * down to a single candidate `gapDriftId` (tapSelection.js's own
 * resolveTapSelection, reused on this list the same way it cycles overlapping
 * plants) — nothing to do when no outline contains the point; a no-op when
 * the point is still inside the SAME drift already isolated (a gap between
 * that drift's own members: tapping it should not deselect); otherwise enter
 * the (possibly different, on a repeat tap into an overlapping planting)
 * drift the cycle landed on.
 * @param {string|null} gapDriftId
 * @param {{ selectedDriftId: string }} driftContext
 * @returns {{ type: 'clear' } | { type: 'noop' } | { type: 'selectDrift', driftId: string }}
 */
export function resolveGapTapAction(gapDriftId, driftContext) {
  if (!gapDriftId) return { type: 'clear' };
  if (driftContext?.selectedDriftId && gapDriftId === driftContext.selectedDriftId) return { type: 'noop' };
  return { type: 'selectDrift', driftId: gapDriftId };
}

/**
 * Whether `point` (yard feet) falls inside driftId's own outline — used for
 * mouse, which has no per-spot cycling: a click on empty ground that is still
 * within the isolated drift's own outline is a no-op, not a leave.
 * @param {Array<object>} plants
 * @param {string} driftId
 * @param {{x:number,y:number}} point
 * @returns {boolean}
 */
export function isPointInsideDrift(plants, driftId, point) {
  if (!driftId || !point) return false;
  const members = driftMembers(plants, driftId);
  if (!members.length) return false;
  return isPointInDriftOutline(point, driftOutline(members));
}
