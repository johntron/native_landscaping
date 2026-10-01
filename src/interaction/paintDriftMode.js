/**
 * "Paint a drift along a stroke" (nl-o47.6.6, nl-o47.6's making method 4):
 * choose a species in the Add plant sheet's Paint choice, then trace along a
 * bed on the plan — one finger, or the mouse — and plants drop along the
 * stroke at the species' own spacing, sharing one new driftId, one stroke at
 * a time, until Done. Owns the bottom bar (#paintBar) that takes the SAME
 * fixed-bottom slot #selectionBar/#driftReviewBar/#phoneEditorBar's idle bar
 * already alternate over (design.html), and orchestrates
 * src/interaction/paintController.js's raw stroke events into
 * src/state/driftEdits.js's paintDrift.
 *
 * Edit mode only, never on the read-only example yard — enforced here too
 * (start()'s own guard), not just by where the Add plant sheet's Paint
 * choice is reachable.
 *
 * MODE EXCLUSIVITY. Painting and a drift-suggestion review (nl-o47.6.5) are
 * mutually exclusive, the same way review and an ordinary selection already
 * are: start() refuses while a review is active. The reverse direction needs
 * no matching change in src/interaction/driftReviewMode.js — the "N possible
 * drifts" banner and "Make drift" (which needs a live single-plant selection)
 * are already unreachable while painting, because src/app.js's own selection
 * guards (isDriftReviewActive's existing call sites) are widened to also
 * check isActive() here, so the ordinary selection never repopulates during
 * painting and nothing double-shows a bar.
 *
 * LOCKING. Unlike a review, which keeps the plan's own dragController alive
 * for its own tap-to-toggle, painting needs it, and every elevation
 * controller, fully locked for its duration — this controller is the ONLY
 * pointer consumer the plan's svg has while a stroke is possible.
 * src/app.js's `syncDragLocks` dependency is the single place that decides
 * every dragController's locked state from appState.mode and isActive()
 * together, called here on both start and stop so a same-mode re-apply
 * elsewhere (Setup's rebuildViews, say) cannot silently re-unlock them out
 * from under an open paint session. The plan's own paint pointer
 * controller(s) (`getPaintControllers`) are unlocked/relocked directly here,
 * the one thing only this module is in a position to toggle.
 *
 * LIVE PREVIEW. Every stroke move recomputes, at most once per animation
 * frame (queuePreview, below — copying and resampling the whole polyline on
 * every raw pointermove would be wasted work on a long stroke), the same
 * resampleStroke + dropPositionsOutsideYard pipeline paintDrift itself runs,
 * so the preview and the eventual result can never disagree, and stores it on
 * `appState.paintPreview` for src/render/topView.js's appendPaintPreview to
 * draw. A stroke this module's own paintController decided was too short to
 * count (a tap) never reaches here at all.
 */
import { paintDrift } from '../state/driftEdits.js';
import { DEFAULT_MEMBER_RADIUS_FT, SPACING_FACTOR } from '../state/driftGeometry.js';
import { dropPositionsOutsideYard, MAX_PAINT_COUNT, resampleStroke } from '../state/driftPaint.js';
import { createPlantFromSpecies } from '../data/plantParser.js';
import { resolveYardBounds } from '../render/yardBounds.js';
import { buildPlantLabel, driftLabel } from '../render/labels.js';

/**
 * @param {object} deps
 * @param {object} deps.elements  bar, label, doneBtn, moreBtn, moreGroup,
 *   hintEl, undoBtn, redoBtn, undoRealBtn, redoRealBtn — see design.html's
 *   #paintBar markup.
 * @param {object} deps.appState  holds `species`, `plants`, `project`,
 *   `mode`, `readOnly`; gains `paintPreview` (owned entirely by this module)
 * @param {() => void} deps.render
 * @param {() => void} deps.refreshSpeciesTable
 * @param {(description: string) => void} deps.commitLayoutChange
 * @param {() => void} deps.clearSelection  plantSelection.clearSelection —
 *   painting and the ordinary selection never coexist, like a review
 * @param {(driftId: string) => void} deps.selectDrift
 * @param {(ids: string[]) => void} deps.selectPlants  for the rare stroke
 *   that ends in exactly one plant (no driftId survives normalizeDrifts)
 * @param {() => boolean} [deps.isReviewActive]  refuses to start while a
 *   drift-suggestion review is open (src/interaction/driftReviewMode.js)
 * @param {() => void} deps.syncDragLocks  re-applies every dragController's
 *   locked state from appState.mode and this module's own isActive()
 *   (src/app.js) — called after every active/inactive transition
 * @param {() => Array<{setLocked:(locked:boolean)=>void}|null>} deps.getPaintControllers
 *   one per plan view panel (src/interaction/paintController.js); this
 *   module is the only thing that ever unlocks them
 * @param {{ closePlants?: () => void, switchToPlan?: () => void }} [deps.phoneEditor]
 */
