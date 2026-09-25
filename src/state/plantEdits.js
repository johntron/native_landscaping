/**
 * Add, clone, and remove plants in the layout. Each takes the app state,
 * replaces `state.plants` with a new array (never mutates it), and returns
 * what changed, so the caller can push one undo entry and re-render.
 * Every new plant id is minted by src/state/plantIds.js.
 */
import { createViewTransform } from '../render/viewTransform.js';
import { createPlantFromSpecies } from '../data/plantParser.js';
import { classifyPlantLayer } from './layers.js';
import { buildCloneId, buildNewPlantId } from './plantIds.js';
import { LIFECYCLE_KEYS, lifecycleOf, validateLifecycle, withLifecycle } from '../data/plantLifecycle.js';

export function clonePlantById(state, plantId) {
  if (!plantId) return null;
  const source = state.plants.find((p) => String(p.id) === String(plantId));
  if (!source) return null;
  const planView = state.project.views.find((view) => view.type === 'plan');
  const { originFt, extentFt } = createViewTransform(planView);
  const offset = 1.1;
  // A clone is a new plant in the plan: it is not in the ground yet and came
  // from nowhere, whatever the plant it was copied from records (nl-3s5.22).
  const copied = { ...source };
  LIFECYCLE_KEYS.forEach((key) => delete copied[key]);
  const clone = {
    ...copied,
    id: buildCloneId(state.plants, source.id),
    x: clampFeet(source.x + offset, originFt.x, originFt.x + extentFt.width),
    y: clampFeet(source.y + offset * 0.6, originFt.y, originFt.y + extentFt.height),
  };
  clone.layer = classifyPlantLayer(clone);
  state.plants = [...state.plants, clone];
  return clone;
}

/**
 * Place one plant of the chosen species at the middle of the plan view — the
 * one spot guaranteed to be on the drawing, from which it can be dragged.
 * @param {{ plants: object[], species: object[], project: object }} state  src/app.js's appState
 * @param {string} speciesId the select's value: plants.csv's `id` for the species
 * @returns {Object|null} the new plant, or null if the species or plan view is gone
 */
export function addPlantFromCatalog(state, speciesId) {
  const key = String(speciesId || '');
  if (!key) return null;
  // buildLayoutCsv writes speciesId and buildPlantsFromCsv resolves by it, so the
  // match is on the id alone: never on a name that could be renamed.
  const speciesEntry = state.species.find((entry) => entry.speciesId === key);
  if (!speciesEntry) return null;
  const planView = state.project?.views?.find((view) => view.type === 'plan');
  if (!planView) return null;
  const { originFt, extentFt } = createViewTransform(planView);
  const plant = createPlantFromSpecies(speciesEntry, {
    id: buildNewPlantId(state.plants, speciesEntry.botanicalName || speciesEntry.speciesId),
    x: originFt.x + extentFt.width / 2,
    y: originFt.y + extentFt.height / 2,
  });
  state.plants = [...state.plants, plant];
  return plant;
}

/**
 * Drop a plant from the layout.
 * @returns {boolean} whether a plant was actually removed
 */
export function removePlantById(state, plantId) {
  if (!plantId) return false;
  const id = String(plantId);
  const remaining = state.plants.filter((plant) => String(plant.id) !== id);
  if (remaining.length === state.plants.length) return false;
  state.plants = remaining;
  return true;
}

/**
 * Set one plant's lifecycle (status, planting date, source). `fields` is
 * merged over the plant's current lifecycle, so the panel can send only what
 * changed; switching to planned drops the date. The result is checked with
 * validateLifecycle first, and a refused edit changes nothing.
 * @param {{ plants: object[] }} state
 * @param {string} plantId
 * @param {{ status?: string, plantedOn?: string, source?: object|null }} fields
 * @param {{ today?: string }} [options] passed to validateLifecycle
 * @returns {{ plant: object|null, problems: string[] }} the new plant, or null
 *   with the problems (none when the plant is gone or nothing changed)
 */
export function setPlantLifecycle(state, plantId, fields, options) {
  const id = String(plantId ?? '');
  const index = state.plants.findIndex((plant) => String(plant.id) === id);
  if (!id || index < 0) return { plant: null, problems: [] };
  const current = state.plants[index];
  const merged = { ...lifecycleOf(current), ...fields };
  if (merged.status !== 'planted') merged.plantedOn = '';
  const problems = validateLifecycle(merged, options);
  if (problems.length) return { plant: null, problems };
  const next = withLifecycle(current, merged);
  if (JSON.stringify(lifecycleOf(next)) === JSON.stringify(lifecycleOf(current))) {
    return { plant: null, problems: [] };
  }
  const plants = [...state.plants];
  plants[index] = next;
  state.plants = plants;
  return { plant: next, problems: [] };
}

function clampFeet(value, min, max) {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
