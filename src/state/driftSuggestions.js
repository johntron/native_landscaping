/**
 * Pure logic for "suggest drifts from an existing yard" (nl-o47.6.5, nl-o47.6's
 * MAKING method 3): a yard planted before drifts existed has masses built by
 * cloning, and this turns src/state/driftGeometry.js's suggestClusters into a
 * one-at-a-time REVIEW a person accepts, adjusts, or skips. No DOM, no
 * appState — src/interaction/driftReviewMode.js is the stateful wrapper.
 *
 * DERIVED, NOT STORED: there is deliberately no persisted "queue" of
 * suggestions with an index into it. The current suggestion is always the
 * first entry of orderedSuggestions(plants) whose key has not been skipped
 * this session — recomputed fresh every time from appState.plants. That makes
 * Accept, Undo/Redo, and an unrelated add during review all correct for free:
 * an accepted cluster's members carry a driftId now, so suggestClusters
 * already excludes them; an undone accept drops that driftId, so the exact
 * same cluster (same speciesId, same member ids) reappears on the very next
 * read, with no special "was this my own undo" detection needed anywhere.
 */
import { lifecycleOf } from '../data/plantLifecycle.js';
import { driftLabel } from '../render/labels.js';
import { MIN_SUGGESTION_CLUSTER_SIZE, suggestClusters } from './driftGeometry.js';

/**
 * suggestClusters' own clusters, largest first (the owner's own review order:
 * the seed yard's ~19-plant horseherb mass is worth reviewing before a
 * 2-plant afterthought). Array#sort is stable, so a tie in size keeps
 * suggestClusters' own first-appearance order.
 * @param {Array<object>} plants
 * @param {{ k?: number, minSize?: number }} [options]
 * @returns {Array<{ speciesId: string, members: object[] }>}
 */
export function orderedSuggestions(plants, options) {
  return [...suggestClusters(plants, options)].sort((a, b) => b.members.length - a.members.length);
}

/**
 * A suggestion's stable identity for one review session: its species plus its
 * OWN algorithmic members (sorted ids), never the person's own toggled
 * adjustments — those are tracked separately (src/interaction/driftReviewMode.js)
 * so a toggle-then-Skip still recognises "this same suggestion" the next time
 * it is recomputed from unchanged plants.
 * @param {{ speciesId: string, members: object[] }} suggestion
 * @returns {string}
 */
export function suggestionKey(suggestion) {
  const ids = (suggestion?.members || []).map((member) => String(member.id)).sort();
  return `${suggestion?.speciesId || ''}::${ids.join(',')}`;
}

/**
 * Every suggestion still worth showing this session: orderedSuggestions minus
 * whatever the person has already Skipped (by suggestionKey). An Accept needs
 * no entry here — its members now carry a driftId, so suggestClusters itself
 * excludes them on the very next call.
 * @param {Array<object>} plants
 * @param {Set<string>|Iterable<string>} skippedKeys
 * @param {{ k?: number, minSize?: number }} [options]
 * @returns {Array<{ speciesId: string, members: object[] }>}
 */
export function pendingSuggestions(plants, skippedKeys, options) {
  const skipped = skippedKeys instanceof Set ? skippedKeys : new Set(skippedKeys || []);
  return orderedSuggestions(plants, options).filter((suggestion) => !skipped.has(suggestionKey(suggestion)));
}

/**
 * A tap on `plantId` while reviewing `members` (the CURRENT suggestion's
 * adjusted membership, full plant objects): toggles it in or out.
 *
 * - Already a member: removed, unless that would drop below
 *   MIN_SUGGESTION_CLUSTER_SIZE, which is refused with a reason instead (a
 *   suggestion may never fall below a real drift's own floor).
 * - Not a member, but the same species and not already in some OTHER drift:
 *   added.
 * - Anything else (a different species, or already in a real drift, or no
 *   such plant) — a silent no-op: "a different-species tap does nothing"
 *   (nl-o47.6.5's own spec), not an error.
 * @param {Array<object>} members full plant objects, the suggestion's current membership
 * @param {string} plantId
 * @param {Array<object>} plants every plant in the yard (to resolve a candidate not yet a member)
 * @returns {{ members: object[], reason: string|null }}
 */
