/**
 * Edits to a drift (nl-o47.6): grow it, shrink it, spread it, clone it, or
 * take it apart. Each takes the app state, replaces
 * `state.plants` with a new array (never mutates it), and returns what
 * changed, in plantEdits.js's own style — this file is deliberately separate
 * from plantEdits.js (which another change is editing concurrently) rather
 * than added to it.
 *
 * A drift is a label, not a stored shape (src/state/driftGeometry.js), so
 * every edit here reads the plan straight from the members it finds by
 * driftId and writes back only their `x`, `y`, or `driftId` — the geometry
 * itself is never stored anywhere these functions have to keep in sync.
 *
 * A plant is clamped to the declared yard, never to a view's own rectangle
 * (docs/design-tool.md "Yard bounds"; src/render/yardBounds.js), so every
 * edit that can move or place a plant reads bounds from `resolveYardBounds`,
 * not from a view's origin/extent the way clonePlantById does.
 *
 * A DRIFT ALWAYS HAS AT LEAST 2 MEMBERS (nl-o47.6's REVISED design,
 * 2026-09-28; nl-o47.6.9): pruneUndersizedDrift/dropUndersizedDrifts below are
 * the one place that rule is enforced, called from every edit here that can
 * leave a drift with fewer than two members (removeDriftMember,
 * removePlantFromDrift, removeDriftAwarePlant) so a UI handler never has to
 * remember to.
 */
import { resolveYardBounds } from '../render/yardBounds.js';
import { createPlantFromSpecies } from '../data/plantParser.js';
import { LIFECYCLE_KEYS, lifecycleOf, validateLifecycle, withLifecycle } from '../data/plantLifecycle.js';
import { dropUndersizedDrifts } from '../data/driftId.js';
import { addPlantFromCatalog, clonePlantById, removePlantById } from './plantEdits.js';

// Re-exported so a caller that mints/edits/prunes a drift can reach the
// whole-list version of the ">= 2 members" rule through "the drift edits
// module" (this file), the same way src/state/plantIds.js re-exports
// isValidDriftId — dropUndersizedDrifts itself lives in src/data/driftId.js,
// not here, so src/data/ modules (plantParser.js's buildPlantsFromCsv and
// plantsFromPlacements) can also reach it without reaching into src/state/
// (see driftId.js's own module comment on that layering rule).
export { dropUndersizedDrifts };
import { buildCloneId, buildDriftId, buildNewPlantId } from './plantIds.js';
import {
  allDrifts,
  clampGroup,
  clumpPositions,
  DEFAULT_MEMBER_RADIUS_FT,
  driftLifecycleSummary,
  driftMembers,
  driftSpacing,
  memberToRemove,
  MIN_SUGGESTION_CLUSTER_SIZE,
  nextMemberPosition,
  SPACING_FACTOR,
  spreadPositions,
} from './driftGeometry.js';

/**
 * "How many?" ceiling in the Add plant sheet (nl-o47.6.3): OUR JUDGEMENT, not
 * a technical limit. The sheet is a search-and-tap picker, not a bulk-planting
 * tool — someone wanting more than this is better served planting in a few
 * batches, or (later) painting a drift along a stroke (nl-o47.6.6).
 */
export const MAX_DRIFT_COUNT = 50;

/**
 * Every driftId currently used in the yard.
 * @param {Array<{driftId?: string}>} plants
 * @returns {string[]}
 */
function existingDriftIds(plants) {
  return allDrifts(plants).map((drift) => drift.driftId);
}

/**
 * Drop the driftId label from `driftId`'s own members if fewer than two of
 * them remain (nl-o47.6.9's ">= 2 members, always" rule) — a no-op when the
 * drift still has 2+ members, or none at all. dropUndersizedDrifts (imported
 * from src/data/driftId.js, re-exported below) is the whole-list version of
 * this same rule, for a caller that builds a fresh plant list rather than
 * editing one drift at a time.
 * @param {Array<object>} plants
 * @param {string} driftId
 * @returns {Array<object>}
 */
