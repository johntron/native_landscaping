// Server-side (fs-based) counterpart to src/data/ecologyTables.js's browser
// fetchCsv loader — same pattern tools/fnct-genus-screen.mjs already uses
// (readFileSync + parseCsv straight into the pure index builders in
// src/analysis/). Kept in tools/ rather than src/ because it touches the
// filesystem; the classifier itself (src/analysis/yardRelevance.js) stays
// pure and side-effect-free.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../../src/data/csvLoader.js';
import { buildHostGeneraIndex, emptyHostGeneraIndex } from '../../src/analysis/hostGenera.js';
import { buildInteractionsIndex, emptyInteractionsIndex } from '../../src/analysis/faunaMatches.js';
import { catalogGenusKeys } from '../../src/analysis/plantMatches.js';
import { buildAnimalGeneraIndex } from '../../src/analysis/yardRelevance.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function readCsv(relativePath) {
  try {
    return readFileSync(`${ROOT}${relativePath}`, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Build the ecology + catalog indexes the yard-relevance feed lane needs, for
 * one ecoregion. Returns `{ ok: false, reason }` when `ecoregion` is missing
 * or host-genera.csv has no rows for it — same "report, don't guess" stance
 * as computePlantMatches' bail-out — so the feed route can surface a clear
 * message instead of silently returning zero items.
 * @param {{ ecoregion?: string }} options
 */
export function loadYardRelevanceTables({ ecoregion } = {}) {
  const trimmed = String(ecoregion || '').trim();
  if (!trimmed) {
    return { ok: false, reason: 'This saved area has no ecoregion set — add one to use the yard-relevance lane.' };
  }

  const hostGeneraCsv = readCsv('ecology/host-genera.csv');
  const hostGenera = hostGeneraCsv ? buildHostGeneraIndex(hostGeneraCsv, { ecoregion: trimmed }) : emptyHostGeneraIndex();
  if (!hostGenera.size) {
    return { ok: false, reason: `No keystone-genus data for ecoregion "${trimmed}".` };
  }

  const interactionsCsv = readCsv('ecology/plant-animal-interactions.csv');
  const interactions = interactionsCsv ? buildInteractionsIndex(interactionsCsv) : emptyInteractionsIndex();
  const animalGeneraIndex = buildAnimalGeneraIndex(interactions);

  const plantsCsv = readCsv('plants.csv');
  const speciesRows = plantsCsv ? parseCsv(plantsCsv) : [];

  return {
    ok: true,
    hostGenera,
    interactions,
    animalGeneraIndex,
    catalogGenusKeys: catalogGenusKeys(speciesRows),
  };
}