export function createPaintDriftMode({
  elements,
  appState,
  render,
  refreshSpeciesTable,
  commitLayoutChange,
  clearSelection,
  selectDrift,
  selectPlants,
  isReviewActive = () => false,
  syncDragLocks,
  getPaintControllers,
  phoneEditor,
}) {
  const { bar, label, doneBtn, moreBtn, moreGroup, hintEl, undoBtn, redoBtn, undoRealBtn, redoRealBtn } = elements;

  let active = false;
  let currentSpeciesId = '';
  let currentLabel = '';
  let currentSpacing = 0;
  let currentRadiusFt = 0;
  let lastDriftId = '';
  let lastPlantIds = [];
  let pendingPreviewPoints = null;
  let previewFrameQueued = false;

  const closeMore = () => {
    if (!moreGroup) return;
    moreGroup.classList.remove('is-open');
    moreBtn?.setAttribute('aria-expanded', 'false');
  };
  moreBtn?.addEventListener('click', () => {
    if (!moreGroup) return;
    const willOpen = !moreGroup.classList.contains('is-open');
    moreGroup.classList.toggle('is-open', willOpen);
    moreBtn.setAttribute('aria-expanded', String(willOpen));
  });
  // Forward to the REAL undo/redo buttons, exactly like selectionBar.js/
  // driftReviewMode.js's own mirrored pairs — never disabled-but-clicked.
  undoBtn?.addEventListener('click', () => {
    if (undoRealBtn && !undoRealBtn.disabled) undoRealBtn.click();
  });
  redoBtn?.addEventListener('click', () => {
    if (redoRealBtn && !redoRealBtn.disabled) redoRealBtn.click();
  });
  doneBtn?.addEventListener('click', () => done());

  function setHint(message) {
    if (!hintEl) return;
    hintEl.textContent = message || '';
    hintEl.hidden = !message;
  }

  function hideBar() {
    if (bar) bar.hidden = true;
    closeMore();
    setHint('');
  }

  function sync() {
    if (!bar) return;
    bar.hidden = !active;
    if (!active) {
      closeMore();
      return;
    }
    if (label) label.textContent = `Paint ${currentLabel} — trace along the bed`;
  }

  /**
   * src/interaction/paintController.js's onStrokeMove: the full polyline
   * collected so far, in plan feet, from the stroke's own start — only once
   * it has moved past the tap threshold (a plain tap never reaches here).
   * Recomputed at most once per frame; a long stroke can report many moves
   * between two frames, and only the latest one matters.
   */
  function handleStrokeMove(points) {
    if (!active) return;
    pendingPreviewPoints = points;
    if (previewFrameQueued) return;
    previewFrameQueued = true;
    requestAnimationFrame(() => {
      previewFrameQueued = false;
      if (!active || !pendingPreviewPoints) return;
      const tracePoints = pendingPreviewPoints;
      const bounds = resolveYardBounds(appState.project);
      const { positions } = resampleStroke(tracePoints, currentSpacing);
      appState.paintPreview = {
        tracePoints,
        positions: dropPositionsOutsideYard(positions, bounds),
        radiusFt: currentRadiusFt,
      };
      render();
    });
  }

  /** onStrokeEnd: the full polyline, only for a stroke that moved past the
   * tap threshold at some point — commits the edit (src/state/driftEdits.js's
   * paintDrift) as one history entry and stays in paint mode for more. */
  function handleStrokeEnd(tracePoints) {
    if (!active) return;
    appState.paintPreview = null;
    const { plants: created, driftId, reason, capped } = paintDrift(appState, currentSpeciesId, tracePoints);
    if (!created.length) {
      render();
      setHint(reason || '');
      return;
    }
    lastDriftId = driftId || '';
    lastPlantIds = created.map((plant) => plant.id);
    render();
    refreshSpeciesTable();
    commitLayoutChange(`Painted ${driftLabel(created)}`);
    setHint(
      capped
        ? `Reached the ${MAX_PAINT_COUNT}-plant limit for one stroke; trace another to continue.`
        : ''
    );
  }

  /** onStrokeCancel: a plain tap (nothing was ever shown), a second finger
   * arriving mid-stroke, or an interrupted gesture — never leaves paint mode. */
  function handleStrokeCancel() {
    if (!active) return;
    pendingPreviewPoints = null;
    if (appState.paintPreview) {
      appState.paintPreview = null;
      render();
    }
  }

  function setPaintControllersLocked(locked) {
    (getPaintControllers?.() || []).forEach((controller) => controller?.setLocked?.(locked));
  }

  /** Edit mode, not read-only, and no drift review already open — checked
   * here too, not just at the Add plant sheet's own Paint choice. */
  function start(speciesId) {
    if (active || isReviewActive?.()) return;
    if (appState.readOnly || appState.mode !== 'edit') return;
    const speciesEntry = (appState.species || []).find((entry) => entry.speciesId === speciesId);
    if (!speciesEntry) return;

    // A throwaway probe, exactly like addDriftFromCatalog's and paintDrift's
    // own: only its resolved width is read, to size the live preview the
    // same way the eventual edit will.
    const probe = createPlantFromSpecies(speciesEntry, { id: 'probe', x: 0, y: 0 });
    const resolvedWidth = Number(probe.width) || DEFAULT_MEMBER_RADIUS_FT * 2;
    currentSpeciesId = speciesId;
    currentSpacing = resolvedWidth * SPACING_FACTOR;
    currentRadiusFt = resolvedWidth / 2;
    currentLabel = buildPlantLabel(speciesEntry) || speciesEntry.commonName || speciesEntry.botanicalName || 'plant';
    lastDriftId = '';
    lastPlantIds = [];
    pendingPreviewPoints = null;
    appState.paintPreview = null;

    active = true;
    clearSelection();
    syncDragLocks();
    setPaintControllersLocked(false);
    phoneEditor?.closePlants?.();
    phoneEditor?.switchToPlan?.();
    setHint('');
    refreshSpeciesTable(); // hides the "N possible drifts" banner now that isActive() is true
    // The phone editor's own idle bar (a fourth occupant of this same fixed-
    // bottom slot) only re-syncs itself from render() or its own sync() — see
    // phoneEditor.js's syncBar — so entering paint mode has to trigger one,
    // the same way clearSelection()'s own onSelectionChange already triggers
    // one for the ordinary selection.
    render();
    sync();
  }

  /** Shared by Done and a forced stop (a real mode change, src/app.js's
   * applyMode): unlock every drag controller BEFORE selecting anything, since
   * a controller only re-arms is-selection-active while unlocked
   * (dragController.js's setSelectionActive) — selecting first would leave
   * the very next touch unable to move what Done just selected. */
  function finish(selectLast) {
    if (!active) return;
    active = false;
    appState.paintPreview = null;
    pendingPreviewPoints = null;
    setPaintControllersLocked(true);
    syncDragLocks();
    hideBar();
    render();
    refreshSpeciesTable(); // the banner reappears if anything is still pending
    if (selectLast) {
      if (lastDriftId) selectDrift?.(lastDriftId);
      else if (lastPlantIds.length) selectPlants?.(lastPlantIds);
    }
  }

  /** The Done button: leaves paint mode and selects the last painted drift
   * (or, for a stroke that only ever placed one plant, that plant). */
  function done() {
    finish(true);
  }

  /** A forced stop — a real mode change, or anything else that for any
   * reason ends a paint session in progress — selects nothing (selection
   * means nothing outside Edit mode, and a mode change already clears it). */
  function stop() {
    finish(false);
  }

  return {
    isActive: () => active,
    start,
    done,
    stop,
    handleStrokeMove,
    handleStrokeEnd,
    handleStrokeCancel,
    sync,
    /** So src/app.js's document-level click handler can ignore a click that
     * lands on the bar itself, the way it already does for the selection bar
     * and the drift-review bar. */
    contains: (node) => Boolean(bar && node instanceof Node && bar.contains(node)),
  };
}
