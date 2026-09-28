/**
 * The selection action bar (nl-o47.2): visible in Edit mode whenever
 * appState.selectedPlantIds is non-empty. Fixed to the bottom of the
 * viewport (styles.css, env(safe-area-inset-bottom)) so it is reachable on a
 * phone without scrolling; a small floating bar on desktop too.
 *
 * Shows the selected plant's common name (falling back to its botanical
 * name, then "1 plant"), or "N plants" — only single selection has UI today,
 * but the count form is ready for a drift's several plants (nl-o47.6). The
 * actions: Details (opens the existing plant detail sheet, src/ui/detailSheet.js),
 * Clone, Remove, four nudge arrows labelled by compass point, and Done
 * (clear the selection).
 *
 * DOM lookups stay in src/app.js, which passes every element in; every action
 * here is a callback into app.js, which owns the actual edit + commit.
 */

export function createSelectionBar({
  elements,
  appState,
  onDetails,
  onClone,
  onRemove,
  onDone,
  onNudge,
}) {
  const { bar, name, detailsBtn, cloneBtn, removeBtn, doneBtn, nudgeN, nudgeE, nudgeS, nudgeW } = elements;

  /** Re-read appState and show/hide/relabel the bar. Called from render(). */
  const sync = () => {
    if (!bar) return;
    const selection = appState.selectedPlantIds;
    const visible = appState.mode === 'edit' && Boolean(selection) && selection.size > 0;
    bar.hidden = !visible;
    if (!visible || !name) return;
    const ids = [...selection];
    if (ids.length === 1) {
      const plant = appState.plants.find((candidate) => String(candidate.id) === ids[0]);
      name.textContent = plant?.commonName || plant?.botanicalName || '1 plant';
    } else {
      name.textContent = `${ids.length} plants`;
    }
  };

  detailsBtn?.addEventListener('click', () => onDetails?.());
  cloneBtn?.addEventListener('click', () => onClone?.());
  removeBtn?.addEventListener('click', () => onRemove?.());
  doneBtn?.addEventListener('click', () => onDone?.());
  nudgeN?.addEventListener('click', () => onNudge?.('N'));
  nudgeE?.addEventListener('click', () => onNudge?.('E'));
  nudgeS?.addEventListener('click', () => onNudge?.('S'));
  nudgeW?.addEventListener('click', () => onNudge?.('W'));

  return {
    sync,
    /** So src/app.js's document-level click handler can ignore a click that
     * lands on the bar itself, the way it already does for the plant menu. */
    contains: (node) => Boolean(bar && node instanceof Node && bar.contains(node)),
  };
}
