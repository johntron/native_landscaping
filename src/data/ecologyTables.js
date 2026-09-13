import { fetchCsv } from './csvLoader.js';
import { buildHostGeneraIndex, emptyHostGeneraIndex } from '../analysis/hostGenera.js';
import {
  buildInteractionsIndex,
  emptyInteractionsIndex,
  buildNearbyFaunaIndex,
  emptyNearbyFaunaIndex,
} from '../analysis/faunaMatches.js';

/**
 * Load the three committed ecology tables and hand back the built indexes.
 *
 * These tables are read by every page that says anything about fauna — the
 * design page's rules, the ecosystem page's plant matches, and whatever comes
 * next — and each page used to fetch them itself. That was three copies of the
 * same four lines, and the copies had drifted: `app.js` degraded a missing
 * table to an empty index and kept rendering, while `ecosystemPage.js` let one
 * failed fetch abort its whole plant-matches block. Since an empty index is
 * exactly what the rules are written to report as `not-declared`, the tolerant
 * behaviour is the correct one, and this module is where it now lives once.
 *
 * **A missing table costs checks, not the app.** Every fetch is caught
 * individually; a caller always gets three usable indexes. What failed is
 * reported in `warnings` so a page can say so in its own voice rather than
 * leaving the reader to guess why a panel is empty.
 *
 * @param {object} options
 * @param {string} [options.ecoregion] EPA Level I code; host-genera rows are
 *   per ecoregion, and without one the index is deliberately empty.
 * @param {string|URL} [options.baseUrl] resolved against, for tests.
 * @param {(path: URL) => Promise<string>} [options.fetchCsvImpl] seam for tests.
 * @returns {Promise<{ hostGenera: object, interactions: object, nearbyFauna: object, warnings: string[] }>}
 */
export async function loadEcologyTables({
  ecoregion,
  baseUrl = typeof document === 'undefined' ? 'http://localhost/' : document.baseURI,
  fetchCsvImpl = fetchCsv,
} = {}) {
  const warnings = [];

  const read = async (path, whatItCosts) => {
    try {
      return await fetchCsvImpl(new URL(path, baseUrl));
    } catch (err) {
      const warning = `${path} unavailable; ${whatItCosts}`;
      warnings.push(warning);
      console.warn(warning, err);
      return '';
    }
  };

  const [hostGeneraCsv, interactionsCsv, nearbyFaunaCsv] = await Promise.all([
    read('ecology/host-genera.csv', 'genus checks will report as not declared'),
    read('ecology/plant-animal-interactions.csv', 'local fauna checks will report as not declared'),
    read('ecology/nearby-fauna.csv', 'local fauna checks will report as not declared'),
  ]);

  return {
    hostGenera: hostGeneraCsv
      ? buildHostGeneraIndex(hostGeneraCsv, { ecoregion })
      : emptyHostGeneraIndex(),
    interactions: interactionsCsv ? buildInteractionsIndex(interactionsCsv) : emptyInteractionsIndex(),
    nearbyFauna: nearbyFaunaCsv ? buildNearbyFaunaIndex(nearbyFaunaCsv) : emptyNearbyFaunaIndex(),
    warnings,
  };
}
