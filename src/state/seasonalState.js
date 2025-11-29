import { DORMANT_FOLIAGE_COLOR } from '../constants.js';

const monthToSeason = {
  12: 'winter',
  1: 'winter',
  2: 'winter',
  3: 'spring',
  4: 'spring',
  5: 'spring',
  6: 'summer',
  7: 'summer',
  8: 'summer',
  9: 'fall',
  10: 'fall',
  11: 'fall',
};

export function computePlantState(plant, month) {
  const isGrowing = plant.growingMonths.length ? plant.growingMonths.includes(month) : true;
  const isFlowering = plant.floweringMonths.length
    ? plant.floweringMonths.includes(month) && isGrowing
    : false;

  const foliageColor = isGrowing
    ? pickFoliageColor(plant, month)
    : plant.dormantColor || DORMANT_FOLIAGE_COLOR;

  const flowerColor = isFlowering ? plant.flowerColor : null;

  return {
    isGrowing,
    isFlowering,
    foliageColor,
    flowerColor,
  };
}

function pickFoliageColor(plant, month) {
  const season = monthToSeason[month] || 'summer';
  return (
    plant.foliageColors?.[season] ||
    plant.leafColor ||
    DORMANT_FOLIAGE_COLOR
  );
}