export function pruneUndersizedDrift(plants, driftId) {
  if (!driftId) return plants;
  const members = driftMembers(plants, driftId);
  if (members.length !== 1) return plants;
  return plants.map((plant) => {
    if (plant.driftId !== driftId) return plant;
    const next = { ...plant };
    delete next.driftId;
    return next;
  });
}

/**
 * Add N plants of one species from the catalog (nl-o47.6.3, the Add plant
 * sheet's "How many?"), at `at` in yard feet (or the plan's own middle — see
 * addPlantFromCatalog) when the visible centre could not be computed.
 *
 * N=1 is exactly src/state/plantEdits.js's addPlantFromCatalog: no driftId,
 * today's single-plant behaviour unchanged. That function is called once and
 * REUSED for N>1 too, rather than re-implemented here, purely to learn the
 * centre point it already clamps to the declared yard and the species' own
 * resolved width (its plants.csv width_ft, or createPlantFromSpecies' own
 * estimate when that is blank) — exactly what a clump needs, computed exactly
 * the way a single plant is placed today. For N>1 that one probe plant is
 * discarded (state.plants is put back the way addPlantFromCatalog found it)
 * and replaced by the whole clump: an evenly spaced sunflower/phyllotaxis
 * layout (src/state/driftGeometry.js clumpPositions) at spacing = the
 * species' width x SPACING_FACTOR (OUR JUDGEMENT — see driftGeometry.js),
 * translated to fit the declared yard as a GROUP so the clump keeps its shape
 * (clumpPositions already calls clampGroup; never clamped point-by-point,
 * which would flatten the pattern's edge against the boundary). Every member
 * is built the same way addDriftMember builds a new one (createPlantFromSpecies,
 * a fresh id from buildNewPlantId each time) and shares one new driftId,
 * minted (buildDriftId) from the species' common name, else its botanical
 * name — never from a name the person typed, since nothing here asks for one.
 * @param {{ plants: object[], species: object[], project: object }} state
 * @param {string} speciesId plants.csv's `id` for the species
 * @param {number} count how many to add; clamped to [1, MAX_DRIFT_COUNT]
 * @param {{ at?: { x: number, y: number } }} [options]
 * @returns {{ plants: object[], driftId: string|null }} the plants that were
 *   added (empty when the species or plan view is gone); `driftId` is null
 *   for a lone plant, which carries no drift label
 */
export function addDriftFromCatalog(state, speciesId, count, { at } = {}) {
  const n = Math.min(MAX_DRIFT_COUNT, Math.max(1, Math.trunc(Number(count)) || 1));

  const before = state.plants;
  const probe = addPlantFromCatalog(state, speciesId, { at });
  if (!probe) return { plants: [], driftId: null };
  if (n <= 1) return { plants: [probe], driftId: null };

  // n > 1: `probe` only taught us the clamped centre and the species'
  // resolved width; put the plants back the way addPlantFromCatalog found
  // them and build the real clump below instead of keeping it.
  state.plants = before;

  const speciesEntry = state.species.find((entry) => entry.speciesId === probe.speciesId);
  const bounds = resolveYardBounds(state.project);
  const spacing = (Number(probe.width) || DEFAULT_MEMBER_RADIUS_FT * 2) * SPACING_FACTOR;
  const positions = clumpPositions(n, spacing, { x: probe.x, y: probe.y }, bounds);
  const driftId = buildDriftId(
    existingDriftIds(state.plants),
    speciesEntry?.commonName || speciesEntry?.botanicalName || probe.speciesId
  );

  let plants = state.plants;
  const created = positions.map((position) => {
    const member = createPlantFromSpecies(speciesEntry, {
      id: buildNewPlantId(plants, speciesEntry.botanicalName || speciesEntry.speciesId),
      x: position.x,
      y: position.y,
      driftId,
    });
    plants = [...plants, member];
    return member;
  });
  state.plants = plants;
  return { plants: created, driftId };
}

