// fs-based loader for ecology/invasive-watchlist.csv, same pattern as
// yardRelevanceTables.js (readFileSync + parseCsv straight into the pure
// index builder — see tools/fnct-genus-screen.mjs for the original of this
// pattern).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildInvasiveWatchlistIndex, emptyInvasiveWatchlistIndex } from '../../src/analysis/invasiveWatchlist.js';

const PATH = fileURLToPath(new URL('../../ecology/invasive-watchlist.csv', import.meta.url));

export function loadInvasiveWatchlist() {
  let csvText = '';
  try {
    csvText = readFileSync(PATH, 'utf8');
  } catch {
    return emptyInvasiveWatchlistIndex();
  }
  return buildInvasiveWatchlistIndex(csvText);
}
