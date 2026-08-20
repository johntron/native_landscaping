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

/**
 * Build an id for a plant newly placed from the species catalog. Same
 * collision guarantee as buildCloneId, but named after the species rather than
 * an original — a plant added from the catalog has no plant it is a copy of, so
 * `salvia-greggii-1` reads better than `salvia-greggii-copy` in the CSV.
 * @param {Array<{id: string}>} existingPlants
 * @param {string} botanicalName
 * @returns {string}
 */
export function buildNewPlantId(existingPlants, botanicalName) {
  const existing = new Set((existingPlants || []).map((p) => String(p.id)));
  const base =
    String(botanicalName || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'plant';
  let counter = 1;
  let candidate = `${base}-${counter}`;
  while (existing.has(candidate)) {
    counter += 1;
    candidate = `${base}-${counter}`;
  }
  return candidate;
}
