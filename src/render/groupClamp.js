/**
 * Clamping a MOVE applied to every member of a selection at once (nl-o47.2),
 * so a group drag keeps the group's shape: every member is offset by the same
 * delta, and the delta is shrunk just enough that no member leaves the yard,
 * rather than each member being clamped to the yard on its own (which would
 * pull the group apart).
 *
 * This is `resolveYardBounds`'s clamp generalized from one point to a set of
 * points sharing one delta. A single-member group reduces to exactly the
 * single-plant clamp already used elsewhere.
 */

/**
 * The largest delta, in the same direction as `delta`, that keeps every value
 * in `values` inside `[bounds.min, bounds.max]` once shifted by it.
 *
 * Assumes every value already sits inside the bounds (the case whenever the
 * group started legally placed) — the yard can only have shrunk on drags that
 * came before this one, and this function does not try to repair that; see
 * yardBounds.js's own note that a plant already outside is never dragged back.
 *
 * @param {number[]} values
 * @param {number} delta
 * @param {{min:number,max:number}} bounds
 * @returns {number}
 */
export function clampGroupAxisDelta(values, delta, bounds) {
  if (!values.length) return 0;
  let min = values[0];
  let max = values[0];
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] < min) min = values[i];
    if (values[i] > max) max = values[i];
  }
  // The most negative delta that keeps `min` from passing bounds.min, and the
  // most positive one that keeps `max` from passing bounds.max.
  const lowSlack = bounds.min - min;
  const highSlack = bounds.max - max;
  return Math.min(Math.max(delta, lowSlack), highSlack);
}

/**
 * The 2D form for a plan-view group drag: each axis is clamped independently
 * (an axis-aligned translation, so the axes cannot interact), which is what
 * keeps the group's shape exactly — a diagonal move is never bent to one side.
 *
 * @param {Array<{x:number,y:number}>} positions  each member's CURRENT position
 * @param {{x:number,y:number}} delta             the proposed move
 * @param {{x:{min,max}, y:{min,max}}} bounds
 * @returns {{x:number,y:number}}
 */
export function clampGroupDelta(positions, delta, bounds) {
  return {
    x: clampGroupAxisDelta(
      positions.map((p) => p.x),
      delta.x,
      bounds.x
    ),
    y: clampGroupAxisDelta(
      positions.map((p) => p.y),
      delta.y,
      bounds.y
    ),
  };
}
