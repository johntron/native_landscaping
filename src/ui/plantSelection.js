/**
 * The plant selection (nl-o47.2): a SET of plant ids that Edit-mode's touch
 * and desktop gestures, and the selection action bar (src/ui/selectionBar.js),
 * all read and write. One module owns appState.selectedPlantIds so nothing
 * else has to keep a second copy in sync.
 *
 * Reconciled with speciesHighlight's "targeted plant" the other direction:
 * setTargetedPlant (src/ui/speciesHighlight.js) selects whatever it targets
 * while Edit mode is on, by calling back into selectPlants — see that
 * module's own comment for why, and src/app.js for the wiring order (this
 * module is built before speciesHighlight so that hook has something to
 * call).
 */
import { pruneSelectionIds, selectionsEqual, toSelectionSet } from '../state/selection.js';

/**
 * @param {object} deps
 * @param {object} deps.appState        holds `selectedPlantIds` (a Set<string>)
 * @param {() => void} deps.render
 * @param {(selection: Set<string>) => void} [deps.onSelectionChange]  fired
 *   right after appState.selectedPlantIds changes, before render() — used to
 *   sync the drag controllers' touch-action class (is-selection-active)
 */
export function createPlantSelection({ appState, render, onSelectionChange = () => {} }) {
  const setSelection = (next) => {
    if (selectionsEqual(next, appState.selectedPlantIds)) return;
    appState.selectedPlantIds = next;
    onSelectionChange(appState.selectedPlantIds);
    render();
  };

  /** Replace the selection with exactly these ids (a single id is the common case today). */
  const selectPlants = (ids) => setSelection(toSelectionSet(ids));

  const clearSelection = () => setSelection(new Set());

  const getSelection = () => appState.selectedPlantIds;

  /**
   * Drop ids no plant carries any more. Called from the same places
   * refreshSpeciesTable already runs (src/app.js): add, clone, remove,
   * undo/redo, and the initial load — exactly the events that can change
   * which plants exist.
   */
  const pruneSelection = () => setSelection(pruneSelectionIds(appState.selectedPlantIds, appState.plants));

  return { selectPlants, clearSelection, getSelection, pruneSelection };
}