/**
 * "+" on a SINGLE plant (nl-o47.6.9, the REVISED design's "count converts"):
 * turn it into a drift of 2, seamlessly, in one edit. Mints a driftId from
 * the species (buildDriftId, same as addDriftFromCatalog), places the second
 * member at the plant's own default spacing — driftGeometry.js's
 * nextMemberPosition, given just this one plant as its "members" array, is
 * exactly the 1-member fallback (the four cardinal directions) addDriftMember
 * already reuses for a real 1-member drift, so this is not a second
 * implementation of "where does the next member go" — and copies the
 * plant's own lifecycle onto it (nl-o47.6.10: a drift's members share one
 * planting status, so the very first member it ever gets already agrees).
 * `plantSelection.selectDrift(driftId)` (src/app.js) is what then makes the
 * new drift the selection, whole; this function only edits `state.plants`.
 * @param {{ plants: object[], species: object[], project: object }} state
 * @param {string} plantId
 * @returns {{ driftId: string|null, members: object[], reason: string|null }}
 */
export function convertToDrift(state, plantId) {
  const index = state.plants.findIndex((plant) => String(plant.id) === String(plantId));
  if (index < 0) return { driftId: null, members: [], reason: 'no such plant' };
  const original = state.plants[index];
  if (original.driftId) return { driftId: null, members: [], reason: 'already in a drift' };
  const speciesEntry = (state.species || []).find((entry) => entry.speciesId === original.speciesId);
  if (!speciesEntry) return { driftId: null, members: [], reason: 'the plant\'s species is no longer in the catalog' };

  const bounds = resolveYardBounds(state.project);
  const spacing = driftSpacing([original], original.width);
  const { position, reason } = nextMemberPosition([original], spacing, bounds);
  if (!position) return { driftId: null, members: [], reason };

  const driftId = buildDriftId(
    existingDriftIds(state.plants),
    speciesEntry.commonName || speciesEntry.botanicalName || original.speciesId
  );
  const second = withLifecycle(
    createPlantFromSpecies(speciesEntry, {
      id: buildNewPlantId(state.plants, speciesEntry.botanicalName || speciesEntry.speciesId),
      x: position.x,
      y: position.y,
      driftId,
    }),
    lifecycleOf(original)
  );
  const plants = [...state.plants];
  plants[index] = { ...original, driftId };
  plants.push(second);
  state.plants = plants;
  return { driftId, members: [plants[index], second], reason: null };
}

/**
 * "+": add one member to a drift, on its edge in the biggest angular gap, at
 * the drift's own spacing (src/state/driftGeometry.js nextMemberPosition).
 * The new plant is built the same way Add-from-catalog builds one
 * (createPlantFromSpecies, so it gets every species attribute and a computed
 * layer), carries the drift's id, and copies the drift's own shared
 * lifecycle onto it (nl-o47.6.10: "one planting status per drift" — the FIRST
 * member's values, via driftLifecycleSummary, so a drift whose members
 * happen to differ still gets a coherent value to copy rather than picking
 * one at random; its next lifecycle edit unifies every member anyway).
 * @param {{ plants: object[], species: object[], project: object }} state
 * @param {string} driftId
 * @returns {{ plant: object|null, reason: string|null }}
 */
export function addDriftMember(state, driftId) {
  const members = driftMembers(state.plants, driftId);
  if (!members.length) return { plant: null, reason: 'no such drift' };
  const speciesEntry = (state.species || []).find((entry) => entry.speciesId === members[0].speciesId);
  if (!speciesEntry) return { plant: null, reason: 'the drift\'s species is no longer in the catalog' };

  const bounds = resolveYardBounds(state.project);
  // Every member already carries its own `.width` from createPlantFromSpecies
  // (species catalog width, or an estimate when the species has none); read
  // it from a member rather than the species row, which can be blank.
  const spacing = driftSpacing(members, members[0].width);
  const { position, reason } = nextMemberPosition(members, spacing, bounds);
  if (!position) return { plant: null, reason };

  const base = createPlantFromSpecies(speciesEntry, {
    id: buildNewPlantId(state.plants, speciesEntry.botanicalName || speciesEntry.speciesId),
    x: position.x,
    y: position.y,
    driftId,
  });
  const plant = withLifecycle(base, driftLifecycleSummary(members).lifecycle);
  state.plants = [...state.plants, plant];
  return { plant, reason: null };
}

