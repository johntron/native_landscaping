/**
 * Per-observation classifier for the rarity/discovery feed lane (nl-1qy.4).
 *
 * Three fact kinds, checked in this order and returning the FIRST that
 * matches (an event only ever carries one `relevance` per the feed's
 * existing single-relevance-per-item shape — see tools/feedState/feed.js):
 *
 *  1. local-scarcity (nl-1qy.4.1) — sourced from data/ecosystem.db's
 *     species_observations.observation_count, the same /v1/observations/
 *     species_counts data fetch-ecosystem-index.mjs already pulls per
 *     place+taxon.
 *  2. conservation-status (nl-1qy.4.2) — the conservation_status column
 *     tools/fetch-observation-events.mjs now captures per event from the
 *     same batched /v1/taxa lookup that already fetched establishment_means
 *     (see tools/inatShared.mjs's fetchTaxaFacts).
 *  3. protected-species (nl-1qy.4.3) — the taxon_geoprivacy column, captured
 *     only by the separate protected-species fetch pass
 *     (pollAreaProtectedSpecies); every other event's taxon_geoprivacy is
 *     'open' or blank and never matches here.
 *
 * No composite score, per the epic's hard boundary (nl-3hi), already honored
 * by yardRelevance.js and invasiveWatchlist.js: each kind only ever surfaces
 * its own raw fact (a count, a status string, a geoprivacy flag) — never a
 * synthesized "how rare" score. A taxon absent from the local index is left
 * unclassified rather than treated as "zero observations" — ecosystem.db is
 * a snapshot scoped to whichever iconic taxa were fetched for a place, so
 * "not in the index" means "unknown," not "rare." The local-scarcity
 * inclusion cutoff (maxObservationCount) is a caller-supplied filter value,
 * never a constant this module picks, so the feed's "how rare is rare" stays
 * the reader's call. conservation-status and protected-species are each
 * independently toggle-able (includeConservationStatus /
 * includeProtectedSpecies) rather than always-on, so a reader who only wants
 * local-scarcity facts isn't shown the other two by default.
 */

/**
 * @param {{taxon_name?: string, conservation_status?: string, conservation_status_name?: string, taxon_geoprivacy?: string}} event a row from observation_events
 * @param {{speciesObservations: Map<string, number>, maxObservationCount?: number, includeConservationStatus?: boolean, includeProtectedSpecies?: boolean}} ctx
 *   speciesObservations maps taxon_name -> observation_count (see
 *   tools/feedState/rarityTables.js). maxObservationCount, when given, drops
 *   any event whose local count exceeds it; omitted, every event with a
 *   known count is surfaced (faceting, not filtering).
 * @returns {null
 *   |{kind: 'local-scarcity', observationCount: number}
 *   |{kind: 'conservation-status', status: string, statusName: string}
 *   |{kind: 'protected-species', taxonGeoprivacy: string}}
 */
export function classifyRarity(
  event,
  { speciesObservations, maxObservationCount, includeConservationStatus, includeProtectedSpecies } = {}
) {
  if (speciesObservations && speciesObservations.size) {
    const taxonName = String(event?.taxon_name || '').trim();
    if (taxonName && speciesObservations.has(taxonName)) {
      const observationCount = speciesObservations.get(taxonName);
      if (!Number.isFinite(maxObservationCount) || observationCount <= maxObservationCount) {
        return { kind: 'local-scarcity', observationCount };
      }
    }
  }

  if (includeConservationStatus && event?.conservation_status) {
    return {
      kind: 'conservation-status',
      status: event.conservation_status,
      statusName: event.conservation_status_name || '',
    };
  }

  // Predicate per nl-1qy.4.3: taxon_geoprivacy IN (obscured, private), full
  // stop — never additionally gated on the observer's own geoprivacy choice
  // (see fetch-observation-events.mjs's PROTECTED_TAXON_GEOPRIVACY and its
  // empirical Bald Eagle / Phyllanthus polygonoides findings).
  if (includeProtectedSpecies && (event?.taxon_geoprivacy === 'obscured' || event?.taxon_geoprivacy === 'private')) {
    return { kind: 'protected-species', taxonGeoprivacy: event.taxon_geoprivacy };
  }

  return null;
}
