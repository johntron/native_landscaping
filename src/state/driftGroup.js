/**
 * Pure logic for a HAND-MADE drift proposal (nl-o47.6.4, nl-o47.6's MAKING
 * method 2, "group selected plants"): the selection bar's "Make drift"
 * action on a single plant NOT in a drift opens the SAME review UI a
 * suggestion opens (src/interaction/driftReviewMode.js), seeded with just
 * that one plant instead of an algorithmic cluster (src/state/driftGeometry.js
 * suggestClusters). No DOM, no appState.
 *
 * Differs from src/state/driftSuggestions.js's own toggle in exactly the one
 * way the design calls for: a tap may pull in a plant that ALREADY belongs to
 * another real drift — it moves, rather than being silently refused —
 * because picking members by hand is explicitly about drift-or-no-drift, not
 * about adjusting an algorithmic cluster of untouched plants. The moving
 * member's OLD drift is cleaned up by src/state/driftEdits.js's
 * acceptDriftGroup (a normalizeDrifts pass after the write), not here.
 */
import { driftLabel } from '../render/labels.js';
import { driftMembers } from './driftGeometry.js';

/**
 * The hand-made proposal's starting point: one plant, alone. `null` for
 * anything the "Make drift" action should never have been offered for — no
 * plant, no species, or already in a drift (the selection bar's own
 * plainSingleMode already excludes the last case before showing the action;
 * this just stays defensive rather than trust the caller).
 * @param {object} plant
 * @returns {{ speciesId: string, members: object[] }|null}
 */
export function seedGroupProposal(plant) {
  if (!plant || !plant.speciesId || plant.driftId) return null;
  return { speciesId: plant.speciesId, members: [plant] };
}

/**
 * A tap on `plantId` while building a hand-made proposal of `speciesId`:
 * toggles it in or out of `members` (the proposal's current membership).
 *
 * - Already a member: removed — UNLESS it is the last one, refused with a
 *   reason instead (nothing left to build a drift around; a proposal starts
 *   at one member, so its own floor is 1, not a real drift's floor of 2 —
 *   Accept itself is what stays disabled below 2, renderGroup/acceptGroup in
 *   src/interaction/driftReviewMode.js).
 * - Not a member, same species: added, WHETHER OR NOT it already belongs to
 *   another real drift — it will move (src/state/driftEdits.js's
 *   acceptDriftGroup) — which is the one way this differs from
 *   toggleSuggestionMember (src/state/driftSuggestions.js).
 * - A different species: a silent no-op with a reason the caller may show
 *   once ("say so once in the bar's hint if tapped," nl-o47.6.4's own note).
 * - No such plant: a silent no-op, no reason (nothing to explain).
 * @param {string} speciesId the proposal's fixed species
 * @param {Array<object>} members full plant objects, the proposal's current membership
 * @param {string} plantId
 * @param {Array<object>} plants every plant in the yard
 * @returns {{ members: object[], reason: string|null }}
 */
export function toggleGroupMember(speciesId, members, plantId, plants) {
  const list = Array.isArray(members) ? members : [];
  const id = String(plantId ?? '');
  if (!id) return { members: list, reason: null };

  const alreadyIn = list.some((member) => String(member.id) === id);
  if (alreadyIn) {
    if (list.length <= 1) {
      return { members: list, reason: 'A drift needs at least one plant to start from.' };
    }
    return { members: list.filter((member) => String(member.id) !== id), reason: null };
  }

  const candidate = (plants || []).find((plant) => String(plant.id) === id);
  if (!candidate) return { members: list, reason: null };
  if (!speciesId || candidate.speciesId !== speciesId) {
    return { members: list, reason: 'That plant is a different species.' };
  }
  return { members: [...list, candidate], reason: null };
}

/**
 * Among `members` (the proposal's current membership), how many already
 * belong to another real drift, grouped by that drift and labelled with ITS
 * OWN current whole membership — "2 from CI (4x)" (describeGroupSources,
 * below) reads the SOURCE drift's full size as it stands right now, not just
 * the count about to move, so Accept is not a surprise (nl-o47.6.4's own
 * note). Ordered by each source drift's first appearance among `members`.
 * @param {Array<object>} members the proposal's current members
 * @param {Array<object>} plants every plant in the yard, to resolve each
 *   source drift's full current membership
 * @returns {Array<{ driftId: string, movingCount: number, label: string }>}
 */
export function summarizeGroupSources(members, plants) {
  const list = Array.isArray(members) ? members : [];
  const order = [];
  const counts = new Map();
  list.forEach((member) => {
    const driftId = member?.driftId;
    if (!driftId) return;
    counts.set(driftId, (counts.get(driftId) || 0) + 1);
    if (!order.includes(driftId)) order.push(driftId);
  });
  return order.map((driftId) => ({
    driftId,
    movingCount: counts.get(driftId),
    label: driftLabel(driftMembers(plants, driftId)),
  }));
}

/**
 * summarizeGroupSources' own display line, e.g. "2 from CI (4x)", joining
 * more than one source drift with ", ". '' when nothing is moving.
 * @param {Array<{ movingCount: number, label: string }>} groups
 * @returns {string}
 */
export function describeGroupSources(groups) {
  return (groups || [])
    .filter((group) => group.label)
    .map((group) => `${group.movingCount} from ${group.label}`)
    .join(', ');
}
