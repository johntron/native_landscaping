const MAX_FLOWERS = 30;
const MIN_FLOWERS = 1;
const AREA_PER_FLOWER = 1500;

const DEFAULT_ZONE_BY_TYPE = {
  spike: 'upper',
  raceme: 'upper',
  panicle: 'upper',
  spray: 'upper',
  umbel: 'upper',
  head: 'upper',
  scatter: 'full',
};

const strategyMap = {
  spike: spikeStrategy,
  raceme: spikeStrategy,
  panicle: panicleStrategy,
  spray: panicleStrategy,
  umbel: umbelStrategy,
  head: umbelStrategy,
  scatter: scatterStrategy,
};

/**
 * Generate flower centers for plan or elevation views based on inflorescence type.
 * @param {Object} options
 * @param {'plan'|'elevation'} options.variant
 * @param {Object} options.canopy - view-specific bounds
 * @param {{ cx: number, cy: number, radius: number }} [options.canopy.plan]
 * @param {{ cx: number, width: number, height: number, groundY: number }} [options.canopy.elevation]
 * @param {{ next: () => number }} options.rng
 * @param {string} [options.inflorescence]
 * @param {number|string|null} [options.flowerCountHint]
 * @param {'upper'|'mid'|'full'} [options.flowerZone]
 * @param {(point: { x: number, y: number }) => boolean} [options.accept] optional rejection sampling predicate
 * @returns {Array<{ x: number, y: number }>}
 */
export function buildFlowerCenters({
  variant,
  canopy,
  rng,
  inflorescence,
  flowerCountHint,
  flowerZone,
  accept,
}) {
  const type = normalizeInflorescence(inflorescence);
  const strategy = strategyMap[type] || scatterStrategy;
  const resolvedZone = normalizeZone(flowerZone) || DEFAULT_ZONE_BY_TYPE[type] || 'full';
  const count = deriveCount(flowerCountHint, canopy);

  return strategy({ variant, canopy, rng, count, zone: resolvedZone, accept });
}

export const inflorescenceStrategies = strategyMap;

function spikeStrategy({ variant, canopy, rng, count, zone, accept }) {
  if (variant === 'plan') {
    const plan = canopy.plan;
    if (!plan?.radius) return [];
    const lineAngle = randomAngle(rng);
    const span = plan.radius * 0.8;
    const base = plan.radius * 0.08;
    const jitterMag = plan.radius * 0.06;

    return buildList(count, (idx) => {
      const t = count === 1 ? 0.5 : idx / Math.max(count - 1, 1);
      const distance = base + span * t + jitter(rng, plan.radius * 0.04);
      const x = plan.cx + Math.cos(lineAngle) * distance + jitter(rng, jitterMag);
      const y = plan.cy + Math.sin(lineAngle) * distance + jitter(rng, jitterMag);
      return { x, y };
    }, accept);
  }

  const elevation = canopy.elevation;
  const range = resolveElevationRange(elevation, zone);
  if (!range) return [];
  const span = (range.max - range.min) * 0.85;
  const base = range.min + (range.max - range.min) * 0.05;
  const jitterX = (elevation?.width || 0) * 0.06;
  const jitterY = (range.max - range.min) * 0.08;

  return buildList(count, (idx) => {
    const t = count === 1 ? 0.6 : idx / Math.max(count - 1, 1);
    const y = base + span * t + jitter(rng, jitterY);
    const x = (elevation?.cx || 0) + jitter(rng, jitterX);
    return { x, y };
  }, accept);
}

function panicleStrategy({ variant, canopy, rng, count, zone, accept }) {
  const adjustedCount = clamp(Math.round(count * 1.2), 3, MAX_FLOWERS);
  if (variant === 'plan') {
    const plan = canopy.plan;
    if (!plan?.radius) return [];
    const orientation = randomAngle(rng);
    const baseAnchor = samplePlanPoint(rng, plan, zone);
    const spread = plan.radius * 0.55;

    return buildList(adjustedCount, () => {
      const angularSpread = orientation + jitter(rng, Math.PI * 0.35);
      const distance = spread * Math.pow(rng.next(), 0.6);
      const x = baseAnchor.x + Math.cos(angularSpread) * distance + jitter(rng, plan.radius * 0.05);
      const y = baseAnchor.y + Math.sin(angularSpread) * distance + jitter(rng, plan.radius * 0.05);
      return { x, y };
    }, accept);
  }

  const elevation = canopy.elevation;
  const range = resolveElevationRange(elevation, zone);
  if (!range) return [];
  const { cx = 0, width = 0 } = elevation || {};
  const height = (range.max - range.min);
  const anchorY = range.min + height * 0.25 + jitter(rng, height * 0.12);

  return buildList(adjustedCount, () => ({
    x: cx + jitter(rng, width * 0.25),
    y: clamp(anchorY + jitter(rng, height * 0.35), range.min, range.max),
  }), accept);
}

