/**
 * The selection action bar (nl-o47.2): visible in Edit mode whenever
 * appState.selectedPlantIds is non-empty. Fixed to the bottom of the
 * viewport (styles.css, env(safe-area-inset-bottom)) so it is reachable on a
 * phone without scrolling; a small floating bar on desktop too.
 *
 * Three modes, none of them a separate element — src/app.js's render() calls
 * sync() and this module alone decides what shows (nl-o47.6.2 adds the last
 * two, keyed off appState.selectedDriftId/driftDrilledIn,
 * src/ui/plantSelection.js):
 *  - plain (no drift): the plant's name (or "N plants"), Details, Clone,
 *    Remove, Done, the four nudges — exactly nl-o47.2.
 *  - whole drift selected: driftLabel's species-initials-plus-count text
 *    (src/render/labels.js, nl-o47.6.11 — a drift has no name of its own to
 *    edit, so there is no rename field); count -/N/+; spread tighter/looser;
 *    Planting (the drift-wide status/date/source/ecotype editor, nl-o47.6.10
 *    — opens #detailSheet without touching the selection, src/app.js's
 *    openDriftPlantingSheet); Clone drift; Remove drift; Done; nudges (which
 *    already move the whole selection, unchanged).
 *  - drilled into one member: the SAME plain single-plant controls (Details/
 *    Clone/Remove act on that one plant) plus "Remove from drift" and "Back
 *    to drift".
 *
 * DOM lookups stay in src/app.js, which passes every element in; every
 * action here is a callback into app.js, which owns the actual edit + commit
 * (this module never calls driftEdits.js/layoutHistory itself).
 *
 * nl-o47.4 adds one more purely-local bit of state: whether the "More"
 * popover (nudges, the drift count stepper, spread, clone/remove drift, the
 * drilled-in extras — everything styles.css moves off the bar's one primary
 * row on a phone) is open. Desktop hides the toggle and forces the popover's
 * content inline via CSS, so this never has anything to do there; on a
 * phone it opens/closes on its own button and closes itself whenever the
 * bar's own context changes (hidden entirely, or a different selection/drift
 * mode) so a stale popover from the LAST selection can't linger open over a
 * new one.
 *
 * It also carries an Undo (primary row) and Redo (in the popover), reachable
 * while a selection is still live — undoing a drag or a nudge is the first
 * thing anyone reaches for right after making it, and Done-then-Undo would
 * also throw the selection away. `undoBtn`/`redoBtn` here are a SECOND pair
 * of buttons, not the real `#undoLayoutBtn`/`#redoLayoutBtn` the toolbar and
 * the editor's idle bar already use (one DOM button cannot sit in two
 * places, and it would need to jump between the idle bar and this one on
 * every selection change): a click here just forwards to the real button
 * (`undoRealBtn`/`redoRealBtn`, only if it is not already disabled). Their
 * OWN disabled/title state is not mirrored here — src/history/
 * layoutHistoryController.js's updateHistoryControls() sets it directly,
 * alongside the real buttons, at the one place that already knows when it
 * changes; mirroring it again from this module's own sync() (which runs
 * from render(), BEFORE a drag's commit updates history) read it a tick too
 * early and left the mirror stuck disabled.
 */
import { driftMembers, driftSpacing, memberToRemove, nextMemberPosition } from '../state/driftGeometry.js';
import { driftLabel } from '../render/labels.js';
import { lifecycleOf } from '../data/plantLifecycle.js';
import { resolveYardBounds } from '../render/yardBounds.js';

