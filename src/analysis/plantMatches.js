import { normalizeGenus } from './hostGenera.js';
import { matchesForGenus } from './faunaMatches.js';

/**
 * The "next phase" of the nearby-ecosystem index (nl-a7e): which keystone/
 * larval-host genera for this ecoregion are worth prioritizing at this
 * specific address, using two independent kinds of local evidence from
 * `data/ecosystem.db`:
 *
 *   - associated fauna — animal species GloBI documents as using the genus
 *     (`ecology/plant-animal-interactions.csv`) that are ALSO confirmed
 *     nearby, within their taxon's plausible range. This is the PRIMARY
 *     signal: it says "something is already here that would use this plant",
 *     and does not require the plant itself to have been seen.
 *   - nearby Plantae observations — the genus itself confirmed growing wild
 *     nearby. Secondary, display-only evidence here (it was the sole
 *     criterion in the first version of this module).
 *
 * `rules/keystoneGenera.js`'s `topAbsent` already names the heaviest-hitting
 * genera the catalog cannot supply, ecoregion-wide; this module narrows that
 * to what this specific address has local evidence for.
 *
 * Same "no invented score" stance as `faunaMatches.js`: within the
 * associated-fauna tier, genera are ranked by host-genera.csv's own sourced
 * NWF counts (the same `rank()` formula `keystoneGenera.js` uses for its
 * suggestions) — never by iNaturalist observation_count, which carries heavy
 * observer bias and is display-only.
 *
 * A genus not on host-genera.csv is left out entirely rather than guessed —
 * this is also how nativity is enforced: host-genera.csv is a curated,
 * sourced ecoregion-9 native list, so a genus of introduced weeds observed
 * nearby (e.g. Daucus carota) never has a row and never surfaces.
 */

/**
 * Group `data/ecosystem.db` Plantae rows by genus.
 * @param {Array<{iconic_taxon: string, genus: string, taxon_name: string, common_name: string, radius_mi: number, observation_count: number}>} rows
 * @returns {Map<string, {genus: string, species: Array<{taxonName: string, commonName: string, radiusMi: number, observationCount: number}>}>}
 */
export function groupPlantaeByGenus(rows) {
  const byGenus = new Map();
  (rows || []).forEach((row) => {
    if (row.iconic_taxon !== 'Plantae') return;
    const key = normalizeGenus(row.genus);
    if (!key) return;
    if (!byGenus.has(key)) byGenus.set(key, { genus: row.genus, species: [] });
    byGenus.get(key).species.push({
      taxonName: row.taxon_name,
      commonName: row.common_name || '',
      radiusMi: row.radius_mi,
      observationCount: row.observation_count,
    });
  });
  return byGenus;
}

/**
 * Botanical genera already in the plants.csv catalog, as a normalized-genus
 * key set — same grain host-genera.csv and the ecosystem rows join on.
 * @param {Array<{botanical_name?: string}>} speciesRows raw plants.csv rows (parseCsv output)
 */
export function catalogGenusKeys(speciesRows) {
  const keys = new Set();
  (speciesRows || []).forEach((row) => {
    const genus = String(row.botanical_name || '').trim().split(/\s+/)[0];
    if (genus) keys.add(normalizeGenus(genus));
  });
  return keys;
}

/** Same weighting `rules/keystoneGenera.js` uses to rank its own suggestions — caterpillar hosts count double, since that is what birds actually feed their young on. */
function rank(row) {
  return (row.lepHostSpecies ?? 0) * 2 + (row.beeSpecialistSpecies ?? 0);
}

function animalKey(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .slice(0, 2)
    .join(' ');
}

/**
 * Adapts `data/ecosystem.db`'s fauna rows — finer per-taxon radius bands than
 * `ecology/nearby-fauna.csv`'s five fixed bands — into the shape
 * `faunaMatches.js`'s `matchesForGenus` expects, so this module can reuse
 * that join rather than re-deriving it. Deliberately does NOT touch
 * `rules/localFaunaSupport.js` or `ecology/nearby-fauna.csv` — that pipeline
 * stays as-is; this is an additive, independent read of the same kind of
 * data from a different (more granular) source.
 * @param {Array<object>} observationRows
 * @param {string} place
 */
export function buildEcosystemFaunaIndex(observationRows, place) {
  const byAnimal = new Map();
  (observationRows || []).forEach((row) => {
    if (row.iconic_taxon === 'Plantae') return;
    const key = animalKey(row.taxon_name);
    const existing = byAnimal.get(key);
    if (existing && existing.nearestRadiusMi <= row.radius_mi) return;
    byAnimal.set(key, {
      place,
      animalSpecies: row.taxon_name,
      animalCommon: row.common_name || '',
      iconicTaxon: row.iconic_taxon,
      nearestRadiusMi: row.radius_mi,
      observationCount: row.observation_count,
    });
  });
  return {
    size: byAnimal.size,
    byPlace: new Map([[place, byAnimal]]),
    forPlace: (p) => (p === place ? byAnimal : new Map()),
  };
}

/**
 * Keystone/larval-host genera (per `hostGenera`, ecoregion-scoped) — the
 * FULL list, not just ones with local evidence — split by whether the
 * catalog already carries that genus, and ranked within each side by: (1)
 * how many nearby-confirmed animal species GloBI documents using the genus,
 * then (2) host-genera.csv's own keystone counts. A genus with zero local
 * evidence of either kind still appears, at the bottom of its side, ranked
 * by keystone count alone — this is a prioritization, not a filter.
 *
 * @param {{observationRows: Array<object>, hostGenera: ReturnType<import('./hostGenera.js').buildHostGeneraIndex>, catalogGenusKeys: Set<string>, interactions: ReturnType<import('./faunaMatches.js').buildInteractionsIndex>, place: string}} args
 * @returns {{candidates: Array<object>, alreadyInCatalog: Array<object>}} each entry: { genus, hostGeneraRow, associatedFauna, nearbySpecies }
 */
export function matchNearbyKeystoneGenera({
  observationRows,
  hostGenera,
  catalogGenusKeys: catalogKeys,
  interactions,
  place,
}) {
  const plantaeByGenus = groupPlantaeByGenus(observationRows);
  const faunaIndex = buildEcosystemFaunaIndex(observationRows, place);

  const genusNames = [...new Set([...(hostGenera?.byGenus?.values() || [])].map((row) => row.genus))];

  const candidates = [];
  const alreadyInCatalog = [];

  genusNames.forEach((genus) => {
    if (!hostGenera.isKeystone(genus)) return;
    const key = normalizeGenus(genus);
    const row = hostGenera.lookup(genus);
    const nearbySpecies = (plantaeByGenus.get(key)?.species || [])
      .slice()
      .sort((a, b) => a.radiusMi - b.radiusMi);
    const associatedFauna = interactions
      ? matchesForGenus(genus, { interactions, nearbyFauna: faunaIndex, place }).filter(
          (match) => match.inRange !== false
        )
      : [];
    const item = { genus, hostGeneraRow: row, associatedFauna, nearbySpecies };
    if (catalogKeys?.has(key)) {
      alreadyInCatalog.push(item);
    } else {
      candidates.push(item);
    }
  });

  const byPriority = (a, b) =>
    b.associatedFauna.length - a.associatedFauna.length || rank(b.hostGeneraRow) - rank(a.hostGeneraRow);
  candidates.sort(byPriority);
  alreadyInCatalog.sort(byPriority);

  return { candidates, alreadyInCatalog };
}
