import { normalizeGenus } from './hostGenera.js';
import { animalKey } from './faunaMatches.js';

/**
 * Per-observation classifier for the yard-relevance feed lane (nl-1qy.2).
 *
 * Deliberately separate from `matchNearbyKeystoneGenera` (plantMatches.js):
 * that function is genus-aggregate — one item per genus, built from a whole
 * area's Plantae rows — while a feed item is one observation, dismissible by
 * (observation_id, area_id). Bending the aggregate into a per-row shape would
 * either mint synthetic observation_ids (breaking feed_state's primary key)
 * or fork a tested function with existing callers. This module reuses the
 * same ecology indexes (hostGenera, interactions, catalogGenusKeys) but
 * answers a different question: "is this one observation evidence for a
 * keystone genus missing from the catalog?"
 *
 * No composite score, per the epic's hard boundary (nl-3hi) — each relevant
 * event carries the fact it's evidence of (a missing genus, a documented
 * animal-genus relationship), never an invented likelihood.
 */

/**
 * Invert `plant-animal-interactions.csv`'s genus-keyed index into an
 * animal-keyed one: given an animal observed nearby, which genera do
 * documented interactions say it uses? Built once per request, not per row.
 * @param {ReturnType<import('./faunaMatches.js').buildInteractionsIndex>} interactions
 * @returns {Map<string, Array<{genus: string, category: string, interactionType: string}>>}
 */
export function buildAnimalGeneraIndex(interactions) {
  const byAnimal = new Map();
  for (const rows of interactions?.byGenus?.values() || []) {
    for (const row of rows) {
      const key = animalKey(row.animalSpecies);
      if (!key) continue;
      if (!byAnimal.has(key)) byAnimal.set(key, []);
      byAnimal.get(key).push({
        genus: row.genus,
        category: row.category,
        interactionType: row.interactionType,
      });
    }
  }
  return byAnimal;
}

/** A keystone genus not already in the catalog — the only kind of genus this lane ever surfaces. */
function missingKeystoneGenus(genus, { hostGenera, catalogGenusKeys }) {
  if (!genus || !hostGenera.isKeystone(genus)) return null;
  if (catalogGenusKeys?.has(normalizeGenus(genus))) return null;
  return hostGenera.lookup(genus);
}

/**
 * Classify one observation-event row.
 * @param {{iconic_taxon?: string, taxon_name?: string}} event a row from observation_events
 * @param {{hostGenera: object, interactions: object, animalGeneraIndex: Map, catalogGenusKeys: Set<string>}} ctx
 * @returns {null|{kind: 'missing-genus', genus: string, hostGeneraRow: object}|{kind: 'associated-fauna', matches: Array<{genus: string, hostGeneraRow: object, category: string, interactionType: string}>}}
 */
export function classifyYardRelevance(event, { hostGenera, interactions, animalGeneraIndex, catalogGenusKeys }) {
  if (!hostGenera || !hostGenera.size) return null;

  if (event.iconic_taxon === 'Plantae') {
    const genus = String(event.taxon_name || '').trim().split(/\s+/)[0];
    const row = missingKeystoneGenus(genus, { hostGenera, catalogGenusKeys });
    return row ? { kind: 'missing-genus', genus, hostGeneraRow: row } : null;
  }

  if (!interactions?.size || !animalGeneraIndex?.size) return null;
  const key = animalKey(event.taxon_name);
  const candidates = animalGeneraIndex.get(key) || [];
  const matches = [];
  for (const candidate of candidates) {
    const row = missingKeystoneGenus(candidate.genus, { hostGenera, catalogGenusKeys });
    if (row) matches.push({ genus: candidate.genus, hostGeneraRow: row, category: candidate.category, interactionType: candidate.interactionType });
  }
  return matches.length ? { kind: 'associated-fauna', matches } : null;
}
