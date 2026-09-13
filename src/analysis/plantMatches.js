import { normalizeGenus } from './hostGenera.js';

/**
 * The "next phase" of the nearby-ecosystem index (nl-a7e): which keystone/
 * larval-host genera for this ecoregion are ALREADY confirmed growing wild
 * near the site — via `data/ecosystem.db`'s Plantae rows — but absent from
 * the catalog. `rules/keystoneGenera.js`'s `topAbsent` already names the
 * heaviest-hitting genera the catalog cannot supply; this module answers the
 * next question that rule cannot: which of those gaps this specific address
 * has actual local evidence for, not just an ecoregion-wide list.
 *
 * Same "no invented score" stance as `faunaMatches.js`: candidates are ranked
 * by host-genera.csv's own sourced NWF counts (the same `rank()` formula
 * `keystoneGenera.js` uses for its suggestions), never by iNaturalist
 * observation_count — that number carries heavy observer bias and is
 * display-only here.
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

/**
 * Keystone/larval-host genera (per `hostGenera`, ecoregion-scoped) confirmed
 * growing near the site (per `observationRows`), split by whether the
 * catalog already carries that genus.
 *
 * @param {{observationRows: Array<object>, hostGenera: ReturnType<import('./hostGenera.js').buildHostGeneraIndex>, catalogGenusKeys: Set<string>}} args
 * @returns {{candidates: Array<object>, alreadyInCatalog: Array<object>}} each entry: { genus, hostGeneraRow, nearbySpecies }
 */
export function matchNearbyKeystoneGenera({ observationRows, hostGenera, catalogGenusKeys: catalogKeys }) {
  const byGenus = groupPlantaeByGenus(observationRows);
  const candidates = [];
  const alreadyInCatalog = [];

  byGenus.forEach((entry, key) => {
    if (!hostGenera?.isKeystone(entry.genus)) return;
    const row = hostGenera.lookup(entry.genus);
    const nearbySpecies = entry.species.slice().sort((a, b) => a.radiusMi - b.radiusMi);
    const item = { genus: entry.genus, hostGeneraRow: row, nearbySpecies };
    if (catalogKeys?.has(key)) {
      alreadyInCatalog.push(item);
    } else {
      candidates.push(item);
    }
  });

  const byRank = (a, b) => rank(b.hostGeneraRow) - rank(a.hostGeneraRow);
  candidates.sort(byRank);
  alreadyInCatalog.sort(byRank);

  return { candidates, alreadyInCatalog };
}
