// Server-side (fs/SQLite-based) counterpart to src/analysis/rarity.js's pure
// classifier — same split as yardRelevanceTables.js: this module touches
// data/ecosystem.db, the classifier itself stays side-effect-free.
//
// Unlike host-genera.csv/plant-animal-interactions.csv (checked in, read
// once), ecosystem.db is a *local*, gitignored index (see
// tools/ecosystemIndexDb.js) that only covers yards whose index has been
// built. So "no index" is treated the same "report, don't guess" way
// loadYardRelevanceTables treats a missing ecoregion — never silently as
// "every taxon here has zero observations."
//
// Keyed by yard (nl-3s5.6): a saved area names a `place` label
// (filters.place), and the index is per yard, so the label is resolved among
// the AREA OWNER'S OWN yards only (resolveRarityProject). The same label on
// another owner's yard is never consulted, and an area with no owner resolves
// to nothing.
import { indexStatus, listSpeciesObservations, locationKey, openEcosystemDb } from '../ecosystemIndexDb.js';
import { listOwnerProjectSites } from '../../server/db/projectSites.js';

/**
 * The yard whose index a saved area's rarity lane reads: among the area
 * owner's yards whose place label equals `place` (case- and space-
 * insensitively, since the saved-areas form is free text), the oldest one with
 * an index built for its current location. null when none.
 *
 * @param {{ appDb: object, ecosystemDb: object, ownerId: number | null | undefined, place: string | undefined }} args
 * @returns {number | null} app.db projects.id
 */
export function resolveRarityProject({ appDb, ecosystemDb, ownerId, place }) {
  const wanted = normalizePlace(place);
  if (!wanted || ownerId == null) return null;
  for (const site of listOwnerProjectSites(appDb, ownerId)) {
    if (normalizePlace(site.place) !== wanted) continue;
    if (indexStatus(ecosystemDb, site.id, locationKey(site.location)).rowsApply) return site.id;
  }
  return null;
}

function normalizePlace(place) {
  return String(place || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Build the taxon_name -> observation_count map the rarity feed lane needs,
 * from one yard's index.
 * @param {{ place?: string, projectId?: number | null, db?: object, dbPath?: string }} options
 *   `place` is the saved area's label, used only to say what is missing;
 *   `projectId` is what resolveRarityProject found for it. `db` is an
 *   already-open handle from openEcosystemDb (what the web server passes, so
 *   this never opens a fresh handle per request — nl-3s5.14); `dbPath` is
 *   test-only, overriding the default data/ecosystem.db location when no `db`
 *   handle is given.
 * @returns {{ ok: false, reason: string } | { ok: true, speciesObservations: Map<string, number> }}
 */
export function loadRarityTables({ place, projectId, db, dbPath } = {}) {
  const trimmed = String(place || '').trim();
  if (!trimmed) {
    return { ok: false, reason: 'This saved area has no place set — add one to use the rarity lane.' };
  }
  const noIndex = {
    ok: false,
    reason: `No local species index for place "${trimmed}" — it must match the place of one of your yards that has a location and a built nearby index.`,
  };
  if (projectId == null) return noIndex;

  const ecosystemDb = db || openEcosystemDb(dbPath);
  const rows = listSpeciesObservations(ecosystemDb, { projectId });
  if (!rows.length) return noIndex;

  const speciesObservations = new Map();
  for (const row of rows) {
    speciesObservations.set(row.taxon_name, row.observation_count);
  }
  return { ok: true, speciesObservations };
}
