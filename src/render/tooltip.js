import { buildPlantLabel } from './labels.js';
import { formatMonthRange } from '../state/seasonalState.js';

/**
 * The species table and this list are two views of the same species facts —
 * label, growth form, and bloom range live here too, not just in the table,
 * so a reader gets the same information whichever one they open first.
 */
export function buildTooltipLines(plant, state) {
  return [
    formatLabelLine(plant),
    plant.botanicalName,
    plant.commonName,
    `Height: ${formatFeet(plant.height)}ft, Width: ${formatFeet(plant.width)}ft`,
    formatGrowthShapeLine(plant),
    formatPositionLine(plant),
    `Sun: ${plant.sunPref}`,
    `Water: ${plant.waterPref}`,
    `Soil: ${plant.soilPref}`,
    formatBloomLine(plant),
    formatInflorescenceLine(plant, state),
    state?.isFlowering ? 'Flowering' : '',
    formatFruitLine(plant, state),
  ];
}

function formatLabelLine(plant) {
  const label = buildPlantLabel(plant);
  return label ? `Label: ${label}` : '';
}

function formatGrowthShapeLine(plant) {
  const shape = plant.growthShape || plant.growth_shape;
  return shape ? `Growth form: ${shape}` : '';
}

function formatBloomLine(plant) {
  const range = formatMonthRange(plant.floweringMonths || plant.flowering_season_months);
  return range ? `Bloom: ${range}` : '';
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
