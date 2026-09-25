import { LIFECYCLE_CSV_COLUMNS, lifecycleCsvCells } from './plantLifecycle.js';

/**
 * planting_layout.csv's columns: where each plant stands, then its lifecycle
 * (nl-3s5.22: status, planted_on, and the free-text source with the sourcing/
 * row it was linked to, if any). The file is the person's own record of their
 * yard, so it carries everything they entered about each plant. A file with
 * only the first four columns still loads (src/data/plantParser.js).
 */
export const LAYOUT_POSITION_HEADER = Object.freeze(['id', 'species_id', 'x_ft', 'y_ft']);
export const LAYOUT_HEADER = Object.freeze([...LAYOUT_POSITION_HEADER, ...LIFECYCLE_CSV_COLUMNS]);

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
      ...lifecycleCsvCells(plant).map(escapeCell),
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
  if (!/[",\r\n]/.test(str)) return str;
  return `"${str.replace(/"/g, '""')}"`;
}
