const LAYOUT_HEADER = ['id', 'botanical_name', 'x_ft', 'y_ft', 'width_ft', 'height_ft', 'growth_shape'];

/**
 * Convert the current in-memory plants into a planting_layout.csv payload.
 * Coordinates remain in feet so the exported file can be dropped back into the app.
 * @param {Array<Object>} plants
 * @returns {string}
 */
export function buildLayoutCsv(plants) {
  const lines = [LAYOUT_HEADER.join(',')];

  plants.forEach((plant) => {
    lines.push([
      escapeCell(plant.id),
      escapeCell(plant.botanicalName),
      formatNumber(plant.x),
      formatNumber(plant.y),
      formatNumber(plant.width),
      formatNumber(plant.height),
      escapeCell(plant.growthShape),
    ].join(','));
  });

  return lines.join('\n');
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
