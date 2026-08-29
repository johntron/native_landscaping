export const PLANT_LAYERS = ['trees', 'sculptural', 'accents', 'groundcover'];

/**
 * Bucket plants into broad vertical layers so we can hide upper strata.
 * Uses height first, with growth shape as a hint for sculptural forms.
 */
export function classifyPlantLayer(plant) {
  const height = Number(plant?.height ?? plant?.height_ft ?? 0) || 0;
  const shape = (plant?.growthShape || plant?.growth_shape || '').toLowerCase();
  const width = Number(plant?.width ?? plant?.width_ft ?? 0) || 0;

  if (shape === 'creeping') return 'groundcover';
  if (shape === 'tree') return 'trees';
  if (height >= 4 || shape === 'vertical' || shape === 'vase' || shape === 'arch') {
    return 'sculptural';
  }
  if (height >= 1.25) return 'accents';
  return 'groundcover';
}

/**
 * Same buckets as classifyPlantLayer, but returns null instead of a fabricated
 * height/shape when neither is genuinely declared — for the ecology rule
 * (verticalLayers), which must not silently grade a plant on a guessed size.
 * classifyPlantLayer itself stays defaulting, because the renderer needs a
 * bucket for every plant regardless of whether its size is known (see nl-c58).
 */
export function classifyDeclaredLayer(species) {
  const shape = (species?.growthShape || species?.growth_shape || '').toLowerCase();
  if (shape === 'creeping') return 'groundcover';
  if (shape === 'tree') return 'trees';
  if (shape === 'vertical' || shape === 'vase' || shape === 'arch') return 'sculptural';
  const height = Number(species?.height ?? species?.height_ft);
  if (!(height > 0)) return null;
  if (height >= 4) return 'sculptural';
  if (height >= 1.25) return 'accents';
  return 'groundcover';
}

export function clampHiddenLayerCount(count) {
  if (!Number.isFinite(count)) return 0;
  if (count < 0) return 0;
  if (count > PLANT_LAYERS.length) return PLANT_LAYERS.length;
  return Math.round(count);
}

export function filterPlantStatesByHiddenLayers(plantStates, hiddenCount = 0) {
  const clamped = clampHiddenLayerCount(hiddenCount);
  if (!clamped) return plantStates;

  return plantStates.filter(({ plant }) => {
    const layer = plant?.layer || classifyPlantLayer(plant || {});
    const idx = PLANT_LAYERS.indexOf(layer);
    if (idx === -1) return true;
    return idx >= clamped;
  });
}
