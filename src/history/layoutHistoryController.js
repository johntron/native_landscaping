/**
 * The design tool's layout history as the page uses it: the undo and redo
 * buttons, the save-status line, and committing a layout change (record it,
 * persist it through POST /api/layout, then adopt the entry and cursor the
 * server reports). src/history/layoutHistory.js is the stack itself; this is
 * the wiring around it that used to live inside app.js's init().
 *
 * Until start() runs (the layout has not loaded yet) there is no history, and
 * commit() does nothing, exactly as the old placeholder commitLayoutChange did.
 *
 * History holds placements only (src/data/placements.js); the plants shown are
 * always built from them with plantsFromPlacements, so their attributes are
 * whatever plants.csv says now (nl-3s5.19).
 *
 * History IS the yard (nl-3s5.3): the server stores no layout file any more,
 * so the plants shown are the entry at the stored cursor, full stop. The old
 * start() reconciled history against planting_layout.csv and saved an
 * "edited outside the app" entry when they disagreed; that reconciliation now
 * runs once, in the import (server/db/projectImport.js), and nowhere else.
 */
import { createLayoutHistory } from './layoutHistory.js';
import { plantsFromPlacements } from '../data/plantParser.js';
import { persistLayout, updateHistoryCursor } from '../data/persistence.js';

/**
 * @param {object} deps
 * @param {object} deps.appState                  reads species and project; replaces plants
 * @param {HTMLButtonElement|null} deps.undoButton
 * @param {HTMLButtonElement|null} deps.redoButton
 * @param {HTMLElement|null} deps.historyStatus
 * @param {() => void} deps.render
 * @param {() => void} deps.refreshSpeciesTable
 */
export function createLayoutHistoryController({
  appState,
  undoButton,
  redoButton,
  historyStatus,
  render,
  refreshSpeciesTable,
}) {
  let layoutHistoryInstance = null;

  const updateHistoryStatus = (message, state = '') => {
    if (!historyStatus) return;
    historyStatus.textContent = message || '';
    if (state) {
      historyStatus.dataset.state = state;
    } else {
      historyStatus.removeAttribute('data-state');
    }
  };

  const updateHistoryControls = () => {
    const canUndo = layoutHistoryInstance?.canUndo() ?? false;
    const canRedo = layoutHistoryInstance?.canRedo() ?? false;
    if (undoButton) undoButton.disabled = !canUndo;
    if (redoButton) redoButton.disabled = !canRedo;
  };

  const toPlants = (placements) =>
    plantsFromPlacements(placements, appState.species, { synonyms: appState.speciesSynonyms });

  const applyHistoryPlants = (placements) => {
    if (!Array.isArray(placements)) return;
    // Undo/redo move POSITIONS through history; attributes come from the catalog.
    appState.plants = toPlants(placements);
    render();
    // Undoing an add or a remove changes which species are placed.
    refreshSpeciesTable();
    updateHistoryControls();
  };

  const handleUndo = () => {
    if (!layoutHistoryInstance) return;
    const plants = layoutHistoryInstance.undo();
    if (!plants) return;
    applyHistoryPlants(plants);
    updateHistoryCursor(layoutHistoryInstance.getCursor(), updateHistoryStatus, {
      projectId: appState.project?.id,
    });
  };

  const handleRedo = () => {
    if (!layoutHistoryInstance) return;
    const plants = layoutHistoryInstance.redo();
    if (!plants) return;
    applyHistoryPlants(plants);
    updateHistoryCursor(layoutHistoryInstance.getCursor(), updateHistoryStatus, {
      projectId: appState.project?.id,
    });
  };

  if (undoButton) {
    undoButton.addEventListener('click', handleUndo);
  }
  if (redoButton) {
    redoButton.addEventListener('click', handleRedo);
  }

  /**
   * Record `plants` as one undoable step and persist it through POST /api/layout,
   * then adopt the entry and cursor the server reports.
   * @param {Array<object>} plants
   * @param {string} description
   * @param {(message: string, state: string) => void} [status] defaults to the status line
   */
  function recordAndPersist(plants, description, status = updateHistoryStatus) {
    const previousPlants = layoutHistoryInstance.getCurrentPlants();
    layoutHistoryInstance.record(plants, { description });
    updateHistoryControls();
    // previousPlants seeds the server's 'Initial layout' entry when it has no
    // history yet (a new yard), so both stacks keep the same indices.
    return persistLayout(plants, description, status, {
      previousPlants,
      projectId: appState.project?.id,
    }).then((result) => {
      if (result) {
        console.log('Layout persisted', {
          entryId: result.entry?.id || 'unknown',
          cursor: result.cursor,
        });
      }
      if (result?.entry) {
        layoutHistoryInstance.annotateCurrentEntry(result.entry);
      }
      if (typeof result?.cursor === 'number') {
        layoutHistoryInstance.setCursor(result.cursor);
      }
      updateHistoryControls();
      return result;
    });
  }

  /**
   * Build the stack from the saved history and return the plants to show:
   * the entry at the cursor, or none for a yard with no history yet.
   *
   * @param {{ entries?: Array, cursor?: number }} historyData  from loadLayoutHistory
   */
  function start(historyData) {
    const entries = Array.isArray(historyData?.entries) ? historyData.entries : [];
    layoutHistoryInstance = createLayoutHistory([], {
      seedEntries: entries,
      initialCursor: typeof historyData?.cursor === 'number' ? historyData.cursor : null,
    });
    updateHistoryControls();
    return toPlants(layoutHistoryInstance.getCurrentPlants());
  }

  /** Record appState.plants as one undoable step and persist it. */
  function commit(description) {
    if (!layoutHistoryInstance) return;
    recordAndPersist(appState.plants, description);
  }

  return { start, commit, updateStatus: updateHistoryStatus };
}