/**
 * "-": remove the drift's member src/state/driftGeometry.js's memberToRemove
 * picks (the farthest planned member from the centroid; refuses if only
 * planted members remain). If exactly one member would remain, it drops the
 * driftId label with it (nl-o47.6.9: a drift always has >= 2 members; 1 -> 2
 * -> 1 hands the original plant back, unlabelled, as a plain single plant).
 * @param {{ plants: object[] }} state
 * @param {string} driftId
 * @returns {{ plant: object|null, reason: string|null }}
 */
export function removeDriftMember(state, driftId) {
  const members = driftMembers(state.plants, driftId);
  if (!members.length) return { plant: null, reason: 'no such drift' };
  const { member, reason } = memberToRemove(members);
  if (!member) return { plant: null, reason };
  const remaining = state.plants.filter((plant) => plant.id !== member.id);
  state.plants = pruneUndersizedDrift(remaining, driftId);
  return { plant: member, reason: null };
}

/**
 * Spread tighter/looser: scale a drift's members about their centroid,
 * clamped to the yard as a group (src/state/driftGeometry.js spreadPositions)
 * so the shape survives rather than individual members being squashed.
 * @param {{ plants: object[], project: object }} state
 * @param {string} driftId
 * @param {number} factor
 * @returns {{ members: object[], appliedFactor: number, reason: string|null }}
 */
export function spreadDrift(state, driftId, factor) {
  const members = driftMembers(state.plants, driftId);
  if (!members.length) return { members: [], appliedFactor: 1, reason: 'no such drift' };
  const bounds = resolveYardBounds(state.project);
  const { positions, appliedFactor } = spreadPositions(members, factor, bounds);
  const byId = new Map(positions.map((p) => [p.id, p]));
  state.plants = state.plants.map((plant) => {
    const next = byId.get(plant.id);
    return next ? { ...plant, x: next.x, y: next.y } : plant;
  });
  const updated = state.plants.filter((plant) => byId.has(plant.id));
  return { members: updated, appliedFactor, reason: null };
}

/**
 * Clone a whole drift: every member is copied (a new plant id from
 * buildCloneId, lifecycle dropped the way clonePlantById drops it — a clone
 * is not in the ground and came from nowhere), the copy gets one new driftId
 * (buildDriftId, from the species — a fresh drift, not the original, so it is
 * named afresh rather than inheriting whatever name the original was given),
 * and the whole copy is offset on the x axis by the original drift's own
 * width plus its spacing — clear of every original member, not a fixed nudge
 * that would work for one plant but interleave a whole mass planting with
 * its copy — then clamped to the yard as a group (clampGroup), the same
 * translate-to-fit spreadDrift/clumpPositions use. If offsetting to the east
 * would not fit the yard, west is tried instead; if neither cleanly fits,
 * east is kept and clampGroup does its best effort.
 * @param {{ plants: object[], project: object }} state
 * @param {string} driftId
 * @returns {{ driftId: string|null, plants: object[], reason: string|null }}
 */
