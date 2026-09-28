/**
 * The plant selection (nl-o47.2): a SET of plant ids that Edit-mode's touch
 * and desktop gestures, and the selection action bar (src/ui/selectionBar.js),
 * all read and write. One module owns appState.selectedPlantIds so nothing
 * else has to keep a second copy in sync.
 *
 * nl-o47.6.2 adds the selection's DRIFT CONTEXT alongside it:
 * appState.selectedDriftId ('' when none) and appState.driftDrilledIn — see
 * src/state/driftSelection.js's own comment for why both fields are needed
 * (a drift id alone cannot tell "the whole drift is selected" from "one of
 * its members is" when the drift happens to have exactly one member). This
 * module is still the one owner of all three fields; the decisions
 * themselves (driftForExactSelection, inferDriftContext, pruneDriftContext)
 * are pure and live there so they can be tested with no appState at all.
 *
 * Reconciled with speciesHighlight's "targeted plant" the other direction:
 * setTargetedPlant (src/ui/speciesHighlight.js) selects whatever it targets
 * while Edit mode is on, by calling back into selectPlants — see that
 * module's own comment for why, and src/app.js for the wiring order (this
 * module is built before speciesHighlight so that hook has something to
 * call).
 */
import { pruneSelectionIds, selectionsEqual, toSelectionSet } from '../state/selection.js';
import { currentDriftMemberIds, inferDriftContext, pruneDriftContext } from '../state/driftSelection.js';

const NO_DRIFT_CONTEXT = Object.freeze({ selectedDriftId: '', driftDrilledIn: false });

/**
 * @param {object} deps
 * @param {object} deps.appState        holds `selectedPlantIds` (a Set<string>),
 *   `selectedDriftId` and `driftDrilledIn`
 * @param {() => void} deps.render
 * @param {(selection: Set<string>) => void} [deps.onSelectionChange]  fired
 *   right after appState.selectedPlantIds changes, before render() — used to
 *   sync the drag controllers' touch-action class (is-selection-active)
 */
export function createPlantSelection({ appState, render, onSelectionChange = () => {} }) {
  // Normalized on both sides so a fresh appState with neither field set yet
  // (every test fixture, and the page before appState.js's own defaults run)
  // reads as "no drift context" rather than as a change from `undefined`.
  const driftContextChanged = (next) =>
    next.selectedDriftId !== (appState.selectedDriftId || '') ||
    next.driftDrilledIn !== Boolean(appState.driftDrilledIn);

  const setSelection = (nextIds, driftContext = NO_DRIFT_CONTEXT) => {
    if (selectionsEqual(nextIds, appState.selectedPlantIds) && !driftContextChanged(driftContext)) return;
    appState.selectedPlantIds = nextIds;
    appState.selectedDriftId = driftContext.selectedDriftId;
    appState.driftDrilledIn = driftContext.driftDrilledIn;
    onSelectionChange(appState.selectedPlantIds);
    render();
  };

  /**
   * Replace the selection with exactly these ids (a single id is the common
   * case for a plain plant). The drift context is INFERRED from the ids
   * themselves plus whatever context was active before this call — see
   * src/state/driftSelection.js's inferDriftContext for the exact rule. This
   * is deliberately the ONE entry point every caller uses (right-click, the
   * detail sheet, the Add plant sheet's onPick, nl-o47.6.3's "add N of a
   * species"): none of them has to know a drift exists, and handing this
   * exactly one drift's member ids is how a caller enters whole-drift mode.
   */
  const selectPlants = (ids) => {
    const nextIds = toSelectionSet(ids);
    setSelection(nextIds, inferDriftContext(nextIds, appState.plants, appState.selectedDriftId));
  };

  /**
   * Drill into one member of `driftId`, keeping the drift context active
   * (driftDrilledIn: true) — the touch/mouse controllers call this directly
   * (src/interaction/dragController.js) rather than going through
   * selectPlants, because THEY already know which drift is involved and
   * inferDriftContext's "narrowing an already-active context" rule would
   * otherwise require the drift to already be active, which is not yet true
   * on, e.g., a mouse click that drills straight in.
   */
  const drillIntoDriftMember = (plantId, driftId) => {
    setSelection(toSelectionSet([plantId]), { selectedDriftId: driftId, driftDrilledIn: true });
  };

  /** Select every current member of `driftId` — whole-drift mode. */
  const selectDrift = (driftId) => selectPlants(currentDriftMemberIds(driftId, appState.plants));

  const clearSelection = () => setSelection(new Set(), NO_DRIFT_CONTEXT);

  const getSelection = () => appState.selectedPlantIds;

  /** `{ selectedDriftId, driftDrilledIn }` — see src/state/driftSelection.js. */
  const getDriftContext = () => ({
    selectedDriftId: appState.selectedDriftId || '',
    driftDrilledIn: Boolean(appState.driftDrilledIn),
  });

  /**
   * Drop ids no plant carries any more, and re-derive the drift context to
   * match (src/state/driftSelection.js's pruneDriftContext). Called from the
   * same places refreshSpeciesTable already runs (src/app.js): add, clone,
   * remove, undo/redo, and the initial load — exactly the events that can
   * change which plants (and drift memberships) exist. Whole mode resyncs its
   * ids to the drift's CURRENT membership rather than the stale pruned
   * snapshot, so a "+"/"-" elsewhere (or an undo/redo of one) keeps showing
   * every member and the right count.
   */
  const pruneSelection = () => {
    const prunedIds = pruneSelectionIds(appState.selectedPlantIds, appState.plants);
    const context = pruneDriftContext(getDriftContext(), prunedIds, appState.plants);
    const nextIds =
      context.selectedDriftId && !context.driftDrilledIn
        ? toSelectionSet(currentDriftMemberIds(context.selectedDriftId, appState.plants))
        : prunedIds;
    setSelection(nextIds, context);
  };

  return {
    selectPlants,
    drillIntoDriftMember,
    selectDrift,
    clearSelection,
    getSelection,
    getDriftContext,
    pruneSelection,
  };
}
