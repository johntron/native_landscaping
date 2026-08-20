import { renderTopView } from './topView.js';
import { renderElevationView } from './elevationViews.js';
import { filterPlantStatesByHiddenLayers } from '../state/layers.js';

/**
 * @param {{ topSvg: SVGSVGElement, elevationSvgs: SVGSVGElement[] }} svgRefs
 * @param {Array<{ plant: any, state: any }>} plantStates
 * @param {object} options `project` carries the active project config (views[]).
 */
export function renderViews(svgRefs, plantStates, options = {}) {
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
  const views = project?.views || [];
  const planView = views.find((view) => view.type === 'plan');
  if (planView) {
    renderTopView(topSvg, topOrdered, planView, renderOptions);
  }

  // Elevation panels are still positional slots; nl-tz7.4 makes them config-driven.
  const elevations = views.filter((view) => view.type === 'elevation');
  elevationSvgs.forEach((svg, index) => {
    const elevation = elevations[index];
    if (!svg || !elevation) return;
    renderElevationView(svg, filtered, elevation, renderOptions);
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