export function cloneDrift(state, driftId) {
  const members = driftMembers(state.plants, driftId);
  if (!members.length) return { driftId: null, plants: [], reason: 'no such drift' };

  const newDriftId = buildDriftId(existingDriftIds(state.plants), members[0].speciesId);
  const bounds = resolveYardBounds(state.project);
  const spacing = driftSpacing(members, members[0].width);
  const xs = members.map((m) => m.x);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const offsetFt = maxX - minX + spacing;
  const dx = bounds && maxX + offsetFt > bounds.x.max && minX - offsetFt >= bounds.x.min ? -offsetFt : offsetFt;

  let plants = state.plants;
  const clones = [];
  members.forEach((member) => {
    const copied = { ...member };
    LIFECYCLE_KEYS.forEach((key) => delete copied[key]);
    const clone = {
      ...copied,
      id: buildCloneId(plants, member.id),
      driftId: newDriftId,
      x: member.x + dx,
      y: member.y,
    };
    plants = [...plants, clone];
    clones.push(clone);
  });

  if (bounds) {
    const shifted = clampGroup(
      clones.map((c) => ({ id: c.id, x: c.x, y: c.y })),
      bounds
    );
    const byId = new Map(shifted.map((p) => [p.id, p]));
    plants = plants.map((plant) => {
      const next = byId.get(plant.id);
      return next ? { ...plant, x: next.x, y: next.y } : plant;
    });
  }

  state.plants = plants;
  return { driftId: newDriftId, plants: state.plants.filter((p) => p.driftId === newDriftId), reason: null };
}

/**
 * Clone ONE plant — plantEdits.js's own clonePlantById, which starts every
 * clone planned with no source, since a clone is not in the ground and came
 * from nowhere — except that a clone which STAYS in a drift (clonePlantById
 * already carries driftId through like any other field) copies the source
 * member's own lifecycle instead (nl-o47.6.10: "one planting status per
 * drift" holds from the moment a member exists, not only once an explicit
 * lifecycle edit reaches it). Cloning a plant in no drift, or cloning a whole
 * drift (cloneDrift, above, which already starts every copy uniformly
 * planned), is unaffected. The drilled-in selection bar's Clone, the detail
 * sheet's Clone, and the plant context menu's Clone all go through this
 * rather than clonePlantById directly.
 * @param {{ plants: object[], project: object }} state
 * @param {string} plantId
 * @returns {object|null} the clone, or null if plantId does not resolve
 */
export function cloneDriftAwarePlant(state, plantId) {
  const source = state.plants.find((plant) => String(plant.id) === String(plantId));
  const clone = clonePlantById(state, plantId);
  if (!clone || !source?.driftId) return clone;
  const withCopiedLifecycle = withLifecycle(clone, lifecycleOf(source));
  state.plants = state.plants.map((plant) => (plant.id === clone.id ? withCopiedLifecycle : plant));
  return withCopiedLifecycle;
}

/**
 * Remove one plant from its drift (it stays in the yard, just no longer
 * labelled). A no-op, not an error, for a plant already in no drift. If doing
 * so would leave exactly one member behind, that member loses the driftId
 * label too (nl-o47.6.9: a drift always has >= 2 members) — the whole drift
 * ends, not just this one plant's membership in it.
 * @param {{ plants: object[] }} state
 * @param {string} plantId
 * @returns {{ plant: object|null, reason: string|null }}
 */
export function removePlantFromDrift(state, plantId) {
  const id = String(plantId ?? '');
  const index = state.plants.findIndex((plant) => String(plant.id) === id);
  if (index < 0) return { plant: null, reason: 'no such plant' };
  const current = state.plants[index];
  if (!current.driftId) return { plant: current, reason: null };
  const driftId = current.driftId;
  const next = { ...current };
  delete next.driftId;
  const plants = [...state.plants];
  plants[index] = next;
  state.plants = pruneUndersizedDrift(plants, driftId);
  return { plant: state.plants[index], reason: null };
}

/**
 * Delete one plant outright — plantEdits.js's own removePlantById, which
 * knows nothing about drifts — except that if the deleted plant belonged to a
 * drift and doing so leaves exactly one member behind, that member loses the
 * driftId label too (nl-o47.6.9: a drift always has >= 2 members). This is
 * NOT "Remove from drift" (removePlantFromDrift above), which unlabels a
 * plant without deleting it: it is what a drilled-in member's own Remove, the
 * detail sheet's Remove, and the plant context menu's Remove all mean — they
 * delete the one plant they were opened for, drift or no drift, and every one
 * of them goes through this rather than removePlantById directly so the
 * invariant holds no matter which of them a person used.
 * @param {{ plants: object[] }} state
 * @param {string} plantId
 * @returns {boolean} whether a plant was actually removed
 */
