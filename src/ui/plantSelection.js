/**
 * The plant selection (nl-o47.2): a SET of plant ids that Edit-mode's touch
 * and desktop gestures, and the selection action bar (src/ui/selectionBar.js),
 * all read and write. One module owns appState.selectedPlantIds so nothing
 * else has to keep a second copy in sync.
 *
 * nl-o47.6.12: internally the selection is a DISCRIMINATED UNION —
 * `{ driftId, ids: null }` (a whole drift, its membership always read live
 * from appState.plants, never stored) or `{ driftId: '', ids: Set }` (plain
 * plant ids) — rather than a Set plus two extra context flags. "Drilled into
 * one member" is DERIVED, not stored: exactly one selected plant, and that
 * plant carries a driftId (getDriftContext, below). A drift always has >= 2
 * members (nl-o47.6.9), so a 1-id `{ ids }` selection can never also be some
 * drift's exact whole membership — the ambiguity a separate driftDrilledIn
 * flag existed for cannot arise any more. One consequence is a NAMED
 * behaviour change (nl-o47.6.12): a cold long-press/Details/right-click on a
 * drift member now opens it drilled in immediately, where the old design's
 * `inferDriftContext` needed an already-active context to narrow from.
 *
 * appState.selectedPlantIds stays a real, stored field — every other module
 * (topView.js/elevationViews.js via app.js's render() options,
 * src/ui/selectionBar.js, src/export/exportActions.js) still just reads it
 * directly, unaffected by any of this — but it is now a CACHE this module
 * refreshes on every change (getSelection() keeps returning it). What is
 * deleted is appState.selectedDriftId/driftDrilledIn: every direct reader of
 * those two now calls getDriftContext() instead (a derived getter, computed
 * fresh from the union and the current appState.plants), which is why the
 * drag controllers barely change — they already went through
 * getDriftContext()/getSelection(), never the two appState fields by name.
 *
 * src/state/driftSelection.js's driftForExactSelection is the one pure
 * decision left there: whether a set of ids names some drift's current full
 * membership exactly, which is what lets selectPlants(ids) store the compact
 * `{ driftId }` form instead of the ids themselves.
 *
 * Reconciled with speciesHighlight's "targeted plant" the other direction:
 * setTargetedPlant (src/ui/speciesHighlight.js) selects whatever it targets
 * while Edit mode is on, by calling back into selectPlants — see that
 * module's own comment for why, and src/app.js for the wiring order (this
 * module is built before speciesHighlight so that hook has something to
 * call).
 */
import { pruneSelectionIds, selectionsEqual, toSelectionSet } from '../state/selection.js';
import { driftForExactSelection } from '../state/driftSelection.js';
import { driftMembers } from '../state/driftGeometry.js';

/**
 * @param {object} deps
 * @param {object} deps.appState        holds `plants` and `selectedPlantIds`
 *   (a Set<string>, the derived cache this module writes)
 * @param {() => void} deps.render
 * @param {(selection: Set<string>) => void} [deps.onSelectionChange]  fired
 *   right after appState.selectedPlantIds changes, before render() — used to
 *   sync the drag controllers' touch-action class (is-selection-active)
 */
