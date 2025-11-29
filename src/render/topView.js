import { DEFAULT_PIXELS_PER_INCH, INCHES_PER_FOOT, PLAN_VIEWBOX } from '../constants.js';
import { appendTooltip, clearSvg, createSvgElement } from './svgUtils.js';
import { buildTooltipLines } from './tooltip.js';

/**
 * Render the plan view using simple circles scaled to plant width.
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
