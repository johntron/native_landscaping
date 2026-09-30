/**
 * Pure helpers for the SELECTION'S drift context (nl-o47.6.2, builds on
 * nl-o47.2's plain id Set). Since nl-o47.6.12 the selection itself is a
 * discriminated union — `{ driftId }` (a whole drift, its membership always
 * read live) or `{ ids: Set<string> }` (plain plant ids) — owned by
 * `src/ui/plantSelection.js`. "Drilled into one member" is DERIVED, not
 * stored: exactly one selected plant, and that plant carries a driftId. A
 * drift always has >= 2 members (nl-o47.6.9), so an `{ ids }` selection of
 * size 1 can never also be some drift's exact whole membership — the
 * ambiguity a separate `driftDrilledIn` flag used to exist for cannot arise
 * any more, which is also why a cold single-plant selection of a drift
 * member now drills in immediately (nl-o47.6.12's one named behaviour
 * change) instead of needing an already-active context to narrow from.
 *
 * `driftForExactSelection` is the one decision left here: whether a set of
 * ids names some drift's CURRENT full membership exactly, which is what lets
 * `selectPlants(ids)` (plantSelection.js) store the compact `{ driftId }`
 * form instead of the ids themselves.
 */
import { driftMembers } from './driftGeometry.js';

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