function umbelStrategy({ variant, canopy, rng, count, zone, accept }) {
  if (variant === 'plan') {
    const plan = canopy.plan;
    if (!plan?.radius) return [];
    const anchor = samplePlanPoint(rng, plan, zone);
    const tight = plan.radius * 0.25;

    return buildList(count, () => ({
      x: anchor.x + jitter(rng, tight * 0.6),
      y: anchor.y + jitter(rng, tight * 0.6),
    }));
  }

  const elevation = canopy.elevation;
  const range = resolveElevationRange(elevation, zone);
  if (!range) return [];
  const { cx = 0, width = 0 } = elevation || {};
  const anchorY = range.min + (range.max - range.min) * 0.2 + jitter(rng, (range.max - range.min) * 0.08);
  const horizontal = width * 0.12;
  const vertical = (range.max - range.min) * 0.12;

  return buildList(count, () => ({
    x: cx + jitter(rng, horizontal),
    y: clamp(anchorY + jitter(rng, vertical), range.min, range.max),
  }), accept);
}

function scatterStrategy({ variant, canopy, rng, count, zone, accept }) {
  if (variant === 'plan') {
    const plan = canopy.plan;
    if (!plan?.radius) return [];
    return buildList(count, () => samplePlanPoint(rng, plan, zone), accept);
  }

  const elevation = canopy.elevation;
  const range = resolveElevationRange(elevation, zone);
  if (!range) return [];
  const width = elevation?.width || 0;

  return buildList(count, () => sampleElevationPoint(rng, elevation, range, width * 0.25), accept);
}

function deriveCount(hint, canopy) {
  const numericHint = Number(hint);
  if (Number.isFinite(numericHint) && numericHint > 0) {
    return clamp(Math.round(numericHint), MIN_FLOWERS, MAX_FLOWERS);
  }
  const area = estimateCanopyArea(canopy);
  const estimated = Math.max(Math.round(area / AREA_PER_FLOWER), MIN_FLOWERS);
  return clamp(estimated, MIN_FLOWERS, MAX_FLOWERS);
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

function normalizeInflorescence(value) {
  const v = (value || '').toLowerCase();
  if (!v) return 'scatter';
  return v;
}

function normalizeZone(value) {
  if (!value) return null;
  const v = value.toLowerCase();
  if (v === 'upper' || v === 'mid' || v === 'full') return v;
  return null;
}

function resolveElevationRange(elevation, zone) {
  if (!elevation) return null;
  const { groundY = 0, height = 0 } = elevation;
  const topY = groundY - height;
  const zoneKey = zone || 'full';
  if (zoneKey === 'upper') {
    return { min: topY, max: topY + height * 0.45 };
  }
  if (zoneKey === 'mid') {
    return { min: topY + height * 0.25, max: topY + height * 0.75 };
  }
  return { min: topY + height * 0.05, max: groundY - height * 0.08 };
}

function samplePlanPoint(rng, plan, zone) {
  const radius = plan.radius;
  const angle = randomAngle(rng);
  const { min, max } = resolvePlanRadialRange(radius, zone);
  const r = min + (max - min) * Math.sqrt(rng.next());
  return {
    x: plan.cx + Math.cos(angle) * r,
    y: plan.cy + Math.sin(angle) * r,
  };
}

function resolvePlanRadialRange(radius, zone) {
  const key = zone || 'full';
  if (key === 'upper') return { min: radius * 0.1, max: radius * 0.6 };
  if (key === 'mid') return { min: radius * 0.3, max: radius * 0.9 };
  return { min: radius * 0.05, max: radius };
}

function sampleElevationPoint(rng, elevation, range, jitterX) {
  const width = elevation?.width || 0;
  const cx = elevation?.cx || 0;
  const x = cx + jitter(rng, jitterX || width * 0.18);
  const y = range.min + (range.max - range.min) * rng.next();
  return { x, y };
}

function jitter(rng, magnitude) {
  return (rng.next() - 0.5) * 2 * magnitude;
}

function randomAngle(rng) {
  return rng.next() * Math.PI * 2;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

const MAX_PLACEMENT_ATTEMPTS = 40;

function buildList(count, factory, accept) {
  const items = [];
  for (let i = 0; i < count; i += 1) {
    let attempts = 0;
    let candidate = null;
    let accepted = false;

    while (attempts < MAX_PLACEMENT_ATTEMPTS && !accepted) {
      candidate = factory(i);
      attempts += 1;
      accepted = !accept || accept(candidate);
    }

    if (candidate) {
      items.push(candidate);
    }
  }
  return items;
}
