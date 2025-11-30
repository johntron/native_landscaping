export function buildTooltipLines(plant, state) {
  return [
    plant.commonName,
    plant.botanicalName,
    `Height: ${plant.height}ft, Width: ${plant.width}ft`,
    `Sun: ${plant.sunPref}`,
    `Water: ${plant.waterPref}`,
    `Soil: ${plant.soilPref}`,
    formatInflorescenceLine(plant, state),
    state?.isFlowering ? 'Flowering' : '',
  ];
}

function formatInflorescenceLine(plant, state) {
  const type = plant.inflorescence || plant.inflorescenceType || plant.inflorescence_type;
  if (!type && !plant.flowerCountHint && !plant.flower_zone && !plant.flowerZone) return '';
  const count = plant.flowerCountHint ?? plant.flower_count_hint;
  const zone = plant.flowerZone || plant.flower_zone;
  const pieces = [];
  if (type) pieces.push(type);
  if (count) pieces.push(`≈${count}`);
  if (zone) pieces.push(`${zone} canopy`);
  if (state?.isFlowering === false) pieces.push('(off-cycle)');
  return `Inflorescence: ${pieces.filter(Boolean).join(', ')}`;
}
