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
 * driftId and writes back only their `x`, `y`, `driftId`, or lifecycle
 * fields — the geometry itself is never stored anywhere these functions have
 * to keep in sync.
 *
 * A plant is clamped to the declared yard, never to a view's own rectangle
 * (docs/design-tool.md "Yard bounds"; src/render/yardBounds.js), so every
 * edit that can move or place a plant reads bounds from `resolveYardBounds`,
 * not from a view's origin/extent the way clonePlantById does.
 *
 * A DRIFT ALWAYS HAS AT LEAST TWO MEMBERS, ONE SPECIES, AND ONE LIFECYCLE
 * (nl-o47.6's REVISED design, 2026-09-28, nl-o47.6.9/.10; nl-o47.6.12
 * collapses the three onto one enforcement point): every edit below that can
 * leave a drift undersized, mixed-species, or mixed-lifecycle — growing a
 * lone plant or an existing drift (addDriftMember), cloning a member
 * (cloneDriftAwarePlant), or shrinking one (removeDriftMember,
 * removePlantFromDrift, removeDriftAwarePlant) — does the plain edit (add or
 * remove a plant, set or drop a driftId field) and then calls
 * src/data/driftId.js's `normalizeDrifts` on the whole list, rather than each
 * carrying its own bespoke pruning/copying logic. A UI handler never has to
 * remember any of this itself.
 */
import { resolveYardBounds } from '../render/yardBounds.js';
import { createPlantFromSpecies } from '../data/plantParser.js';
import { LIFECYCLE_KEYS, lifecycleOf, validateLifecycle, withLifecycle } from '../data/plantLifecycle.js';
import { normalizeDrifts } from '../data/driftId.js';
import { addPlantFromCatalog, clonePlantById, removePlantById } from './plantEdits.js';
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
 * "+": add one member to a drift, on its edge in the biggest angular gap, at
 * the drift's own spacing (src/state/driftGeometry.js nextMemberPosition) —
 * OR, given a `plantId` for a plant in no drift yet, mint a fresh drift of 2
 * from it (nl-o47.6.9's "count converts": the count stepper reads 1 with "+"
 * on a single plain plant too, going through this same path; nl-o47.6.12
 * folds what used to be a separate convertToDrift into this one "grow"
 * function, since both are just "place one more member of this species,
 * minting a driftId first if there isn't one yet"). Pass a string (an
 * existing `driftId`) for the first case or `{ plantId }` for the second —
 * never both.
 *
 * The new member is built the same way Add-from-catalog builds one
 * (createPlantFromSpecies, so it gets every species attribute and a computed
 * layer). Its position comes from nextMemberPosition given the CURRENT
 * members (or, converting a lone plant, that one plant as a 1-member array —
 * driftGeometry.js's own 1-member fallback, the four cardinal directions, so
 * this is not a second implementation of "where does the next member go").
 * The plain edit — add the new member, and for a fresh drift relabel the
 * original plant too — is followed by one normalizeDrifts call (nl-o47.6.12),
 * which unifies the new member's lifecycle onto the drift's shared one (the
 * FIRST member's, by array order — the original plant, for a fresh drift, or
 * whichever existing member is earliest, for a real one) rather than this
 * function copying it directly: a drift's very first "+" already agrees with
 * the rest, and a mixed-lifecycle drift (older data, an import) is healed by
 * its next "+" too, not just by a load.
 * @param {{ plants: object[], species: object[], project: object }} state
 * @param {string|{ driftId?: string, plantId?: string }} target
 * @returns {{ plant: object|null, driftId: string|null, reason: string|null }}
 *   `plant` is the new member; `driftId` is the drift it (now) belongs to —
 *   freshly minted when `target` was a plantId
 */
