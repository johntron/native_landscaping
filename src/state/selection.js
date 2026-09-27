/**
 * Pure helpers for the plant selection (nl-o47.2): a SET of plant ids that
 * Edit-mode's touch and desktop gestures build on. The stateful side (holding
 * the Set on appState, notifying render, and reconciling with speciesHighlight's
 * "targeted plant") lives in src/ui/plantSelection.js; this file is the part
 * that can be reasoned about, and tested, with no DOM.
 */

/**
 * Ids from `selection` that still name a plant in `plants`. Called after
 * undo/redo, a remove, or a fresh load — anything that can drop a plant the
 * selection was pointing at.
 * @param {Set<string>} selection
 * @param {Array<{id: any}>} plants
 * @returns {Set<string>} a new Set (never the same instance as `selection`)
 */
export function pruneSelectionIds(selection, plants) {
  const existing = new Set((plants || []).map((plant) => String(plant.id)));
  const pruned = new Set();
  (selection || []).forEach((id) => {
    const normalized = String(id);
    if (existing.has(normalized)) pruned.add(normalized);
  });
  return pruned;
}

/**
 * Whether two selections name exactly the same ids, order aside. Used to skip
 * a redundant render when a selection change is a no-op (e.g. pruning after
 * an undo that did not touch the selected plant).
 */
export function selectionsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
}

/** Build a normalized (string-keyed) selection Set from an id or a list of ids. */
export function toSelectionSet(ids) {
  const list = Array.isArray(ids) ? ids : [ids];
  return new Set(list.filter((id) => id !== null && id !== undefined && id !== '').map(String));
}
