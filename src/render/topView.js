import { PLANT_BLEND_OPACITY } from '../constants.js';
import { createViewTransform } from './viewTransform.js';
import { makeRng, seedForPlant } from '../utils/rng.js';
import { getSpeciesKey } from '../utils/speciesKey.js';
import { clearSvg, createSvgElement } from './svgUtils.js';
import { buildFeatureGroup } from './featureViews.js';
import { buildFlowerCenters } from './inflorescenceStrategies.js';
import { pointInPolygon, distanceToPath } from './geometry.js';
import { geometryKeyFor } from '../data/featureConfig.js';
import { buildPlantLabel } from './labels.js';
import { buildFruitCenters } from './fruitPlacement.js';
import { buildSmoothPath } from './pathUtils.js';

const HIGHLIGHT_COLOR = '#ef7d1a';
const HIGHLIGHT_OUTLINE_OPACITY = 0.9;
const TARGET_COLOR = '#1b74d8';
const TARGET_OUTLINE_OPACITY = 0.95;
const CLIMB_WARNING_COLOR = '#d64545';

// A low-climber this close to a wall (fences are modeled as walls — see
// featureConfig.js) is assumed to be climbing it. If the wall is tall enough
// to contain the vine's mature height, it hugs the support and draws narrow;
// otherwise it outgrows the support, tops it, and cascades over — keeping its
// full natural spread rather than narrowing. This close to a box instead (not
// climbable) it keeps its full width but gets a warning ring, since it will
// likely just sprawl over the box.
const CLIMB_PROXIMITY_FT = 2;
const CLIMB_WIDTH_FT = 1.5;

/** Nearest feature of `type` to a feet-space point, with its feet distance, or null. */
function nearestFeature(point, features, type) {
  let best = null;
  features.forEach((feature) => {
    if (feature.type !== type) return;
    const points = feature[geometryKeyFor(feature.type)] || [];
    if (points.length < 2) return;
    let distanceFt = 0;
    if (type === 'box' && !pointInPolygon(point, points)) {
      distanceFt = distanceToPath(point, [...points, points[0]]);
    } else if (type !== 'box') {
      distanceFt = distanceToPath(point, points);
    }
    if (!best || distanceFt < best.distanceFt) best = { feature, distanceFt };
  });
  return best;
}

/**
 * Render a plan view using wavy domed foliage silhouettes scaled to plant width.
 *
 * The view's own transform supplies the scale, so a detail crop — a plan view
 * with a non-zero origin and a smaller extent — renders through this same path.
 *
 * @param {SVGSVGElement} svg
 * @param {Array<{ plant: any, state: any }>} plantStates
 * @param {object} view a normalized plan view (see createViewTransform)
 * @param {{ showLabels?: boolean }} [options]
 */
