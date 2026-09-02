import { parseCsv } from '../data/csvLoader.js';
import { normalizeGenus } from './hostGenera.js';

/**
 * Join two checked-in, sourced tables — same shape as ecology/host-genera.csv,
 * fetched offline by tools/fetch-plant-animal-interactions.mjs and
 * tools/fetch-nearby-fauna.mjs — to answer "which animals already reported
 * near this site would plausibly use this plant":
 *
 *   ecology/plant-animal-interactions.csv   genus-keyed, global (GloBI)
 *   ecology/nearby-fauna.csv                place-keyed, local (iNaturalist)
 *
 * The grain is deliberately asymmetric: the animal side is species-level
 * (what the user actually wants to know), the plant side is genus-level
 * (how host/pollinator records actually exist in the literature — monarch is
 * documented against *Asclepias*, not against *Asclepias tuberosa*
 * specifically). This mirrors ecology/host-genera.csv and hostGenera.js.
 *
 * **No likelihood score is computed here.** iNaturalist observation counts
 * carry heavy observer bias (monarchs are wildly over-reported relative to
 * native bees), so this module reports presence + distance band + counts and
 * leaves judgement to the reader — the same "no invented number" stance
 * src/analysis/ecology.js takes for the ecoregion checks.
 */

/**
 * How far a taxon group plausibly ranges to find a newly planted specimen.
 * Reasoned defaults, not a sourced biological fact like host-genera.csv's
 * counts — the same kind of authored judgment threshold as AMPLE_SHARE in
 * rules/keystoneGenera.js. Ordered by typical foraging/home-range scale:
 * flying pollinators and small ectotherms range least, birds and mammals most.
 */
export const RANGE_THRESHOLD_MI = Object.freeze({
  Insecta: 3,
  Amphibia: 3,
  Reptilia: 3,
  Mammalia: 8,
  Aves: 15,
});

/**
 * Parse ecology/plant-animal-interactions.csv into a genus-keyed index.
 *
 * Columns: genus, animal_species, animal_common, category ("pollinator" or
 * "feeds-on"), interaction_type (GloBI's raw verb), synonym_of, source.
 */
export function buildInteractionsIndex(csvText) {
  const rows = parseCsv(csvText || '').map(normalizeInteractionRow).filter((row) => row.genus);
  const byGenus = new Map();
  rows.forEach((row) => {
    const key = normalizeGenus(row.genus);
    if (!byGenus.has(key)) byGenus.set(key, []);
    byGenus.get(key).push(row);
  });
  return {
    size: rows.length,
    byGenus,
    forGenus(genus) {
      return byGenus.get(normalizeGenus(genus)) || [];
    },
  };
}

export function emptyInteractionsIndex() {
  return { size: 0, byGenus: new Map(), forGenus: () => [] };
}

/**
 * Parse ecology/nearby-fauna.csv into a place-keyed index.
 *
 * Columns: place, animal_species, animal_common, iconic_taxon,
 * nearest_radius_mi (the smallest of the fetch tool's distance bands the
 * species was found within), observation_count, fetched_on, source.
 */
export function buildNearbyFaunaIndex(csvText) {
  const rows = parseCsv(csvText || '').map(normalizeFaunaRow).filter((row) => row.place);
  const byPlace = new Map();
  rows.forEach((row) => {
    if (!byPlace.has(row.place)) byPlace.set(row.place, new Map());
    byPlace.get(row.place).set(animalKey(row.animalSpecies), row);
  });
  return {
    size: rows.length,
    byPlace,
    forPlace(place) {
      return byPlace.get(String(place || '').trim()) || new Map();
    },
  };
}

export function emptyNearbyFaunaIndex() {
  return { size: 0, byPlace: new Map(), forPlace: () => new Map() };
}

/**
 * The animals reported near `place` that documented interactions say would
 * use this genus, with each one's distance band and whether that band is
 * within the taxon's plausible range (RANGE_THRESHOLD_MI).
 *
 * Pure join, no scoring: `inRange` is the only judgement made, and it is a
 * distance comparison, not a likelihood estimate.
 *
 * @param {string} genus
 * @param {{ interactions: ReturnType<typeof buildInteractionsIndex>, nearbyFauna: ReturnType<typeof buildNearbyFaunaIndex>, place: string }} ctx
 * @returns {Array<{ animalSpecies: string, animalCommon: string, category: string, interactionType: string, iconicTaxon: string, nearestRadiusMi: number, observationCount: number, inRange: boolean }>}
 */
export function matchesForGenus(genus, { interactions, nearbyFauna, place }) {
  const nearby = nearbyFauna.forPlace(place);
  if (!nearby.size) return [];
  const seen = new Set();
  const matches = [];
  interactions.forGenus(genus).forEach((interaction) => {
    const key = animalKey(interaction.animalSpecies);
    const local = nearby.get(key);
    if (!local) return;
    const dedupeKey = `${key}|${interaction.category}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    const threshold = RANGE_THRESHOLD_MI[local.iconicTaxon];
    matches.push({
      animalSpecies: local.animalSpecies,
      animalCommon: local.animalCommon || interaction.animalCommon,
      category: interaction.category,
      interactionType: interaction.interactionType,
      iconicTaxon: local.iconicTaxon,
      nearestRadiusMi: local.nearestRadiusMi,
      observationCount: local.observationCount,
      inRange: Number.isFinite(threshold) ? local.nearestRadiusMi <= threshold : null,
    });
  });
  return matches.sort((a, b) => a.nearestRadiusMi - b.nearestRadiusMi);
}

/** Scientific names sometimes carry a trinomial subspecies on one side and not the other. */
function animalKey(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .slice(0, 2)
    .join(' ');
}

function normalizeInteractionRow(row) {
  return {
    genus: String(row.genus || '').trim(),
    animalSpecies: String(row.animal_species || '').trim(),
    animalCommon: String(row.animal_common || '').trim(),
    category: String(row.category || '').trim(),
    interactionType: String(row.interaction_type || '').trim(),
    source: String(row.source || '').trim(),
  };
}

function normalizeFaunaRow(row) {
  return {
    place: String(row.place || '').trim(),
    animalSpecies: String(row.animal_species || '').trim(),
    animalCommon: String(row.animal_common || '').trim(),
    iconicTaxon: String(row.iconic_taxon || '').trim(),
    nearestRadiusMi: Number(row.nearest_radius_mi),
    observationCount: Number(row.observation_count) || 0,
    source: String(row.source || '').trim(),
  };
}
