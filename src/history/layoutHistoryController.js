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
 */
import { createLayoutHistory } from './layoutHistory.js';
import { reconcileHistoryWithLayout } from './reconcileLayout.js';
import { plantsFromPlacements } from '../data/plantParser.js';
import { persistLayout, updateHistoryCursor } from '../data/persistence.js';

/** The description of the entry recorded when the layout file was changed outside the app. */
export const OUTSIDE_EDIT_DESCRIPTION = 'Layout file edited outside the app';

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
   * Build the stack from the saved history and return the plants to show.
   *
   * The layout file wins over history (see reconcileLayout.js): when another
   * entry matches it, the cursor moves there and the server is told; when none
   * does, the file's layout is recorded and saved as a new entry, so undo still
   * reaches the last state made in the app and both stacks keep one index.
   *
   * @param {Array<object>} initialPlants  the layout CSV as loaded
   * @param {{ entries?: Array, cursor?: number }} historyData  from loadLayoutHistory
   */
  function start(initialPlants, historyData) {
    const { entries, cursor, verdict } = reconcileHistoryWithLayout(
      historyData?.entries || [],
      typeof historyData?.cursor === 'number' ? historyData.cursor : NaN,
      initialPlants
    );
    layoutHistoryInstance = createLayoutHistory(initialPlants, {
      seedEntries: entries,
      initialCursor: cursor,
    });

    const projectId = appState.project?.id;
    if (!projectId && (verdict === 'moved' || verdict === 'diverged')) {
      // Never write without knowing which project: show the file, touch nothing.
      updateHistoryStatus('planting_layout.csv does not match the saved history; not saved (no project).', 'warning');
    } else if (verdict === 'moved') {
      updateHistoryCursor(layoutHistoryInstance.getCursor(), updateHistoryStatus, {
        projectId: appState.project?.id,
      });
    } else if (verdict === 'diverged') {
      updateHistoryStatus('planting_layout.csv changed outside the app; saved it as a new history entry.', 'warning');
      // Keep that warning up: only a failure to save replaces it.
      recordAndPersist(initialPlants, OUTSIDE_EDIT_DESCRIPTION, (message, state) => {
        if (state === 'error') updateHistoryStatus(message, state);
      });
    }

    const plants = layoutHistoryInstance.getCurrentEntry()
      ? toPlants(layoutHistoryInstance.getCurrentPlants())
      : initialPlants;
    updateHistoryControls();
    return plants;
  }

  /** Record appState.plants as one undoable step and persist it. */
  function commit(description) {
    if (!layoutHistoryInstance) return;
    recordAndPersist(appState.plants, description);
  }

  return { start, commit, updateStatus: updateHistoryStatus };
}