export function addDriftMember(state, target) {
  const driftId = typeof target === 'string' ? target : target?.driftId || null;
  const plantId = typeof target === 'string' ? null : target?.plantId || null;

  let members;
  let convertedFrom = null; // the lone plant, when minting a fresh drift
  if (driftId) {
    members = driftMembers(state.plants, driftId);
    if (!members.length) return { plant: null, driftId: null, reason: 'no such drift' };
  } else {
    const original = state.plants.find((plant) => String(plant.id) === String(plantId));
    if (!original) return { plant: null, driftId: null, reason: 'no such plant' };
    if (original.driftId) return { plant: null, driftId: null, reason: 'already in a drift' };
    members = [original];
    convertedFrom = original;
  }

  const speciesEntry = (state.species || []).find((entry) => entry.speciesId === members[0].speciesId);
  if (!speciesEntry) return { plant: null, driftId: null, reason: 'the drift\'s species is no longer in the catalog' };

  const bounds = resolveYardBounds(state.project);
  // Every member already carries its own `.width` from createPlantFromSpecies
  // (species catalog width, or an estimate when the species has none); read
  // it from a member rather than the species row, which can be blank.
  const spacing = driftSpacing(members, members[0].width);
  const { position, reason } = nextMemberPosition(members, spacing, bounds);
  if (!position) return { plant: null, driftId: null, reason };

  const resolvedDriftId =
    driftId ||
    buildDriftId(
      existingDriftIds(state.plants),
      speciesEntry.commonName || speciesEntry.botanicalName || members[0].speciesId
    );

  const newMember = createPlantFromSpecies(speciesEntry, {
    id: buildNewPlantId(state.plants, speciesEntry.botanicalName || speciesEntry.speciesId),
    x: position.x,
    y: position.y,
    driftId: resolvedDriftId,
  });

  let plants = state.plants;
  if (convertedFrom) {
    plants = plants.map((plant) => (plant === convertedFrom ? { ...plant, driftId: resolvedDriftId } : plant));
  }
  state.plants = normalizeDrifts([...plants, newMember]);
  const settledMember = state.plants.find((plant) => plant.id === newMember.id) ?? newMember;
  return { plant: settledMember, driftId: resolvedDriftId, reason: null };
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
  state.plants = normalizeDrifts(state.plants.filter((plant) => plant.id !== member.id));
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
 * already carries driftId through like any other field) has its lifecycle
 * unified onto the drift's shared one instead (nl-o47.6.10: "one planting
 * status per drift" holds from the moment a member exists, not only once an
 * explicit lifecycle edit reaches it): the plain clone, then one
 * normalizeDrifts call (nl-o47.6.12), the same "plain edit, then normalize"
 * every other drift-aware edit here uses. Cloning a plant in no drift, or
 * cloning a whole drift (cloneDrift, above, which already starts every copy
 * uniformly planned), is unaffected. The drilled-in selection bar's Clone,
 * the detail sheet's Clone, and the plant context menu's Clone all go
 * through this rather than clonePlantById directly.
 * @param {{ plants: object[], project: object }} state
 * @param {string} plantId
 * @returns {object|null} the clone, or null if plantId does not resolve
 */
export function cloneDriftAwarePlant(state, plantId) {
  const source = state.plants.find((plant) => String(plant.id) === String(plantId));
  const clone = clonePlantById(state, plantId);
  if (!clone || !source?.driftId) return clone;
  state.plants = normalizeDrifts(state.plants);
  return state.plants.find((plant) => plant.id === clone.id) ?? clone;
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
  const plants = [...state.plants];
  const next = { ...current };
  delete next.driftId;
  plants[index] = next;
  state.plants = normalizeDrifts(plants);
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
  const wasInDrift = Boolean(target.driftId);
  if (!removePlantById(state, plantId)) return false;
  if (wasInDrift) state.plants = normalizeDrifts(state.plants);
  return true;
}

