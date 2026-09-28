/**
 * Pure helpers for the SELECTION'S drift context (nl-o47.6.2, builds on
 * nl-o47.2's plain id Set): whether `appState.selectedPlantIds` right now IS
 * a drift (every one of its members) or a single plant DRILLED INTO from
 * that drift, or names no drift at all. `src/ui/plantSelection.js` is the
 * stateful wrapper that owns `appState.selectedDriftId`/`driftDrilledIn` and
 * calls these; this file has no DOM, no appState, so the state machine can be
 * reasoned about (and tested) on its own.
 *
 * Two fields carry the context, never one: a drift id alone cannot tell
 * "the whole drift is selected" from "one of its members is" when the drift
 * happens to have exactly one member, so `driftDrilledIn` is the tie-breaker
 * rather than something inferred from `selectedPlantIds.size`.
 */
import { allDrifts, driftMembers } from './driftGeometry.js';

/** The no-drift context, shared by every branch below that lands there. */
const NONE = Object.freeze({ selectedDriftId: '', driftDrilledIn: false });

/**
 * The driftId that `ids` names EXACTLY (every one of its members, no more, no
 * fewer) — or '' if `ids` is empty, spans more than one drift, includes a
 * plant not in any drift, or is a strict subset/superset of some drift's
 * membership.
 * @param {Iterable<string>} ids
 * @param {Array<{id: any, driftId?: string}>} plants
 * @returns {string}
 */
export function driftForExactSelection(ids, plants) {
  const idSet = new Set(Array.from(ids ?? [], String));
  if (!idSet.size) return '';
  const plantsById = new Map((plants || []).map((plant) => [String(plant.id), plant]));
  let driftId = null;
  for (const id of idSet) {
    const memberDriftId = plantsById.get(id)?.driftId || null;
    if (!memberDriftId) return ''; // a selected plant not in any drift breaks the match
    if (driftId === null) driftId = memberDriftId;
    else if (driftId !== memberDriftId) return ''; // selected plants span more than one drift
  }
  const members = driftMembers(plants, driftId);
  return members.length === idSet.size && members.every((m) => idSet.has(String(m.id))) ? driftId : '';
}

/**
 * What `selectPlants(ids)` (src/ui/plantSelection.js) should set the drift
 * context to, given the context it carried BEFORE this call.
 *
 * - `ids` are exactly one drift's full membership (any size, including 1):
 *   that drift, whole (not drilled) — this is how nl-o47.6.3's "select every
 *   member of the drift just made" and the action bar's "Back to drift" both
 *   enter/return to whole-drift mode, with no separate "select the drift"
 *   entry point needed.
 * - `ids` is a single plant that is a member of the drift ALREADY active
 *   (whole or drilled) before this call: stays in that drift, drilled into
 *   just this member. This is deliberately narrower than "any single drift
 *   member drills in" — Details, Clone, and the detail sheet all route
 *   through selectPlants, and this is what keeps isolation (and "Back to
 *   drift"/"Remove from drift") alive across them rather than dropping the
 *   instant one of them re-selects the single plant it is showing. A cold
 *   right-click on a drift member (no prior drift context) does NOT invent
 *   one — that is a plain single-plant selection, unchanged from nl-o47.2.
 * - Anything else: no drift context.
 * @param {Iterable<string>} ids
 * @param {Array<object>} plants
 * @param {string} previousDriftId  appState.selectedDriftId before this call
 * @returns {{ selectedDriftId: string, driftDrilledIn: boolean }}
 */
export function inferDriftContext(ids, plants, previousDriftId) {
  const idList = Array.from(ids ?? [], String);
  if (!idList.length) return NONE;

  const wholeMatch = driftForExactSelection(idList, plants);
  if (wholeMatch) return { selectedDriftId: wholeMatch, driftDrilledIn: false };

  if (idList.length === 1 && previousDriftId) {
    const plant = (plants || []).find((p) => String(p.id) === idList[0]);
    if (plant?.driftId === previousDriftId) {
      return { selectedDriftId: previousDriftId, driftDrilledIn: true };
    }
  }

  return NONE;
}

/**
 * The drift context to keep after pruning ids that no longer name a plant
 * (src/state/selection.js's pruneSelectionIds — an add/clone/remove/undo/redo
 * elsewhere in the yard). Whole mode follows the SAME drift id's CURRENT
 * membership rather than the stale pruned-id snapshot, so a "+"/"-"
 * elsewhere, or an undo/redo of one, keeps isolation showing the right
 * members and the right count instead of quietly narrowing to whatever ids
 * happened to survive.
 * @param {{ selectedDriftId: string, driftDrilledIn: boolean }} prevContext
 * @param {Set<string>} prunedIds  already pruned (pruneSelectionIds' output)
 * @param {Array<object>} plants   the CURRENT plant list (after whatever changed)
 * @returns {{ selectedDriftId: string, driftDrilledIn: boolean }}
 */
export function pruneDriftContext(prevContext, prunedIds, plants) {
  const { selectedDriftId, driftDrilledIn } = prevContext || NONE;
  if (!selectedDriftId) return NONE;

  if (!driftDrilledIn) {
    if (driftMembers(plants, selectedDriftId).length) {
      return { selectedDriftId, driftDrilledIn: false };
    }
    // The drift itself is gone (dissolved/renamed away from under this
    // selection, e.g. by an undo): fall back to whatever the surviving ids
    // still say about themselves.
    const inferred = driftForExactSelection(prunedIds, plants);
    return inferred ? { selectedDriftId: inferred, driftDrilledIn: false } : NONE;
  }

  if (prunedIds.size === 1) {
    const [id] = prunedIds;
    const plant = (plants || []).find((p) => String(p.id) === id);
    if (plant?.driftId === selectedDriftId) return { selectedDriftId, driftDrilledIn: true };
  }
  return NONE;
}

/**
 * The ids `selectPlants` should actually be given to REPRESENT a whole-drift
 * context accurately: the drift's CURRENT full membership, not a stale
 * snapshot. src/ui/plantSelection.js's pruneSelection calls this once it
 * knows the next context is whole mode, so the selection Set and the context
 * never disagree about which/how-many plants are selected.
 * @param {string} driftId
 * @param {Array<object>} plants
 * @returns {string[]}
 */
export function currentDriftMemberIds(driftId, plants) {
  return driftMembers(plants, driftId).map((m) => String(m.id));
}

/** Every driftId currently used in `plants`, for callers that only need the ids. */
export function existingDriftIds(plants) {
  return allDrifts(plants).map((drift) => drift.driftId);
}
