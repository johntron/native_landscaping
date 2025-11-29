import { PLAN_VIEWBOX } from '../constants.js';
import { appendTooltip, clearSvg, createSvgElement } from './svgUtils.js';
import { buildTooltipLines } from './tooltip.js';

/**
 * Render the plan view using simple circles scaled to plant width.
 * @param {SVGSVGElement} svg
 * @param {Array<{ plant: any, state: any }>} plantStates
 */
export function renderTopView(svg, plantStates) {
  clearSvg(svg);

  plantStates.forEach(({ plant, state }) => {
    const group = createSvgElement('g', { 'data-name': plant.commonName });

    const cx = plant.x;
    const cy = PLAN_VIEWBOX.height - plant.y; // origin bottom-left for yard coordinates
    const radius = plant.width / 2;

    const foliage = createSvgElement('circle', {
      cx,
      cy,
      r: radius,
      fill: state.foliageColor,
    });
    group.appendChild(foliage);

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
