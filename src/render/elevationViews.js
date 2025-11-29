import { appendTooltip, clearSvg, createSvgElement } from './svgUtils.js';
import { buildTooltipLines } from './tooltip.js';

/**
 * South (kitchen) elevation uses the x axis of the yard as horizontal.
 * @param {SVGSVGElement} svg
 * @param {Array<{ plant: any, state: any }>} plantStates
 */
export function renderSouthElevation(svg, plantStates) {
  renderElevation(svg, plantStates, 'x');
}

/**
 * West (patio) elevation uses the y axis of the yard as horizontal to give depth.
 * @param {SVGSVGElement} svg
 * @param {Array<{ plant: any, state: any }>} plantStates
 */
export function renderWestElevation(svg, plantStates) {
  renderElevation(svg, plantStates, 'y');
}

function renderElevation(svg, plantStates, axisKey) {
  clearSvg(svg);

  plantStates.forEach(({ plant, state }) => {
    const group = createSvgElement('g', { 'data-name': plant.commonName });
    const cx = axisKey === 'x' ? plant.x : plant.y;
    const groundY = 100;

    const profile = createProfileShape(plant, state, cx, groundY);
    group.appendChild(profile);

    if (state.flowerColor) {
      const flower = createSvgElement('ellipse', {
        cx,
        cy: groundY - plant.height,
        rx: Math.max(plant.width * 0.2, 0.4),
        ry: Math.max(plant.width * 0.2, 0.4),
        fill: state.flowerColor,
      });
      group.appendChild(flower);
    }

    appendTooltip(group, buildTooltipLines(plant, state));
    svg.appendChild(group);
  });
}

function createProfileShape(plant, state, cx, groundY) {
  const width = plant.width;
  const height = plant.height;
  const shape = plant.growthShape;
  const fill = state.foliageColor;

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
