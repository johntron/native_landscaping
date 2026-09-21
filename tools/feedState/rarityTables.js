// Server-side (fs/SQLite-based) counterpart to src/analysis/rarity.js's pure
// classifier — same split as yardRelevanceTables.js: this module touches
// data/ecosystem.db, the classifier itself stays side-effect-free.
//
// Unlike host-genera.csv/plant-animal-interactions.csv (checked in, read
// once), ecosystem.db is a *local*, gitignored index (see
// tools/ecosystemIndexDb.js) that only exists once someone has run
// tools/fetch-ecosystem-index.mjs for a place, and only covers whichever
// iconic taxa that run fetched. So "no rows for this place" is treated the
// same "report, don't guess" way loadYardRelevanceTables treats a missing
// ecoregion — never silently as "every taxon here has zero observations."
import { openEcosystemDb, listSpeciesObservations } from '../ecosystemIndexDb.js';

/**
 * Build the taxon_name -> observation_count map the rarity feed lane needs,
 * for one place.
 * @param {{ place?: string, dbPath?: string }} options `dbPath` is test-only,
 *   overriding the default data/ecosystem.db location.
 * @returns {{ ok: false, reason: string } | { ok: true, speciesObservations: Map<string, number> }}
 */
export function loadRarityTables({ place, dbPath } = {}) {
  const trimmed = String(place || '').trim();
  if (!trimmed) {
    return { ok: false, reason: 'This saved area has no place set — add one to use the rarity lane.' };
  }

  const db = openEcosystemDb(dbPath);
  const rows = listSpeciesObservations(db, { place: trimmed });
  if (!rows.length) {
    return { ok: false, reason: `No local species index for place "${trimmed}" — run tools/fetch-ecosystem-index.mjs for it first.` };
  }

  const speciesObservations = new Map();
  for (const row of rows) {
    speciesObservations.set(row.taxon_name, row.observation_count);
  }
  return { ok: true, speciesObservations };
}
