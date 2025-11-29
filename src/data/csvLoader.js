/**
 * Fetch the CSV file from a relative path.
 * Kept small so we can swap in other data sources later without changing callers.
 * @param {string|URL} csvPath
 * @returns {Promise<string>}
 */
export async function fetchCsv(csvPath) {
  const response = await fetch(csvPath, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Failed to load plants CSV (${response.status})`);
  }
  return response.text();
}

/**
 * Minimal CSV parser that honours quoted fields and returns an array of row objects.
 * Only features needed for our dataset are implemented to keep dependencies zero.
 * @param {string} csvText
 * @returns {Array<Record<string, string>>}
 */
export function parseCsv(csvText) {
  const lines = csvText.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];

  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const parts = splitCsvLine(lines[i]);
    const row = {};
    header.forEach((key, idx) => {
      row[key] = (parts[idx] ?? '').trim();
    });
    rows.push(row);
  }

  return rows;
}

function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === ',' && !inQuotes) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  cells.push(current);
  return cells;
}
