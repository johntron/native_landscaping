import {
  DEFAULT_PIXELS_PER_INCH,
  ELEVATION_VIEWBOX,
  INCHES_PER_FOOT,
  SOUTH_ELEVATION_BOTTOM_OFFSET_PX,
  SOUTH_ELEVATION_LEFT_OFFSET_PX,
  WEST_ELEVATION_BOTTOM_OFFSET_PX,
  WEST_ELEVATION_LEFT_OFFSET_PX,
} from '../constants.js';
import { makeRng, seedForPlant } from '../utils/rng.js';
import { appendTooltip, clearSvg, createSvgElement } from './svgUtils.js';
import { buildTooltipLines } from './tooltip.js';
import { buildFlowerCenters } from './inflorescenceStrategies.js';
import { pointInPolygon } from './geometry.js';

/**
 * South (kitchen) elevation uses the x axis of the yard as horizontal.
 * @param {SVGSVGElement} svg
 * @param {Array<{ plant: any, state: any }>} plantStates
 * @param {number} pixelsPerInch
 */
export function renderSouthElevation(svg, plantStates, pixelsPerInch = DEFAULT_PIXELS_PER_INCH) {
  renderElevation(
    svg,
    plantStates,
    'x',
    pixelsPerInch,
    SOUTH_ELEVATION_BOTTOM_OFFSET_PX,
    SOUTH_ELEVATION_LEFT_OFFSET_PX
  );
}

/**
 * West (patio) elevation uses the y axis of the yard as horizontal to give depth.
 * @param {SVGSVGElement} svg
 * @param {Array<{ plant: any, state: any }>} plantStates
 * @param {number} pixelsPerInch
 */
export function renderWestElevation(svg, plantStates, pixelsPerInch = DEFAULT_PIXELS_PER_INCH) {
  renderElevation(
    svg,
    plantStates,
    'y',
    pixelsPerInch,
    WEST_ELEVATION_BOTTOM_OFFSET_PX,
    WEST_ELEVATION_LEFT_OFFSET_PX
  );
}

function renderElevation(
  svg,
  plantStates,
  axisKey,
  pixelsPerInch,
  bottomOffsetPx = 0,
  leftOffsetPx = 0
) {
  clearSvg(svg);
  const toPixels = (feet) => feet * INCHES_PER_FOOT * pixelsPerInch;

  plantStates.forEach(({ plant, state }) => {
    const group = createSvgElement('g', { 'data-name': plant.commonName });
    const canopySeed = seedForPlant(plant.id);
    const rng = makeRng(canopySeed);
    const axisValue = axisKey === 'x' ? plant.x : plant.y;
    const cx = toPixels(axisValue) + leftOffsetPx;
    const width = toPixels(plant.width);
    const height = toPixels(plant.height);
    const groundY = ELEVATION_VIEWBOX.height - bottomOffsetPx;
    const profileGeometry = resolveProfileGeometry(width, height, plant.growthShape);
    const outlinePoints = buildProfileOutlinePoints({
      cx,
      groundY,
      width: profileGeometry.adjustedWidth,
      height: profileGeometry.adjustedHeight,
      exponent: profileGeometry.exponent,
      rng: makeRng(canopySeed),
    });

    renderProfileSilhouette({
      width,
      height,
      growthShape: plant.growthShape,
      color: state.foliageColor,
      cx,
      groundY,
      rng,
      group,
      clipSuffix: `${axisKey}-${plant.id}`,
      geometry: profileGeometry,
    });

    if (state.flowerColor) {
      const flowerRng = makeRng(seedForPlant(`${plant.id}-flowers`));
      const adjustedWidth = profileGeometry.adjustedWidth;
      const adjustedHeight = profileGeometry.adjustedHeight;
      const flowerCenters = buildFlowerCenters({
        variant: 'elevation',
        canopy: {
          plan: { cx, cy: groundY - adjustedHeight * 0.5, radius: adjustedWidth / 2 },
          elevation: { cx, width: adjustedWidth, height: adjustedHeight, groundY },
        },
        rng: flowerRng,
        inflorescence: plant.inflorescence || plant.inflorescenceType || plant.inflorescence_type,
        flowerCountHint: plant.flowerCountHint ?? plant.flower_count_hint,
        flowerZone: plant.flowerZone || plant.flower_zone,
        accept: (point) => pointInPolygon(point, outlinePoints),
      });
      const { rx: baseRx, ry: baseRy } = computeElevationFlowerRadii(adjustedWidth, adjustedHeight, flowerCenters.length);
      const soilY = groundY;

      flowerCenters.forEach((center) => {
        const sizeFactor = 0.9 + flowerRng.next() * 0.2;
        const rx = baseRx * sizeFactor;
        const ry = baseRy * (0.9 + flowerRng.next() * 0.18);
        const cy = Math.min(center.y, soilY - ry);
        const flower = createSvgElement('ellipse', {
          cx: center.x,
          cy,
          rx,
          ry,
          fill: state.flowerColor,
        });
        group.appendChild(flower);
      });
    }

    appendTooltip(group, buildTooltipLines(plant, state));
    svg.appendChild(group);
  });
}

