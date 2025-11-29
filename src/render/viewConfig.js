import { ELEVATION_VIEWBOX, PLAN_VIEWBOX } from '../constants.js';

/**
 * Apply viewBox and aspect ratio settings from the single source of truth (constants).
 * Keeping this logic here avoids HTML/CSS duplication drifting out of sync with JS.
 * @param {{ topSvg: SVGSVGElement, southSvg: SVGSVGElement, westSvg: SVGSVGElement }} svgRefs
 * @param {{ topView?: HTMLElement, southView?: HTMLElement, westView?: HTMLElement }} [containerRefs]
 */
export function configureViews({ svgRefs, containerRefs }) {
  const { topSvg, southSvg, westSvg } = svgRefs;

  setViewBox(topSvg, PLAN_VIEWBOX);
  setViewBox(southSvg, ELEVATION_VIEWBOX);
  setViewBox(westSvg, ELEVATION_VIEWBOX);

  [topSvg, southSvg, westSvg].forEach((svg) => {
    if (svg) {
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    }
  });

  // Keep the view containers sized to the same aspect as the active viewBox.
  if (containerRefs) {
    const ratioValue = `${PLAN_VIEWBOX.width} / ${PLAN_VIEWBOX.height}`;
    ['topView', 'southView', 'westView'].forEach((key) => {
      const el = containerRefs[key];
      if (el?.style) {
        el.style.setProperty('--view-aspect-ratio', ratioValue);
      }
    });
  }
}

function setViewBox(svg, viewBox) {
  if (!svg || !viewBox) return;
  svg.setAttribute('viewBox', `0 0 ${viewBox.width} ${viewBox.height}`);
}
