import { DEFAULT_PIXELS_PER_INCH, INCHES_PER_FOOT, PLAN_VIEWBOX } from '../constants.js';
import { makeRng, seedForPlant } from '../utils/rng.js';
import { appendTooltip, clearSvg, createSvgElement } from './svgUtils.js';
import { buildTooltipLines } from './tooltip.js';

/**
 * Render the plan view using wavy domed foliage silhouettes scaled to plant width.
 * @param {SVGSVGElement} svg
 * @param {Array<{ plant: any, state: any }>} plantStates
 * @param {number} pixelsPerInch
 */
export function renderTopView(svg, plantStates, pixelsPerInch = DEFAULT_PIXELS_PER_INCH) {
  clearSvg(svg);
  const toPixels = (feet) => feet * INCHES_PER_FOOT * pixelsPerInch;

  plantStates.forEach(({ plant, state }) => {
    const group = createSvgElement('g', { 'data-name': plant.commonName });
    const cx = toPixels(plant.x);
    const cy = PLAN_VIEWBOX.height - toPixels(plant.y); // origin bottom-left for yard coordinates
    const radius = toPixels(plant.width) / 2;
    const rng = makeRng(seedForPlant(plant.id));

    renderFoliageDome(group, {
      cx,
      cy,
      radius,
      color: state.foliageColor,
      rng,
    });

    if (state.flowerColor) {
      const flower = createSvgElement('circle', {
        cx,
        cy,
        r: Math.max(radius * 0.35, 0.6),
        fill: state.flowerColor,
      });
      group.appendChild(flower);
    }

    appendTooltip(group, buildTooltipLines(plant, state));
    svg.appendChild(group);
  });
}

function renderFoliageDome(group, { cx, cy, radius, color, rng }) {
  const d = buildWavyCirclePath(cx, cy, radius, rng);

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

  return buildSmoothPath(points);
}

function buildSmoothPath(points) {
  if (!points.length) return '';
  const parts = [];
  const last = points[points.length - 1];
  const first = points[0];
  const start = midpoint(last, first);
  parts.push(`M ${start.x.toFixed(2)} ${start.y.toFixed(2)}`);

  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    const mid = midpoint(current, next);
    parts.push(
      `Q ${current.x.toFixed(2)} ${current.y.toFixed(2)} ${mid.x.toFixed(2)} ${mid.y.toFixed(2)}`
    );
  }

  parts.push('Z');
  return parts.join(' ');
}

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
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
