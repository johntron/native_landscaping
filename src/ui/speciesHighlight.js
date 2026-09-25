/**
 * The species table and ecology check under the design tool, and the three
 * pointer states that link them to the drawing: the species highlighted from a
 * table row, the plant targeted by a click, and the plant under the pointer
 * (which highlights its species' row). Each change re-renders the views.
 *
 * refresh() rebuilds the table and re-grades the design. It runs when what is
 * PLANTED changes (add, remove, undo, load), deliberately not from render(),
 * which fires on every month-slider input.
 *
 * The two containers come in from src/app.js, which owns the DOM lookups.
 */
import { analyzeEcology, buildEcologyContext } from '../analysis/ecology.js';
import { renderEcologyPanel } from '../render/ecologyPanel.js';
import { renderSpeciesTable } from '../render/speciesTable.js';
import { getSpeciesKey } from '../utils/speciesKey.js';

/**
 * @param {object} deps
 * @param {object} deps.appState
 * @param {HTMLElement|null} deps.speciesTableContainer   #speciesTable
 * @param {HTMLElement|null} deps.ecologyContainer        #ecologyCheck
 * @param {() => void} deps.render
 */
export function createSpeciesHighlight({ appState, speciesTableContainer, ecologyContainer, render }) {
  let highlightedRowEl = null;

  const setHighlightedSpecies = (speciesKey, rowEl) => {
    const normalized = (speciesKey || '').toLowerCase();
    if (highlightedRowEl && highlightedRowEl !== rowEl) {
      highlightedRowEl.classList.remove('is-highlighted');
    }
    if (normalized && rowEl) {
      rowEl.classList.add('is-highlighted');
      highlightedRowEl = rowEl;
    } else if (!normalized) {
      if (highlightedRowEl) highlightedRowEl.classList.remove('is-highlighted');
      highlightedRowEl = null;
    }
    if (appState.highlightedSpeciesKey !== normalized) {
      appState.highlightedSpeciesKey = normalized;
      render();
    }
  };

  const clearHighlightedSpecies = (rowEl) => {
    if (rowEl && highlightedRowEl && rowEl !== highlightedRowEl) return;
    if (highlightedRowEl) {
      highlightedRowEl.classList.remove('is-highlighted');
      highlightedRowEl = null;
    }
    if (appState.highlightedSpeciesKey) {
      appState.highlightedSpeciesKey = '';
      render();
    }
  };

  /**
   * Re-grade the design. Rides refreshSpeciesTable rather than render() for the
   * same reason the table does: render() fires on every month-slider input
   * event, and rebuilding this DOM mid-drag would collapse a row the reader had
   * just opened. What changes the grade is what is planted, and that is exactly
   * when refreshSpeciesTable runs.
   */
  const refreshEcologyPanel = () => {
    const container = ecologyContainer;
    if (!container) return;
    const results = analyzeEcology(
      buildEcologyContext({
        plants: appState.plants,
        species: appState.species,
        hostGenera: appState.hostGenera,
        site: appState.project?.site,
        ecoregion: appState.project?.ecoregion,
        interactions: appState.interactions,
        nearbyFauna: appState.nearbyFauna,
      })
    );
    renderEcologyPanel(results, container);
  };

  /**
   * Rebuild the species legend from the current plants. Adding, removing, or
   * undoing changes which species are placed, and the table is built from the
   * layout rather than from the catalog. Deliberately not called from render():
   * the month slider renders on every input event, and rebuilding the table
   * mid-drag would orphan the row this closure is holding.
   */
  const refreshSpeciesTable = () => {
    highlightedRowEl = null;
    const stillPlaced = appState.plants.some(
      (plant) => getSpeciesKey(plant) === appState.highlightedSpeciesKey
    );
    if (appState.highlightedSpeciesKey && !stillPlaced) {
      appState.highlightedSpeciesKey = '';
    }
    renderSpeciesTable(speciesTableContainer, appState.plants, appState.hostGenera, {
      onHoverStart: (speciesKey, rowEl) => setHighlightedSpecies(speciesKey, rowEl),
      onHoverEnd: (_speciesKey, rowEl) => clearHighlightedSpecies(rowEl),
    });
    refreshEcologyPanel();
  };

  const setTargetedPlant = (plantId) => {
    const normalized = plantId ? String(plantId) : '';
    if (normalized === appState.targetedPlantId) return;
    appState.targetedPlantId = normalized;
    render();
  };
  const findSpeciesRowEl = (speciesKey) => {
    if (!speciesKey) return null;
    const container = speciesTableContainer;
    if (!container) return null;
    return (
      Array.from(container.querySelectorAll('tr[data-species-key]')).find(
        (row) => row.dataset.speciesKey === speciesKey
      ) || null
    );
  };
  const setHoveredPlant = (plantId) => {
    const normalized = plantId ? String(plantId) : '';
    if (normalized === appState.hoveredPlantId) return;
    appState.hoveredPlantId = normalized;
    const plant = normalized ? appState.plants.find((p) => String(p.id) === normalized) : null;
    if (plant) {
      const speciesKey = getSpeciesKey(plant);
      setHighlightedSpecies(speciesKey, findSpeciesRowEl(speciesKey));
    } else {
      clearHighlightedSpecies();
    }
    render();
  };

  return { refresh: refreshSpeciesTable, setTargetedPlant, setHoveredPlant };
}
