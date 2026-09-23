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

export function clonePlantById(state, plantId) {
  if (!plantId) return null;
  const source = state.plants.find((p) => String(p.id) === String(plantId));
  if (!source) return null;
  const planView = state.project.views.find((view) => view.type === 'plan');
  const { originFt, extentFt } = createViewTransform(planView);
  const offset = 1.1;
  const clone = {
    ...source,
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
 * @param {string} botanicalKey the select's value: a normalized botanical name
 * @returns {Object|null} the new plant, or null if the species or plan view is gone
 */
export function addPlantFromCatalog(state, botanicalKey) {
  const key = String(botanicalKey || '');
  if (!key) return null;
  const speciesEntry = state.species.find(
    (entry) => (entry.botanicalKey || entry.botanicalName) === key
  );
  // buildLayoutCsv writes botanicalName and buildPlantsFromCsv matches on it, so
  // a species without one would write a row that cannot be read back.
  if (!speciesEntry || !speciesEntry.botanicalName) return null;
  const planView = state.project?.views?.find((view) => view.type === 'plan');
  if (!planView) return null;
  const { originFt, extentFt } = createViewTransform(planView);
  const plant = createPlantFromSpecies(speciesEntry, {
    id: buildNewPlantId(state.plants, speciesEntry.botanicalName),
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

function clampFeet(value, min, max) {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
