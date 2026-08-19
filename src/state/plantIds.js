/**
 * Build an id for a new plant that cannot collide with one already placed.
 * Every path that adds a plant must route through this: ids address plants for
 * dragging, cloning, and highlighting, and parsePlantLayoutCsv rejects layouts
 * that repeat one, so a collision here would write a file that will not load.
 * @param {Array<{id: string}>} existingPlants
 * @param {string} baseId
 * @returns {string}
 */
export function buildCloneId(existingPlants, baseId) {
  const existing = new Set((existingPlants || []).map((p) => String(p.id)));
  const base = String(baseId || 'plant');
  let candidate = `${base}-copy`;
  let counter = 2;
  while (existing.has(candidate)) {
    candidate = `${base}-copy-${counter}`;
    counter += 1;
  }
  return candidate;
}
