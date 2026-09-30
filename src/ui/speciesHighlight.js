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
 * @param {(plantId: string) => void} [deps.onSelectPlant]  called by
 *   setTargetedPlant while Edit mode is on (nl-o47.2) — see its own comment
 * @param {(driftId: string) => void} [deps.onSelectDrift]  called by
 *   handleDriftClick while Edit mode is on (nl-o47.6.7) — the species
 *   table's per-drift entries; src/app.js passes plantSelection.selectDrift
 * @param {() => number} [deps.getSuggestionCount]  the "N possible drifts"
 *   banner's count (nl-o47.6.5) — src/app.js already zeroes this outside Edit
 *   mode, on the read-only example yard, and while a review is already open,
 *   so this module needs no mode check of its own.
 * @param {() => void} [deps.onReviewSuggestions]  the banner's "Review" click
 */
export function createSpeciesHighlight({
  appState,
  speciesTableContainer,
  ecologyContainer,
  render,
  onSelectPlant = () => {},
  onSelectDrift = () => {},
  getSuggestionCount = () => 0,
  onReviewSuggestions = () => {},
}) {
  let highlightedRowEl = null;
  let highlightedDriftEl = null;

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
   * The species table's per-drift entries, View mode (nl-o47.6.7): set
   * `driftId` (with the button that named it, so its own `.is-highlighted`
   * class can be toggled the same way a hovered species row's is) as the
   * ring in the plan/elevations — see topView.js's own comment for why this
   * REPLACES highlightedSpeciesKey rather than adding to it. `el` may be
   * null (clearing programmatically, not from a click).
   *
   * Also clears any active species-row hover highlight, every time — a
   * drift chip sits INSIDE its species row, so a click on it (or on a
   * person's own pointer resting there) has already fired that row's
   * mouseenter; without this, toggling a drift's highlight back OFF while
   * the pointer is still over the row would leave the stale species
   * highlight showing (every plant of the species ringed, not none).
   */
  const setHighlightedDrift = (driftId, el) => {
    clearHighlightedSpecies();
    const normalized = driftId ? String(driftId) : '';
    if (highlightedDriftEl && highlightedDriftEl !== el) {
      highlightedDriftEl.classList.remove('is-highlighted');
    }
    if (normalized && el) {
      el.classList.add('is-highlighted');
      highlightedDriftEl = el;
    } else if (!normalized) {
      // Clearing back to none: strip the class from whatever is CURRENTLY
      // highlighted even when that happens to be `el` itself (toggling the
      // same chip off) — the guard above only fires for a *different*
      // element, so without this branch a toggle-off would leave the class
      // in place.
      if (highlightedDriftEl) highlightedDriftEl.classList.remove('is-highlighted');
      highlightedDriftEl = null;
    }
    if (appState.highlightedDriftId !== normalized) {
      appState.highlightedDriftId = normalized;
      render();
    }
  };

  /** A click on an already-highlighted drift's entry clears it — a sticky toggle, not a hover. */
  const toggleHighlightedDrift = (driftId, el) => {
    setHighlightedDrift(appState.highlightedDriftId === driftId ? '' : driftId, el);
  };

  const clearHighlightedDrift = () => setHighlightedDrift('', null);

  /**
   * The species table's per-drift entries' one click handler (nl-o47.6.7):
   * Edit mode selects the drift (the same selection the drag controllers and
   * the action bar use); View mode highlights it instead — mirroring
   * setTargetedPlant's own mode branch below, but exclusive rather than
   * additive, since View mode has no selection to layer a highlight under.
   */
  const handleDriftClick = (driftId, el) => {
    if (appState.mode === 'edit') {
      onSelectDrift(driftId);
    } else {
      toggleHighlightedDrift(driftId, el);
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
    highlightedDriftEl = null;
    const stillPlaced = appState.plants.some(
      (plant) => getSpeciesKey(plant) === appState.highlightedSpeciesKey
    );
    if (appState.highlightedSpeciesKey && !stillPlaced) {
      appState.highlightedSpeciesKey = '';
    }
    // Same check for the drift highlight: a rename, remove, or undo can take
    // the highlighted drift out from under it (its own id, or every one of
    // its members) between one refresh and the next.
    const driftStillExists = appState.plants.some(
      (plant) => plant.driftId === appState.highlightedDriftId
    );
    if (appState.highlightedDriftId && !driftStillExists) {
      appState.highlightedDriftId = '';
    }
    renderSpeciesTable(speciesTableContainer, appState.plants, appState.hostGenera, {
      onHoverStart: (speciesKey, rowEl) => setHighlightedSpecies(speciesKey, rowEl),
      onHoverEnd: (_speciesKey, rowEl) => clearHighlightedSpecies(rowEl),
      onDriftClick: handleDriftClick,
      highlightedDriftId: appState.highlightedDriftId,
      suggestionCount: getSuggestionCount(),
      onReviewSuggestions,
    });
    // The rebuild above already drew the still-highlighted drift's own
    // button with its `.is-highlighted` class (the highlightedDriftId prop
    // just passed), but that button is a brand new element — re-point the
    // closure at it so a later click on some OTHER drift can find and clear
    // it. Unlike the species row's highlightedRowEl above, a drift highlight
    // is a sticky click, not a hover, so leaving this stale would let two
    // chips read highlighted at once after an unrelated add/remove/undo.
    highlightedDriftEl = findDriftButtonEl(appState.highlightedDriftId);
    refreshEcologyPanel();
  };

  /**
   * Target a plant for the blue "target" ring and the detail sheet, in every
   * mode. In Edit mode, targeting also SELECTS it (nl-o47.2): a plant just
   * added from the catalog (src/ui/addPlantSheet.js), right-clicked, or
   * opened in the detail sheet ends up as the Edit-mode selection too,
   * through this one hook — so none of those callers needs to know the
   * selection module (src/ui/plantSelection.js) exists. Rendering suppresses
   * the target ring itself while in Edit mode (src/app.js's render()), so a
   * targeted-and-selected plant shows one ring, not two.
   */
  const setTargetedPlant = (plantId) => {
    const normalized = plantId ? String(plantId) : '';
    if (normalized !== appState.targetedPlantId) {
      appState.targetedPlantId = normalized;
      render();
    }
    if (normalized && appState.mode === 'edit') {
      onSelectPlant(normalized);
    }
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
  const findDriftButtonEl = (driftId) => {
    if (!driftId) return null;
    const container = speciesTableContainer;
    if (!container) return null;
    return (
      Array.from(container.querySelectorAll('button[data-drift-id]')).find(
        (btn) => btn.dataset.driftId === driftId
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

  return { refresh: refreshSpeciesTable, setTargetedPlant, setHoveredPlant, clearHighlightedDrift };
}
