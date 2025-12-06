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
  if (height >= 9 || (height >= 7 && width >= 3)) return 'trees';
  if (height >= 4 || shape === 'vertical' || shape === 'vase' || shape === 'arch') {
    return 'sculptural';
  }
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