export function removeDriftAwarePlant(state, plantId) {
  const target = state.plants.find((plant) => String(plant.id) === String(plantId));
  if (!target) return false;
  const driftId = target.driftId || '';
  if (!removePlantById(state, plantId)) return false;
  if (driftId) state.plants = pruneUndersizedDrift(state.plants, driftId);
  return true;
}

/**
 * Dissolve a drift: every member stays exactly where it is, just no longer
 * labelled with a driftId. The inverse of nothing — there is no "make a
 * drift" edit here (nl-o47.6.3/.4/.6 build that), only what takes one apart.
 * @param {{ plants: object[] }} state
 * @param {string} driftId
 * @returns {{ members: object[], reason: string|null }}
 */
export function dissolveDrift(state, driftId) {
  const members = driftMembers(state.plants, driftId);
  if (!members.length) return { members: [], reason: 'no such drift' };
  state.plants = state.plants.map((plant) => {
    if (plant.driftId !== driftId) return plant;
    const next = { ...plant };
    delete next.driftId;
    return next;
  });
  return { members: state.plants.filter((plant) => members.some((m) => m.id === plant.id)), reason: null };
}

/**
 * Remove a whole drift (nl-o47.6.2's action bar "Remove drift"): a PLANTED
 * member is never deleted automatically (the same rule "-"/memberToRemove
 * follows) — it just loses the driftId label, exactly like dissolveDrift, and
 * stays in the yard as a single plant. A PLANNED member is deleted outright,
 * the same as removePlantById would do to it one at a time. The two counts
 * are returned so the action bar can say what it is about to do before it
 * acts (its own confirmation, never window.confirm).
 * @param {{ plants: object[] }} state
 * @param {string} driftId
 * @returns {{ removedCount: number, dissolvedCount: number, reason: string|null }}
 */
export function removeDrift(state, driftId) {
  const members = driftMembers(state.plants, driftId);
  if (!members.length) return { removedCount: 0, dissolvedCount: 0, reason: 'no such drift' };
  const removedIds = new Set(members.filter((m) => lifecycleOf(m).status !== 'planted').map((m) => m.id));
  state.plants = state.plants
    .filter((plant) => !removedIds.has(plant.id))
    .map((plant) => {
      if (plant.driftId !== driftId) return plant;
      const next = { ...plant };
      delete next.driftId;
      return next;
    });
  return { removedCount: removedIds.size, dissolvedCount: members.length - removedIds.size, reason: null };
}

/**
 * Set a WHOLE DRIFT's lifecycle in one edit (nl-o47.6.10: "one planting
 * status per drift" — status, planted date, source, and local ecotype are
 * shared by every member, never edited separately). The exact counterpart of
 * src/state/plantEdits.js's setPlantLifecycle for one plant: `fields` is
 * merged over the drift's CURRENT shared lifecycle — its first member's
 * values (driftGeometry.js's driftLifecycleSummary; a drift whose members
 * happen to differ, from older data or an import, shows and merges onto the
 * first member's values, and this edit is exactly what unifies every member
 * onto the result) — checked once with validateLifecycle, and a refused edit
 * changes nothing, same as for one plant.
 * @param {{ plants: object[] }} state
 * @param {string} driftId
 * @param {{ status?: string, plantedOn?: string, source?: object|null, localEcotype?: boolean }} fields
 * @param {{ today?: string }} [options] passed to validateLifecycle
 * @returns {{ members: object[], problems: string[] }} every member with the
 *   new lifecycle applied, or [] with the problems (empty when the drift is
 *   gone or nothing actually changed)
 */
