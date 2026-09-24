export const LAYOUT_HEADER = ['id', 'species_id', 'x_ft', 'y_ft'];

/**
 * Convert the current in-memory plants into a planting_layout.csv payload.
 * Coordinates remain in feet so the exported file can be dropped back into the app.
 *
 * The species is written as plants.csv's `id` (the plant's `speciesId`), never
 * its botanical name, so a later rename in plants.csv cannot orphan the row
 * (nl-3s5.18). A plant without one would write a row nothing can read back, so
 * that is refused rather than written blank. The usual cause is a history
 * entry saved before species ids existed: run tools/migrate-species-ids.mjs.
 * @param {Array<Object>} plants
 * @returns {string}
 */
export function buildLayoutCsv(plants) {
  const lines = [LAYOUT_HEADER.join(',')];

  plants.forEach((plant) => {
    if (!plant.speciesId) {
      throw new Error(
        `Plant "${plant.id}" (${plant.botanicalName || 'no botanical name'}) has no speciesId, so its layout row could not be read back; ` +
          'if it came from an old layout-history.json, run tools/migrate-species-ids.mjs on the projects directory'
      );
    }
    lines.push([
      escapeCell(plant.id),
      escapeCell(plant.speciesId),
      formatNumber(plant.x),
      formatNumber(plant.y),
    ].join(','));
  });

  return lines.join('\n');
}

/**
 * buildLayoutCsv for COMPARISON only: null instead of a throw when some plant
 * has no speciesId. Loading history compares every saved entry against the
 * layout file, and one unreadable entry (a pre-species-id snapshot, or a stray
 * test row) must mean "this entry does not match", not "history failed to load".
 * @param {Array<Object>} plants
 * @returns {string|null}
 */
export function tryBuildLayoutCsv(plants) {
  if (!Array.isArray(plants) || plants.some((plant) => !plant?.speciesId)) return null;
  return buildLayoutCsv(plants);
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return '';
  return value.toFixed(3);
}

function escapeCell(value) {
  if (value === undefined || value === null) return '';
  const str = String(value);
  if (!/[",\n]/.test(str)) return str;
  return `"${str.replace(/"/g, '""')}"`;
}
