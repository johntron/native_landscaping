import { renderTopView } from './topView.js';
import { renderElevationView } from './elevationViews.js';
import { filterPlantStatesByHiddenLayers } from '../state/layers.js';

/**
 * @param {Array<{ view: object, svg: SVGSVGElement }>} panels one per project view
 * @param {Array<{ plant: any, state: any }>} plantStates
 * @param {object} options
 */
export function renderViews(panels, plantStates, options = {}) {
  const {
    showLabels = false,
    hiddenLayerCount = 0,
    highlightedSpeciesKey = '',
    targetedPlantId = '',
    hoveredPlantId = '',
  } = options;
  const filtered = filterPlantStatesByHiddenLayers(plantStates, hiddenLayerCount);
  const topOrdered = orderTopViewPlantStates(filtered);
  const renderOptions = {
    showLabels,
    highlightedSpeciesKey,
    targetedPlantId,
    hoveredPlantId,
  };
  panels.forEach(({ view, svg }) => {
    if (!svg || !view) return;
    // Plan and crop views layer by height; elevations sort along their own depth axis.
    if (view.type === 'plan') {
      renderTopView(svg, topOrdered, view, renderOptions);
    } else {
      renderElevationView(svg, filtered, view, renderOptions);
    }
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
