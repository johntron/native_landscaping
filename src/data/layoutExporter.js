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
      formatLayoutNumber(plant.x),
      formatLayoutNumber(plant.y),
    ].join(','));
  });

  return lines.join('\n');
}

/**
 * How the layout file writes a coordinate. Exported so a comparison against a
 * saved layout (src/data/placements.js sameLayout) uses the file's own format.
 * @param {number} value
 * @returns {string}
 */
export function formatLayoutNumber(value) {
  if (!Number.isFinite(value)) return '';
  return value.toFixed(3);
}

function escapeCell(value) {
  if (value === undefined || value === null) return '';
  const str = String(value);
  if (!/[",\n]/.test(str)) return str;
  return `"${str.replace(/"/g, '""')}"`;
}
