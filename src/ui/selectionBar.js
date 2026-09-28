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
 *  - whole drift selected: the driftId humanized + its member count, with an
 *    inline rename field (never window.prompt/alert/confirm); count -/N/+;
 *    spread tighter/looser; Clone drift; Remove drift; Done; nudges (which
 *    already move the whole selection, unchanged).
 *  - drilled into one member: the SAME plain single-plant controls (Details/
 *    Clone/Remove act on that one plant) plus "Remove from drift" and "Back
 *    to drift".
 *
 * DOM lookups stay in src/app.js, which passes every element in; every
 * action here is a callback into app.js, which owns the actual edit + commit
 * (this module never calls driftEdits.js/layoutHistory itself). The
 * exception is validating a typed drift name (empty, or a collision reported
 * back by onRename) — purely about what this INPUT accepts, not the edit.
 */
import { driftMembers, driftSpacing, memberToRemove, nextMemberPosition } from '../state/driftGeometry.js';
import { humanizeDriftId } from '../data/driftId.js';
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
  onRename,
  onCountChange,
  onSpread,
  onCloneDrift,
  onRemoveDrift,
  onRemoveFromDrift,
  onBackToDrift,
}) {
  const {
    bar,
    name,
    detailsBtn,
    cloneBtn,
    removeBtn,
    doneBtn,
    nudgeN,
    nudgeE,
    nudgeS,
    nudgeW,
    driftNameGroup,
    driftNameInput,
    driftCountLabel,
    driftNameStatus,
    driftCountGroup,
    driftCountDecBtn,
    driftCountValue,
    driftCountIncBtn,
    driftGroup,
    spreadTighterBtn,
    spreadLooserBtn,
    cloneDriftBtn,
    removeDriftBtn,
    driftMemberGroup,
    removeFromDriftBtn,
    backToDriftBtn,
  } = elements;

  const setStatus = (message) => {
    if (!driftNameStatus) return;
    driftNameStatus.textContent = message || '';
    driftNameStatus.hidden = !message;
  };

  /** Re-read appState and show/hide/relabel the bar. Called from render(). */
  const sync = () => {
    if (!bar) return;
    const selection = appState.selectedPlantIds;
    const visible = appState.mode === 'edit' && Boolean(selection) && selection.size > 0;
    bar.hidden = !visible;
    if (!visible) return;

    const driftId = appState.selectedDriftId || '';
    const drilledIn = Boolean(appState.driftDrilledIn);
    const wholeDriftMode = Boolean(driftId) && !drilledIn;
    const drilledInMode = Boolean(driftId) && drilledIn;

    // Plain single-plant controls: shown for "no drift" AND "drilled in"
    // (drilled-in is the single-plant bar plus two extra buttons), hidden
    // only for whole-drift mode.
    if (name) name.hidden = wholeDriftMode;
    if (detailsBtn) detailsBtn.hidden = wholeDriftMode;
    if (cloneBtn) cloneBtn.hidden = wholeDriftMode;
    if (removeBtn) removeBtn.hidden = wholeDriftMode;
    if (!wholeDriftMode) {
      const ids = [...selection];
      if (name) {
        if (ids.length === 1) {
          const plant = appState.plants.find((candidate) => String(candidate.id) === ids[0]);
          name.textContent = plant?.commonName || plant?.botanicalName || '1 plant';
        } else {
          name.textContent = `${ids.length} plants`;
        }
      }
    }

    if (driftNameGroup) driftNameGroup.hidden = !wholeDriftMode;
    if (driftCountGroup) driftCountGroup.hidden = !wholeDriftMode;
    if (driftGroup) driftGroup.hidden = !wholeDriftMode;
    if (driftMemberGroup) driftMemberGroup.hidden = !drilledInMode;
    if (!wholeDriftMode) setStatus('');

    if (wholeDriftMode) syncDriftControls(driftId);
  };

  function syncDriftControls(driftId) {
    const members = driftMembers(appState.plants, driftId);
    const label = humanizeDriftId(driftId);
    const count = members.length;

    if (driftNameInput && document.activeElement !== driftNameInput) {
      driftNameInput.value = label;
    }
    if (driftCountLabel) {
      driftCountLabel.textContent = `· ${count} plant${count === 1 ? '' : 's'}`;
    }
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
  cloneDriftBtn?.addEventListener('click', () => onCloneDrift?.());
  removeDriftBtn?.addEventListener('click', () => onRemoveDrift?.());
  removeFromDriftBtn?.addEventListener('click', () => onRemoveFromDrift?.());
  backToDriftBtn?.addEventListener('click', () => onBackToDrift?.());

  driftNameInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      driftNameInput.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      driftNameInput.value = humanizeDriftId(appState.selectedDriftId);
      setStatus('');
      driftNameInput.blur();
    }
  });
  driftNameInput?.addEventListener('blur', () => {
    // The selection may have moved on (a mode change, Done) between focus
    // and blur; only a live whole-drift selection can still be renamed.
    if (!appState.selectedDriftId || appState.driftDrilledIn) return;
    const value = driftNameInput.value.trim();
    if (!value) {
      setStatus('Give the drift a name.');
      return;
    }
    const result = onRename?.(appState.selectedDriftId, value);
    setStatus(result?.reason || '');
  });

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
