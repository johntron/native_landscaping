/**
 * The design tool's layout history as the page uses it: the undo and redo
 * buttons, the save-status line, and committing a layout change (record it,
 * persist it through POST /api/layout, then adopt the entry and cursor the
 * server reports). src/history/layoutHistory.js is the stack itself; this is
 * the wiring around it that used to live inside app.js's init().
 *
 * Until start() runs (the layout has not loaded yet) there is no history, and
 * commit() does nothing, exactly as the old placeholder commitLayoutChange did.
 */
import { createLayoutHistory } from './layoutHistory.js';
import { rehydratePlants } from '../data/plantParser.js';
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

  const applyHistoryPlants = (plants) => {
    if (!Array.isArray(plants)) return;
    // Same reasoning as the boot-time restore: a history entry's attributes are a
    // snapshot from whenever it was recorded, not necessarily what the catalog says
    // now. Undo/redo move POSITIONS through history; attributes stay live.
    appState.plants = rehydratePlants(plants, appState.species, { synonyms: appState.speciesSynonyms });
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
   * Build the stack from the saved history and return the plants to show.
   * @param {Array<object>} initialPlants  the layout CSV as loaded
   * @param {{ entries?: Array, cursor?: number }} historyData  from loadLayoutHistory
   */
  function start(initialPlants, historyData) {
    const historyEntries = historyData.entries || [];
    const historyCursor = typeof historyData.cursor === 'number' ? historyData.cursor : -1;
    layoutHistoryInstance = createLayoutHistory(initialPlants, {
      seedEntries: historyEntries,
      initialCursor: historyCursor,
    });
    const currentPlants = layoutHistoryInstance.getCurrentPlants();
    // A history entry snapshots full plant objects, attributes included, so a
    // restored entry would otherwise un-correct any catalog fix made since it was
    // recorded — see rehydratePlants. Positions and identity come from history;
    // attributes always come fresh from the catalog just parsed.
    const plants = rehydratePlants(currentPlants.length ? currentPlants : initialPlants, appState.species, {
      synonyms: appState.speciesSynonyms,
    });
    updateHistoryControls();
    return plants;
  }

  /** Record appState.plants as one undoable step and persist it. */
  function commit(description) {
    if (!layoutHistoryInstance) return;
    const previousPlants = layoutHistoryInstance.getCurrentPlants();
    layoutHistoryInstance.record(appState.plants, { description });
    updateHistoryControls();
    persistLayout(appState.plants, description, updateHistoryStatus, {
      previousPlants,
      projectId: appState.project.id,
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
    });
  }

  return { start, commit, updateStatus: updateHistoryStatus };
}