export function toggleSuggestionMember(members, plantId, plants) {
  const list = Array.isArray(members) ? members : [];
  const id = String(plantId ?? '');
  if (!id) return { members: list, reason: null };

  const alreadyIn = list.some((member) => String(member.id) === id);
  if (alreadyIn) {
    if (list.length <= MIN_SUGGESTION_CLUSTER_SIZE) {
      return { members: list, reason: `A drift needs at least ${MIN_SUGGESTION_CLUSTER_SIZE} plants.` };
    }
    return { members: list.filter((member) => String(member.id) !== id), reason: null };
  }

  const speciesId = list[0]?.speciesId;
  const candidate = (plants || []).find((plant) => String(plant.id) === id);
  if (!candidate || candidate.driftId || !speciesId || candidate.speciesId !== speciesId) {
    return { members: list, reason: null };
  }
  return { members: [...list, candidate], reason: null };
}

/**
 * Whether `members` (the current suggestion's adjusted membership) share one
 * planting status/date/source/ecotype, and the distinct lifecycles actually
 * found, largest group first — "one planting status per drift" (nl-o47.6.10)
 * means Accept must not silently pick one when they disagree; the caller
 * offers these as the choices instead ("pick one of the distinct lifecycles
 * found," nl-o47.6.5's own note).
 * @param {Array<object>} members full plant objects
 * @returns {{ uniform: boolean, groups: Array<{ lifecycle: object, count: number }> }}
 *   groups in first-appearance order among `members`
 */
export function summarizeSuggestionLifecycle(members) {
  const list = Array.isArray(members) ? members : [];
  const groups = [];
  const indexByKey = new Map();
  list.forEach((member) => {
    const lifecycle = lifecycleOf(member);
    const key = JSON.stringify(lifecycle);
    if (!indexByKey.has(key)) {
      indexByKey.set(key, groups.length);
      groups.push({ lifecycle, count: 0 });
    }
    groups[indexByKey.get(key)].count += 1;
  });
  return { uniform: groups.length <= 1, groups };
}

/**
 * The compact difference line the review bar shows when a suggestion's
 * members disagree, e.g. "12 planned, 5 planted" (nl-o47.6.5's own example) —
 * by STATUS alone, the coarsest and most common way an old, hand-built mass
 * disagrees. A finer disagreement (same status, different date/source/
 * ecotype) still shows as more than one option in describeLifecycleChoice
 * below; this line is only the headline.
 * @param {Array<object>} members full plant objects
 * @returns {string} '' for an empty list
 */
export function summarizeStatusCounts(members) {
  const list = Array.isArray(members) ? members : [];
  let planned = 0;
  let planted = 0;
  list.forEach((member) => {
    if (lifecycleOf(member).status === 'planted') planted += 1;
    else planned += 1;
  });
  const parts = [];
  if (planned) parts.push(`${planned} planned`);
  if (planted) parts.push(`${planted} planted`);
  return parts.join(', ');
}

/**
 * A suggestion's own display text (nl-o47.6.5): a suggestion is a proposed
 * drift, so it reads exactly like a real one — driftLabel's species initials
 * plus count, e.g. "CV (3x)" (nl-o47.6.11, src/render/labels.js) — this is
 * the ONE place a suggestion's name is composed. Every place the review shows
 * a suggestion's name — the bar's own label, an Accept's commit description —
 * reads it from here rather than composing it inline. `speciesId` is a
 * fallback only, for the degenerate case driftLabel itself cannot label (an
 * empty membership, or members with no usable name at all).
 * @param {Array<object>} members full plant objects, the suggestion's current (possibly adjusted) membership
 * @param {string} speciesId  suggestion.speciesId
 * @returns {string}
 */
export function describeSuggestion(members, speciesId) {
  return driftLabel(members) || speciesId || '';
}

/**
 * One distinct-lifecycle option's label, for the choice
 * summarizeSuggestionLifecycle's `groups` offers: "Planned (12)", "Planted,
 * 2026-03-01 (5)", "Planted, local ecotype (3)".
 * @param {{ lifecycle: { status: string, plantedOn: string, localEcotype: boolean }, count: number }} group
 * @returns {string}
 */
export function describeLifecycleChoice({ lifecycle, count }) {
  const parts = [lifecycle.status === 'planted' ? 'Planted' : 'Planned'];
  if (lifecycle.status === 'planted' && lifecycle.plantedOn) parts.push(lifecycle.plantedOn);
  if (lifecycle.localEcotype) parts.push('local ecotype');
  return `${parts.join(', ')} (${count})`;
}
