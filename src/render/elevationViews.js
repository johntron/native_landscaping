import {
  DEFAULT_PIXELS_PER_INCH,
  ELEVATION_VIEWBOX,
  FRONT_VIEW_BOTTOM_OFFSET_PX,
  SIDE_VIEW_BOTTOM_OFFSET_PX,
  INCHES_PER_FOOT,
} from '../constants.js';
import { appendTooltip, clearSvg, createSvgElement } from './svgUtils.js';
import { buildTooltipLines } from './tooltip.js';

/**
 * South (kitchen) elevation uses the x axis of the yard as horizontal.
 * @param {SVGSVGElement} svg
 * @param {Array<{ plant: any, state: any }>} plantStates
 * @param {number} pixelsPerInch
 */
export function renderSouthElevation(svg, plantStates, pixelsPerInch = DEFAULT_PIXELS_PER_INCH) {
  renderElevation(svg, plantStates, 'x', pixelsPerInch, FRONT_VIEW_BOTTOM_OFFSET_PX);
}

/**
 * West (patio) elevation uses the y axis of the yard as horizontal to give depth.
 * @param {SVGSVGElement} svg
 * @param {Array<{ plant: any, state: any }>} plantStates
 * @param {number} pixelsPerInch
 */
export function renderWestElevation(svg, plantStates, pixelsPerInch = DEFAULT_PIXELS_PER_INCH) {
  renderElevation(svg, plantStates, 'y', pixelsPerInch, SIDE_VIEW_BOTTOM_OFFSET_PX);
}

function renderElevation(svg, plantStates, axisKey, pixelsPerInch, bottomOffsetPx = 0) {
  clearSvg(svg);
  const toPixels = (feet) => feet * INCHES_PER_FOOT * pixelsPerInch;

  plantStates.forEach(({ plant, state }) => {
    const group = createSvgElement('g', { 'data-name': plant.commonName });
    const cx = toPixels(axisKey === 'x' ? plant.x : plant.y);
    const width = toPixels(plant.width);
    const height = toPixels(plant.height);
    const groundY = ELEVATION_VIEWBOX.height - bottomOffsetPx;

    const profile = createProfileShape({
      width,
      height,
      growthShape: plant.growthShape,
      fill: state.foliageColor,
      cx,
      groundY,
    });
    group.appendChild(profile);

    if (state.flowerColor) {
      const flower = createSvgElement('ellipse', {
        cx,
        cy: groundY - height,
        rx: Math.max(width * 0.2, 0.4),
        ry: Math.max(width * 0.2, 0.4),
        fill: state.flowerColor,
      });
      group.appendChild(flower);
    }

    appendTooltip(group, buildTooltipLines(plant, state));
    svg.appendChild(group);
  });
}

function createProfileShape({ width, height, growthShape, fill, cx, groundY }) {
  const shape = growthShape;

  if (shape === 'vertical' || shape === 'vase' || shape === 'tree') {
    return createSvgElement('rect', {
      x: cx - width / 2,
      y: groundY - height,
      width,
      height,
      rx: width * 0.25,
      ry: width * 0.25,
      fill,
    });
  }

  if (shape === 'creeping' || shape === 'groundcover') {
    const bodyHeight = Math.max(height * 0.6, 1);
    return createSvgElement('rect', {
      x: cx - width / 2,
      y: groundY - bodyHeight,
      width,
      height: bodyHeight,
      rx: bodyHeight * 0.4,
      ry: bodyHeight * 0.4,
      fill,
    });
  }

  if (shape === 'grass' || shape === 'grass-like') {
    const path = [
      `M ${cx - width * 0.35} ${groundY}`,
      `L ${cx} ${groundY - height}`,
      `L ${cx + width * 0.35} ${groundY}`,
      'Z',
    ].join(' ');
    return createSvgElement('path', { d: path, fill });
  }

  // default mound/dome profile
  const domePath = [
    `M ${cx - width / 2} ${groundY}`,
    `Q ${cx} ${groundY - height} ${cx + width / 2} ${groundY}`,
    'Z',
  ].join(' ');
  return createSvgElement('path', { d: domePath, fill });
}
