import { renderTopView } from './topView.js';
import { renderSouthElevation, renderWestElevation } from './elevationViews.js';

export function renderViews(svgRefs, plantStates, pixelsPerInch) {
  const { topSvg, southSvg, westSvg } = svgRefs;
  renderTopView(topSvg, plantStates, pixelsPerInch);
  renderSouthElevation(southSvg, plantStates, pixelsPerInch);
  renderWestElevation(westSvg, plantStates, pixelsPerInch);
}
