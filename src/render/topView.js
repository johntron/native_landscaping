import { DEFAULT_PIXELS_PER_INCH, INCHES_PER_FOOT, PLAN_VIEWBOX } from '../constants.js';
import { makeRng, seedForPlant } from '../utils/rng.js';
import { appendTooltip, clearSvg, createSvgElement } from './svgUtils.js';
import { buildTooltipLines } from './tooltip.js';
import { buildFlowerCenters } from './inflorescenceStrategies.js';
import { pointInPolygon } from './geometry.js';
import { buildPlantLabel } from './labels.js';
import { buildFruitCenters } from './fruitPlacement.js';
import { buildSmoothPath } from './pathUtils.js';

/**
 * Render the plan view using wavy domed foliage silhouettes scaled to plant width.
 * @param {SVGSVGElement} svg
 * @param {Array<{ plant: any, state: any }>} plantStates
 * @param {number} pixelsPerInch
 * @param {{ showLabels?: boolean }} [options]
 */
export function renderTopView(
  svg,
  plantStates,
  pixelsPerInch = DEFAULT_PIXELS_PER_INCH,
  options = {}
) {
  const { showLabels = false } = options;
  clearSvg(svg);
  const toPixels = (feet) => feet * INCHES_PER_FOOT * pixelsPerInch;

  plantStates.forEach(({ plant, state }) => {
    const group = createSvgElement('g', { 'data-name': plant.commonName });
    const cx = toPixels(plant.x);
    const cy = PLAN_VIEWBOX.height - toPixels(plant.y); // origin bottom-left for yard coordinates
    const radius = toPixels(plant.width) / 2;
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

    appendTooltip(group, buildTooltipLines(plant, state));
    svg.appendChild(group);
  });
}

function renderFoliageDome(group, { cx, cy, radius, color, rng, outlinePoints }) {
  const points = outlinePoints || buildWavyCirclePoints(cx, cy, radius, rng);
  const d = buildSmoothPath(points);

  const base = createSvgElement('path', {
    d,
    fill: color,
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