function renderProfileSilhouette({
  width,
  height,
  growthShape,
  color,
  cx,
  groundY,
  rng,
  group,
  clipSuffix,
  geometry,
}) {
  const { adjustedWidth, adjustedHeight, exponent } = geometry || resolveProfileGeometry(width, height, growthShape);
  const d = buildWavyProfilePath({ cx, groundY, width: adjustedWidth, height: adjustedHeight, exponent, rng });
  const clipId = buildClipId(clipSuffix);

  const base = createSvgElement('path', { d, fill: color });
  group.appendChild(base);

  const defs = createSvgElement('defs', {});
  const clipPath = createSvgElement('clipPath', { id: clipId });
  clipPath.appendChild(createSvgElement('path', { d }));
  defs.appendChild(clipPath);
  group.appendChild(defs);

  const shade = createSvgElement('ellipse', {
    cx: cx + adjustedWidth * 0.12,
    cy: groundY - adjustedHeight * 0.55,
    rx: adjustedWidth * 0.38,
    ry: adjustedHeight * 0.42,
    fill: darkenHex(color, 0.65),
    'fill-opacity': 0.35,
  });
  shade.setAttribute('clip-path', `url(#${clipId})`);
  group.appendChild(shade);

  const midHighlight = createSvgElement('ellipse', {
    cx: cx - adjustedWidth * 0.1,
    cy: groundY - adjustedHeight * 0.5,
    rx: adjustedWidth * 0.32,
    ry: adjustedHeight * 0.35,
    fill: lightenHex(color, 0.25),
    'fill-opacity': 0.75,
  });
  midHighlight.setAttribute('clip-path', `url(#${clipId})`);
  group.appendChild(midHighlight);

  const brightHighlight = createSvgElement('ellipse', {
    cx: cx - adjustedWidth * 0.2,
    cy: groundY - adjustedHeight * 0.62,
    rx: adjustedWidth * 0.22,
    ry: adjustedHeight * 0.22,
    fill: lightenHex(color, 0.45),
    'fill-opacity': 0.7,
  });
  brightHighlight.setAttribute('clip-path', `url(#${clipId})`);
  group.appendChild(brightHighlight);

  const outline = createSvgElement('path', {
    d,
    fill: 'none',
    stroke: darkenHex(color, 0.55),
    'stroke-width': Math.max(adjustedWidth * 0.05, 0.9),
    'stroke-linejoin': 'round',
  });
  group.appendChild(outline);
}

function resolveProfileGeometry(width, height, growthShape) {
  const shape = (growthShape || '').toLowerCase();
  if (shape === 'vertical' || shape === 'tree' || shape === 'vase') {
    return {
      adjustedWidth: width * 0.82,
      adjustedHeight: height * 1.05,
      exponent: 0.85,
    };
  }
  if (shape === 'creeping' || shape === 'groundcover') {
    return {
      adjustedWidth: width,
      adjustedHeight: Math.max(height * 0.55, 1),
      exponent: 1.5,
    };
  }
  if (shape === 'grass' || shape === 'grass-like') {
    return {
      adjustedWidth: width * 0.76,
      adjustedHeight: height * 1.1,
      exponent: 0.95,
    };
  }
  return {
    adjustedWidth: width,
    adjustedHeight: height,
    exponent: 1.05,
  };
}

function buildProfileOutlinePoints({ cx, groundY, width, height, exponent, rng }) {
  const { topPoints, startX } = buildProfileTopPoints({ cx, groundY, width, height, exponent, rng });
  if (!topPoints.length) return [];
  const outline = [{ x: startX, y: groundY }, ...topPoints, { x: cx + width / 2, y: groundY }];
  return outline;
}

function buildProfileTopPoints({ cx, groundY, width, height, exponent, rng }) {
  const pointCount = 12 + Math.floor(rng.next() * 5); // 12-16 points along the top
  const startX = cx - width / 2;
  const segments = pointCount;
  const topPoints = [];

  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const arch = Math.pow(Math.sin(Math.PI * t), exponent);
    const jitterY = (rng.next() - 0.5) * height * 0.08;
    const jitterX = (rng.next() - 0.5) * width * 0.025;
    const x = startX + width * t + jitterX;
    const y = groundY - arch * height + jitterY;
    topPoints.push({ x, y });
  }

  return { topPoints, startX };
}

function buildProfilePathFromTopPoints({ topPoints, startX, cx, groundY, width }) {
  if (!topPoints.length) return '';

  const pathParts = [];
  const first = topPoints[0];
  pathParts.push(`M ${(startX).toFixed(2)} ${groundY.toFixed(2)}`);
  pathParts.push(`L ${first.x.toFixed(2)} ${first.y.toFixed(2)}`);

  for (let i = 0; i < topPoints.length - 1; i += 1) {
    const current = topPoints[i];
    const next = topPoints[i + 1];
    const mid = midpoint(current, next);
    pathParts.push(
      `Q ${current.x.toFixed(2)} ${current.y.toFixed(2)} ${mid.x.toFixed(2)} ${mid.y.toFixed(2)}`
    );
  }

  pathParts.push(`L ${cx + width / 2} ${groundY.toFixed(2)}`);
  pathParts.push(`L ${(startX).toFixed(2)} ${groundY.toFixed(2)}`);
  pathParts.push('Z');
  return pathParts.join(' ');
}

function buildWavyProfilePath({ cx, groundY, width, height, exponent, rng }) {
  const { topPoints, startX } = buildProfileTopPoints({ cx, groundY, width, height, exponent, rng });
  return buildProfilePathFromTopPoints({ topPoints, startX, cx, groundY, width });
}

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function computeElevationFlowerRadii(width, height, count) {
  if (!count) return { rx: 0, ry: 0 };
  const base = width * 0.2;
  const scaled = base / Math.sqrt(count);
  const rx = Math.max(scaled, 0.4);
  const ry = Math.max(Math.min(scaled * 0.9, height * 0.22), 0.35);
  return { rx, ry };
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

function buildClipId(suffix) {
  const safe = String(suffix || 'plant')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 60);
  return `plant-clip-${safe}`;
}