/**
 * Accept a suggested drift (nl-o47.6.5, "suggest drifts from an existing
 * yard"): mint one driftId (buildDriftId, the same rule addDriftFromCatalog
 * and convertToDrift already use) and write it onto exactly `memberIds` — the
 * REVIEWED, possibly person-adjusted membership, not necessarily
 * suggestClusters' own raw cluster — as ONE state.plants replacement, so a
 * caller's single commit is one history entry regardless of whether a
 * lifecycle was also unified in the same call.
 *
 * "One planting status per drift" (nl-o47.6.10) is enforced here, not left to
 * the caller: if the members disagree and no `lifecycle` choice is given, the
 * accept is refused outright — Accept must never silently pick one. When
 * `lifecycle` IS given (the person's own choice among the distinct ones
 * found, src/state/driftSuggestions.js's summarizeSuggestionLifecycle), it is
 * applied through setDriftLifecycle in the SAME call; a refused lifecycle
 * (validateLifecycle catches a future-dated plantedOn an old import can
 * carry) rolls the driftId assignment back too, rather than leaving a fresh
 * drift with no valid shared lifecycle.
 * @param {{ plants: object[], species: object[] }} state
 * @param {Iterable<string>} memberIds
 * @param {{ lifecycle?: { status?: string, plantedOn?: string, source?: object|null, localEcotype?: boolean } }} [options]
 * @returns {{ driftId: string|null, members: object[], reason: string|null }}
 */
export function acceptDriftSuggestion(state, memberIds, { lifecycle } = {}) {
  const ids = new Set(Array.from(memberIds ?? [], String));
  if (ids.size < MIN_SUGGESTION_CLUSTER_SIZE) {
    return { driftId: null, members: [], reason: `a drift needs at least ${MIN_SUGGESTION_CLUSTER_SIZE} plants` };
  }
  const members = state.plants.filter((plant) => ids.has(String(plant.id)));
  if (members.length !== ids.size) {
    return { driftId: null, members: [], reason: 'some of these plants no longer exist' };
  }
  if (members.some((plant) => plant.driftId)) {
    return { driftId: null, members: [], reason: 'a plant here is already in a drift' };
  }
  const speciesId = members[0].speciesId;
  if (!speciesId || !members.every((plant) => plant.speciesId === speciesId)) {
    return { driftId: null, members: [], reason: 'a drift is one species' };
  }
  if (!lifecycle && !driftLifecycleSummary(members).uniform) {
    return { driftId: null, members: [], reason: 'choose the planting status these plants share' };
  }

  const before = state.plants;
  const speciesEntry = (state.species || []).find((entry) => entry.speciesId === speciesId);
  const driftId = buildDriftId(
    existingDriftIds(state.plants),
    speciesEntry?.commonName || speciesEntry?.botanicalName || speciesId
  );
  state.plants = state.plants.map((plant) => (ids.has(String(plant.id)) ? { ...plant, driftId } : plant));
  if (lifecycle) {
    const { problems } = setDriftLifecycle(state, driftId, lifecycle);
    if (problems.length) {
      state.plants = before; // never leave a driftId assigned with no valid shared lifecycle
      return { driftId: null, members: [], reason: problems.join(' ') };
    }
  }
  return { driftId, members: driftMembers(state.plants, driftId), reason: null };
}

export function setDriftLifecycle(state, driftId, fields, options) {
  const members = driftMembers(state.plants, driftId);
  if (!members.length) return { members: [], problems: [] };
  const merged = { ...driftLifecycleSummary(members).lifecycle, ...fields };
  if (merged.status !== 'planted') merged.plantedOn = '';
  const problems = validateLifecycle(merged, options);
  if (problems.length) return { members: [], problems };

  const memberIds = new Set(members.map((m) => m.id));
  // Same no-op check setPlantLifecycle makes for one plant: every member
  // already reads exactly like `merged`, canonical form compared as JSON.
  const targetKey = JSON.stringify(lifecycleOf(merged));
  const alreadyMatches = members.every((m) => JSON.stringify(lifecycleOf(m)) === targetKey);
  if (alreadyMatches) return { members: [], problems: [] };

  state.plants = state.plants.map((plant) => (memberIds.has(plant.id) ? withLifecycle(plant, merged) : plant));
  return { members: state.plants.filter((plant) => memberIds.has(plant.id)), problems: [] };
}
