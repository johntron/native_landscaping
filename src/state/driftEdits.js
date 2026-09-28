/**
 * Edits to a drift (nl-o47.6): grow it, shrink it, spread it, rename it,
 * clone it, or take it apart. Each takes the app state, replaces
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
 */
import { resolveYardBounds } from '../render/yardBounds.js';
import { createPlantFromSpecies } from '../data/plantParser.js';
import { LIFECYCLE_KEYS } from '../data/plantLifecycle.js';
import { slugifyDriftLabel } from '../data/driftId.js';
import { addPlantFromCatalog } from './plantEdits.js';
import { buildCloneId, buildDriftId, buildNewPlantId } from './plantIds.js';
import {
  allDrifts,
  clampGroup,
  clumpPositions,
  DEFAULT_MEMBER_RADIUS_FT,
  driftMembers,
  driftSpacing,
  memberToRemove,
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
 * the drift's own spacing (src/state/driftGeometry.js nextMemberPosition).
 * The new plant is built the same way Add-from-catalog builds one
 * (createPlantFromSpecies, so it gets every species attribute and a computed
 * layer), starts planned with no source (LIFECYCLE_KEYS are never copied from
 * anywhere here — there is nothing to copy them from), and carries the
 * drift's id.
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

  const plant = createPlantFromSpecies(speciesEntry, {
    id: buildNewPlantId(state.plants, speciesEntry.botanicalName || speciesEntry.speciesId),
    x: position.x,
    y: position.y,
    driftId,
  });
  state.plants = [...state.plants, plant];
  return { plant, reason: null };
}

/**
 * "-": remove the drift's member src/state/driftGeometry.js's memberToRemove
 * picks (the farthest planned member from the centroid; refuses if only
 * planted members remain).
 * @param {{ plants: object[] }} state
 * @param {string} driftId
 * @returns {{ plant: object|null, reason: string|null }}
 */
export function removeDriftMember(state, driftId) {
  const members = driftMembers(state.plants, driftId);
  if (!members.length) return { plant: null, reason: 'no such drift' };
  const { member, reason } = memberToRemove(members);
  if (!member) return { plant: null, reason };
  state.plants = state.plants.filter((plant) => plant.id !== member.id);
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
 * Rename a drift: rewrite `driftId` on every one of its members to a slug of
 * `label` (src/data/driftId.js slugifyDriftLabel, which always yields a valid
 * one — a label with no usable characters slugs to 'drift'). Refuses a name
 * that collides with a DIFFERENT existing drift; renaming a drift to the name
 * it already has is a no-op, not a collision.
 * @param {{ plants: object[] }} state
 * @param {string} driftId
 * @param {string} label
 * @returns {{ driftId: string|null, reason: string|null }}
 */
export function renameDrift(state, driftId, label) {
  const members = driftMembers(state.plants, driftId);
  if (!members.length) return { driftId: null, reason: 'no such drift' };
  const nextId = slugifyDriftLabel(label);
  if (nextId === driftId) return { driftId, reason: null };
  if (existingDriftIds(state.plants).includes(nextId)) {
    return { driftId: null, reason: `"${nextId}" is already the name of another drift` };
  }
  state.plants = state.plants.map((plant) => (plant.driftId === driftId ? { ...plant, driftId: nextId } : plant));
  return { driftId: nextId, reason: null };
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
 * Remove one plant from its drift (it stays in the yard, just no longer
 * labelled). A no-op, not an error, for a plant already in no drift.
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
  const next = { ...current };
  delete next.driftId;
  const plants = [...state.plants];
  plants[index] = next;
  state.plants = plants;
  return { plant: next, reason: null };
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