export function createPlantSelection({ appState, render, onSelectionChange = () => {} }) {
  /** { driftId: string, ids: Set<string>|null } — exactly one is meaningful. */
  let selection = { driftId: '', ids: new Set() };

  /** The Set getSelection()/appState.selectedPlantIds should read for `sel`. */
  const idsFor = (sel) =>
    sel.driftId ? new Set(driftMembers(appState.plants, sel.driftId).map((m) => String(m.id))) : sel.ids;

  /** Install `next` and its derived cache, with no render/onSelectionChange —
   * for a caller that drives those itself (pruneSelection's own setSelection
   * calls below already do; getRawSelection/setRawSelection's caller,
   * src/export/exportActions.js, always re-renders on its own too). */
  const applySelection = (next) => {
    selection = next;
    appState.selectedPlantIds = idsFor(next);
  };

  const setSelection = (next) => {
    const nextIds = idsFor(next);
    if (next.driftId === selection.driftId && selectionsEqual(nextIds, appState.selectedPlantIds)) return;
    applySelection(next);
    onSelectionChange(appState.selectedPlantIds);
    render();
  };

  /**
   * Replace the selection with exactly these ids (a single id is the common
   * case for a plain plant). Handing this exactly one drift's CURRENT member
   * ids enters that drift, whole — this is deliberately the ONE entry point
   * every caller uses (right-click, the detail sheet, the Add plant sheet's
   * onPick, nl-o47.6.3's "add N of a species"): none of them has to know a
   * drift exists.
   */
  const selectPlants = (ids) => {
    const nextIds = toSelectionSet(ids);
    const wholeMatch = driftForExactSelection(nextIds, appState.plants);
    setSelection(wholeMatch ? { driftId: wholeMatch, ids: null } : { driftId: '', ids: nextIds });
  };

  /** Select every current member of `driftId` — whole-drift mode. */
  const selectDrift = (driftId) => setSelection({ driftId, ids: null });

  const clearSelection = () => setSelection({ driftId: '', ids: new Set() });

  const getSelection = () => appState.selectedPlantIds;

  /**
   * `{ selectedDriftId, driftDrilledIn }`, derived fresh every call: a whole
   * drift is `{ selectedDriftId: driftId, driftDrilledIn: false }`; a plain
   * selection of exactly one plant that carries a driftId is
   * `{ selectedDriftId: thatDriftId, driftDrilledIn: true }` (the named
   * behaviour change above); anything else is no drift context.
   */
  const getDriftContext = () => {
    if (selection.driftId) return { selectedDriftId: selection.driftId, driftDrilledIn: false };
    if (selection.ids && selection.ids.size === 1) {
      const [id] = selection.ids;
      const plant = appState.plants.find((candidate) => String(candidate.id) === id);
      if (plant?.driftId) return { selectedDriftId: plant.driftId, driftDrilledIn: true };
    }
    return { selectedDriftId: '', driftDrilledIn: false };
  };

  /**
   * Drop ids no plant carries any more, and re-sync a whole-drift selection
   * to its drift's CURRENT membership. Called from the same places
   * refreshSpeciesTable already runs (src/app.js): add, clone, remove,
   * undo/redo, and the initial load — exactly the events that can change
   * which plants (and drift memberships) exist.
   *
   * Pruning a drift selection is simply "does the drift still exist"
   * (nl-o47.6.12): re-selecting it (setSelection, below) re-derives its
   * current ids for free and is a no-op render-wise unless membership
   * actually changed. If the drift is gone (dissolved, or undone out from
   * under this selection), the fallback reads the STALE cached ids
   * (appState.selectedPlantIds, as of before this change) pruned against the
   * current plants — the same "whatever the surviving ids still say about
   * themselves" the old pruneDriftContext read off a stored snapshot, now
   * read off the cache instead — and re-checks whether THEY now name some
   * other drift exactly.
   */
  const pruneSelection = () => {
    if (selection.driftId) {
      if (driftMembers(appState.plants, selection.driftId).length >= 2) {
        setSelection({ driftId: selection.driftId, ids: null });
        return;
      }
      const prunedIds = pruneSelectionIds(appState.selectedPlantIds, appState.plants);
      const reDrift = driftForExactSelection(prunedIds, appState.plants);
      setSelection(reDrift ? { driftId: reDrift, ids: null } : { driftId: '', ids: prunedIds });
      return;
    }
    setSelection({ driftId: '', ids: pruneSelectionIds(selection.ids, appState.plants) });
  };

  return {
    selectPlants,
    selectDrift,
    clearSelection,
    getSelection,
    getDriftContext,
    pruneSelection,
    /**
     * A snapshot of the raw internal union, for a caller that must blank the
     * selection and restore EXACTLY what was there afterward
     * (src/export/exportActions.js's capture) without firing
     * onSelectionChange or a render — the caller drives both itself, the
     * same way it already drives appState.selectedPlantIds's own
     * blank-and-restore around a capture.
     * @returns {{ driftId: string, ids: Set<string>|null }}
     */
    getRawSelection: () => ({ driftId: selection.driftId, ids: selection.ids ? new Set(selection.ids) : null }),
    /** The inverse of getRawSelection: installs `raw` and refreshes the
     * derived cache, with no render/onSelectionChange (see getRawSelection). */
    setRawSelection: (raw) =>
      applySelection(
        raw?.driftId ? { driftId: raw.driftId, ids: null } : { driftId: '', ids: new Set(raw?.ids || []) }
      ),
  };
}
