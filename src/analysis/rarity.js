/**
 * Per-observation classifier for the rarity/discovery feed lane (nl-1qy.4).
 *
 * Local scarcity is the first of three planned facts (conservation status
 * and protected/obscured-species status follow in nl-1qy.4.2/.3) — sourced
 * from data/ecosystem.db's species_observations.observation_count, the same
 * /v1/observations/species_counts data fetch-ecosystem-index.mjs already
 * pulls per place+taxon.
 *
 * No composite score, per the epic's hard boundary (nl-3hi), already honored
 * by yardRelevance.js and invasiveWatchlist.js: this only ever surfaces the
 * raw count. A taxon absent from the local index is left unclassified rather
 * than treated as "zero observations" — ecosystem.db is a snapshot scoped to
 * whichever iconic taxa were fetched for a place, so "not in the index" means
 * "unknown," not "rare." The inclusion cutoff (maxObservationCount) is a
 * caller-supplied filter value, never a constant this module picks, so the
 * feed's "how rare is rare" stays the reader's call.
 */

/**
 * @param {{taxon_name?: string}} event a row from observation_events
 * @param {{speciesObservations: Map<string, number>, maxObservationCount?: number}} ctx
 *   speciesObservations maps taxon_name -> observation_count (see
 *   tools/feedState/rarityTables.js). maxObservationCount, when given, drops
 *   any event whose local count exceeds it; omitted, every event with a
 *   known count is surfaced (faceting, not filtering).
 * @returns {null|{kind: 'local-scarcity', observationCount: number}}
 */
export function classifyRarity(event, { speciesObservations, maxObservationCount } = {}) {
  if (!speciesObservations || !speciesObservations.size) return null;
  const taxonName = String(event?.taxon_name || '').trim();
  if (!taxonName || !speciesObservations.has(taxonName)) return null;

  const observationCount = speciesObservations.get(taxonName);
  if (Number.isFinite(maxObservationCount) && observationCount > maxObservationCount) return null;

  return { kind: 'local-scarcity', observationCount };
}