export function renderTopView(svg, plantStates, view, options = {}) {
  const transform = createViewTransform(view);
  const {
    showLabels = false,
    highlightedSpeciesKey = '',
    targetedPlantId = '',
    hoveredPlantId = '',
    features = [],
  } = options;
  clearSvg(svg);
  const normalizedHighlightKey = (highlightedSpeciesKey || '').toLowerCase();
  const normalizedTargetId = String(targetedPlantId || '');
  const normalizedHoveredId = String(hoveredPlantId || '');
  const toPixels = transform.toPx;
  const highlightTargets = [];
  const targetMarkers = [];
  const climbWarnings = [];

  // A plan has no depth to sort on, so features go underneath the plants in the
  // order they were authored — the authoring order IS the z-order.
  features.forEach((feature) => svg.appendChild(buildFeatureGroup(feature, transform)));

  plantStates.forEach(({ plant, state }) => {
    const speciesKey = getSpeciesKey(plant);
    const isHighlighted = Boolean(normalizedHighlightKey && speciesKey === normalizedHighlightKey);
    const isTargeted = normalizedTargetId && String(plant.id) === normalizedTargetId;
    const isHovered = normalizedHoveredId && String(plant.id) === normalizedHoveredId;
    const group = createSvgElement('g', {
      'data-name': plant.commonName,
      'data-plant-id': plant.id,
      'data-species-key': speciesKey,
    });
    const { x: cx, y: cy } = transform.planToViewBox(plant);
    let effectiveWidth = plant.width;
    let isBoxWarning = false;
    if (plant.growthShape === 'low-climber') {
      const point = { x: plant.x, y: plant.y };
      const nearestWall = nearestFeature(point, features, 'wall');
      if (nearestWall && nearestWall.distanceFt <= CLIMB_PROXIMITY_FT) {
        const supportContainsVine = plant.height <= nearestWall.feature.heightFt;
        effectiveWidth = supportContainsVine ? Math.min(plant.width, CLIMB_WIDTH_FT) : plant.width;
      } else {
        const nearestBox = nearestFeature(point, features, 'box');
        isBoxWarning = Boolean(nearestBox && nearestBox.distanceFt <= CLIMB_PROXIMITY_FT);
      }
    }
    const radius = toPixels(effectiveWidth) / 2;
    const canopySeed = seedForPlant(plant.id);
    const canopyPoints = buildWavyCirclePoints(cx, cy, radius, makeRng(canopySeed));
    const rng = makeRng(canopySeed);

    renderFoliageDome(group, {
      cx,
      cy,
      radius,
      color: state.foliageColor,
      rng,
      outlinePoints: canopyPoints,
    });

    if (state.flowerColor) {
      const flowerRng = makeRng(seedForPlant(`${plant.id}-flowers`));
      const flowerCenters = buildFlowerCenters({
        variant: 'plan',
        canopy: { plan: { cx, cy, radius } },
        rng: flowerRng,
        inflorescence: plant.inflorescence || plant.inflorescenceType || plant.inflorescence_type,
        flowerCountHint: plant.flowerCountHint ?? plant.flower_count_hint,
        flowerZone: plant.flowerZone || plant.flower_zone,
        accept: (point) => pointInPolygon(point, canopyPoints),
      });
      const flowerRadius = computePlanFlowerRadius(radius, flowerCenters.length);

      flowerCenters.forEach((center) => {
        const jitteredRadius = flowerRadius * (0.9 + flowerRng.next() * 0.18);
        const flower = createSvgElement('circle', {
          cx: center.x,
          cy: center.y,
          r: jitteredRadius,
          fill: state.flowerColor,
        });
        group.appendChild(flower);
      });
    }

    if (state.fruitColor) {
      const fruitRng = makeRng(seedForPlant(`${plant.id}-fruit`));
      const fruitCenters = buildFruitCenters({
        variant: 'plan',
        canopy: { plan: { cx, cy, radius } },
        rng: fruitRng,
        fruitLoad: plant.fruitLoad,
        accept: (point) => pointInPolygon(point, canopyPoints),
      });
      const fruitRadius = computePlanFruitRadius(radius, fruitCenters.length);

      fruitCenters.forEach((center) => {
        const jitteredRadius = fruitRadius * (0.88 + fruitRng.next() * 0.18);
        const fruit = createSvgElement('circle', {
          cx: center.x,
          cy: center.y,
          r: jitteredRadius,
          fill: state.fruitColor,
          stroke: darkenHex(state.fruitColor, 0.6),
          'stroke-width': Math.max(jitteredRadius * 0.35, 0.7),
        });
        group.appendChild(fruit);
      });
    }

    if (showLabels) {
      const label = buildPlantLabel(plant);
      if (label) {
        const fontSize = Math.max(radius * 0.6, 16);
        const text = createSvgElement('text', {
          x: cx,
          y: cy,
          'text-anchor': 'middle',
          'dominant-baseline': 'middle',
          'font-size': fontSize,
          'font-weight': 700,
          fill: '#1b1b1b',
          stroke: '#fff',
          'stroke-width': Math.max(fontSize * 0.12, 1.2),
          'paint-order': 'stroke fill',
          'pointer-events': 'none',
        });
        text.textContent = label;
        group.appendChild(text);
      }
    }

    svg.appendChild(group);

    if (isHighlighted) {
      highlightTargets.push({ cx, cy, radius });
    }
    if (isTargeted || isHovered) {
      targetMarkers.push({ cx, cy, radius });
    }
    if (isBoxWarning) {
      climbWarnings.push({ cx, cy, radius });
    }
  });

  highlightTargets.forEach((target) => appendHighlightRing(svg, target));
  targetMarkers.forEach((target) => appendTargetRing(svg, target));
  climbWarnings.forEach((target) => appendClimbWarningRing(svg, target));
}

function renderFoliageDome(group, { cx, cy, radius, color, rng, outlinePoints }) {
  const points = outlinePoints || buildWavyCirclePoints(cx, cy, radius, rng);
  const d = buildSmoothPath(points);

  const base = createSvgElement('path', {
    d,
    fill: color,
    'fill-opacity': PLANT_BLEND_OPACITY,
  });
  group.appendChild(base);

  const shade = createSvgElement('circle', {
    cx: cx + radius * 0.2,
    cy: cy + radius * 0.18,
    r: radius * 0.72,
    fill: darkenHex(color, 0.7),
    'fill-opacity': 0.4,
  });
  group.appendChild(shade);

  const midHighlight = createSvgElement('circle', {
    cx: cx - radius * 0.12,
    cy: cy - radius * 0.12,
    r: radius * 0.58,
    fill: lightenHex(color, 0.25),
    'fill-opacity': 0.85,
  });
  group.appendChild(midHighlight);

  const brightHighlight = createSvgElement('circle', {
    cx: cx - radius * 0.22,
    cy: cy - radius * 0.26,
    r: radius * 0.38,
    fill: lightenHex(color, 0.45),
    'fill-opacity': 0.7,
  });
  group.appendChild(brightHighlight);

  const outline = createSvgElement('path', {
    d,
    fill: 'none',
    stroke: darkenHex(color, 0.55),
    'stroke-width': Math.max(radius * 0.06, 0.8),
    'stroke-linejoin': 'round',
  });
  group.appendChild(outline);
}

