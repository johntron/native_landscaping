import { parseCsv } from '../data/csvLoader.js';
import { normalizeGenus } from './hostGenera.js';
import { isExcludedEstablishment } from './establishmentMeans.js';

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
 * What a GloBI verb actually witnesses, as three labels rather than one score.
 *
 * `category` in the CSV is deliberately coarse — two buckets, because
 * tools/fetch-plant-animal-interactions.mjs found that GloBI's `eatenBy`
 * conflates true herbivory with bees filed generically as "forages on", and
 * refused to invent a split the data does not carry. This keeps that refusal
 * and adds only what the raw verb genuinely distinguishes:
 *
 *   develops-on   the animal completes part of its life cycle ON the plant
 *   consumes      the animal eats it; which tissue, and as what life stage,
 *                 the record does not say
 *   flower-visit  the animal was recorded at the flowers
 *
 * **`develops-on` is not a synonym for "caterpillar", and the counts prove
 * the verbs are source-dependent rather than biological.** Against this
 * repo's tables, only 7 of 22 screened genera carry ANY `hostOf` record near
 * this site (18 records, against 112 `eatenBy`), Quercus's two are a gall
 * wasp and a gall midge rather than any Lepidoptera, and Carya's walnut sphinx
 * — unambiguously a caterpillar developing on the plant — arrives as
 * `eatenBy`. So these labels say what was recorded, not what is true, and a
 * reader must be shown both columns. Filtering to `develops-on` alone would
 * silently drop real host records; that is why nothing here defaults to it.
 */
export const EVIDENCE_BY_INTERACTION_TYPE = Object.freeze({
  hostOf: 'develops-on',
  hasEggsLayedOnBy: 'develops-on',
  eatenBy: 'consumes',
  pollinatedBy: 'flower-visit',
  flowersVisitedBy: 'flower-visit',
  visitsFlowersOf: 'flower-visit',
  visitedBy: 'flower-visit',
});

/** '' for a verb the fetch tool did not keep, so an unknown never reads as evidence. */
export function evidenceKind(interactionType) {
  return EVIDENCE_BY_INTERACTION_TYPE[String(interactionType || '').trim()] || '';
}

/**
 * Which label to keep when one animal is recorded against one plant under
 * several verbs — a strength ordering for DEDUPING ONLY, not a score anything
 * is ranked or summed by.
 */
const EVIDENCE_RANK = { 'develops-on': 3, consumes: 2, 'flower-visit': 1 };

function evidenceRank(evidence) {
  return EVIDENCE_RANK[evidence] || 0;
}

/**
 * How far a taxon group plausibly ranges to find a newly planted specimen.
 * Reasoned defaults, not a sourced biological fact like host-genera.csv's
 * counts — the same kind of authored judgment threshold as AMPLE_SHARE in
 * rules/keystoneGenera.js. Ordered by typical foraging/home-range scale:
 * flying pollinators and small ectotherms range least, birds and mammals most.
 *
 * These were always meant as real miles (nl-rma): nearby-fauna.csv's
 * nearest_radius_mi held kilometres by mistake for a while after these
 * thresholds were written (fixed by nl-a8v), but the mistake was in the
 * CSV's generation, not in this reasoning — these numbers were authored
 * against plausible home ranges in miles, never tuned against the
 * mislabeled column. So nl-a8v's fix made the comparison correct for the
 * first time rather than needing a matching change here.
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
 * species was found within), observation_count, establishment_means,
 * fetched_on, source.
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
 * `establishmentMeans` rides along on every match, and `nativeOnly` drops the
 * animals iNaturalist's checklist positively calls introduced/naturalized/
 * invasive for this place. Off by default so existing callers are unchanged;
 * a page arguing that a native plant supports local wildlife should turn it on,
 * because a European Starling on that list argues the opposite. Unassessed
 * species are kept either way — no listing is not evidence of non-native
 * status (see establishmentMeans.js).
 *
 * `evidence` labels each match per EVIDENCE_BY_INTERACTION_TYPE, and
 * `evidenceKinds` narrows to the labels a caller wants. Read that constant's
 * note before narrowing: the verbs are source-dependent, so asking for
 * 'develops-on' alone drops real host records filed as 'consumes'.
 *
 * @param {string} genus
 * @param {{ interactions: ReturnType<typeof buildInteractionsIndex>, nearbyFauna: ReturnType<typeof buildNearbyFaunaIndex>, place: string, nativeOnly?: boolean, evidenceKinds?: Iterable<string> }} ctx
 * @returns {Array<{ animalSpecies: string, animalCommon: string, category: string, interactionType: string, evidence: string, iconicTaxon: string, nearestRadiusMi: number, observationCount: number, establishmentMeans: string, inRange: boolean }>}
 */
export function matchesForGenus(
  genus,
  { interactions, nearbyFauna, place, nativeOnly = false, evidenceKinds = null }
) {
  const wantedEvidence = evidenceKinds ? new Set(evidenceKinds) : null;
  const nearby = nearbyFauna.forPlace(place);
  if (!nearby.size) return [];
  // One row per animal per category, as before. But `category` is coarse
  // enough that hostOf and eatenBy share the 'feeds-on' bucket, so which verb
  // reached the reader used to depend on CSV row order. Now the strongest
  // evidence recorded for that animal wins, which is deterministic and is the
  // claim a reader would want: "developing on it" outranks "eating it".
  const byDedupeKey = new Map();
  interactions.forGenus(genus).forEach((interaction) => {
    const key = animalKey(interaction.animalSpecies);
    const local = nearby.get(key);
    if (!local) return;
    if (nativeOnly && isExcludedEstablishment(local.establishmentMeans)) return;
    const evidence = evidenceKind(interaction.interactionType);
    if (wantedEvidence && !wantedEvidence.has(evidence)) return;
    const dedupeKey = `${key}|${interaction.category}`;
    const existing = byDedupeKey.get(dedupeKey);
    if (existing && evidenceRank(evidence) <= evidenceRank(existing.evidence)) return;
    const threshold = RANGE_THRESHOLD_MI[local.iconicTaxon];
    byDedupeKey.set(dedupeKey, {
      animalSpecies: local.animalSpecies,
      animalCommon: local.animalCommon || interaction.animalCommon,
      category: interaction.category,
      interactionType: interaction.interactionType,
      evidence,
      iconicTaxon: local.iconicTaxon,
      nearestRadiusMi: local.nearestRadiusMi,
      observationCount: local.observationCount,
      establishmentMeans: local.establishmentMeans,
      inRange: Number.isFinite(threshold) ? local.nearestRadiusMi <= threshold : null,
    });
  });
  return [...byDedupeKey.values()].sort((a, b) => a.nearestRadiusMi - b.nearestRadiusMi);
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
    establishmentMeans: String(row.establishment_means || '').trim(),
    source: String(row.source || '').trim(),
  };
}
