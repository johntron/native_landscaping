export function buildTooltipLines(plant, state) {
  return [
    plant.commonName,
    plant.botanicalName,
    `Height: ${formatFeet(plant.height)}ft, Width: ${formatFeet(plant.width)}ft`,
    formatPositionLine(plant),
    `Sun: ${plant.sunPref}`,
    `Water: ${plant.waterPref}`,
    `Soil: ${plant.soilPref}`,
    formatInflorescenceLine(plant, state),
    state?.isFlowering ? 'Flowering' : '',
    formatFruitLine(plant, state),
  ];
}

function formatPositionLine(plant) {
  const x = formatFeet(plant.x);
  const y = formatFeet(plant.y);
  if (!x && !y) return '';
  return `Position: x=${x}ft, y=${y}ft`;
}

function formatFeet(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '';
  return num.toFixed(1);
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

function formatFruitLine(plant, state) {
  if (!plant.fruitColor && !plant.fruitLoad) return '';
  const pieces = [];
  if (plant.fruitColor) pieces.push(plant.fruitColor);
  if (plant.fruitLoad) pieces.push(`${plant.fruitLoad} load`);
  if (state?.isFruiting === false) pieces.push('(not in season)');
  if (state?.isFruiting) pieces.push('fruiting');
  return pieces.length ? `Fruit: ${pieces.join(', ')}` : '';
}
