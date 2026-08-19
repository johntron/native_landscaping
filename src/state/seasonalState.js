import { DORMANT_FOLIAGE_COLOR, MONTH_NAMES } from '../constants.js';

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
  const isFruiting = computeFruiting(plant, month, { isGrowing });
  const fruitColor = isFruiting ? plant.fruitColor : null;

  return {
    isGrowing,
    isFlowering,
    foliageColor,
    flowerColor,
    isFruiting,
    fruitColor,
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

export function formatMonthRange(monthsSpec) {
  const months = normalizeMonthsForDisplay(monthsSpec);
  if (!months.length) return '';
  const spans = [];
  let start = months[0];
  let prev = months[0];

  for (let i = 1; i <= months.length; i += 1) {
    const current = months[i];
    if (current === prev + 1) {
      prev = current;
      continue;
    }
    if (start === prev) {
      spans.push(MONTH_NAMES[start - 1]);
    } else {
      spans.push(`${MONTH_NAMES[start - 1]}-${MONTH_NAMES[prev - 1]}`);
    }
    start = current;
    prev = current;
  }
  return spans.join(', ');
}

function normalizeMonthsForDisplay(spec) {
  if (Array.isArray(spec) && spec.length) {
    return [...spec].map((m) => Number(m)).filter((m) => Number.isFinite(m) && m >= 1 && m <= 12).sort((a, b) => a - b);
  }
  if (typeof spec === 'string') {
    const parts = spec.split(/[,\s]+/).filter(Boolean);
    const months = [];
    parts.forEach((part) => {
      if (part.includes('-')) {
        const [a, b] = part.split('-').map(Number);
        if (Number.isFinite(a) && Number.isFinite(b)) {
          const start = Math.max(1, Math.min(12, a));
          const end = Math.max(1, Math.min(12, b));
          if (end >= start) {
            for (let m = start; m <= end; m += 1) months.push(m);
          }
        }
      } else {
        const num = Number(part);
        if (Number.isFinite(num) && num >= 1 && num <= 12) months.push(num);
      }
    });
    return months.sort((a, b) => a - b);
  }
  return [];
}

function computeFruiting(plant, month, { isGrowing }) {
  const hasFruitMonths = Array.isArray(plant.fruitMonths) && plant.fruitMonths.length > 0;
  if (!hasFruitMonths) return false;
  if (!plant.fruitColor || plant.fruitLoad === 'none') return false;
  if (!plant.floweringMonths || plant.floweringMonths.length === 0) return false;
  const inSeason = plant.fruitMonths.includes(month);
  if (!inSeason) return false;
  // Fruits can persist into dormancy, so we do not require isGrowing to be true.
  return true;
}