export function createSelectionBar({
  elements,
  appState,
  onDetails,
  onClone,
  onRemove,
  onDone,
  onNudge,
  onCountChange,
  onSpread,
  onCloneDrift,
  onRemoveDrift,
  onRemoveFromDrift,
  onBackToDrift,
  onDriftPlanting,
}) {
  const {
    bar,
    name,
    detailsBtn,
    cloneBtn,
    removeBtn,
    doneBtn,
    moreBtn,
    moreGroup,
    undoBtn,
    redoBtn,
    undoRealBtn,
    redoRealBtn,
    nudgeN,
    nudgeE,
    nudgeS,
    nudgeW,
    driftCountGroup,
    driftCountDecBtn,
    driftCountValue,
    driftCountIncBtn,
    driftGroup,
    spreadTighterBtn,
    spreadLooserBtn,
    driftPlantingBtn,
    cloneDriftBtn,
    removeDriftBtn,
    driftMemberGroup,
    removeFromDriftBtn,
    backToDriftBtn,
  } = elements;

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
  // Forward to the REAL button (never disabled-but-clicked): a disabled
  // native button already swallows a click, but undoBtn/redoBtn are their
  // own elements and must not fire the real handler while it has nothing to
  // undo/redo.
  undoBtn?.addEventListener('click', () => {
    if (undoRealBtn && !undoRealBtn.disabled) undoRealBtn.click();
  });
  redoBtn?.addEventListener('click', () => {
    if (redoRealBtn && !redoRealBtn.disabled) redoRealBtn.click();
  });
  // What the popover is showing right now, so sync() (called on every
  // render — every month-slider tick included) can tell "the same selection,
  // possibly just nudged or spread from inside the popover itself" apart
  // from "a genuinely different bar," and only force it shut for the latter.
  // Pressing Looser five times in a row must not close the popover after
  // the first press.
  let lastBarKey = '';

  /** Re-read appState and show/hide/relabel the bar. Called from render(). */
  const sync = () => {
    if (!bar) return;
    const selection = appState.selectedPlantIds;
    const visible = appState.mode === 'edit' && Boolean(selection) && selection.size > 0;
    bar.hidden = !visible;
    if (!visible) {
      closeMore();
      lastBarKey = '';
      return;
    }

    const driftId = appState.selectedDriftId || '';
    const drilledIn = Boolean(appState.driftDrilledIn);
    const wholeDriftMode = Boolean(driftId) && !drilledIn;
    const drilledInMode = Boolean(driftId) && drilledIn;
    const soleId = selection.size === 1 ? [...selection][0] : '';
    const solePlant = soleId ? appState.plants.find((candidate) => String(candidate.id) === soleId) : null;
    // The count stepper also appears for a single PLAIN plant (nl-o47.6.9):
    // "+" there converts it into a drift of 2. Excludes a COLD single-plant
    // selection of an existing drift's member (no drift context active) —
    // that plant already belongs to a real drift with its own count, so this
    // is deliberately narrower than "selection.size === 1 && !wholeDriftMode".
    const plainSingleMode = !wholeDriftMode && !drilledInMode && Boolean(solePlant) && !solePlant.driftId;

    const barKey = `${driftId}|${drilledIn}`;
    if (barKey !== lastBarKey) closeMore();
    lastBarKey = barKey;

    // Plain single-plant controls: shown for "no drift" AND "drilled in"
    // (drilled-in is the single-plant bar plus two extra buttons), hidden
    // only for whole-drift mode.
    if (name) name.hidden = false; // shown in every mode now (nl-o47.6.9's review) — see syncDriftControls for whole-drift text
    if (detailsBtn) detailsBtn.hidden = wholeDriftMode;
    if (cloneBtn) cloneBtn.hidden = wholeDriftMode;
    if (removeBtn) removeBtn.hidden = wholeDriftMode;
    if (!wholeDriftMode && name) {
      const ids = [...selection];
      if (ids.length === 1) {
        const plant = appState.plants.find((candidate) => String(candidate.id) === ids[0]);
        name.textContent = plant?.commonName || plant?.botanicalName || '1 plant';
      } else {
        name.textContent = `${ids.length} plants`;
      }
    }

    if (driftCountGroup) driftCountGroup.hidden = !wholeDriftMode && !plainSingleMode;
    if (driftGroup) driftGroup.hidden = !wholeDriftMode;
    if (driftMemberGroup) driftMemberGroup.hidden = !drilledInMode;

    if (wholeDriftMode) syncDriftControls(driftId);
    else if (plainSingleMode) syncSinglePlantCountControls(soleId);
  };

  function syncDriftControls(driftId) {
    const members = driftMembers(appState.plants, driftId);
    const count = members.length;

    if (name) name.textContent = driftLabel(members);
    if (driftCountValue) driftCountValue.textContent = String(count);

    if (driftCountDecBtn) {
      const { member, reason } = memberToRemove(members);
      driftCountDecBtn.disabled = !member;
      driftCountDecBtn.title = member ? '' : reason || '';
    }
    if (driftCountIncBtn) {
      const bounds = resolveYardBounds(appState.project);
      const spacing = driftSpacing(members, members[0]?.width);
      const { position, reason } = nextMemberPosition(members, spacing, bounds);
      driftCountIncBtn.disabled = !position;
      driftCountIncBtn.title = position ? '' : reason || '';
    }
    if (removeDriftBtn) {
      removeDriftBtn.textContent = describeRemoveDriftLabel(members);
    }
  }

  /**
   * The count stepper for a single PLAIN plant (nl-o47.6.9): always reads 1,
   * "-" always disabled (Remove already deletes a lone plant), "+" disabled
   * only when src/state/driftEdits.js's convertToDrift would itself refuse —
   * the SAME check ("is there room for a second member?") it runs, computed
   * here from the one plant rather than duplicating convertToDrift's whole
   * edit just to read its answer.
   */
  function syncSinglePlantCountControls(plantId) {
    if (driftCountValue) driftCountValue.textContent = '1';
    if (driftCountDecBtn) {
      driftCountDecBtn.disabled = true;
      driftCountDecBtn.title = 'Remove deletes the plant';
    }
    if (driftCountIncBtn) {
      const plant = appState.plants.find((candidate) => String(candidate.id) === plantId);
      const bounds = resolveYardBounds(appState.project);
      const spacing = plant ? driftSpacing([plant], plant.width) : 0;
      const { position, reason } = plant
        ? nextMemberPosition([plant], spacing, bounds)
        : { position: null, reason: '' };
      driftCountIncBtn.disabled = !position;
      driftCountIncBtn.title = position ? '' : reason || '';
    }
  }

  detailsBtn?.addEventListener('click', () => onDetails?.());
  cloneBtn?.addEventListener('click', () => onClone?.());
  removeBtn?.addEventListener('click', () => onRemove?.());
  doneBtn?.addEventListener('click', () => onDone?.());
  nudgeN?.addEventListener('click', () => onNudge?.('N'));
  nudgeE?.addEventListener('click', () => onNudge?.('E'));
  nudgeS?.addEventListener('click', () => onNudge?.('S'));
  nudgeW?.addEventListener('click', () => onNudge?.('W'));

  driftCountDecBtn?.addEventListener('click', () => onCountChange?.(-1));
  driftCountIncBtn?.addEventListener('click', () => onCountChange?.(1));
  spreadTighterBtn?.addEventListener('click', () => onSpread?.('tighter'));
  spreadLooserBtn?.addEventListener('click', () => onSpread?.('looser'));
  driftPlantingBtn?.addEventListener('click', () => onDriftPlanting?.());
  cloneDriftBtn?.addEventListener('click', () => onCloneDrift?.());
  removeDriftBtn?.addEventListener('click', () => onRemoveDrift?.());
  removeFromDriftBtn?.addEventListener('click', () => onRemoveFromDrift?.());
  backToDriftBtn?.addEventListener('click', () => onBackToDrift?.());

  return {
    sync,
    /** So src/app.js's document-level click handler can ignore a click that
     * lands on the bar itself, the way it already does for the plant menu. */
    contains: (node) => Boolean(bar && node instanceof Node && bar.contains(node)),
  };
}

/**
 * "Remove drift" says what it is about to do before it acts (nl-o47.6.2's
 * notes: no window.confirm — the button's own label is the confirmation):
 * a PLANNED member is deleted, a PLANTED one only loses the driftId label
 * and stays in the yard (src/state/driftEdits.js removeDrift's own rule).
 */
function describeRemoveDriftLabel(members) {
  const removed = members.filter((m) => lifecycleOf(m).status !== 'planted').length;
  const dissolved = members.length - removed;
  if (removed && dissolved) return `Remove drift (${removed} removed, ${dissolved} stay planted)`;
  if (removed) return `Remove drift (${removed})`;
  if (dissolved) return `Remove drift (${dissolved} stay planted)`;
  return 'Remove drift';
}
