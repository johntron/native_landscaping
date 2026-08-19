import { renderTopView } from './topView.js';
import { renderElevationView } from './elevationViews.js';
import { filterPlantStatesByHiddenLayers } from '../state/layers.js';

/**
 * @param {{ topSvg: SVGSVGElement, elevationSvgs: SVGSVGElement[] }} svgRefs
 * @param {Array<{ plant: any, state: any }>} plantStates
 * @param {number} pixelsPerInch
 * @param {object} options `project` carries the active project config (plan + elevations).
 */
export function renderViews(svgRefs, plantStates, pixelsPerInch, options = {}) {
  const { topSvg, elevationSvgs = [] } = svgRefs;
  const {
    showLabels = false,
    hiddenLayerCount = 0,
    highlightedSpeciesKey = '',
    targetedPlantId = '',
    hoveredPlantId = '',
    project,
  } = options;
  const filtered = filterPlantStatesByHiddenLayers(plantStates, hiddenLayerCount);
  const topOrdered = orderTopViewPlantStates(filtered);
  const renderOptions = {
    showLabels,
    highlightedSpeciesKey,
    targetedPlantId,
    hoveredPlantId,
  };
  renderTopView(topSvg, topOrdered, pixelsPerInch, {
    ...renderOptions,
    viewBox: project?.plan?.viewBox,
  });

  const elevations = project?.elevations || [];
  elevationSvgs.forEach((svg, index) => {
    const elevation = elevations[index];
    if (!svg || !elevation) return;
    renderElevationView(svg, filtered, pixelsPerInch, elevation, renderOptions);
  });
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