/**
 * Remove a whole drift (nl-o47.6.2's action bar "Remove drift"): a PLANTED
 * member is never deleted automatically (the same rule "-"/memberToRemove
 * follows) — it just loses the driftId label and stays in the yard as a
 * single plant. A PLANNED member is deleted outright,
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
 * The shared core of acceptDriftSuggestion (nl-o47.6.5) and acceptDriftGroup
 * (nl-o47.6.4, below): mint one driftId (buildDriftId, the same rule
 * addDriftFromCatalog and addDriftMember's plantId path already use) and
 * write it onto exactly `memberIds` — the REVIEWED, possibly person-adjusted
 * membership — as ONE state.plants replacement, so a caller's single commit
 * is one history entry regardless of whether a lifecycle was also unified in
 * the same call.
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
 *
 * The two callers differ in exactly one thing, `allowMove`: a suggestion
 * (src/state/driftSuggestions.js's suggestClusters) never proposes a member
 * that already carries a driftId, so acceptDriftSuggestion keeps refusing one
 * defensively; a hand-made group (src/state/driftGroup.js's
 * toggleGroupMember) explicitly INVITES tapping one in, so acceptDriftGroup
 * allows it and runs normalizeDrifts afterward to clean up whatever moving a
 * member leaves behind at its OLD drift (a lone leftover drops its label,
 * src/data/driftId.js) — the only case that can ever leave another drift
 * undersized, so acceptDriftSuggestion has never needed that pass.
 * @param {{ plants: object[], species: object[] }} state
 * @param {Iterable<string>} memberIds
 * @param {{ lifecycle?: { status?: string, plantedOn?: string, source?: object|null, localEcotype?: boolean }, allowMove?: boolean }} [options]
 * @returns {{ driftId: string|null, members: object[], reason: string|null }}
 */
function acceptDriftMembership(state, memberIds, { lifecycle, allowMove = false } = {}) {
  const ids = new Set(Array.from(memberIds ?? [], String));
  if (ids.size < MIN_SUGGESTION_CLUSTER_SIZE) {
    return { driftId: null, members: [], reason: `a drift needs at least ${MIN_SUGGESTION_CLUSTER_SIZE} plants` };
  }
  const members = state.plants.filter((plant) => ids.has(String(plant.id)));
  if (members.length !== ids.size) {
    return { driftId: null, members: [], reason: 'some of these plants no longer exist' };
  }
  if (!allowMove && members.some((plant) => plant.driftId)) {
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
  let plants = state.plants.map((plant) => (ids.has(String(plant.id)) ? { ...plant, driftId } : plant));
  if (allowMove) plants = normalizeDrifts(plants); // cleans up any OLD drift a moved member left behind
  state.plants = plants;
  if (lifecycle) {
    const { problems } = setDriftLifecycle(state, driftId, lifecycle);
    if (problems.length) {
      state.plants = before; // never leave a driftId assigned with no valid shared lifecycle
      return { driftId: null, members: [], reason: problems.join(' ') };
    }
  }
  return { driftId, members: driftMembers(state.plants, driftId), reason: null };
}

/**
 * Accept a suggested drift (nl-o47.6.5, "suggest drifts from an existing
 * yard") — see acceptDriftMembership above for the shared shape. A suggested
 * member never already carries a driftId (suggestClusters excludes one), so
 * this keeps refusing one defensively rather than moving it.
 * @param {{ plants: object[], species: object[] }} state
 * @param {Iterable<string>} memberIds
 * @param {{ lifecycle?: { status?: string, plantedOn?: string, source?: object|null, localEcotype?: boolean } }} [options]
 * @returns {{ driftId: string|null, members: object[], reason: string|null }}
 */
export function acceptDriftSuggestion(state, memberIds, options = {}) {
  return acceptDriftMembership(state, memberIds, options);
}

/**
 * Accept a HAND-MADE drift proposal (nl-o47.6.4, "group selected plants"):
 * the exact same one-history-entry shape as acceptDriftSuggestion, except a
 * member MAY already belong to another real drift — it moves into the new
 * one instead of being refused, and the drift it moved OUT of is cleaned up
 * in the same call (acceptDriftMembership's `allowMove`, above). The bar that
 * built `memberIds` (src/interaction/driftReviewMode.js's group mode) already
 * said how many were about to move, from src/state/driftGroup.js's
 * summarizeGroupSources, so this is never a surprise.
 * @param {{ plants: object[], species: object[] }} state
 * @param {Iterable<string>} memberIds
 * @param {{ lifecycle?: { status?: string, plantedOn?: string, source?: object|null, localEcotype?: boolean } }} [options]
 * @returns {{ driftId: string|null, members: object[], reason: string|null }}
 */
export function acceptDriftGroup(state, memberIds, options = {}) {
  return acceptDriftMembership(state, memberIds, { ...options, allowMove: true });
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
