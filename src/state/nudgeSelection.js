/**
 * Nudge every selected plant one step in a compass direction (nl-o47.2), for
 * the selection action bar's arrow buttons and the desktop keyboard bonus.
 *
 * Yard coordinates: origin at the SW corner, x increases EAST, y increases
 * NORTH (docs/design-tool.md "Elevation orientation"), so N/S move y and E/W
 * move x. The group is clamped as a whole (src/render/groupClamp.js), the
 * same way a touch group drag is, so nudging never pulls the group apart even
 * when one member is nearer the yard edge than the others.
 */
import { clampGroupDelta } from '../render/groupClamp.js';

/** A judgement call, not a sourced fact: how far one nudge moves the group. */
export const NUDGE_STEP_FT = 0.5;

const UNIT_DELTA_BY_DIRECTION = {
  N: { x: 0, y: 1 },
  S: { x: 0, y: -1 },
  E: { x: 1, y: 0 },
  W: { x: -1, y: 0 },
};

/**
 * Mutates the matching plants in place (the same objects layoutHistory's
 * commit reads x/y off of, exactly like a drag), so it commits through the
 * same path as every other edit.
 *
 * @param {{plants: Array<{id:any,x:number,y:number}>}} state  src/app.js's appState
 * @param {Set<string>} selection
 * @param {'N'|'S'|'E'|'W'} direction
 * @param {{x:{min,max},y:{min,max}}|null} [bounds]  null means "no yard to clamp to"
 * @param {number} [stepFt]
 * @returns {boolean} whether any plant actually moved (a no-op nudge, e.g.
 *   already pinned against the yard edge, should not create a history entry)
 */
export function nudgeSelection(state, selection, direction, bounds = null, stepFt = NUDGE_STEP_FT) {
  const unit = UNIT_DELTA_BY_DIRECTION[direction];
  if (!unit || !selection || !selection.size) return false;
  const members = (state.plants || []).filter((plant) => selection.has(String(plant.id)));
  if (!members.length) return false;

  const effectiveBounds = bounds || {
    x: { min: -Infinity, max: Infinity },
    y: { min: -Infinity, max: Infinity },
  };
  const delta = clampGroupDelta(members, { x: unit.x * stepFt, y: unit.y * stepFt }, effectiveBounds);

  let moved = false;
  members.forEach((plant) => {
    const nextX = plant.x + delta.x;
    const nextY = plant.y + delta.y;
    if (Math.abs(nextX - plant.x) > 1e-9 || Math.abs(nextY - plant.y) > 1e-9) moved = true;
    plant.x = nextX;
    plant.y = nextY;
  });
  return moved;
}
