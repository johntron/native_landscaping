/**
 * Pure decisions behind touch/pen selection in Edit mode (nl-o47.2):
 * classifying a completed gesture as a tap or a drag, and — for a tap —
 * whether it repeats the previous tap's spot (cycling to the next overlapping
 * candidate) or starts fresh (selecting the nearest one). No DOM, no pointer
 * events: src/interaction/dragController.js is the only caller, and it is
 * what turns a real gesture into the plain values these take.
 */

/**
 * How far (in CSS/screen px) a pointer may move between down and up and still
 * count as a tap rather than the start of a drag — a judgement call, not a
 * platform constant. The same threshold doubles as "about the same spot" for
 * cycling: a second tap has to land at least this close to the first to be
 * read as "tap it again" rather than "tap somewhere else."
 */
export const TAP_MOVEMENT_THRESHOLD_PX = 8;

/**
 * @param {number} dx
 * @param {number} dy
 * @param {number} [thresholdPx]
 * @returns {boolean} true once the pointer has moved far enough that this is
 *   a drag, not a tap
 */
export function exceedsTapThreshold(dx, dy, thresholdPx = TAP_MOVEMENT_THRESHOLD_PX) {
  return Math.sqrt(dx * dx + dy * dy) > thresholdPx;
}

/**
 * @param {{x:number,y:number}|null} a
 * @param {{x:number,y:number}|null} b
 * @param {number} [thresholdPx]
 * @returns {boolean}
 */
export function isSameSpot(a, b, thresholdPx = TAP_MOVEMENT_THRESHOLD_PX) {
  if (!a || !b) return false;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy) <= thresholdPx;
}

/**
 * Whether two candidate lists name the same ids, order aside. A second tap 1px
 * from the first can reorder pickPlantHit's distance sort without changing
 * which plants overlap that point, and a reorder must not look like a new
 * place was tapped.
 * @param {string[]} a
 * @param {string[]} b
 */
export function sameMembership(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  const sortedA = [...a].map(String).sort();
  const sortedB = [...b].map(String).sort();
  return sortedA.every((id, i) => id === sortedB[i]);
}

/**
 * Decide what a completed tap selects, and what the next tap should compare
 * itself against.
 *
 * A tap on empty ground (no candidates) clears the selection: `selectedId` is
 * null and `nextTap` is null, so a following tap anywhere starts fresh. A tap
 * on a plant selects the nearest candidate (pickPlantHit's own order) UNLESS
 * it repeats the previous tap's spot with the same overlapping candidates, in
 * which case it advances to the next one in that FIRST tap's order — the
 * order is captured once and reused, never recomputed from a possibly
 * reordered candidate list, so cycling cannot double back or skip.
 *
 * @param {Array<{id: string}>} candidates  ordered nearest-first (pickPlantHit)
 * @param {{x:number,y:number}} point        this tap's down position, client px
 * @param {{point:{x,y}, order:string[], index:number}|null} previousTap
 * @param {number} [thresholdPx]
 * @returns {{
 *   selectedId: string|null,
 *   nextTap: {point:{x,y}, order:string[], index:number}|null,
 * }}
 */
export function resolveTapSelection(candidates, point, previousTap, thresholdPx = TAP_MOVEMENT_THRESHOLD_PX) {
  const ids = (candidates || []).map((candidate) => String(candidate.id));
  if (!ids.length) {
    return { selectedId: null, nextTap: null };
  }

  const isCycle =
    Boolean(previousTap) &&
    isSameSpot(previousTap.point, point, thresholdPx) &&
    sameMembership(ids, previousTap.order);

  if (isCycle) {
    const nextIndex = (previousTap.index + 1) % previousTap.order.length;
    return {
      selectedId: previousTap.order[nextIndex],
      nextTap: { point, order: previousTap.order, index: nextIndex },
    };
  }

  return {
    selectedId: ids[0],
    nextTap: { point, order: ids, index: 0 },
  };
}