function buildWavyCirclePath(cx, cy, radius, rng) {
  const points = buildWavyCirclePoints(cx, cy, radius, rng);
  return buildSmoothPath(points);
}

function buildWavyCirclePoints(cx, cy, radius, rng) {
  const pointCount = 14 + Math.floor(rng.next() * 6); // 14-19 points
  const angleStep = (Math.PI * 2) / pointCount;
  const wobble = 0.12;
  const points = [];

  for (let i = 0; i < pointCount; i += 1) {
    const angle = i * angleStep;
    const radialJitter = 1 + (rng.next() - 0.5) * wobble;
    const ripple = 1 + Math.sin(angle * 2) * 0.05;
    const r = radius * radialJitter * ripple;
    points.push({
      x: cx + Math.cos(angle) * r,
      y: cy + Math.sin(angle) * r,
    });
  }

  return points;
}

function computePlanFlowerRadius(canopyRadius, count) {
  if (!count) return 0;
  const scaled = (canopyRadius * 0.35) / Math.sqrt(count);
  return Math.max(scaled, 0.6);
}

function computePlanFruitRadius(canopyRadius, count) {
  if (!count) return 0;
  const scaled = (canopyRadius * 0.22) / Math.sqrt(count);
  return Math.max(scaled, 0.5);
}

function darkenHex(color, factor) {
  const { r, g, b } = parseHex(color);
  return formatHex(
    Math.round(r * factor),
    Math.round(g * factor),
    Math.round(b * factor)
  );
}

function lightenHex(color, amount) {
  const { r, g, b } = parseHex(color);
  return formatHex(
    Math.round(r + (255 - r) * amount),
    Math.round(g + (255 - g) * amount),
    Math.round(b + (255 - b) * amount)
  );
}

function parseHex(color) {
  const match = /^#?([a-f\d]{6})$/i.exec(color);
  if (!match) return { r: 0, g: 0, b: 0 };
  const num = parseInt(match[1], 16);
  return {
    r: (num >> 16) & 0xff,
    g: (num >> 8) & 0xff,
    b: num & 0xff,
  };
}

function formatHex(r, g, b) {
  const toHex = (value) => value.toString(16).padStart(2, '0');
  return `#${toHex(clampChannel(r))}${toHex(clampChannel(g))}${toHex(clampChannel(b))}`;
}

function clampChannel(value) {
  if (value < 0) return 0;
  if (value > 255) return 255;
  return value;
}

function appendHighlightRing(svg, { cx, cy, radius }) {
  const outer = createSvgElement('circle', {
    cx,
    cy,
    r: radius * 1.05 + 6,
    fill: 'none',
    stroke: HIGHLIGHT_COLOR,
    'stroke-width': Math.max(radius * 0.12, 3),
    'stroke-dasharray': '7 6',
    'stroke-opacity': HIGHLIGHT_OUTLINE_OPACITY,
    'pointer-events': 'none',
  });
  const center = createSvgElement('circle', {
    cx,
    cy,
    r: Math.max(radius * 0.1, 4),
    fill: HIGHLIGHT_COLOR,
    'fill-opacity': 0.8,
    stroke: '#fff',
    'stroke-width': 2,
    'pointer-events': 'none',
  });
  svg.appendChild(outer);
  svg.appendChild(center);
}

/** A low-climber sitting next to a box, with no climbable wall in reach — it will likely just sprawl over it. */
function appendClimbWarningRing(svg, { cx, cy, radius }) {
  const outer = createSvgElement('circle', {
    cx,
    cy,
    r: radius * 1.08 + 5,
    fill: 'none',
    stroke: CLIMB_WARNING_COLOR,
    'stroke-width': Math.max(radius * 0.1, 2.5),
    'stroke-dasharray': '4 4',
    'stroke-opacity': 0.9,
    'pointer-events': 'none',
  });
  svg.appendChild(outer);
}

function appendTargetRing(svg, { cx, cy, radius }) {
  const outer = createSvgElement('circle', {
    cx,
    cy,
    r: radius * 1.02 + 4,
    fill: 'none',
    stroke: TARGET_COLOR,
    'stroke-width': Math.max(radius * 0.18, 3.6),
    'stroke-opacity': TARGET_OUTLINE_OPACITY,
    'pointer-events': 'none',
  });
  const center = createSvgElement('circle', {
    cx,
    cy,
    r: Math.max(radius * 0.16, 5),
    fill: TARGET_COLOR,
    'fill-opacity': 0.9,
    stroke: '#fff',
    'stroke-width': 2,
    'pointer-events': 'none',
  });
  svg.appendChild(outer);
  svg.appendChild(center);
}
