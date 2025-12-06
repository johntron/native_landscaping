import { buildFlowerCenters } from './inflorescenceStrategies.js';

const FRUIT_LOAD_MULTIPLIER = {
  sparse: 0.6,
  moderate: 1,
  heavy: 1.5,
};

/**
 * Build berry/fruit centers using the existing flower placement logic with a scatter layout.
 * @param {'plan'|'elevation'} variant
 * @param {Object} canopy
 * @param {{ next: () => number }} rng
 * @param {string} fruitLoad
 * @param {(point: { x: number, y: number }) => boolean} [accept]
 */
export function buildFruitCenters({ variant, canopy, rng, fruitLoad, accept }) {
  const load = normalizeLoad(fruitLoad);
  if (load === 'none') return [];

  const baseCount = estimateBaseCount(canopy);
  const scaled = Math.max(Math.round(baseCount * (FRUIT_LOAD_MULTIPLIER[load] || 0.8)), 1);

  return buildFlowerCenters({
    variant,
    canopy,
    rng,
    inflorescence: 'scatter',
    flowerCountHint: scaled,
    flowerZone: 'mid',
    accept,
  });
}

function estimateBaseCount(canopy) {
  const area = estimateCanopyArea(canopy);
  const count = Math.round(area / 3200) + 2; // lightweight clusters
  return clamp(count, 2, 18);
}

function estimateCanopyArea(canopy) {
  if (canopy?.plan?.radius) {
    return Math.PI * canopy.plan.radius * canopy.plan.radius;
  }
  if (canopy?.elevation?.width && canopy?.elevation?.height) {
    return canopy.elevation.width * canopy.elevation.height * 0.5;
  }
  return 1;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeLoad(value) {
  const v = (value || '').toLowerCase();
  if (v === 'heavy') return 'heavy';
  if (v === 'moderate' || v === 'medium') return 'moderate';
  if (v === 'sparse' || v === 'light') return 'sparse';
  if (v === 'none') return 'none';
  return 'moderate';
}
