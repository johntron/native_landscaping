import { renderTopView } from './topView.js';
import { renderSouthElevation, renderWestElevation } from './elevationViews.js';

export function renderViews(svgRefs, plantStates, pixelsPerInch, options = {}) {
  const { topSvg, southSvg, westSvg } = svgRefs;
  const { showLabels = false } = options;
  const ordered = orderPlantStatesForStacking(plantStates);
  renderTopView(topSvg, ordered, pixelsPerInch, { showLabels });
  renderSouthElevation(southSvg, ordered, pixelsPerInch, { showLabels });
  renderWestElevation(westSvg, ordered, pixelsPerInch, { showLabels });
}

function orderPlantStatesForStacking(plantStates) {
  // Draw shorter plants first so taller ones naturally layer on top.
  return [...plantStates].sort((a, b) => {
    const heightDiff = (a.plant.height ?? 0) - (b.plant.height ?? 0);
    if (heightDiff !== 0) return heightDiff;
    const widthDiff = (a.plant.width ?? 0) - (b.plant.width ?? 0);
    if (widthDiff !== 0) return widthDiff;
    return String(a.plant.id ?? '').localeCompare(String(b.plant.id ?? ''));
  });
}
