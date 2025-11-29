import { renderTopView } from './topView.js';
import { renderSouthElevation, renderWestElevation } from './elevationViews.js';

export function renderViews(svgRefs, plantStates) {
  const { topSvg, southSvg, westSvg } = svgRefs;
  renderTopView(topSvg, plantStates);
  renderSouthElevation(southSvg, plantStates);
  renderWestElevation(westSvg, plantStates);
}
