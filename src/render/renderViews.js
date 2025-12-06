import { renderTopView } from './topView.js';
import { renderSouthElevation, renderWestElevation } from './elevationViews.js';
import { filterPlantStatesByHiddenLayers } from '../state/layers.js';

export function renderViews(svgRefs, plantStates, pixelsPerInch, options = {}) {
  const { topSvg, southSvg, westSvg } = svgRefs;
  const { showLabels = false, hiddenLayerCount = 0 } = options;
  const filtered = filterPlantStatesByHiddenLayers(plantStates, hiddenLayerCount);
  const topOrdered = orderTopViewPlantStates(filtered);
  renderTopView(topSvg, topOrdered, pixelsPerInch, { showLabels });
  renderSouthElevation(southSvg, filtered, pixelsPerInch, { showLabels });
  renderWestElevation(westSvg, filtered, pixelsPerInch, { showLabels });
}

function orderTopViewPlantStates(plantStates) {
  // Plan view layers purely by height: shorter first, taller last.
  return [...plantStates].sort((a, b) => {
    const heightDiff = (a.plant.height ?? 0) - (b.plant.height ?? 0);
    if (heightDiff !== 0) return heightDiff;
    const widthDiff = (a.plant.width ?? 0) - (b.plant.width ?? 0);
    if (widthDiff !== 0) return widthDiff;
    return String(a.plant.id ?? '').localeCompare(String(b.plant.id ?? ''));
  });
}
